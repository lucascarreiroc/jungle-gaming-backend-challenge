import { afterAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'crypto';
import { WagerTransactionKind, WagerTransactionStatus, LedgerDirection } from '../../src/domain/wager-transaction';
import { FailureCode } from '../../src/domain/errors';
import { OutboxPublisherWorker } from '../../src/application/workers/outbox-publisher.worker';
import { PendingReferenceWorker } from '../../src/application/workers/pending-reference.worker';
import type { EventPublisher } from '../../src/application/ports';
import { createTestContext } from '../support/test-db';

const ctx = createTestContext();

afterAll(async () => {
  await ctx.close();
});

describe('Schema constraints (enforced by Postgres itself)', () => {
  it('rejects a negative wallet balance at the database level', async () => {
    const client = await ctx.pool.connect();
    try {
      await client.query('BEGIN');
      let threw = false;
      try {
        await client.query(
          `INSERT INTO wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
           VALUES ($1, $2, 'BRL', -10.00, 1, now(), now())`,
          [randomUUID(), randomUUID()],
        );
      } catch (err) {
        threw = true;
        expect(String(err)).toContain('chk_wallets_balance_non_negative');
      }
      expect(threw).toBe(true);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('rejects two wallets for the same playerId + currency at the database level', async () => {
    const playerId = randomUUID();
    const client = await ctx.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
         VALUES ($1, $2, 'BRL', 0.00, 1, now(), now())`,
        [randomUUID(), playerId],
      );
      let threw = false;
      try {
        await client.query(
          `INSERT INTO wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
           VALUES ($1, $2, 'BRL', 0.00, 1, now(), now())`,
          [randomUUID(), playerId],
        );
      } catch (err) {
        threw = true;
        expect(String(err)).toContain('uq_wallets_player_currency');
      }
      expect(threw).toBe(true);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('rejects an unbalanced ledger entry at the database level (balanceBefore ± money != balanceAfter)', async () => {
    const { walletId } = await ctx.createFundedWallet('100.00');
    const client = await ctx.pool.connect();
    try {
      await client.query('BEGIN');
      const txId = randomUUID();
      await client.query(
        `INSERT INTO wager_transactions (
          id, provider_id, external_transaction_id, idempotency_key, payload_hash,
          wallet_id, player_id, round_id, game_id, kind, money_amount, money_currency, status, created_at
        ) VALUES ($1,'p','ext','p:ext','hash',$2,$3,'r','g','BET',10.00,'BRL','PROCESSED', now())`,
        [txId, walletId, randomUUID()],
      );
      let threw = false;
      try {
        await client.query(
          `INSERT INTO wallet_ledger_entries (
            id, wallet_id, transaction_id, direction, money_amount, money_currency,
            balance_before, balance_after, created_at
          ) VALUES ($1,$2,$3,'DEBIT',10.00,'BRL',100.00,85.00, now())`,
          [randomUUID(), walletId, txId],
        );
      } catch (err) {
        threw = true;
        expect(String(err)).toContain('chk_ledger_balanced');
      }
      expect(threw).toBe(true);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

describe('Atomicity: wallet + ledger + transaction + outbox in a single commit', () => {
  it('a successful BET updates wallet, creates a ledger entry, and enqueues outbox events together', async () => {
    const { walletId, playerId } = await ctx.createFundedWallet('100.00');

    const result = await ctx.submit({
      walletId,
      playerId,
      kind: WagerTransactionKind.Bet,
      money: { amount: '15.00', currency: 'BRL' },
    });

    expect(result.status).toBe(WagerTransactionStatus.Processed);

    const wallet = await ctx.getWallet(walletId);
    expect(wallet?.balance.toJSON().amount).toBe('85.00');

    const entries = await ctx.getLedgerEntries(walletId);
    const betEntry = entries.find((e) => e.transactionId === result.transactionId);
    expect(betEntry).toBeDefined();
    expect(betEntry?.direction).toBe(LedgerDirection.Debit);

    const outboxRows = await ctx.pool.query(
      `SELECT event_type FROM outbox_messages WHERE aggregate_id = $1 OR aggregate_id = $2 ORDER BY occurred_at`,
      [result.transactionId, walletId],
    );
    const eventTypes = outboxRows.rows.map((r) => r.event_type);
    expect(eventTypes).toContain('WalletBalanceChanged');
    expect(eventTypes).toContain('WagerTransactionProcessed');
  });
});

class FakeEventPublisher implements EventPublisher {
  public published: Array<{ destination: string; message: Record<string, unknown> }> = [];
  public failNextN = 0;

  async publish(destination: string, message: Record<string, unknown>): Promise<void> {
    if (this.failNextN > 0) {
      this.failNextN -= 1;
      throw new Error('simulated transient publish failure');
    }
    this.published.push({ destination, message });
  }
}

describe('OutboxPublisherWorker (real Postgres, fake network publisher)', () => {
  it('publishes pending outbox messages and marks them as published', async () => {
    const { walletId, playerId } = await ctx.createFundedWallet('50.00');
    const result = await ctx.submit({
      walletId,
      playerId,
      kind: WagerTransactionKind.Bet,
      money: { amount: '5.00', currency: 'BRL' },
    });

    const publisher = new FakeEventPublisher();
    const worker = new OutboxPublisherWorker(ctx.uow, ctx.outbox, publisher, ctx.clock, 'fake-destination', 50);

    const { published } = await worker.runOnce();
    expect(published).toBeGreaterThanOrEqual(1);

    const rows = await ctx.pool.query(
      `SELECT published_at FROM outbox_messages WHERE aggregate_id = $1`,
      [result.transactionId],
    );
    for (const row of rows.rows) {
      expect(row.published_at).not.toBeNull();
    }
  });

  it('retries with backoff when publishing fails, without losing the message', async () => {
    const { walletId, playerId } = await ctx.createFundedWallet('50.00');
    await ctx.submit({
      walletId,
      playerId,
      kind: WagerTransactionKind.Bet,
      money: { amount: '5.00', currency: 'BRL' },
    });

    const publisher = new FakeEventPublisher();
    publisher.failNextN = 100;
    const worker = new OutboxPublisherWorker(ctx.uow, ctx.outbox, publisher, ctx.clock, 'fake-destination', 50);

    const { failed } = await worker.runOnce();
    expect(failed).toBeGreaterThanOrEqual(1);

    const rows = await ctx.pool.query(
      `SELECT attempts, next_attempt_at, published_at FROM outbox_messages WHERE published_at IS NULL AND attempts > 0 ORDER BY occurred_at DESC LIMIT 5`,
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const row of rows.rows) {
      expect(row.published_at).toBeNull();
      expect(Number(row.attempts)).toBeGreaterThan(0);
      expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
    }
  });

  it('two concurrent publisher instances never publish the same message twice (SKIP LOCKED)', async () => {
    const { walletId, playerId } = await ctx.createFundedWallet('50.00');
    await ctx.submit({
      walletId,
      playerId,
      kind: WagerTransactionKind.Bet,
      money: { amount: '5.00', currency: 'BRL' },
    });

    const publisherA = new FakeEventPublisher();
    const publisherB = new FakeEventPublisher();
    const workerA = new OutboxPublisherWorker(ctx.uow, ctx.outbox, publisherA, ctx.clock, 'dest', 50);
    const workerB = new OutboxPublisherWorker(ctx.uow, ctx.outbox, publisherB, ctx.clock, 'dest', 50);

    await Promise.all([workerA.runOnce(), workerB.runOnce()]);

    const allPublishedIds = [...publisherA.published, ...publisherB.published].map(
      (p) => p.message.eventId as string,
    );
    const uniqueIds = new Set(allPublishedIds);
    expect(uniqueIds.size).toBe(allPublishedIds.length);
  });
});

describe('Out-of-order references (section 7.1)', () => {
  it('a REFUND arriving before its BET is stored as PENDING_REFERENCE, then resolved by the worker once the BET exists', async () => {
    const { walletId, playerId } = await ctx.createFundedWallet('100.00');
    const betExternalId = `tx-bet-${randomUUID()}`;

    const refundResult = await ctx.submit({
      walletId,
      playerId,
      kind: WagerTransactionKind.Refund,
      money: { amount: '20.00', currency: 'BRL' },
      externalTransactionId: `tx-refund-${randomUUID()}`,
      referenceExternalTransactionId: betExternalId,
    });
    expect(refundResult.status).toBe(WagerTransactionStatus.PendingReference);

    const walletBefore = await ctx.getWallet(walletId);
    expect(walletBefore?.balance.toJSON().amount).toBe('100.00');

    const betResult = await ctx.submit({
      walletId,
      playerId,
      kind: WagerTransactionKind.Bet,
      money: { amount: '20.00', currency: 'BRL' },
      externalTransactionId: betExternalId,
    });
    expect(betResult.status).toBe(WagerTransactionStatus.Processed);

    const worker = new PendingReferenceWorker(ctx.uow, ctx.transactions, ctx.useCase);
    const { resolved } = await worker.runOnce();
    expect(resolved).toBeGreaterThanOrEqual(1);

    const walletAfter = await ctx.getWallet(walletId);
    expect(walletAfter?.balance.toJSON().amount).toBe('100.00');

    const resolvedTransaction = await ctx.uow.run((tx) => ctx.transactions.findById(refundResult.transactionId, tx));
    expect(resolvedTransaction?.status).toBe(WagerTransactionStatus.Processed);
  });

  it('a reversal that never finds its reference is rejected after exhausting attempts', async () => {
    const { walletId, playerId } = await ctx.createFundedWallet('100.00');

    const refundResult = await ctx.submit({
      walletId,
      playerId,
      kind: WagerTransactionKind.Refund,
      money: { amount: '20.00', currency: 'BRL' },
      externalTransactionId: `tx-refund-orphan-${randomUUID()}`,
      referenceExternalTransactionId: `tx-never-exists-${randomUUID()}`,
    });
    expect(refundResult.status).toBe(WagerTransactionStatus.PendingReference);

    const worker = new PendingReferenceWorker(ctx.uow, ctx.transactions, ctx.useCase);
    let finalStatus: string | undefined;
    for (let i = 0; i < 12; i++) {
      await worker.runOnce();
      const current = await ctx.uow.run((tx) => ctx.transactions.findById(refundResult.transactionId, tx));
      finalStatus = current?.status;
      if (finalStatus === WagerTransactionStatus.Rejected) break;
    }

    expect(finalStatus).toBe(WagerTransactionStatus.Rejected);

    const rejectedTransaction = await ctx.uow.run((tx) => ctx.transactions.findById(refundResult.transactionId, tx));
    expect(rejectedTransaction?.failureCode).toBe(FailureCode.REFERENCE_NOT_FOUND_TIMEOUT);

    const wallet = await ctx.getWallet(walletId);
    expect(wallet?.balance.toJSON().amount).toBe('100.00');
  });
});

describe('Reconciliation', () => {
  it('stored balance matches the balance recalculated from the ledger after several operations', async () => {
    const { walletId, playerId } = await ctx.createFundedWallet('200.00');

    await ctx.submit({ walletId, playerId, kind: WagerTransactionKind.Bet, money: { amount: '30.00', currency: 'BRL' } });
    await ctx.submit({ walletId, playerId, kind: WagerTransactionKind.Bet, money: { amount: '10.00', currency: 'BRL' } });
    await ctx.submit({ walletId, playerId, kind: WagerTransactionKind.Win, money: { amount: '15.00', currency: 'BRL' } });

    const wallet = await ctx.getWallet(walletId);
    const { balance: calculatedRaw } = await ctx.uow.run((tx) => ctx.ledger.sumByWallet(walletId, tx));

    const [whole, fraction = ''] = calculatedRaw.split('.');
    const calculated = `${whole}.${fraction.padEnd(2, '0').slice(0, 2)}`;

    expect(wallet?.balance.toJSON().amount).toBe(calculated);
    expect(wallet?.balance.toJSON().amount).toBe('175.00');
  });
});
