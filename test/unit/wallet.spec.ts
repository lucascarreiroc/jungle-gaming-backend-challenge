import { describe, expect, it } from 'bun:test';
import { randomUUID } from 'crypto';
import { Wallet } from '../../src/domain/wallet';
import { Money, CurrencyMismatchError } from '../../src/domain/money';
import { InsufficientBalanceError, ReversalWouldGoNegativeError } from '../../src/domain/errors';

function openWallet(initial = '100.00') {
  return Wallet.open({
    id: randomUUID(),
    playerId: randomUUID(),
    initialBalance: Money.from({ amount: initial, currency: 'BRL' }),
  });
}

describe('Wallet', () => {
  it('opens with the given initial balance and version 1', () => {
    const wallet = openWallet('100.00');
    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  it('debits successfully when balance is sufficient', () => {
    const wallet = openWallet('100.00');
    const result = wallet.debit(Money.from({ amount: '30.00', currency: 'BRL' }));
    expect(wallet.balance.toJSON().amount).toBe('70.00');
    expect(result.balanceBefore.toJSON().amount).toBe('100.00');
    expect(result.balanceAfter.toJSON().amount).toBe('70.00');
  });

  it('increments version only when balance changes', () => {
    const wallet = openWallet('100.00');
    expect(wallet.version).toBe(1);
    wallet.debit(Money.from({ amount: '10.00', currency: 'BRL' }));
    expect(wallet.version).toBe(2);
    wallet.credit(Money.from({ amount: '5.00', currency: 'BRL' }));
    expect(wallet.version).toBe(3);
  });

  it('rejects a debit that would make the balance negative', () => {
    const wallet = openWallet('50.00');
    expect(() => wallet.debit(Money.from({ amount: '50.01', currency: 'BRL' }))).toThrow(
      InsufficientBalanceError,
    );
    expect(wallet.balance.toJSON().amount).toBe('50.00');
    expect(wallet.version).toBe(1);
  });

  it('allows a debit that exactly zeroes the balance', () => {
    const wallet = openWallet('50.00');
    wallet.debit(Money.from({ amount: '50.00', currency: 'BRL' }));
    expect(wallet.balance.isZero()).toBe(true);
  });

  it('credits increase the balance', () => {
    const wallet = openWallet('10.00');
    wallet.credit(Money.from({ amount: '5.00', currency: 'BRL' }));
    expect(wallet.balance.toJSON().amount).toBe('15.00');
  });

  it('rejects operations in a different currency than the wallet', () => {
    const wallet = openWallet('10.00');
    expect(() => wallet.debit(Money.from({ amount: '5.00', currency: 'USD' }))).toThrow(
      CurrencyMismatchError,
    );
  });

  it('reverseCredit (undo of a WIN/REFUND) rejects if it would go negative', () => {
    const wallet = openWallet('10.00');
    expect(() =>
      wallet.reverseCredit(Money.from({ amount: '20.00', currency: 'BRL' })),
    ).toThrow(ReversalWouldGoNegativeError);
  });

  it('reverseDebit (undo of a BET) always increases the balance', () => {
    const wallet = openWallet('10.00');
    wallet.reverseDebit(Money.from({ amount: '5.00', currency: 'BRL' }));
    expect(wallet.balance.toJSON().amount).toBe('15.00');
  });

  it('the mandatory scenario: two concurrent 80.00 bets on a 100.00 balance', () => {
    const wallet = openWallet('100.00');
    const bet = Money.from({ amount: '80.00', currency: 'BRL' });

    wallet.debit(bet);
    expect(wallet.balance.toJSON().amount).toBe('20.00');

    expect(() => wallet.debit(bet)).toThrow(InsufficientBalanceError);
    expect(wallet.balance.toJSON().amount).toBe('20.00');
  });

  it('rehydrate reconstructs an equivalent wallet without revalidating transitions', () => {
    const original = openWallet('42.00');
    original.debit(Money.from({ amount: '2.00', currency: 'BRL' }));

    const rehydrated = Wallet.rehydrate({
      id: original.id,
      playerId: original.playerId,
      currency: original.currency,
      balance: original.balance,
      version: original.version,
      createdAt: original.createdAt,
      updatedAt: original.updatedAt,
    });

    expect(rehydrated.balance.equals(original.balance)).toBe(true);
    expect(rehydrated.version).toBe(original.version);
  });
});
