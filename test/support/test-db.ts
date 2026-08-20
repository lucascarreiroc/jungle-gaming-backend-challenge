import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { Wallet } from '../../src/domain/wallet';
import { Money } from '../../src/domain/money';
import { WagerTransaction } from '../../src/domain/wager-transaction';
import { LedgerDirection } from '../../src/domain/wager-transaction';
import { WalletLedgerEntry } from '../../src/domain/wallet-ledger-entry';
import {
  PostgresUnitOfWork,
  PostgresWalletRepository,
  PostgresWagerTransactionRepository,
  PostgresLedgerRepository,
  PostgresOutboxRepository,
  SystemClock,
  UuidGenerator,
} from '../../src/infrastructure/db/postgres-repositories';
import { SubmitWagerTransactionUseCase, SubmitWagerTransactionInput, SubmitWagerTransactionOutput } from '../../src/application/use-cases/submit-wager-transaction.use-case';

export function createTestContext() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL não está definida. Rode: $env:DATABASE_URL="postgres://wagering:wagering@localhost:5433/wagering" antes de "bun test test/concurrency"',
    );
  }

  const pool = new Pool({ connectionString, max: 20 });

  const uow = new PostgresUnitOfWork(pool);
  const wallets = new PostgresWalletRepository();
  const transactions = new PostgresWagerTransactionRepository();
  const ledger = new PostgresLedgerRepository();
  const outbox = new PostgresOutboxRepository();
  const clock = new SystemClock();
  const ids = new UuidGenerator();

  const useCase = new SubmitWagerTransactionUseCase(uow, wallets, transactions, ledger, outbox, clock, ids);

  async function createFundedWallet(initialAmount: string, currency = 'BRL') {
    const playerId = randomUUID();
    return uow.run(async (tx) => {
      const wallet = Wallet.open({
        id: randomUUID(),
        playerId,
        initialBalance: Money.zero(currency),
      });
      await wallets.insert(wallet, tx);

      const initial = Money.from({ amount: initialAmount, currency });
      if (initial.isPositive()) {
        const opening = WagerTransaction.createOpening({
          id: randomUUID(),
          walletId: wallet.id,
          playerId,
          money: initial,
        });
        const mutation = wallet.credit(initial);
        await transactions.insert(opening, tx);
        opening.markProcessed(undefined, new Date());
        await transactions.update(opening, tx);
        await wallets.updateWithOptimisticLock(wallet, 1, tx);

        const entry = WalletLedgerEntry.create({
          id: randomUUID(),
          walletId: wallet.id,
          transactionId: opening.id,
          direction: LedgerDirection.Credit,
          money: initial,
          balanceBefore: mutation.balanceBefore,
          balanceAfter: mutation.balanceAfter,
        });
        await ledger.insert(entry, tx);
      }

      return { walletId: wallet.id, playerId };
    });
  }

  async function getWallet(walletId: string) {
    return uow.run((tx) => wallets.findById(walletId, tx));
  }

  async function getLedgerEntries(walletId: string) {
    return uow.run((tx) => ledger.listByWallet(walletId, undefined, 1000, tx));
  }

  async function submit(
    overrides: Partial<SubmitWagerTransactionInput> &
      Pick<SubmitWagerTransactionInput, 'walletId' | 'playerId' | 'kind' | 'money'>,
  ): Promise<SubmitWagerTransactionOutput> {
    const externalId = overrides.externalTransactionId ?? `tx-${randomUUID()}`;
    return useCase.execute({
      providerId: 'provider-a',
      externalTransactionId: externalId,
      idempotencyKey: `provider-a:${externalId}`,
      roundId: 'round-x',
      gameId: 'fortune-chimp',
      ...overrides,
    });
  }

  async function close() {
    await pool.end();
  }

  return {
    pool,
    uow,
    wallets,
    transactions,
    ledger,
    outbox,
    clock,
    useCase,
    createFundedWallet,
    getWallet,
    getLedgerEntries,
    submit,
    close,
  };
}

export type TestContext = ReturnType<typeof createTestContext>;
