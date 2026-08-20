ALTER TABLE wager_transactions
    ADD COLUMN reference_check_attempts INTEGER NOT NULL DEFAULT 0;

