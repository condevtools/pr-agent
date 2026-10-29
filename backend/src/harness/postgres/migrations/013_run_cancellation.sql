ALTER TABLE pr_agent_harness.publication_batch_operations
  DROP CONSTRAINT publication_batch_operations_action_shape,
  ADD CONSTRAINT publication_batch_operations_action_shape CHECK (
    (action_state = 'active' AND skipped_at IS NULL AND skip_reason IS NULL)
    OR
    (action_state = 'skipped' AND skipped_at IS NOT NULL
      AND skip_reason IN ('batch_predecessor_failed','run_cancelled_before_dispatch'))
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
      AND (
        (NEW.skip_reason = 'batch_predecessor_failed' AND EXISTS (
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
        ))
        OR
        (NEW.skip_reason = 'run_cancelled_before_dispatch' AND EXISTS (
          SELECT 1
          FROM pr_agent_harness.run_publication_batches rpb
          JOIN pr_agent_harness.agent_runs r
            ON r.tenant_id=rpb.tenant_id AND r.id=rpb.run_id
          JOIN pr_agent_harness.repository_operations ro
            ON ro.tenant_id=OLD.tenant_id
           AND ro.business_operation_id=OLD.business_operation_id
          WHERE rpb.tenant_id=OLD.tenant_id AND rpb.batch_id=OLD.batch_id
            AND (r.status='cancelled' OR r.cancel_requested_at IS NOT NULL)
            AND ro.status='prepared' AND ro.attempt_count=0 AND ro.dispatched_at IS NULL
        ))
      )
    ) THEN
      RAISE EXCEPTION 'sealed publication batch link outcome transition is invalid';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION pr_agent_harness.skip_cancelled_run_publications(
    requested_tenant_id uuid,
    requested_run_id uuid
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pr_agent_harness
AS $$
DECLARE
  candidate record;
  operation_ids text[] := ARRAY[]::text[];
  skipped_count integer := 0;
  run_cancelled boolean;
BEGIN
  IF requested_tenant_id IS DISTINCT FROM
     nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'Run cancellation tenant context mismatch';
  END IF;

  SELECT (status='cancelled' OR cancel_requested_at IS NOT NULL)
  INTO run_cancelled
  FROM pr_agent_harness.agent_runs
  WHERE tenant_id=requested_tenant_id AND id=requested_run_id
  FOR UPDATE;
  IF NOT COALESCE(run_cancelled, false) THEN
    RAISE EXCEPTION 'Run cancellation fact is missing';
  END IF;

  FOR candidate IN
    SELECT DISTINCT pbo.business_operation_id
    FROM pr_agent_harness.run_publication_batches rpb
    JOIN pr_agent_harness.publication_batch_operations pbo
      ON pbo.tenant_id=rpb.tenant_id AND pbo.batch_id=rpb.batch_id
    JOIN pr_agent_harness.repository_operations ro
      ON ro.tenant_id=pbo.tenant_id
     AND ro.business_operation_id=pbo.business_operation_id
    WHERE rpb.tenant_id=requested_tenant_id AND rpb.run_id=requested_run_id
      AND pbo.action_state='active' AND ro.status='prepared'
      AND ro.attempt_count=0 AND ro.dispatched_at IS NULL
    ORDER BY pbo.business_operation_id
  LOOP
    PERFORM 1 FROM pr_agent_harness.repository_operations
    WHERE tenant_id=requested_tenant_id
      AND business_operation_id=candidate.business_operation_id
    FOR UPDATE;
    operation_ids := array_append(operation_ids, candidate.business_operation_id);
  END LOOP;

  IF cardinality(operation_ids)=0 THEN
    RETURN 0;
  END IF;

  UPDATE pr_agent_harness.publication_batch_operations pbo
  SET action_state='skipped',skipped_at=now(),
      skip_reason='run_cancelled_before_dispatch'
  FROM pr_agent_harness.run_publication_batches rpb,
       pr_agent_harness.repository_operations ro
  WHERE rpb.tenant_id=requested_tenant_id AND rpb.run_id=requested_run_id
    AND pbo.tenant_id=rpb.tenant_id AND pbo.batch_id=rpb.batch_id
    AND ro.tenant_id=pbo.tenant_id
    AND ro.business_operation_id=pbo.business_operation_id
    AND pbo.action_state='active' AND ro.status='prepared'
    AND ro.attempt_count=0 AND ro.dispatched_at IS NULL;
  GET DIAGNOSTICS skipped_count = ROW_COUNT;

  UPDATE pr_agent_harness.repository_operations ro
  SET status='cancelled',outcome_code='publication_abandoned',remote_id=NULL,
      last_error_code='run_cancelled_before_dispatch',resolved_at=now(),
      version=version+1,updated_at=now()
  WHERE ro.tenant_id=requested_tenant_id
    AND ro.business_operation_id=ANY(operation_ids)
    AND ro.status='prepared' AND ro.attempt_count=0 AND ro.dispatched_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM pr_agent_harness.publication_batch_operations actionable
      WHERE actionable.tenant_id=ro.tenant_id
        AND actionable.business_operation_id=ro.business_operation_id
        AND actionable.action_state='active'
    );

  INSERT INTO pr_agent_harness.audit_logs (
    tenant_id,run_id,actor_type,actor_id,action,decision,reason_code,
    resource_type,resource_ref,details_json
  )
  SELECT requested_tenant_id,requested_run_id,'system','run-control',
         'publication.run_membership_skipped','allowed',
         'run_cancelled_before_dispatch','repository_operation',operation_id,
         jsonb_build_object('runId',requested_run_id)
  FROM unnest(operation_ids) AS operation_id;

  RETURN skipped_count;
END;
$$;

REVOKE ALL ON FUNCTION pr_agent_harness.skip_cancelled_run_publications(uuid,uuid)
  FROM PUBLIC;
