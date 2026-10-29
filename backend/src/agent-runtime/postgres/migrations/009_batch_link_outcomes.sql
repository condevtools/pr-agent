ALTER TABLE pr_agent_harness.publication_batch_operations
  ADD COLUMN action_state text NOT NULL DEFAULT 'active'
    CHECK (action_state IN ('active', 'skipped')),
  ADD COLUMN skipped_at timestamptz,
  ADD COLUMN skip_reason text,
  ADD CONSTRAINT publication_batch_operations_action_shape CHECK (
    (action_state = 'active' AND skipped_at IS NULL AND skip_reason IS NULL)
    OR
    (action_state = 'skipped' AND skipped_at IS NOT NULL
      AND skip_reason = 'batch_predecessor_failed')
  );

CREATE OR REPLACE FUNCTION pr_agent_harness.guard_sealed_batch_links()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pr_agent_harness
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (
      SELECT 1 FROM pr_agent_harness.publication_batches pb
      WHERE pb.tenant_id = NEW.tenant_id AND pb.id = NEW.batch_id
        AND pb.seal_state = 'sealed'
    ) THEN
      RAISE EXCEPTION 'sealed publication batch membership is immutable';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF EXISTS (
      SELECT 1 FROM pr_agent_harness.publication_batches pb
      WHERE pb.tenant_id = OLD.tenant_id AND pb.id = OLD.batch_id
        AND pb.seal_state = 'sealed'
    ) THEN
      RAISE EXCEPTION 'sealed publication batch membership is immutable';
    END IF;
    RETURN OLD;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pr_agent_harness.publication_batches pb
    WHERE (pb.tenant_id = OLD.tenant_id AND pb.id = OLD.batch_id
           OR pb.tenant_id = NEW.tenant_id AND pb.id = NEW.batch_id)
      AND pb.seal_state = 'sealed'
  ) THEN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.batch_id IS DISTINCT FROM OLD.batch_id
      OR NEW.ordinal IS DISTINCT FROM OLD.ordinal
      OR NEW.business_operation_id IS DISTINCT FROM OLD.business_operation_id THEN
      RAISE EXCEPTION 'sealed publication batch membership is immutable';
    END IF;
    IF NOT (
      OLD.action_state = 'active'
      AND NEW.action_state = 'skipped'
      AND NEW.skipped_at IS NOT NULL
      AND NEW.skip_reason = 'batch_predecessor_failed'
      AND EXISTS (
        SELECT 1
        FROM pr_agent_harness.publication_batch_operations predecessor
        JOIN pr_agent_harness.repository_operations ro
          ON ro.tenant_id = predecessor.tenant_id
         AND ro.business_operation_id = predecessor.business_operation_id
        WHERE predecessor.tenant_id = OLD.tenant_id
          AND predecessor.batch_id = OLD.batch_id
          AND predecessor.ordinal < OLD.ordinal
          AND (
            ro.status IN ('failed_definite', 'cancelled')
            OR (ro.status = 'succeeded' AND ro.outcome_code = 'stale')
          )
      )
    ) THEN
      RAISE EXCEPTION 'sealed publication batch link outcome transition is invalid';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION pr_agent_harness.skip_failed_batch_successors(
    requested_tenant_id uuid,
    requested_batch_id uuid
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pr_agent_harness
AS $$
DECLARE
  candidate record;
  skipped_ids text[] := ARRAY[]::text[];
  skipped_count integer := 0;
BEGIN
  IF requested_tenant_id IS DISTINCT FROM
     nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'publication batch tenant context mismatch';
  END IF;

  FOR candidate IN
    WITH first_failure AS (
      SELECT min(pbo.ordinal) AS ordinal
      FROM pr_agent_harness.publication_batch_operations pbo
      JOIN pr_agent_harness.repository_operations ro
        ON ro.tenant_id = pbo.tenant_id
       AND ro.business_operation_id = pbo.business_operation_id
      WHERE pbo.tenant_id = requested_tenant_id
        AND pbo.batch_id = requested_batch_id
        AND (
          ro.status IN ('failed_definite', 'cancelled')
          OR (ro.status = 'succeeded' AND ro.outcome_code = 'stale')
        )
    )
    SELECT ro.business_operation_id
    FROM pr_agent_harness.publication_batch_operations pbo
    JOIN pr_agent_harness.repository_operations ro
      ON ro.tenant_id = pbo.tenant_id
     AND ro.business_operation_id = pbo.business_operation_id,
         first_failure
    WHERE pbo.tenant_id = requested_tenant_id
      AND pbo.batch_id = requested_batch_id
      AND first_failure.ordinal IS NOT NULL
      AND pbo.ordinal > first_failure.ordinal
      AND pbo.action_state = 'active'
      AND ro.status = 'prepared'
    ORDER BY ro.business_operation_id
    FOR UPDATE OF ro
  LOOP
    skipped_ids := array_append(skipped_ids, candidate.business_operation_id);
  END LOOP;

  IF cardinality(skipped_ids) = 0 THEN
    RETURN 0;
  END IF;

  UPDATE pr_agent_harness.publication_batch_operations pbo
  SET action_state = 'skipped', skipped_at = now(),
      skip_reason = 'batch_predecessor_failed'
  WHERE pbo.tenant_id = requested_tenant_id
    AND pbo.batch_id = requested_batch_id
    AND pbo.business_operation_id = ANY(skipped_ids)
    AND pbo.action_state = 'active';
  GET DIAGNOSTICS skipped_count = ROW_COUNT;

  INSERT INTO pr_agent_harness.audit_logs (
    tenant_id, actor_type, actor_id, action, decision, reason_code,
    resource_type, resource_ref, details_json
  )
  SELECT requested_tenant_id, 'system', 'publication-batch-coordinator',
         'publication.batch_successor_skipped', 'allowed',
         'batch_predecessor_failed', 'repository_operation', operation_id,
         jsonb_build_object('batchId', requested_batch_id)
  FROM unnest(skipped_ids) AS operation_id;

  UPDATE pr_agent_harness.repository_operations ro
  SET status = 'cancelled', outcome_code = 'publication_abandoned',
      remote_id = NULL, last_error_code = 'batch_predecessor_failed',
      resolved_at = now(), version = version + 1, updated_at = now()
  WHERE ro.tenant_id = requested_tenant_id
    AND ro.business_operation_id = ANY(skipped_ids)
    AND ro.status = 'prepared'
    AND NOT EXISTS (
      SELECT 1
      FROM pr_agent_harness.publication_batch_operations actionable
      WHERE actionable.tenant_id = ro.tenant_id
        AND actionable.business_operation_id = ro.business_operation_id
        AND actionable.action_state = 'active'
    );

  RETURN skipped_count;
END;
$$;

REVOKE ALL ON FUNCTION pr_agent_harness.skip_failed_batch_successors(uuid, uuid)
  FROM PUBLIC;

COMMENT ON COLUMN pr_agent_harness.publication_batch_operations.action_state IS
  'Per-batch disposition. Skipping never rewrites a shared operation still actionable from another batch.';
