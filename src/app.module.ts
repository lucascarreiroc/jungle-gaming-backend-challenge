import { Module } from '@nestjs/common';
import { Pool } from 'pg';
import { WalletsController } from './interfaces/http/wallets.controller';
import { WageringController } from './interfaces/http/wagering.controller';
import { HealthController } from './interfaces/http/health.controller';
import { MetricsController } from './interfaces/http/metrics.controller';
import {
  PostgresUnitOfWork,
  PostgresWalletRepository,
  PostgresWagerTransactionRepository,
  PostgresLedgerRepository,
  PostgresInboxRepository,
  PostgresOutboxRepository,
  SystemClock,
  UuidGenerator,
} from './infrastructure/db/postgres-repositories';
import { SubmitWagerTransactionUseCase } from './application/use-cases/submit-wager-transaction.use-case';
import { TOKENS } from './tokens';

@Module({
  controllers: [WalletsController, WageringController, HealthController, MetricsController],
  providers: [
    {
      provide: TOKENS.PG_POOL,
      useFactory: () => {
        const connectionString = process.env.DATABASE_URL;
        if (!connectionString) {
          throw new Error('DATABASE_URL environment variable is required');
        }
        return new Pool({ connectionString });
      },
    },
    {
      provide: TOKENS.UNIT_OF_WORK,
      useFactory: (pool: Pool) => new PostgresUnitOfWork(pool),
      inject: [TOKENS.PG_POOL],
    },
    { provide: TOKENS.WALLET_REPOSITORY, useClass: PostgresWalletRepository },
    { provide: TOKENS.WAGER_TRANSACTION_REPOSITORY, useClass: PostgresWagerTransactionRepository },
    { provide: TOKENS.LEDGER_REPOSITORY, useClass: PostgresLedgerRepository },
    { provide: TOKENS.INBOX_REPOSITORY, useClass: PostgresInboxRepository },
    { provide: TOKENS.OUTBOX_REPOSITORY, useClass: PostgresOutboxRepository },
    { provide: TOKENS.CLOCK, useClass: SystemClock },
    { provide: TOKENS.ID_GENERATOR, useClass: UuidGenerator },
    {
      provide: SubmitWagerTransactionUseCase,
      useFactory: (
        uow: PostgresUnitOfWork,
        wallets: PostgresWalletRepository,
        transactions: PostgresWagerTransactionRepository,
        ledger: PostgresLedgerRepository,
        outbox: PostgresOutboxRepository,
        clock: SystemClock,
        ids: UuidGenerator,
      ) => new SubmitWagerTransactionUseCase(uow, wallets, transactions, ledger, outbox, clock, ids),
      inject: [
        TOKENS.UNIT_OF_WORK,
        TOKENS.WALLET_REPOSITORY,
        TOKENS.WAGER_TRANSACTION_REPOSITORY,
        TOKENS.LEDGER_REPOSITORY,
        TOKENS.OUTBOX_REPOSITORY,
        TOKENS.CLOCK,
        TOKENS.ID_GENERATOR,
      ],
    },
  ],
})
export class AppModule {}
