/**
 * Tokens de DI do NestJS. Interfaces TypeScript não existem em tempo de
 * execução, então o Nest não consegue resolver `constructor(x: WalletRepository)`
 * automaticamente por reflexão — precisamos de tokens string/symbol explícitos
 * usados tanto no @Inject() do consumidor quanto no `provide` do módulo.
 */
export const TOKENS = {
  PG_POOL: 'PG_POOL',
  UNIT_OF_WORK: 'UNIT_OF_WORK',
  WALLET_REPOSITORY: 'WALLET_REPOSITORY',
  WAGER_TRANSACTION_REPOSITORY: 'WAGER_TRANSACTION_REPOSITORY',
  LEDGER_REPOSITORY: 'LEDGER_REPOSITORY',
  INBOX_REPOSITORY: 'INBOX_REPOSITORY',
  OUTBOX_REPOSITORY: 'OUTBOX_REPOSITORY',
  CLOCK: 'CLOCK',
  ID_GENERATOR: 'ID_GENERATOR',
} as const;
