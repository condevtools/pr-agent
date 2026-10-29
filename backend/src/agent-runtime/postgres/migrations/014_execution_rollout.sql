ALTER TABLE pr_agent_harness.integration_bindings
  ADD COLUMN review_execution_state text NOT NULL DEFAULT 'active'
    CHECK (review_execution_state IN ('active','draining')),
  ADD COLUMN execution_drain_receipt jsonb,
  ADD COLUMN execution_resume_receipt jsonb,
  ADD COLUMN execution_switch_receipt jsonb;

ALTER TABLE pr_agent_harness.publication_batches
  ADD COLUMN execution_mode_generation bigint NOT NULL DEFAULT 0
    CHECK (execution_mode_generation >= 0);

CREATE OR REPLACE FUNCTION pr_agent_harness.lock_active_review_execution_authority(
    requested_tenant_id uuid,
    requested_integration_id uuid,
    requested_publication_generation bigint,
    requested_execution_generation bigint
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pr_agent_harness
AS $$
DECLARE
  matched boolean;
BEGIN
  SELECT true INTO matched
  FROM pr_agent_harness.integration_bindings
  WHERE tenant_id = requested_tenant_id
    AND id = requested_integration_id
    AND active
    AND publication_state = 'active'
    AND publication_generation = requested_publication_generation
    AND review_execution_mode = 'harness_async'
    AND execution_mode_generation = requested_execution_generation
    AND review_execution_state = 'active'
  FOR SHARE;
  RETURN COALESCE(matched, false);
END;
$$;

CREATE OR REPLACE FUNCTION pr_agent_harness.lock_resumable_review_execution_authority(
    requested_tenant_id uuid,
    requested_integration_id uuid,
    requested_publication_generation bigint,
    requested_execution_generation bigint
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pr_agent_harness
AS $$
DECLARE
  matched boolean;
BEGIN
  SELECT true INTO matched
  FROM pr_agent_harness.integration_bindings
  WHERE tenant_id = requested_tenant_id
    AND id = requested_integration_id
    AND active
    AND publication_state IN ('active','draining')
    AND publication_generation = requested_publication_generation
    AND review_execution_mode = 'harness_async'
    AND execution_mode_generation = requested_execution_generation
    AND review_execution_state IN ('active','draining')
  FOR SHARE;
  RETURN COALESCE(matched, false);
END;
$$;

CREATE FUNCTION pr_agent_harness.lock_active_legacy_review_execution_authority(
    requested_tenant_id uuid,
    requested_integration_id uuid,
    requested_publication_generation bigint,
    requested_execution_generation bigint
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pr_agent_harness
AS $$
DECLARE
  matched boolean;
BEGIN
  SELECT true INTO matched
  FROM pr_agent_harness.integration_bindings
  WHERE tenant_id = requested_tenant_id
    AND id = requested_integration_id
    AND active
    AND publication_state = 'active'
    AND publication_generation = requested_publication_generation
    AND review_execution_mode = 'legacy_sync'
    AND execution_mode_generation = requested_execution_generation
    AND review_execution_state = 'active'
  FOR SHARE;
  RETURN COALESCE(matched, false);
END;
$$;

REVOKE ALL ON FUNCTION pr_agent_harness.lock_active_legacy_review_execution_authority(
  uuid, uuid, bigint, bigint
) FROM PUBLIC;

CREATE FUNCTION pr_agent_harness.lock_resumable_legacy_review_execution_authority(
    requested_tenant_id uuid,
    requested_integration_id uuid,
    requested_publication_generation bigint,
    requested_execution_generation bigint
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pr_agent_harness
AS $$
DECLARE
  matched boolean;
BEGIN
  SELECT true INTO matched
  FROM pr_agent_harness.integration_bindings
  WHERE tenant_id = requested_tenant_id
    AND id = requested_integration_id
    AND active
    AND publication_state IN ('active','draining')
    AND publication_generation = requested_publication_generation
    AND review_execution_mode = 'legacy_sync'
    AND execution_mode_generation = requested_execution_generation
    AND review_execution_state IN ('active','draining')
  FOR SHARE;
  RETURN COALESCE(matched, false);
END;
$$;

REVOKE ALL ON FUNCTION pr_agent_harness.lock_resumable_legacy_review_execution_authority(
  uuid, uuid, bigint, bigint
) FROM PUBLIC;

COMMENT ON COLUMN pr_agent_harness.integration_bindings.review_execution_state IS
  'Admission state for review execution. Draining blocks new work while existing Runs may finish.';
COMMENT ON COLUMN pr_agent_harness.integration_bindings.execution_drain_receipt IS
  'Administrative evidence for the most recent execution drain.';
COMMENT ON COLUMN pr_agent_harness.integration_bindings.execution_resume_receipt IS
  'Administrative evidence for aborting an execution drain without changing mode generation.';
COMMENT ON COLUMN pr_agent_harness.integration_bindings.execution_switch_receipt IS
  'Administrative evidence for the most recent execution mode switch.';
