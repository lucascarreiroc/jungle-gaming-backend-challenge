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

/**
 * Resultado de uma aplicação de débito/crédito na Wallet.
 * Carrega os dois "antes/depois" necessários para montar o WalletLedgerEntry
 * sem que o agregado dependa da classe de ledger diretamente (mantém o
 * domínio desacoplado — quem monta o ledger é o use case / application layer).
 */
export interface BalanceMutationResult {
  balanceBefore: Money;
  balanceAfter: Money;
  newVersion: number;
}

/**
 * Wallet é o Aggregate Root e a unidade de concorrência do sistema.
 *
 * Invariantes garantidas aqui (e reforçadas por constraints no schema, ver
 * migrations/001_init.sql):
 * - saldo nunca negativo;
 * - moeda da operação == moeda da wallet;
 * - version incrementa somente quando o saldo muda (usado tanto para
 *   optimistic locking quanto como contador de auditoria).
 *
 * A concorrência entre múltiplas instâncias é resolvida em duas camadas:
 * 1) Optimistic locking via coluna `version` (WHERE id = ? AND version = ?);
 * 2) Retry limitado no use case quando o UPDATE afeta 0 linhas (ver
 *    SubmitWagerTransactionUseCase). Isso evita lock global compartilhado
 *    entre wallets distintas — cada wallet é serializada apenas contra si mesma.
 */
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

  /** Reconstrução a partir da persistência — não revalida transições. */
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

  /**
   * Debita o valor informado. Lança InsufficientBalanceError se o saldo
   * resultante fosse negativo — a chamada não muta estado em caso de erro.
   */
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

  /**
   * Credita o valor informado.
   */
  credit(money: Money, at: Date = new Date()): BalanceMutationResult {
    this.assertSameCurrency(money);
    const balanceBefore = this._balance;
    const balanceAfter = this._balance.add(money);
    this.applyNewBalance(balanceAfter, at);
    return { balanceBefore, balanceAfter, newVersion: this._version };
  }

  /**
   * Usado por ROLLBACK, que pode inverter tanto um débito quanto um crédito.
   * `direction` indica o sinal do efeito original a ser revertido.
   * Lança ReversalWouldGoNegativeError com failureCode distinto de uma BET
   * comum sem saldo (ver seção 7 do desafio).
   */
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
