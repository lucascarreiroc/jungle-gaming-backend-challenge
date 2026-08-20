import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Pool } from 'pg';
import { AppModule } from './app.module';
import { TOKENS } from './tokens';
import { SQSClient, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { SqsConsumer } from './infrastructure/sqs/sqs-consumer';
import { SqsEventPublisher } from './infrastructure/sqs/sqs-event-publisher';
import { setDlqDepth } from './infrastructure/observability/metrics';
import { SubmitWagerTransactionUseCase } from './application/use-cases/submit-wager-transaction.use-case';
import { OutboxPublisherWorker } from './application/workers/outbox-publisher.worker';
import { PendingReferenceWorker } from './application/workers/pending-reference.worker';
import {
  PostgresUnitOfWork,
  PostgresInboxRepository,
  PostgresOutboxRepository,
  PostgresWagerTransactionRepository,
  SystemClock,
} from './infrastructure/db/postgres-repositories';

const OUTBOX_PUBLISH_INTERVAL_MS = 2000;
const PENDING_REFERENCE_INTERVAL_MS = 5000;

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const port = process.env.PORT ? Number(process.env.PORT) : 3000;

  const pool = app.get<Pool>(TOKENS.PG_POOL);
  const uow = new PostgresUnitOfWork(pool);
  const clock = new SystemClock();
  const useCase = app.get(SubmitWagerTransactionUseCase);

  let sqsConsumer: SqsConsumer | undefined;
  let outboxTimer: ReturnType<typeof setInterval> | undefined;
  let pendingReferenceTimer: ReturnType<typeof setInterval> | undefined;
  let dlqPollTimer: ReturnType<typeof setInterval> | undefined;

  const dlqUrl = process.env.SQS_DLQ_URL;
  if (dlqUrl) {
    const sqsClient = new SQSClient({
      region: process.env.AWS_REGION ?? 'us-east-1',
      endpoint: process.env.AWS_ENDPOINT,
    });
    dlqPollTimer = setInterval(() => {
      sqsClient
        .send(
          new GetQueueAttributesCommand({
            QueueUrl: dlqUrl,
            AttributeNames: ['ApproximateNumberOfMessages'],
          }),
        )
        .then((res) => {
          const count = Number(res.Attributes?.ApproximateNumberOfMessages ?? '0');
          setDlqDepth(count);
        })
        .catch((err) => {
          console.error('[main] failed to poll DLQ depth:', err);
        });
    }, 10000);
  }

  const eventsQueueUrl = process.env.WAGER_EVENTS_QUEUE_URL;
  if (eventsQueueUrl) {
    const outboxRepo = new PostgresOutboxRepository();
    const publisher = new SqsEventPublisher({
      region: process.env.AWS_REGION ?? 'us-east-1',
      endpoint: process.env.AWS_ENDPOINT,
    });
    const outboxWorker = new OutboxPublisherWorker(uow, outboxRepo, publisher, clock, eventsQueueUrl);

    outboxTimer = setInterval(() => {
      outboxWorker.runOnce().catch((err) => {
        console.error('[OutboxPublisherWorker] error:', err);
      });
    }, OUTBOX_PUBLISH_INTERVAL_MS);
  } else {
    console.warn(
      '[main] WAGER_EVENTS_QUEUE_URL não definida — OutboxPublisherWorker não vai rodar. ' +
        'Eventos continuam sendo gravados na tabela outbox_messages, mas não serão publicados no SQS.',
    );
  }

  {
    const transactionsRepo = new PostgresWagerTransactionRepository();
    const pendingReferenceWorker = new PendingReferenceWorker(uow, transactionsRepo, useCase);
    pendingReferenceTimer = setInterval(() => {
      pendingReferenceWorker.runOnce().catch((err) => {
        console.error('[PendingReferenceWorker] error:', err);
      });
    }, PENDING_REFERENCE_INTERVAL_MS);
  }

  if (process.env.ENABLE_SQS_CONSUMER === 'true') {
    const inbox = new PostgresInboxRepository();

    sqsConsumer = new SqsConsumer(
      {
        queueUrl: requireEnv('SQS_QUEUE_URL'),
        region: process.env.AWS_REGION ?? 'us-east-1',
        endpoint: process.env.AWS_ENDPOINT,
      },
      useCase,
      inbox,
      uow,
    );

    sqsConsumer.start().catch((err) => {
      console.error('[SqsConsumer] fatal error in polling loop:', err);
    });
  }

  const shutdown = async (signal: string) => {
    console.log(`[main] received ${signal}, shutting down gracefully...`);
    if (outboxTimer) clearInterval(outboxTimer);
    if (pendingReferenceTimer) clearInterval(pendingReferenceTimer);
    if (dlqPollTimer) clearInterval(dlqPollTimer);
    if (sqsConsumer) {
      await sqsConsumer.stop();
    }
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen(port);
  console.log(`Wagering Processor listening on port ${port}`);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Environment variable ${name} is required when ENABLE_SQS_CONSUMER=true`);
  }
  return value;
}

bootstrap();
