import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Pool } from 'pg';
import { AppModule } from './app.module';
import { TOKENS } from './tokens';
import { SqsConsumer } from './infrastructure/sqs/sqs-consumer';
import { SubmitWagerTransactionUseCase } from './application/use-cases/submit-wager-transaction.use-case';
import {
  PostgresUnitOfWork,
  PostgresInboxRepository,
} from './infrastructure/db/postgres-repositories';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const port = process.env.PORT ? Number(process.env.PORT) : 3000;

  let consumer: SqsConsumer | undefined;

  // O consumer SQS é opcional e desligado por padrão — em produção real ele
  // rodaria como um processo/deployment separado da API HTTP (para escalar
  // independentemente), mas para este desafio é suportado no mesmo processo
  // via flag, para simplificar a demonstração local.
  if (process.env.ENABLE_SQS_CONSUMER === 'true') {
    const pool = app.get<Pool>(TOKENS.PG_POOL);
    const useCase = app.get(SubmitWagerTransactionUseCase);
    const uow = new PostgresUnitOfWork(pool);
    const inbox = new PostgresInboxRepository();

    consumer = new SqsConsumer(
      {
        queueUrl: requireEnv('SQS_QUEUE_URL'),
        region: process.env.AWS_REGION ?? 'us-east-1',
        endpoint: process.env.AWS_ENDPOINT,
      },
      useCase,
      inbox,
      uow,
    );

    // Não usamos `await` aqui de propósito: start() roda o loop de polling
    // indefinidamente até stop() ser chamado, então precisa ficar em
    // background enquanto o resto do bootstrap (HTTP) segue.
    consumer.start().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[SqsConsumer] fatal error in polling loop:', err);
    });
  }

  // Shutdown gracioso (ver seção 10 do desafio: "em SIGTERM, concluir
  // mensagens em andamento ou devolver a visibilidade").
  const shutdown = async (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`[main] received ${signal}, shutting down gracefully...`);
    if (consumer) {
      await consumer.stop();
    }
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen(port);
  // eslint-disable-next-line no-console
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
