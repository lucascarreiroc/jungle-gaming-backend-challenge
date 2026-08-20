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
  endpoint?: string;
  maxMessages?: number;
  waitTimeSeconds?: number;
  visibilityTimeoutSeconds?: number;
}

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

  async start(): Promise<void> {
    this.running = true;
    this.stopRequested = false;

    while (!this.stopRequested) {
      try {
        const messages = await this.receiveBatch();
        for (const message of messages) {
          if (this.stopRequested) {
            break;
          }
          const task = this.processMessage(message).finally(() => {
            this.inFlight.delete(task);
          });
          this.inFlight.add(task);
        }
      } catch (err) {
        console.error('[SqsConsumer] receive loop error:', err);
        await sleep(1000);
      }
    }

    this.running = false;
  }

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
    const rawBody = (message.Body ?? '').replace(/^\uFEFF/, '');

    let envelope: WagerTransactionMessageEnvelope;
    try {
      envelope = JSON.parse(rawBody);
    } catch (err) {
      console.error('[SqsConsumer] malformed message body, will retry until DLQ:', rawBody, err);
      return;
    }

    const messageId = envelope.messageId ?? message.MessageId!;
    const payloadHash = createHash('sha256').update(JSON.stringify(envelope.data)).digest('hex');

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

      await this.markProcessedInInbox(messageId, payloadHash);
      await this.ack(receiptHandle);
      console.log(
        `[SqsConsumer] processed messageId=${messageId} kind=${envelope.data.kind} status=${result.status} walletId=${envelope.data.walletId}`,
      );
    } catch (err) {
      if (err instanceof DomainError) {
        console.error('[SqsConsumer] business/domain error, acking (non-retryable):', err.code, err.message);
        await this.markProcessedInInbox(messageId, payloadHash);
        await this.ack(receiptHandle);
        return;
      }

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

}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
