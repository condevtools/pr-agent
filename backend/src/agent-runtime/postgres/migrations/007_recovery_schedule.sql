ALTER TABLE pr_agent_harness.repository_operations
  ADD COLUMN next_reconcile_at timestamptz,
  ADD COLUMN reconcile_attempt_count integer NOT NULL DEFAULT 0
    CHECK (reconcile_attempt_count >= 0),
  ADD COLUMN reconcile_claim_owner text,
  ADD COLUMN reconcile_claim_version bigint NOT NULL DEFAULT 0
    CHECK (reconcile_claim_version >= 0),
  ADD COLUMN reconcile_claim_expires_at timestamptz,
  ADD CONSTRAINT repository_operations_reconcile_claim_shape CHECK (
    (reconcile_claim_owner IS NULL AND reconcile_claim_expires_at IS NULL)
    OR (length(reconcile_claim_owner) > 0 AND reconcile_claim_expires_at IS NOT NULL)
  );

CREATE INDEX repository_operations_recovery_due
  ON pr_agent_harness.repository_operations
    (tenant_id, integration_id, next_reconcile_at, updated_at, business_operation_id)
  WHERE status IN ('in_flight', 'unknown');

CREATE FUNCTION pr_agent_harness.reset_publication_recovery_on_retry()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pr_agent_harness
AS $$
BEGIN
  IF OLD.status IN ('unknown', 'manual_review') AND NEW.status = 'prepared' THEN
    NEW.next_reconcile_at := NULL;
    NEW.reconcile_attempt_count := 0;
    NEW.reconcile_claim_owner := NULL;
    NEW.reconcile_claim_expires_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER repository_operations_reset_recovery_on_retry
BEFORE UPDATE OF status ON pr_agent_harness.repository_operations
FOR EACH ROW
EXECUTE FUNCTION pr_agent_harness.reset_publication_recovery_on_retry();

COMMENT ON COLUMN pr_agent_harness.repository_operations.next_reconcile_at IS
  'Earliest independent reconciliation scan time; NULL means immediately due.';
COMMENT ON COLUMN pr_agent_harness.repository_operations.reconcile_claim_expires_at IS
  'Short worker claim expiry. Expiry permits another lookup, never another dispatch.';
