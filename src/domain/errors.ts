export enum FailureCode {
  VALIDATION_INVALID_MONEY = 'VALIDATION_INVALID_MONEY',
  VALIDATION_CURRENCY_MISMATCH = 'VALIDATION_CURRENCY_MISMATCH',
  VALIDATION_MISSING_REFERENCE = 'VALIDATION_MISSING_REFERENCE',

  BUSINESS_INSUFFICIENT_BALANCE = 'BUSINESS_INSUFFICIENT_BALANCE',
  BUSINESS_REVERSAL_WOULD_GO_NEGATIVE = 'BUSINESS_REVERSAL_WOULD_GO_NEGATIVE',
  BUSINESS_ALREADY_REVERSED = 'BUSINESS_ALREADY_REVERSED',
  BUSINESS_INVALID_TRANSITION = 'BUSINESS_INVALID_TRANSITION',

  CONFLICT_IDEMPOTENCY_PAYLOAD_MISMATCH = 'CONFLICT_IDEMPOTENCY_PAYLOAD_MISMATCH',
  CONFLICT_WALLET_ALREADY_EXISTS = 'CONFLICT_WALLET_ALREADY_EXISTS',
  CONFLICT_OPTIMISTIC_LOCK = 'CONFLICT_OPTIMISTIC_LOCK',

  REFERENCE_NOT_FOUND_TIMEOUT = 'REFERENCE_NOT_FOUND_TIMEOUT',
  REFERENCE_WRONG_KIND = 'REFERENCE_WRONG_KIND',
  REFERENCE_SCOPE_MISMATCH = 'REFERENCE_SCOPE_MISMATCH',

  INFRA_TRANSIENT_FAILURE = 'INFRA_TRANSIENT_FAILURE',
}

export class DomainError extends Error {
  constructor(
    message: string,
    public readonly code: FailureCode,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export class InvalidTransactionStateError extends DomainError {
  constructor(currentStatus: string, attemptedTransition: string) {
    super(
      `Cannot transition from terminal state ${currentStatus} to ${attemptedTransition}`,
      FailureCode.BUSINESS_INVALID_TRANSITION,
    );
  }
}

export class InsufficientBalanceError extends DomainError {
  constructor() {
    super('Wallet balance is insufficient for this operation', FailureCode.BUSINESS_INSUFFICIENT_BALANCE);
  }
}

export class ReversalWouldGoNegativeError extends DomainError {
  constructor() {
    super(
      'Reversal would cause wallet balance to go negative',
      FailureCode.BUSINESS_REVERSAL_WOULD_GO_NEGATIVE,
    );
  }
}
