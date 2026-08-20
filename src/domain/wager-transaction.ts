import { Money } from './money';
import { FailureCode, InvalidTransactionStateError } from './errors';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

const TERMINAL_STATUSES = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt?: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  referenceCheckAttempts?: number;
}

const KINDS_REQUIRING_REFERENCE = new Set([WagerTransactionKind.Refund, WagerTransactionKind.Rollback]);

const KINDS_NOT_AFFECTING_BALANCE = new Set([WagerTransactionKind.Loss]);

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _referenceCheckAttempts: number = 0,
  ) {}

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new Error('OPENING transactions cannot be created through the public factory');
    }
    if (KINDS_REQUIRING_REFERENCE.has(props.kind) && !props.referenceExternalTransactionId) {
      throw new Error(`${props.kind} requires a referenceExternalTransactionId`);
    }
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt ?? new Date(),
      WagerTransactionStatus.Pending,
    );
  }

  static createOpening(props: {
    id: string;
    walletId: string;
    playerId: string;
    money: Money;
    createdAt?: Date;
  }): WagerTransaction {
    return new WagerTransaction(
      props.id,
      'internal',
      props.id,
      `internal:opening:${props.walletId}`,
      'internal',
      props.walletId,
      props.playerId,
      'internal',
      'internal',
      WagerTransactionKind.Opening,
      props.money,
      undefined,
      props.createdAt ?? new Date(),
      WagerTransactionStatus.Pending,
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.referenceCheckAttempts ?? 0,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get referenceCheckAttempts(): number {
    return this._referenceCheckAttempts;
  }

  incrementReferenceCheckAttempts(): void {
    this._referenceCheckAttempts += 1;
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertNotTerminal(WagerTransactionStatus.Processed);
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
  }

  markPendingReference(): void {
    this.assertNotTerminal(WagerTransactionStatus.PendingReference);
    this._status = WagerTransactionStatus.PendingReference;
  }

  reject(code: FailureCode): void {
    this.assertNotTerminal(WagerTransactionStatus.Rejected);
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
  }

  fail(code: FailureCode): void {
    this.assertNotTerminal(WagerTransactionStatus.Failed);
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
  }

  private assertNotTerminal(attempted: WagerTransactionStatus): void {
    if (TERMINAL_STATUSES.has(this._status)) {
      throw new InvalidTransactionStateError(this._status, attempted);
    }
  }

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  affectsBalance(): boolean {
    return !KINDS_NOT_AFFECTING_BALANCE.has(this.kind);
  }

  requiresReference(): boolean {
    return KINDS_REQUIRING_REFERENCE.has(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new Error('ROLLBACK requires the referenced transaction to determine direction');
        }
        const referenceDirection = reference.ledgerDirectionFor();
        return referenceDirection === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
      default:
        throw new Error(`${this.kind} does not produce a ledger entry`);
    }
  }
}
