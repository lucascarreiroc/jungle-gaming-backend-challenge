import { randomUUID } from 'crypto';
import type { MoneyProps } from './money';
import { LedgerDirection } from './wager-transaction';
import { FailureCode } from './errors';

export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = props.data;
  }

  toJSON(): {
    eventId: string;
    eventType: string;
    aggregateId: string;
    correlationId: string;
    causationId?: string;
    occurredAt: string;
    version: number;
    data: T;
  } {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      causationId: this.causationId,
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data,
    };
  }
}

export interface EventContext {
  correlationId: string;
  causationId?: string;
}

function newEventId(): string {
  return randomUUID();
}

export interface WagerTransactionProcessedData {
  transactionId: string;
  walletId: string;
  providerId: string;
  externalTransactionId: string;
  kind: string;
  money: MoneyProps;
  balanceAfter: MoneyProps;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(data: WagerTransactionProcessedData, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      eventId: newEventId(),
      aggregateId: data.transactionId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: new Date(),
      data,
    });
  }
}

export interface WagerTransactionRejectedData {
  transactionId: string;
  walletId: string;
  providerId: string;
  externalTransactionId: string;
  failureCode: FailureCode;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(data: WagerTransactionRejectedData, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected({
      eventId: newEventId(),
      aggregateId: data.transactionId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: new Date(),
      data,
    });
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(data: WalletBalanceChangedData, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({
      eventId: newEventId(),
      aggregateId: data.walletId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: new Date(),
      data,
    });
  }
}

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  walletId: string;
  providerId: string;
  externalTransactionId: string;
  referenceExternalTransactionId: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(
    data: WagerTransactionPendingReferenceData,
    ctx: EventContext,
  ): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
      eventId: newEventId(),
      aggregateId: data.transactionId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: new Date(),
      data,
    });
  }
}
