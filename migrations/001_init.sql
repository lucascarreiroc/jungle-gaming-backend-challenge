-- ============================================================================
-- 001_init.sql — Distributed Wagering Processor
--
-- Decisões de design (ver ARCHITECTURE.md para o raciocínio completo):
--
-- 1) money_amount é NUMERIC(19,2), nunca FLOAT/DOUBLE — precisão exata.
-- 2) wallets.balance >= 0 é reforçado por CHECK constraint, não apenas
--    validado em código de aplicação — mesmo um bug no serviço não
--    consegue persistir saldo negativo.
-- 3) wallets.version é a base do optimistic locking: todo UPDATE de saldo
--    é feito com `WHERE id = ? AND version = ?`, e um UPDATE que afeta
--    0 linhas sinaliza conflito de concorrência para o use case retentar.
-- 4) A idempotência é garantida por UNIQUE(provider_id, idempotency_key)
--    em wager_transactions — não por cache em memória.
-- 5) wallet_ledger_entries não tem coluna de "updated_at" nem qualquer
--    mecanismo de UPDATE esperado — é append-only por design; a garantia
--    de imutabilidade real (revogar UPDATE/DELETE) fica documentada aqui
--    e pode ser reforçada com um trigger/REVOKE em ambientes de produção
--    reais (fora do escopo deste desafio, mas mencionado em ARCHITECTURE.md).
-- 6) inbox_messages usa PK composta (consumer_name, message_id) — dedup
--    persistente, não em memória.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ----------------------------------------------------------------------------
-- wallets
-- ----------------------------------------------------------------------------
CREATE TABLE wallets (
    id              UUID PRIMARY KEY,
    player_id       UUID NOT NULL,
    currency        CHAR(3) NOT NULL,
    balance_amount  NUMERIC(19, 2) NOT NULL,
    version         INTEGER NOT NULL DEFAULT 1,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_wallets_balance_non_negative CHECK (balance_amount >= 0),
    CONSTRAINT chk_wallets_version_positive CHECK (version >= 1),
    CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency)
);

CREATE INDEX idx_wallets_player_id ON wallets (player_id);

-- ----------------------------------------------------------------------------
-- wager_transactions
-- ----------------------------------------------------------------------------
CREATE TABLE wager_transactions (
    id                                  UUID PRIMARY KEY,
    provider_id                         TEXT NOT NULL,
    external_transaction_id             TEXT NOT NULL,
    idempotency_key                     TEXT NOT NULL,
    payload_hash                        TEXT NOT NULL,
    wallet_id                           UUID NOT NULL REFERENCES wallets (id),
    player_id                           UUID NOT NULL,
    round_id                            TEXT NOT NULL,
    game_id                             TEXT NOT NULL,
    kind                                TEXT NOT NULL CHECK (
        kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')
    ),
    money_amount                        NUMERIC(19, 2) NOT NULL CHECK (money_amount >= 0),
    money_currency                      CHAR(3) NOT NULL,
    reference_external_transaction_id   TEXT,
    reference_transaction_id            UUID REFERENCES wager_transactions (id),
    status                              TEXT NOT NULL CHECK (
        status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')
    ),
    failure_code                        TEXT,
    created_at                          TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at                        TIMESTAMPTZ,

    -- Fonte da verdade da idempotência: mesma provider_id + idempotency_key
    -- nunca cria uma segunda linha, independentemente de quantas vezes a
    -- mensagem/requisição chegar (at-least-once delivery).
    CONSTRAINT uq_wager_tx_idempotency UNIQUE (provider_id, idempotency_key),

    -- Um provider nunca pode reusar o mesmo external_transaction_id.
    CONSTRAINT uq_wager_tx_external UNIQUE (provider_id, external_transaction_id)
);

CREATE INDEX idx_wager_tx_wallet_id ON wager_transactions (wallet_id);
CREATE INDEX idx_wager_tx_status ON wager_transactions (status) WHERE status = 'PENDING_REFERENCE';
CREATE INDEX idx_wager_tx_reference_lookup
    ON wager_transactions (provider_id, reference_external_transaction_id)
    WHERE reference_external_transaction_id IS NOT NULL;

-- Uma referência não pode ser revertida duas vezes pelo mesmo tipo de operação:
-- no máximo um REFUND processado por transação referenciada, e no máximo um
-- ROLLBACK processado por transação referenciada.
CREATE UNIQUE INDEX uq_wager_tx_single_refund_per_reference
    ON wager_transactions (reference_transaction_id)
    WHERE kind = 'REFUND' AND status = 'PROCESSED';

CREATE UNIQUE INDEX uq_wager_tx_single_rollback_per_reference
    ON wager_transactions (reference_transaction_id)
    WHERE kind = 'ROLLBACK' AND status = 'PROCESSED';

-- ----------------------------------------------------------------------------
-- wallet_ledger_entries (append-only)
-- ----------------------------------------------------------------------------
CREATE TABLE wallet_ledger_entries (
    id               UUID PRIMARY KEY,
    wallet_id        UUID NOT NULL REFERENCES wallets (id),
    transaction_id   UUID NOT NULL REFERENCES wager_transactions (id),
    direction        TEXT NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
    money_amount     NUMERIC(19, 2) NOT NULL CHECK (money_amount >= 0),
    money_currency   CHAR(3) NOT NULL,
    balance_before   NUMERIC(19, 2) NOT NULL,
    balance_after    NUMERIC(19, 2) NOT NULL CHECK (balance_after >= 0),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Uma transação financeira produz no máximo um lançamento por wallet.
    CONSTRAINT uq_ledger_one_entry_per_transaction UNIQUE (transaction_id, wallet_id),

    -- balanceBefore ± money == balanceAfter (reforçado também em código,
    -- mas o schema garante consistência mesmo diante de bugs futuros).
    CONSTRAINT chk_ledger_balanced CHECK (
        (direction = 'CREDIT' AND balance_before + money_amount = balance_after)
        OR
        (direction = 'DEBIT' AND balance_before - money_amount = balance_after)
    )
);

CREATE INDEX idx_ledger_wallet_id_created_at ON wallet_ledger_entries (wallet_id, created_at, id);

-- Imutabilidade estrutural: revoga UPDATE/DELETE do papel de aplicação.
-- (Em ambiente real o app conectaria com um role dedicado sem esses privilégios;
-- aqui documentamos a intenção mesmo que o role de dev tenha superusuário.)
COMMENT ON TABLE wallet_ledger_entries IS
    'Append-only. UPDATE/DELETE must never be issued against this table.';

-- ----------------------------------------------------------------------------
-- inbox_messages — deduplicação persistente de mensagens SQS
-- ----------------------------------------------------------------------------
CREATE TABLE inbox_messages (
    message_id      TEXT NOT NULL,
    consumer_name   TEXT NOT NULL,
    payload_hash    TEXT NOT NULL,
    received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at    TIMESTAMPTZ,

    PRIMARY KEY (consumer_name, message_id)
);

-- ----------------------------------------------------------------------------
-- outbox_messages — publicação transacional de eventos
-- ----------------------------------------------------------------------------
CREATE TABLE outbox_messages (
    id                UUID PRIMARY KEY,
    aggregate_id      UUID NOT NULL,
    event_type        TEXT NOT NULL,
    payload           JSONB NOT NULL,
    occurred_at       TIMESTAMPTZ NOT NULL,
    attempts          INTEGER NOT NULL DEFAULT 0,
    next_attempt_at   TIMESTAMPTZ,
    published_at      TIMESTAMPTZ
);

-- Índice parcial: só mensagens pendentes interessam ao worker publisher.
-- SKIP LOCKED (usado na query do publisher) evita que múltiplos publishers
-- concorrentes peguem a mesma linha.
CREATE INDEX idx_outbox_pending
    ON outbox_messages (next_attempt_at NULLS FIRST)
    WHERE published_at IS NULL;

-- ----------------------------------------------------------------------------
-- DOWN (reversão)
-- ----------------------------------------------------------------------------
-- DROP TABLE IF EXISTS outbox_messages;
-- DROP TABLE IF EXISTS inbox_messages;
-- DROP TABLE IF EXISTS wallet_ledger_entries;
-- DROP TABLE IF EXISTS wager_transactions;
-- DROP TABLE IF EXISTS wallets;
