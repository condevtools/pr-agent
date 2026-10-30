UPDATE pr_agent_harness.integration_bindings
SET review_execution_mode = 'harness_async',
    execution_mode_generation = GREATEST(execution_mode_generation, 1),
    review_execution_state = 'active',
    updated_at = clock_timestamp()
WHERE review_execution_mode <> 'harness_async'
   OR execution_mode_generation < 1;

ALTER TABLE pr_agent_harness.integration_bindings
  ALTER COLUMN review_execution_mode SET DEFAULT 'harness_async',
  ALTER COLUMN execution_mode_generation SET DEFAULT 1,
  DROP CONSTRAINT integration_bindings_review_execution_mode_check,
  DROP CONSTRAINT integration_bindings_async_execution_shape,
  ADD CONSTRAINT integration_bindings_review_execution_mode_check
    CHECK (review_execution_mode = 'harness_async'),
  ADD CONSTRAINT integration_bindings_async_execution_shape CHECK (
    publication_state = 'blocked'
    OR (publication_state IN ('active','draining')
        AND publication_generation > 0
        AND execution_mode_generation > 0)
  );

DROP FUNCTION IF EXISTS pr_agent_harness.lock_active_legacy_review_execution_authority(
  uuid, uuid, bigint, bigint
);
DROP FUNCTION IF EXISTS pr_agent_harness.lock_resumable_legacy_review_execution_authority(
  uuid, uuid, bigint, bigint
);
