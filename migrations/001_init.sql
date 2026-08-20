CREATE EXTENSION IF NOT EXISTS "pgcrypto";

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

    CONSTRAINT uq_wager_tx_idempotency UNIQUE (provider_id, idempotency_key),

    CONSTRAINT uq_wager_tx_external UNIQUE (provider_id, external_transaction_id)
);

CREATE INDEX idx_wager_tx_wallet_id ON wager_transactions (wallet_id);
CREATE INDEX idx_wager_tx_status ON wager_transactions (status) WHERE status = 'PENDING_REFERENCE';
CREATE INDEX idx_wager_tx_reference_lookup
    ON wager_transactions (provider_id, reference_external_transaction_id)
    WHERE reference_external_transaction_id IS NOT NULL;

CREATE UNIQUE INDEX uq_wager_tx_single_refund_per_reference
    ON wager_transactions (reference_transaction_id)
    WHERE kind = 'REFUND' AND status = 'PROCESSED';

CREATE UNIQUE INDEX uq_wager_tx_single_rollback_per_reference
    ON wager_transactions (reference_transaction_id)
    WHERE kind = 'ROLLBACK' AND status = 'PROCESSED';

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

    CONSTRAINT uq_ledger_one_entry_per_transaction UNIQUE (transaction_id, wallet_id),

    CONSTRAINT chk_ledger_balanced CHECK (
        (direction = 'CREDIT' AND balance_before + money_amount = balance_after)
        OR
        (direction = 'DEBIT' AND balance_before - money_amount = balance_after)
    )
);

CREATE INDEX idx_ledger_wallet_id_created_at ON wallet_ledger_entries (wallet_id, created_at, id);

COMMENT ON TABLE wallet_ledger_entries IS
    'Append-only. UPDATE/DELETE must never be issued against this table.';

CREATE TABLE inbox_messages (
    message_id      TEXT NOT NULL,
    consumer_name   TEXT NOT NULL,
    payload_hash    TEXT NOT NULL,
    received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at    TIMESTAMPTZ,

    PRIMARY KEY (consumer_name, message_id)
);

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

CREATE INDEX idx_outbox_pending
    ON outbox_messages (next_attempt_at NULLS FIRST)
    WHERE published_at IS NULL;

