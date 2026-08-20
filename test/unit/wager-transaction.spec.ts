import { describe, expect, it } from 'bun:test';
import { randomUUID } from 'crypto';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  LedgerDirection,
} from '../../src/domain/wager-transaction';
import { Money } from '../../src/domain/money';
import { FailureCode, InvalidTransactionStateError } from '../../src/domain/errors';

function createBet(overrides: Partial<Parameters<typeof WagerTransaction.create>[0]> = {}) {
  return WagerTransaction.create({
    id: randomUUID(),
    providerId: 'provider-a',
    externalTransactionId: 'tx-1',
    idempotencyKey: 'provider-a:tx-1',
    payloadHash: 'hash-1',
    walletId: randomUUID(),
    playerId: randomUUID(),
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount: '25.00', currency: 'BRL' }),
    ...overrides,
  });
}

describe('WagerTransaction', () => {
  it('is created in PENDING status', () => {
    const tx = createBet();
    expect(tx.status).toBe(WagerTransactionStatus.Pending);
    expect(tx.isTerminal()).toBe(false);
  });

  it('REFUND requires a referenceExternalTransactionId', () => {
    expect(() =>
      createBet({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: undefined }),
    ).toThrow();
  });

  it('ROLLBACK requires a referenceExternalTransactionId', () => {
    expect(() =>
      createBet({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: undefined }),
    ).toThrow();
  });

  it('BET does not require a reference', () => {
    expect(() => createBet()).not.toThrow();
  });

  it('markProcessed transitions to a terminal state', () => {
    const tx = createBet();
    tx.markProcessed(undefined, new Date());
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.isTerminal()).toBe(true);
    expect(tx.processedAt).toBeDefined();
  });

  it('reject transitions to a terminal state with a failure code', () => {
    const tx = createBet();
    tx.reject(FailureCode.BUSINESS_INSUFFICIENT_BALANCE);
    expect(tx.status).toBe(WagerTransactionStatus.Rejected);
    expect(tx.failureCode).toBe(FailureCode.BUSINESS_INSUFFICIENT_BALANCE);
  });

  it('throws when attempting to transition a terminal transaction again', () => {
    const tx = createBet();
    tx.markProcessed(undefined, new Date());
    expect(() => tx.reject(FailureCode.BUSINESS_INSUFFICIENT_BALANCE)).toThrow(
      InvalidTransactionStateError,
    );
    expect(() => tx.markProcessed(undefined, new Date())).toThrow(InvalidTransactionStateError);
    expect(() => tx.markPendingReference()).toThrow(InvalidTransactionStateError);
  });

  it('PENDING_REFERENCE is not terminal and allows a later transition', () => {
    const tx = createBet({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'tx-0',
    });
    tx.markPendingReference();
    expect(tx.isTerminal()).toBe(false);
    tx.markProcessed('some-ref-id', new Date());
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
  });

  it('LOSS does not affect balance; BET does', () => {
    const bet = createBet({ kind: WagerTransactionKind.Bet });
    const loss = createBet({ kind: WagerTransactionKind.Loss });
    expect(bet.affectsBalance()).toBe(true);
    expect(loss.affectsBalance()).toBe(false);
  });

  it('matchesPayload compares the stored payload hash', () => {
    const tx = createBet({ payloadHash: 'abc123' });
    expect(tx.matchesPayload('abc123')).toBe(true);
    expect(tx.matchesPayload('different')).toBe(false);
  });

  it('ledgerDirectionFor: BET is DEBIT, WIN/REFUND are CREDIT', () => {
    const bet = createBet({ kind: WagerTransactionKind.Bet });
    const win = createBet({ kind: WagerTransactionKind.Win });
    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  it('ledgerDirectionFor: ROLLBACK inverts the direction of its reference', () => {
    const bet = createBet({ kind: WagerTransactionKind.Bet });
    const rollbackOfBet = createBet({
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'tx-1',
    });
    expect(rollbackOfBet.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
  });
});
