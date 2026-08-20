import { Wallet } from '../domain/wallet';
import { WagerTransaction } from '../domain/wager-transaction';
import { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { InboxMessage, OutboxMessage } from '../domain/inbox-outbox';

export interface OptimisticUpdateResult {
  updated: boolean;
}

export interface WalletRepository {
  findById(id: string, tx: unknown): Promise<Wallet | null>;
  findByPlayerAndCurrency(playerId: string, currency: string, tx: unknown): Promise<Wallet | null>;
  insert(wallet: Wallet, tx: unknown): Promise<void>;
  updateWithOptimisticLock(
    wallet: Wallet,
    expectedVersion: number,
    tx: unknown,
  ): Promise<OptimisticUpdateResult>;
}

export interface WagerTransactionRepository {
  findById(id: string, tx: unknown): Promise<WagerTransaction | null>;
  findByIdempotencyKey(providerId: string, idempotencyKey: string, tx: unknown): Promise<WagerTransaction | null>;
  findByExternalId(providerId: string, externalTransactionId: string, tx: unknown): Promise<WagerTransaction | null>;
  findPendingReferenceBatch(limit: number, tx: unknown): Promise<WagerTransaction[]>;
  insert(transaction: WagerTransaction, tx: unknown): Promise<void>;
  update(transaction: WagerTransaction, tx: unknown): Promise<void>;
}

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry, tx: unknown): Promise<void>;
  listByWallet(walletId: string, cursor: string | undefined, limit: number, tx: unknown): Promise<WalletLedgerEntry[]>;
  sumByWallet(walletId: string, tx: unknown): Promise<{ balance: string; count: number }>;
}

export interface InboxRepository {
  findByKey(consumerName: string, messageId: string, tx: unknown): Promise<InboxMessage | null>;
  insert(message: InboxMessage, tx: unknown): Promise<void>;
}

export interface OutboxRepository {
  insert(message: OutboxMessage, tx: unknown): Promise<void>;
  lockDueBatch(limit: number, now: Date, tx: unknown): Promise<OutboxMessage[]>;
  update(message: OutboxMessage, tx: unknown): Promise<void>;
}

export interface UnitOfWork {
  run<T>(fn: (tx: unknown) => Promise<T>): Promise<T>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}

export interface EventPublisher {
  publish(destination: string, message: Record<string, unknown>): Promise<void>;
}
