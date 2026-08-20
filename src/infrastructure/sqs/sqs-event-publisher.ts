import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { randomUUID } from 'crypto';
import type { EventPublisher } from '../../application/ports';

export interface SqsEventPublisherConfig {
  region: string;
  endpoint?: string;
}

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
