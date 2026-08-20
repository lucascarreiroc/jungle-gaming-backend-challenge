import { Money } from './money';
import { CurrencyMismatchError } from './money';
import { InsufficientBalanceError, ReversalWouldGoNegativeError } from './errors';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
}

export interface BalanceMutationResult {
  balanceBefore: Money;
  balanceAfter: Money;
  newVersion: number;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): Wallet {
    const now = new Date();
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      now,
      now,
    );
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(money: Money, at: Date = new Date()): BalanceMutationResult {
    this.assertSameCurrency(money);
    if (this._balance.isLessThan(money)) {
      throw new InsufficientBalanceError();
    }
    const balanceBefore = this._balance;
    const balanceAfter = this._balance.subtract(money);
    this.applyNewBalance(balanceAfter, at);
    return { balanceBefore, balanceAfter, newVersion: this._version };
  }

  credit(money: Money, at: Date = new Date()): BalanceMutationResult {
    this.assertSameCurrency(money);
    const balanceBefore = this._balance;
    const balanceAfter = this._balance.add(money);
    this.applyNewBalance(balanceAfter, at);
    return { balanceBefore, balanceAfter, newVersion: this._version };
  }

  reverseCredit(money: Money, at: Date = new Date()): BalanceMutationResult {
    this.assertSameCurrency(money);
    if (this._balance.isLessThan(money)) {
      throw new ReversalWouldGoNegativeError();
    }
    const balanceBefore = this._balance;
    const balanceAfter = this._balance.subtract(money);
    this.applyNewBalance(balanceAfter, at);
    return { balanceBefore, balanceAfter, newVersion: this._version };
  }

  reverseDebit(money: Money, at: Date = new Date()): BalanceMutationResult {
    this.assertSameCurrency(money);
    const balanceBefore = this._balance;
    const balanceAfter = this._balance.add(money);
    this.applyNewBalance(balanceAfter, at);
    return { balanceBefore, balanceAfter, newVersion: this._version };
  }

  private applyNewBalance(newBalance: Money, at: Date): void {
    this._balance = newBalance;
    this._version += 1;
    this._updatedAt = at;
  }

  private assertSameCurrency(money: Money): void {
    if (this.currency !== money.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
