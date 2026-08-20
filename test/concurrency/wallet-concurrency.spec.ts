import { afterAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'crypto';
import { WagerTransactionKind, WagerTransactionStatus, LedgerDirection } from '../../src/domain/wager-transaction';
import { FailureCode } from '../../src/domain/errors';
import { createTestContext } from '../support/test-db';

/**
 * Estes testes exigem Postgres real rodando (docker-compose) e DATABASE_URL
 * setado. Ver README.md. Não usam mocks — a garantia de concorrência só é
 * comprovada com paralelismo de verdade (Promise.all disparando múltiplas
 * conexões simultâneas do pool contra o mesmo banco).
 *
 * Rodar com: bun test test/concurrency
 */
const ctx = createTestContext();

afterAll(async () => {
  await ctx.close();
});

function submitBet(walletId: string, playerId: string, externalId: string, amount: string) {
  return ctx.useCase.execute({
    idempotencyKey: `provider-a:${externalId}`,
    providerId: 'provider-a',
    externalTransactionId: externalId,
    playerId,
    walletId,
    roundId: 'round-x',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: { amount, currency: 'BRL' },
  });
}

describe('Wallet concurrency (real Postgres, real parallelism)', () => {
  it(
    'mandatory scenario: two concurrent 80.00 bets on a 100.00 balance -> exactly one PROCESSED, one REJECTED, final balance 20.00',
    async () => {
      const { walletId, playerId } = await ctx.createFundedWallet('100.00');

      const [resultA, resultB] = await Promise.all([
        submitBet(walletId, playerId, `tx-a-${randomUUID()}`, '80.00'),
        submitBet(walletId, playerId, `tx-b-${randomUUID()}`, '80.00'),
      ]);

      const statuses = [resultA.status, resultB.status].sort();
      expect(statuses).toEqual([WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected].sort());

      const rejected = resultA.status === WagerTransactionStatus.Rejected ? resultA : resultB;
      expect(rejected.failureCode).toBe(FailureCode.BUSINESS_INSUFFICIENT_BALANCE);

      const wallet = await ctx.getWallet(walletId);
      expect(wallet?.balance.toJSON().amount).toBe('20.00');

      const entries = await ctx.getLedgerEntries(walletId);
      // 1 OPENING (credit) + 1 BET (debit) = 2 entries. Only one debit, never two.
      const debits = entries.filter((e) => e.direction === LedgerDirection.Debit);
      expect(debits.length).toBe(1);
    },
    15000,
  );

  it(
    'the same bet submitted 50 times in parallel results in exactly one debit (idempotency under concurrency)',
    async () => {
      const { walletId, playerId } = await ctx.createFundedWallet('1000.00');
      const externalId = `tx-dup-${randomUUID()}`;

      const results = await Promise.all(
        Array.from({ length: 50 }, () => submitBet(walletId, playerId, externalId, '10.00')),
      );

      const processed = results.filter((r) => r.status === WagerTransactionStatus.Processed);
      const replays = results.filter((r) => r.idempotentReplay);

      // Exactly one "original" processing; the other 49 are idempotent replays.
      expect(processed.length).toBe(50); // all report PROCESSED (either original or replay)
      expect(replays.length).toBe(49);

      const wallet = await ctx.getWallet(walletId);
      expect(wallet?.balance.toJSON().amount).toBe('990.00'); // 1000 - 10, only once

      const entries = await ctx.getLedgerEntries(walletId);
      const debits = entries.filter((e) => e.direction === LedgerDirection.Debit);
      expect(debits.length).toBe(1);
    },
    30000,
  );

  it(
    'bets on different wallets process in parallel without blocking each other',
    async () => {
      const walletA = await ctx.createFundedWallet('100.00');
      const walletB = await ctx.createFundedWallet('100.00');

      const start = Date.now();
      const [resultA, resultB] = await Promise.all([
        submitBet(walletA.walletId, walletA.playerId, `tx-parallel-a-${randomUUID()}`, '30.00'),
        submitBet(walletB.walletId, walletB.playerId, `tx-parallel-b-${randomUUID()}`, '30.00'),
      ]);
      const elapsed = Date.now() - start;

      expect(resultA.status).toBe(WagerTransactionStatus.Processed);
      expect(resultB.status).toBe(WagerTransactionStatus.Processed);

      const balanceA = await ctx.getWallet(walletA.walletId);
      const balanceB = await ctx.getWallet(walletB.walletId);
      expect(balanceA?.balance.toJSON().amount).toBe('70.00');
      expect(balanceB?.balance.toJSON().amount).toBe('70.00');

      // Não é uma asserção de performance rígida (ambiente de CI pode variar),
      // apenas um sinal de que não houve serialização artificial entre
      // wallets distintas (ex.: um lock global teria feito isso demorar
      // visivelmente mais que uma única operação).
      expect(elapsed).toBeLessThan(5000);
    },
    15000,
  );

  it(
    'three simultaneous instances hitting the same wallet: exactly one wins per available balance slice',
    async () => {
      const { walletId, playerId } = await ctx.createFundedWallet('100.00');

      // 3 bets of 40.00 each against a 100.00 balance: exactly 2 should
      // succeed (80.00 total) and 1 should be rejected.
      const results = await Promise.all([
        submitBet(walletId, playerId, `tx-three-1-${randomUUID()}`, '40.00'),
        submitBet(walletId, playerId, `tx-three-2-${randomUUID()}`, '40.00'),
        submitBet(walletId, playerId, `tx-three-3-${randomUUID()}`, '40.00'),
      ]);

      const processedCount = results.filter((r) => r.status === WagerTransactionStatus.Processed).length;
      const rejectedCount = results.filter((r) => r.status === WagerTransactionStatus.Rejected).length;

      expect(processedCount).toBe(2);
      expect(rejectedCount).toBe(1);

      const wallet = await ctx.getWallet(walletId);
      expect(wallet?.balance.toJSON().amount).toBe('20.00');
    },
    20000,
  );
});
