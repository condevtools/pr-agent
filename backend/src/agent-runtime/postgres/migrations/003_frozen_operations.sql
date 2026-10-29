ALTER TABLE pr_agent_harness.repository_operations
  ADD COLUMN authority_generation bigint CHECK (authority_generation >= 0),
  ADD COLUMN payload_json jsonb,
  ADD COLUMN evidence_json jsonb,
  ADD COLUMN command_receipt_json jsonb;

ALTER TABLE pr_agent_harness.repository_operations
  DROP CONSTRAINT repository_operations_outcome_code_check,
  ADD CONSTRAINT repository_operations_outcome_code_check CHECK (outcome_code IN (
    'current', 'stale', 'rejected', 'no_effect',
    'not_occurred_confirmed', 'publication_abandoned'
  ));

ALTER TABLE pr_agent_harness.repository_operations
  DROP CONSTRAINT repository_operations_resolution_shape,
  ADD CONSTRAINT repository_operations_resolution_shape CHECK (
    (status = 'succeeded' AND outcome_code IN ('current', 'stale') AND remote_id IS NOT NULL AND resolved_at IS NOT NULL)
    OR (status = 'failed_definite' AND outcome_code IN ('stale', 'rejected', 'no_effect', 'publication_abandoned') AND remote_id IS NULL AND resolved_at IS NOT NULL)
    OR (status = 'cancelled' AND resolved_at IS NOT NULL)
    OR (status IN ('prepared', 'in_flight', 'unknown', 'manual_review') AND resolved_at IS NULL)
  );

COMMENT ON COLUMN pr_agent_harness.repository_operations.payload_json IS
  'Canonical frozen dispatch payload. NULL only for operations created before migration 003.';
COMMENT ON COLUMN pr_agent_harness.repository_operations.authority_generation IS
  'Repository publication authority generation frozen into operation identity; NULL only for blocked generation-0 prototypes.';
COMMENT ON COLUMN pr_agent_harness.repository_operations.evidence_json IS
  'Structured reconciliation or rejection evidence; never used to regenerate a dispatch payload.';
COMMENT ON COLUMN pr_agent_harness.repository_operations.command_receipt_json IS
  'Structured provider command receipt retained independently from reconciliation evidence.';
