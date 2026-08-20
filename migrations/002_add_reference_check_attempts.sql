-- ============================================================================
-- 002_add_reference_check_attempts.sql
--
-- Suporte ao PendingReferenceWorker (seção 7.1 do desafio): persiste quantas
-- vezes já tentamos resolver a referência de uma transação REFUND/ROLLBACK
-- que chegou antes da transação original. Sem isso, o limite de tentativas
-- não sobrevive a um restart do worker/processo.
-- ============================================================================

ALTER TABLE wager_transactions
    ADD COLUMN reference_check_attempts INTEGER NOT NULL DEFAULT 0;

-- ----------------------------------------------------------------------------
-- DOWN (reversão)
-- ----------------------------------------------------------------------------
-- ALTER TABLE wager_transactions DROP COLUMN reference_check_attempts;
