import { Pool, PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { Wallet } from '../../domain/wallet';
import { Money } from '../../domain/money';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  LedgerDirection,
} from '../../domain/wager-transaction';
import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { InboxMessage, OutboxMessage } from '../../domain/inbox-outbox';
import { FailureCode } from '../../domain/errors';
import type {
  WalletRepository,
  WagerTransactionRepository,
  LedgerRepository,
  InboxRepository,
  OutboxRepository,
  UnitOfWork,
  OptimisticUpdateResult,
  Clock,
  IdGenerator,
} from '../../application/ports';

/**
 * Nota de design (ver ARCHITECTURE.md, seção "ORM"):
 * O desafio recomenda MikroORM como opção preferencial. Optamos por acessar
 * o Postgres diretamente via `pg` nesta camada porque a operação mais crítica
 * do sistema — o UPDATE otimista da wallet — precisa de controle explícito
 * sobre a cláusula WHERE version = ? e sobre o número de linhas afetadas, e
 * isso fica mais direto de auditar em SQL puro do que atrás de abstrações de
 * um ORM. Um EntityManager.transactional() do MikroORM encapsularia o mesmo
 * client/transação por baixo; a troca é mecânica, não estrutural — os
 * repositórios abaixo já seguem o contrato de portas (`ports.ts`) para que
 * essa troca seja possível sem tocar nos use cases.
 */

export class PostgresUnitOfWork implements UnitOfWork {
  constructor(private readonly pool: Pool) {}

  async run<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

function asClient(tx: unknown): PoolClient {
  return tx as PoolClient;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class UuidGenerator implements IdGenerator {
  next(): string {
    return randomUUID();
  }
}

export class PostgresWalletRepository implements WalletRepository {
  async findById(id: string, tx: unknown): Promise<Wallet | null> {
    const client = asClient(tx);
    const res = await client.query(
      `SELECT id, player_id, currency, balance_amount, version, created_at, updated_at
       FROM wallets WHERE id = $1`,
      [id],
    );
    if (res.rowCount === 0) return null;
    return this.toDomain(res.rows[0]);
  }

  async findByPlayerAndCurrency(playerId: string, currency: string, tx: unknown): Promise<Wallet | null> {
    const client = asClient(tx);
    const res = await client.query(
      `SELECT id, player_id, currency, balance_amount, version, created_at, updated_at
       FROM wallets WHERE player_id = $1 AND currency = $2`,
      [playerId, currency],
    );
    if (res.rowCount === 0) return null;
    return this.toDomain(res.rows[0]);
  }

  async insert(wallet: Wallet, tx: unknown): Promise<void> {
    const client = asClient(tx);
    await client.query(
      `INSERT INTO wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        wallet.id,
        wallet.playerId,
        wallet.currency,
        wallet.balance.toJSON().amount,
        wallet.version,
        wallet.createdAt,
        wallet.updatedAt,
      ],
    );
  }

  async updateWithOptimisticLock(
    wallet: Wallet,
    expectedVersion: number,
    tx: unknown,
  ): Promise<OptimisticUpdateResult> {
    const client = asClient(tx);
    const res = await client.query(
      `UPDATE wallets
       SET balance_amount = $1, version = $2, updated_at = $3
       WHERE id = $4 AND version = $5`,
      [wallet.balance.toJSON().amount, wallet.version, wallet.updatedAt, wallet.id, expectedVersion],
    );
    return { updated: (res.rowCount ?? 0) > 0 };
  }

  private toDomain(row: any): Wallet {
    return Wallet.rehydrate({
      id: row.id,
      playerId: row.player_id,
      currency: row.currency,
      balance: Money.from({ amount: row.balance_amount, currency: row.currency }),
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
}

export class PostgresWagerTransactionRepository implements WagerTransactionRepository {
  async findById(id: string, tx: unknown): Promise<WagerTransaction | null> {
    const client = asClient(tx);
    const res = await client.query(`SELECT * FROM wager_transactions WHERE id = $1`, [id]);
    if (res.rowCount === 0) return null;
    return this.toDomain(res.rows[0]);
  }

  async findByIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
    tx: unknown,
  ): Promise<WagerTransaction | null> {
    const client = asClient(tx);
    const res = await client.query(
      `SELECT * FROM wager_transactions WHERE provider_id = $1 AND idempotency_key = $2`,
      [providerId, idempotencyKey],
    );
    if (res.rowCount === 0) return null;
    return this.toDomain(res.rows[0]);
  }

  async findByExternalId(
    providerId: string,
    externalTransactionId: string,
    tx: unknown,
  ): Promise<WagerTransaction | null> {
    const client = asClient(tx);
    const res = await client.query(
      `SELECT * FROM wager_transactions WHERE provider_id = $1 AND external_transaction_id = $2`,
      [providerId, externalTransactionId],
    );
    if (res.rowCount === 0) return null;
    return this.toDomain(res.rows[0]);
  }

  async findPendingReferenceBatch(limit: number, tx: unknown): Promise<WagerTransaction[]> {
    const client = asClient(tx);
    const res = await client.query(
      `SELECT * FROM wager_transactions
       WHERE status = 'PENDING_REFERENCE'
       ORDER BY created_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    return res.rows.map((r) => this.toDomain(r));
  }

  async insert(t: WagerTransaction, tx: unknown): Promise<void> {
    const client = asClient(tx);
    const money = t.money.toJSON();
    await client.query(
      `INSERT INTO wager_transactions (
        id, provider_id, external_transaction_id, idempotency_key, payload_hash,
        wallet_id, player_id, round_id, game_id, kind,
        money_amount, money_currency, reference_external_transaction_id,
        reference_transaction_id, status, failure_code, created_at, processed_at,
        reference_check_attempts
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        t.id,
        t.providerId,
        t.externalTransactionId,
        t.idempotencyKey,
        t.payloadHash,
        t.walletId,
        t.playerId,
        t.roundId,
        t.gameId,
        t.kind,
        money.amount,
        money.currency,
        t.referenceExternalTransactionId ?? null,
        t.referenceTransactionId ?? null,
        t.status,
        t.failureCode ?? null,
        t.createdAt,
        t.processedAt ?? null,
        t.referenceCheckAttempts,
      ],
    );
  }

  async update(t: WagerTransaction, tx: unknown): Promise<void> {
    const client = asClient(tx);
    await client.query(
      `UPDATE wager_transactions
       SET status = $1, failure_code = $2, reference_transaction_id = $3, processed_at = $4,
           reference_check_attempts = $5
       WHERE id = $6`,
      [
        t.status,
        t.failureCode ?? null,
        t.referenceTransactionId ?? null,
        t.processedAt ?? null,
        t.referenceCheckAttempts,
        t.id,
      ],
    );
  }

  private toDomain(row: any): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: row.id,
      providerId: row.provider_id,
      externalTransactionId: row.external_transaction_id,
      idempotencyKey: row.idempotency_key,
      payloadHash: row.payload_hash,
      walletId: row.wallet_id,
      playerId: row.player_id,
      roundId: row.round_id,
      gameId: row.game_id,
      kind: row.kind as WagerTransactionKind,
      money: Money.from({ amount: row.money_amount, currency: row.money_currency }),
      referenceExternalTransactionId: row.reference_external_transaction_id ?? undefined,
      createdAt: row.created_at,
      status: row.status as WagerTransactionStatus,
      referenceTransactionId: row.reference_transaction_id ?? undefined,
      failureCode: (row.failure_code as FailureCode) ?? undefined,
      processedAt: row.processed_at ?? undefined,
      referenceCheckAttempts: row.reference_check_attempts ?? 0,
    });
  }
}

export class PostgresLedgerRepository implements LedgerRepository {
  async insert(entry: WalletLedgerEntry, tx: unknown): Promise<void> {
    const client = asClient(tx);
    await client.query(
      `INSERT INTO wallet_ledger_entries (
        id, wallet_id, transaction_id, direction, money_amount, money_currency,
        balance_before, balance_after, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        entry.id,
        entry.walletId,
        entry.transactionId,
        entry.direction,
        entry.money.toJSON().amount,
        entry.money.toJSON().currency,
        entry.balanceBefore.toJSON().amount,
        entry.balanceAfter.toJSON().amount,
        entry.createdAt,
      ],
    );
  }

  async listByWallet(
    walletId: string,
    cursor: string | undefined,
    limit: number,
    tx: unknown,
  ): Promise<WalletLedgerEntry[]> {
    const client = asClient(tx);
    // Cursor opaco: base64 de `${created_at.toISOString()}|${id}` para paginação estável.
    let cursorClause = '';
    const params: unknown[] = [walletId];
    if (cursor) {
      const decoded = Buffer.from(cursor, 'base64').toString('utf-8');
      const [ts, id] = decoded.split('|');
      cursorClause = `AND (created_at, id) > ($${params.length + 1}, $${params.length + 2})`;
      params.push(new Date(ts), id);
    }
    params.push(limit);
    const res = await client.query(
      `SELECT * FROM wallet_ledger_entries
       WHERE wallet_id = $1 ${cursorClause}
       ORDER BY created_at ASC, id ASC
       LIMIT $${params.length}`,
      params,
    );
    return res.rows.map((row) =>
      WalletLedgerEntry.rehydrate({
        id: row.id,
        walletId: row.wallet_id,
        transactionId: row.transaction_id,
        direction: row.direction as LedgerDirection,
        money: Money.from({ amount: row.money_amount, currency: row.money_currency }),
        balanceBefore: Money.from({ amount: row.balance_before, currency: row.money_currency }),
        balanceAfter: Money.from({ amount: row.balance_after, currency: row.money_currency }),
        createdAt: row.created_at,
      }),
    );
  }

  async sumByWallet(walletId: string, tx: unknown): Promise<{ balance: string; count: number }> {
    const client = asClient(tx);
    const res = await client.query(
      `SELECT
         COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN money_amount ELSE -money_amount END), 0) AS balance,
         COUNT(*) AS count
       FROM wallet_ledger_entries WHERE wallet_id = $1`,
      [walletId],
    );
    return { balance: res.rows[0].balance, count: Number(res.rows[0].count) };
  }
}

export class PostgresInboxRepository implements InboxRepository {
  async findByKey(consumerName: string, messageId: string, tx: unknown): Promise<InboxMessage | null> {
    const client = asClient(tx);
    const res = await client.query(
      `SELECT * FROM inbox_messages WHERE consumer_name = $1 AND message_id = $2`,
      [consumerName, messageId],
    );
    if (res.rowCount === 0) return null;
    const row = res.rows[0];
    return InboxMessage.rehydrate({
      messageId: row.message_id,
      consumerName: row.consumer_name,
      payloadHash: row.payload_hash,
      receivedAt: row.received_at,
      processedAt: row.processed_at ?? undefined,
    });
  }

  async insert(message: InboxMessage, tx: unknown): Promise<void> {
    const client = asClient(tx);
    // ON CONFLICT DO NOTHING: se duas instâncias tentarem inserir a mesma
    // (consumer_name, message_id) simultaneamente, a PK composta garante que
    // só uma vence — a outra deve reconsultar e tratar como já processada.
    await client.query(
      `INSERT INTO inbox_messages (message_id, consumer_name, payload_hash, received_at, processed_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (consumer_name, message_id) DO NOTHING`,
      [message.messageId, message.consumerName, message.payloadHash, message.receivedAt, message.processedAt ?? null],
    );
  }
}

export class PostgresOutboxRepository implements OutboxRepository {
  async insert(message: OutboxMessage, tx: unknown): Promise<void> {
    const client = asClient(tx);
    await client.query(
      `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        message.id,
        message.aggregateId,
        message.eventType,
        JSON.stringify(message.payload),
        message.occurredAt,
        message.attempts,
        message.nextAttemptAt ?? null,
        message.publishedAt ?? null,
      ],
    );
  }

  async lockDueBatch(limit: number, now: Date, tx: unknown): Promise<OutboxMessage[]> {
    const client = asClient(tx);
    const res = await client.query(
      `SELECT * FROM outbox_messages
       WHERE published_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
       ORDER BY occurred_at ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED`,
      [now, limit],
    );
    return res.rows.map((row) =>
      OutboxMessage.rehydrate({
        id: row.id,
        aggregateId: row.aggregate_id,
        eventType: row.event_type,
        payload: row.payload,
        occurredAt: row.occurred_at,
        attempts: row.attempts,
        nextAttemptAt: row.next_attempt_at ?? undefined,
        publishedAt: row.published_at ?? undefined,
      }),
    );
  }

  async update(message: OutboxMessage, tx: unknown): Promise<void> {
    const client = asClient(tx);
    await client.query(
      `UPDATE outbox_messages SET attempts = $1, next_attempt_at = $2, published_at = $3 WHERE id = $4`,
      [message.attempts, message.nextAttemptAt ?? null, message.publishedAt ?? null, message.id],
    );
  }
}
