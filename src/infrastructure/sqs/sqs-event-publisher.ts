import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { randomUUID } from 'crypto';
import type { EventPublisher } from '../../application/ports';

export interface SqsEventPublisherConfig {
  region: string;
  endpoint?: string;
}

/**
 * Publica eventos de domínio (WagerTransactionProcessed, WalletBalanceChanged,
 * etc.) em uma fila SQS FIFO. Usado pelo OutboxPublisherWorker — nunca
 * chamado diretamente pelos use cases (ver seção 11 do desafio: eventos só
 * saem depois do commit, via outbox).
 *
 * `destination` (parâmetro de `publish`) é a URL da fila. O `aggregateId`
 * do evento vira o MessageGroupId, garantindo ordenação FIFO por agregado
 * (ex.: todos os eventos da mesma wallet mantêm ordem relativa entre si).
 */
export class SqsEventPublisher implements EventPublisher {
  private readonly client: SQSClient;

  constructor(config: SqsEventPublisherConfig) {
    this.client = new SQSClient({ region: config.region, endpoint: config.endpoint });
  }

  async publish(destination: string, message: Record<string, unknown>): Promise<void> {
    const aggregateId = typeof message.aggregateId === 'string' ? message.aggregateId : randomUUID();
    const eventId = typeof message.eventId === 'string' ? message.eventId : randomUUID();

    await this.client.send(
      new SendMessageCommand({
        QueueUrl: destination,
        MessageBody: JSON.stringify(message),
        MessageGroupId: aggregateId,
        MessageDeduplicationId: eventId,
      }),
    );
  }
}
