import type { UnitOfWork, OutboxRepository, EventPublisher, Clock } from '../ports';
import { recordOutboxRetry, recordOutboxLagMs } from '../../infrastructure/observability/metrics';
import { logEvent } from '../../infrastructure/observability/logger';

export class OutboxPublisherWorker {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly outbox: OutboxRepository,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly destination: string,
    private readonly batchSize = 50,
  ) {}

  async runOnce(): Promise<{ published: number; failed: number }> {
    const now = this.clock.now();
    const batch = await this.uow.run((tx) => this.outbox.lockDueBatch(this.batchSize, now, tx));

    let published = 0;
    let failed = 0;

    for (const message of batch) {
      try {
        await this.publisher.publish(this.destination, message.payload);
        message.markPublished(this.clock.now());
        recordOutboxLagMs(this.clock.now().getTime() - message.occurredAt.getTime());
        published += 1;
      } catch (err) {
        message.scheduleRetry(this.clock.now());
        recordOutboxRetry();
        logEvent('warn', 'outbox message publish failed, scheduled retry', {
          outboxMessageId: message.id,
          aggregateId: message.aggregateId,
          eventType: message.eventType,
          attempts: message.attempts,
          error: err instanceof Error ? err.message : String(err),
        });
        failed += 1;
      }
      await this.uow.run((tx) => this.outbox.update(message, tx));
    }

    return { published, failed };
  }
}
