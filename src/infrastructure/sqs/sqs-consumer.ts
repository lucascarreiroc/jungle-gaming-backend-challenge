import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  Message,
} from '@aws-sdk/client-sqs';
import { createHash } from 'crypto';
import { SubmitWagerTransactionUseCase } from '../../application/use-cases/submit-wager-transaction.use-case';
import type { InboxRepository, UnitOfWork } from '../../application/ports';
import { InboxMessage } from '../../domain/inbox-outbox';
import { DomainError } from '../../domain/errors';
import { WagerTransactionKind } from '../../domain/wager-transaction';
import { recordSqsRedelivery } from '../observability/metrics';
import { logEvent } from '../observability/logger';

const CONSUMER_NAME = 'wager-transactions-consumer';

/**
 * Formato esperado da mensagem publicada na fila (ver seção 10 do desafio).
 */
interface WagerTransactionMessageEnvelope {
  messageId: string;
  type: string;
  occurredAt: string;
  data: {
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: WagerTransactionKind;
    money: { amount: string; currency: string };
    referenceExternalTransactionId?: string;
  };
}

export interface SqsConsumerConfig {
  queueUrl: string;
  region: string;
  endpoint?: string; // usado para apontar para o LocalStack
  maxMessages?: number; // até 10, limite da API SQS
  waitTimeSeconds?: number; // long polling
  visibilityTimeoutSeconds?: number;
}

/**
 * Consumer da fila `wager-transactions.fifo` (ver seção 10 do desafio).
 *
 * Responsabilidades cobertas aqui:
 * - Reutiliza o MESMO `SubmitWagerTransactionUseCase` da entrada HTTP —
 *   não existe uma segunda cópia da lógica de negócio para o caminho SQS.
 * - Deduplica via inbox persistente por (consumerName, messageId), ANTES de
 *   chamar o use case — evita reprocessar efeitos de negócio para uma
 *   mensagem redelivered que já foi tratada.
 * - Faz ack (DeleteMessage) somente depois que o use case retorna com
 *   sucesso (ou com uma rejeição de negócio, que também é terminal e não
 *   deve ser retentada).
 * - Distingue três classes de erro:
 *     · erro de negócio (o use case responde REJECTED de forma controlada)
 *       -> ack, não é reenviado, o resultado fica registrado no nosso banco;
 *     · erro transitório de infraestrutura (ex.: Postgres momentaneamente
 *       fora do ar) -> NÃO faz ack; a mensagem volta a ficar visível após o
 *       visibility timeout expirar e o SQS reentrega automaticamente;
 *     · erro permanente inesperado (bug, payload corrompido que nem chega a
 *       ser um DomainError) -> loga e não faz ack; após esgotar
 *       `maxReceiveCount` (configurado na fila, fora do código da
 *       aplicação — ver ARCHITECTURE.md), o SQS move a mensagem para a DLQ
 *       automaticamente.
 * - Em SIGTERM: para de puxar mensagens novas e espera as mensagens em
 *   andamento terminarem antes de finalizar o processo, em vez de
 *   simplesmente derrubar o processo com trabalho pela metade.
 *
 * Nota de escopo (ver ARCHITECTURE.md): a marcação do InboxMessage como
 * "processado" acontece em uma transação separada da mutação financeira do
 * use case (que já commita sua própria transação internamente). Isso NÃO
 * compromete a correção: a garantia final contra duplicação continua sendo
 * a constraint UNIQUE(provider_id, idempotency_key) no nível de negócio —
 * o Inbox aqui é uma otimização para não nem chamar o use case de novo para
 * uma mensagem obviamente repetida, não a fonte da verdade de idempotência.
 */
export class SqsConsumer {
  private readonly client: SQSClient;
  private running = false;
  private stopRequested = false;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly config: SqsConsumerConfig,
    private readonly useCase: SubmitWagerTransactionUseCase,
    private readonly inbox: InboxRepository,
    private readonly uow: UnitOfWork,
  ) {
    this.client = new SQSClient({
      region: config.region,
      endpoint: config.endpoint,
    });
  }

  /** Inicia o loop de polling. Roda até stop() ser chamado. */
  async start(): Promise<void> {
    this.running = true;
    this.stopRequested = false;

    while (!this.stopRequested) {
      try {
        const messages = await this.receiveBatch();
        for (const message of messages) {
          if (this.stopRequested) {
            // Não inicia processamento de mensagens novas após o pedido de
            // parada — a visibilidade delas expira naturalmente e o SQS as
            // reentrega para outra instância.
            break;
          }
          const task = this.processMessage(message).finally(() => {
            this.inFlight.delete(task);
          });
          this.inFlight.add(task);
        }
      } catch (err) {
        // Erro ao falar com o próprio SQS (não com o processamento de uma
        // mensagem específica) — loga e continua o loop após um pequeno
        // backoff, para não girar em círculo consumindo CPU/rede.
        // eslint-disable-next-line no-console
        console.error('[SqsConsumer] receive loop error:', err);
        await sleep(1000);
      }
    }

    this.running = false;
  }

  /**
   * Sinaliza para o loop parar de puxar mensagens novas e aguarda as que já
   * estão em andamento terminarem (ack ou não-ack) antes de retornar.
   * Chamado a partir do handler de SIGTERM em main.ts.
   */
  async stop(): Promise<void> {
    this.stopRequested = true;
    await Promise.allSettled(Array.from(this.inFlight));
  }

  isRunning(): boolean {
    return this.running;
  }

  private async receiveBatch(): Promise<Message[]> {
    const result = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.config.queueUrl,
        MaxNumberOfMessages: this.config.maxMessages ?? 10,
        WaitTimeSeconds: this.config.waitTimeSeconds ?? 10,
        VisibilityTimeout: this.config.visibilityTimeoutSeconds ?? 30,
      }),
    );
    return result.Messages ?? [];
  }

  private async processMessage(message: Message): Promise<void> {
    const receiptHandle = message.ReceiptHandle!;
    // Remove um possível BOM (Byte Order Mark, \uFEFF) no início do corpo.
    // Alguns produtores (ex.: PowerShell no Windows, dependendo da
    // codificação usada para escrever o payload) inserem esse marcador
    // invisível, que quebra JSON.parse mesmo que o restante do JSON esteja
    // perfeitamente válido.
    const rawBody = (message.Body ?? '').replace(/^\uFEFF/, '');

    let envelope: WagerTransactionMessageEnvelope;
    try {
      envelope = JSON.parse(rawBody);
    } catch (err) {
      // Payload não é nem JSON válido — erro permanente, não adianta
      // retentar. Não faz ack aqui de propósito: deixamos o SQS aplicar sua
      // própria política de maxReceiveCount -> DLQ, para manter um único
      // caminho de "mensagens problemáticas acabam na DLQ" em vez de dois
      // (ack manual vs. redrive policy).
      // eslint-disable-next-line no-console
      console.error('[SqsConsumer] malformed message body, will retry until DLQ:', rawBody, err);
      return;
    }

    const messageId = envelope.messageId ?? message.MessageId!;
    const payloadHash = createHash('sha256').update(JSON.stringify(envelope.data)).digest('hex');

    // 1) Dedup via inbox — checagem rápida antes de qualquer trabalho de negócio.
    const alreadyProcessed = await this.uow.run((tx) => this.inbox.findByKey(CONSUMER_NAME, messageId, tx));
    if (alreadyProcessed?.isProcessed()) {
      await this.ack(receiptHandle);
      return;
    }

    try {
      const result = await this.useCase.execute({
        idempotencyKey: envelope.data.idempotencyKey,
        providerId: envelope.data.providerId,
        externalTransactionId: envelope.data.externalTransactionId,
        playerId: envelope.data.playerId,
        walletId: envelope.data.walletId,
        roundId: envelope.data.roundId,
        gameId: envelope.data.gameId,
        kind: envelope.data.kind,
        money: envelope.data.money,
        referenceExternalTransactionId: envelope.data.referenceExternalTransactionId,
        correlationId: messageId,
      });

      // PROCESSED, REJECTED e PENDING_REFERENCE são todos resultados
      // "tratados com sucesso" do ponto de vista do consumer — nenhum deve
      // ser retentado pelo SQS, por isso fazemos ack em todos eles.
      await this.markProcessedInInbox(messageId, payloadHash);
      await this.ack(receiptHandle);
      // eslint-disable-next-line no-console
      console.log(
        `[SqsConsumer] processed messageId=${messageId} kind=${envelope.data.kind} status=${result.status} walletId=${envelope.data.walletId}`,
      );
    } catch (err) {
      if (err instanceof DomainError) {
        // Erro de negócio que o use case não conseguiu nem classificar como
        // REJECTED estruturado (ex.: IdempotencyConflictError por payload
        // divergente). É um problema de dados, não de infraestrutura —
        // retentar não vai resolver. Registramos e fazemos ack para não
        // girar em loop de redelivery para sempre.
        // eslint-disable-next-line no-console
        console.error('[SqsConsumer] business/domain error, acking (non-retryable):', err.code, err.message);
        await this.markProcessedInInbox(messageId, payloadHash);
        await this.ack(receiptHandle);
        return;
      }

      // Qualquer outro erro é tratado como transitório de infraestrutura
      // (Postgres fora do ar, timeout de rede, etc.) — NÃO fazemos ack.
      // A mensagem volta a ficar visível após o visibility timeout e é
      // reentregue automaticamente pelo SQS.
      recordSqsRedelivery();
      logEvent('error', 'sqs message processing failed transiently, will be redelivered', {
        messageId,
        providerId: envelope.data?.providerId,
        walletId: envelope.data?.walletId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async markProcessedInInbox(messageId: string, payloadHash: string): Promise<void> {
    const inboxMessage = InboxMessage.receive({
      messageId,
      consumerName: CONSUMER_NAME,
      payloadHash,
    });
    inboxMessage.markProcessed(new Date());
    await this.uow.run((tx) => this.inbox.insert(inboxMessage, tx));
  }

  private async ack(receiptHandle: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({ QueueUrl: this.config.queueUrl, ReceiptHandle: receiptHandle }),
    );
  }

  /**
   * Extensão possível (não implementada): em vez de simplesmente esperar o
   * visibility timeout expirar em stop(), poderíamos chamar
   * ChangeMessageVisibilityCommand com VisibilityTimeout: 0 nas mensagens
   * ainda não iniciadas no momento do SIGTERM, devolvendo a visibilidade
   * imediatamente em vez de esperar o timeout — reduz a latência de
   * reentrega para outra instância. Ver ARCHITECTURE.md.
   */
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
