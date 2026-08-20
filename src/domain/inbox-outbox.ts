import { IntegrationEvent } from './events';

export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt?: Date;
}

export interface InboxMessageState {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date;
}

/**
 * InboxMessage garante deduplicação persistente por (consumerName, messageId).
 * Unicidade é reforçada por constraint composta no schema (ver migrations).
 */
export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    return new InboxMessage(
      props.messageId,
      props.consumerName,
      props.payloadHash,
      props.receivedAt ?? new Date(),
    );
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      state.receivedAt,
      state.processedAt,
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    this._processedAt = at;
  }
}

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

/** Backoff exponencial com jitter, cap em 5 minutos. Ver ARCHITECTURE.md. */
function computeBackoff(attempts: number): number {
  const baseMs = 1000;
  const capMs = 5 * 60 * 1000;
  const exp = Math.min(capMs, baseMs * 2 ** attempts);
  const jitter = Math.random() * exp * 0.2;
  return Math.floor(exp + jitter);
}

/**
 * OutboxMessage participa da mesma transação SQL que a mutação financeira
 * (ver seção 11 do desafio). Um worker separado publica mensagens pendentes
 * e marca publishedAt somente após confirmação do broker — publicações
 * duplicadas são seguras porque os consumidores fazem dedup via Inbox.
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const envelope = event.toJSON();
    return new OutboxMessage(
      envelope.eventId,
      envelope.aggregateId,
      envelope.eventType,
      envelope as unknown as Record<string, unknown>,
      event.occurredAt,
      0,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    if (!this.isPending()) return false;
    if (!this._nextAttemptAt) return true;
    return this._nextAttemptAt.getTime() <= now.getTime();
  }

  markPublished(at: Date): void {
    this._publishedAt = at;
  }

  /** Incrementa attempts e calcula o próximo nextAttemptAt (backoff exponencial + jitter). */
  scheduleRetry(now: Date): void {
    this._attempts += 1;
    this._nextAttemptAt = new Date(now.getTime() + computeBackoff(this._attempts));
  }
}
