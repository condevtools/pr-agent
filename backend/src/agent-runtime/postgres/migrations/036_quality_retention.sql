-- Extend the existing restricted maintenance cycle with bounded retention for
-- Langfuse quality control-plane records. Preserve the original implementation
-- as an internal core so existing retention behavior and receipt semantics stay
-- unchanged while callers continue to use run_retention_maintenance.

ALTER FUNCTION pr_agent_harness.maintenance_run_has_legacy_strong_reference(uuid,uuid)
  RENAME TO maintenance_run_has_legacy_strong_reference_core;

CREATE FUNCTION pr_agent_harness.maintenance_run_has_legacy_strong_reference(
  requested_tenant_id uuid,requested_run_id uuid
) RETURNS boolean LANGUAGE sql STABLE
SET search_path=pg_catalog,pr_agent_harness AS $$
  SELECT pr_agent_harness.maintenance_run_has_legacy_strong_reference_core(
      requested_tenant_id,requested_run_id)
    OR EXISTS (
      SELECT 1 FROM pr_agent_harness.quality_trace_links trace
      WHERE trace.tenant_id=requested_tenant_id AND trace.run_id=requested_run_id)
$$;

ALTER FUNCTION pr_agent_harness.run_retention_maintenance(
  uuid,text,integer,integer,integer,integer
) RENAME TO run_retention_maintenance_core;

CREATE FUNCTION pr_agent_harness.quality_retention_candidate_counts(
  content_days integer,replay_days integer,trace_days integer,batch_limit integer
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,pr_agent_harness AS $$
DECLARE sync_jobs integer; prompts integer; annotations integer; traces integer;
BEGIN
  PERFORM pr_agent_harness.assert_maintenance_session();
  PERFORM pr_agent_harness.validate_maintenance_request(
    'preview',content_days,replay_days,trace_days,batch_limit);

  SELECT count(*) INTO sync_jobs FROM (
    SELECT 1 FROM pr_agent_harness.quality_sync_jobs job
    WHERE job.status IN ('succeeded','dead_letter')
      AND job.completed_at<clock_timestamp()-make_interval(days=>trace_days)
    ORDER BY job.completed_at,job.id LIMIT batch_limit
  ) bounded;
  SELECT count(*) INTO prompts FROM (
    SELECT 1 FROM pr_agent_harness.quality_prompt_versions prompt
    WHERE (prompt.status='candidate'
        AND prompt.updated_at<clock_timestamp()-make_interval(days=>content_days))
       OR (prompt.status='retired'
        AND prompt.retired_at<clock_timestamp()-make_interval(days=>content_days))
    ORDER BY coalesce(prompt.retired_at,prompt.updated_at),prompt.id LIMIT batch_limit
  ) bounded;
  SELECT count(*) INTO annotations FROM (
    SELECT 1 FROM pr_agent_harness.quality_annotation_imports annotation
    WHERE (annotation.state IN ('promoted','rejected')
        AND annotation.reviewed_at<clock_timestamp()-make_interval(days=>content_days))
       OR (annotation.state='pending_review'
        AND annotation.created_at<clock_timestamp()-make_interval(days=>replay_days))
    ORDER BY coalesce(annotation.reviewed_at,annotation.created_at),annotation.id LIMIT batch_limit
  ) bounded;
  SELECT count(*) INTO traces FROM (
    SELECT 1 FROM pr_agent_harness.quality_trace_links trace
    JOIN pr_agent_harness.agent_runs run
      ON run.tenant_id=trace.tenant_id AND run.integration_id=trace.integration_id
      AND run.id=trace.run_id
    WHERE trace.created_at<clock_timestamp()-make_interval(days=>trace_days)
      AND run.status IN ('succeeded','failed','cancelled')
      AND run.finished_at<clock_timestamp()-make_interval(days=>trace_days)
      AND NOT EXISTS (
        SELECT 1 FROM pr_agent_harness.quality_annotation_imports annotation
        WHERE annotation.tenant_id=trace.tenant_id
          AND annotation.integration_id=trace.integration_id
          AND annotation.trace_link_id=trace.id)
    ORDER BY trace.created_at,trace.id LIMIT batch_limit
  ) bounded;
  RETURN jsonb_build_object('qualitySyncJobs',sync_jobs,'qualityPrompts',prompts,
    'qualityAnnotations',annotations,'qualityTraceLinks',traces);
END $$;

CREATE FUNCTION pr_agent_harness.run_retention_maintenance(
  requested_cycle_id uuid,requested_action text,content_days integer,replay_days integer,
  trace_days integer,batch_limit integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pr_agent_harness AS $$
DECLARE computed_request_hash text; replayed record; result jsonb; quality_counts jsonb;
  sync_jobs_deleted integer:=0; prompts_deleted integer:=0;
  annotations_deleted integer:=0; traces_deleted integer:=0;
BEGIN
  PERFORM pr_agent_harness.assert_maintenance_session();
  IF requested_cycle_id IS NULL THEN RAISE EXCEPTION 'invalid maintenance cycle id'; END IF;
  PERFORM pr_agent_harness.validate_maintenance_request(
    requested_action,content_days,replay_days,trace_days,batch_limit);
  PERFORM pg_advisory_xact_lock(hashtextextended(requested_cycle_id::text,3012));
  computed_request_hash:=pr_agent_harness.maintenance_request_hash(
    requested_action,content_days,replay_days,trace_days,batch_limit);
  SELECT receipt.action,receipt.request_hash,receipt.result_json INTO replayed
  FROM pr_agent_harness.maintenance_receipts receipt
  WHERE receipt.cycle_id=requested_cycle_id;
  IF FOUND THEN
    IF replayed.action<>requested_action OR replayed.request_hash<>computed_request_hash THEN
      RAISE EXCEPTION 'maintenance cycle id was reused' USING ERRCODE='23505';
    END IF;
    RETURN replayed.result_json;
  END IF;

  quality_counts:=pr_agent_harness.quality_retention_candidate_counts(
    content_days,replay_days,trace_days,batch_limit);
  result:=pr_agent_harness.run_retention_maintenance_core(
    requested_cycle_id,requested_action,content_days,replay_days,trace_days,batch_limit);

  IF requested_action='apply' THEN
    WITH candidates AS (
      SELECT job.id FROM pr_agent_harness.quality_sync_jobs job
      WHERE job.status IN ('succeeded','dead_letter')
        AND job.completed_at<clock_timestamp()-make_interval(days=>trace_days)
      ORDER BY job.completed_at,job.id FOR UPDATE SKIP LOCKED LIMIT batch_limit
    ), removed AS (
      DELETE FROM pr_agent_harness.quality_sync_jobs job USING candidates candidate
      WHERE job.id=candidate.id RETURNING 1
    ) SELECT count(*) INTO sync_jobs_deleted FROM removed;

    WITH candidates AS (
      SELECT prompt.id FROM pr_agent_harness.quality_prompt_versions prompt
      WHERE (prompt.status='candidate'
          AND prompt.updated_at<clock_timestamp()-make_interval(days=>content_days))
         OR (prompt.status='retired'
          AND prompt.retired_at<clock_timestamp()-make_interval(days=>content_days))
      ORDER BY coalesce(prompt.retired_at,prompt.updated_at),prompt.id
      FOR UPDATE SKIP LOCKED LIMIT batch_limit
    ), removed AS (
      DELETE FROM pr_agent_harness.quality_prompt_versions prompt USING candidates candidate
      WHERE prompt.id=candidate.id RETURNING 1
    ) SELECT count(*) INTO prompts_deleted FROM removed;

    -- Trace rows are intentionally considered before annotation cleanup. A
    -- trace referenced at cycle start is retained until a later cycle, keeping
    -- preview and apply candidate counts identical and avoiding FK races.
    WITH candidates AS (
      SELECT trace.id FROM pr_agent_harness.quality_trace_links trace
      JOIN pr_agent_harness.agent_runs run
        ON run.tenant_id=trace.tenant_id AND run.integration_id=trace.integration_id
        AND run.id=trace.run_id
      WHERE trace.created_at<clock_timestamp()-make_interval(days=>trace_days)
        AND run.status IN ('succeeded','failed','cancelled')
        AND run.finished_at<clock_timestamp()-make_interval(days=>trace_days)
        AND NOT EXISTS (
          SELECT 1 FROM pr_agent_harness.quality_annotation_imports annotation
          WHERE annotation.tenant_id=trace.tenant_id
            AND annotation.integration_id=trace.integration_id
            AND annotation.trace_link_id=trace.id)
      ORDER BY trace.created_at,trace.id FOR UPDATE OF trace SKIP LOCKED LIMIT batch_limit
    ), removed AS (
      DELETE FROM pr_agent_harness.quality_trace_links trace USING candidates candidate
      WHERE trace.id=candidate.id RETURNING 1
    ) SELECT count(*) INTO traces_deleted FROM removed;

    WITH candidates AS (
      SELECT annotation.id FROM pr_agent_harness.quality_annotation_imports annotation
      WHERE (annotation.state IN ('promoted','rejected')
          AND annotation.reviewed_at<clock_timestamp()-make_interval(days=>content_days))
         OR (annotation.state='pending_review'
          AND annotation.created_at<clock_timestamp()-make_interval(days=>replay_days))
      ORDER BY coalesce(annotation.reviewed_at,annotation.created_at),annotation.id
      FOR UPDATE SKIP LOCKED LIMIT batch_limit
    ), removed AS (
      DELETE FROM pr_agent_harness.quality_annotation_imports annotation USING candidates candidate
      WHERE annotation.id=candidate.id RETURNING 1
    ) SELECT count(*) INTO annotations_deleted FROM removed;
  END IF;

  result:=jsonb_set(result,'{candidates}',
    coalesce(result->'candidates','{}'::jsonb)||quality_counts,true);
  result:=jsonb_set(result,'{applied}',coalesce(result->'applied','{}'::jsonb)||jsonb_build_object(
    'qualitySyncJobs',sync_jobs_deleted,'qualityPrompts',prompts_deleted,
    'qualityAnnotations',annotations_deleted,'qualityTraceLinks',traces_deleted),true);
  UPDATE pr_agent_harness.maintenance_receipts SET result_json=result
  WHERE cycle_id=requested_cycle_id;
  RETURN result;
END $$;

REVOKE ALL ON FUNCTION pr_agent_harness.run_retention_maintenance_core(
  uuid,text,integer,integer,integer,integer),
  pr_agent_harness.maintenance_run_has_legacy_strong_reference_core(uuid,uuid),
  pr_agent_harness.maintenance_run_has_legacy_strong_reference(uuid,uuid),
  pr_agent_harness.quality_retention_candidate_counts(integer,integer,integer,integer),
  pr_agent_harness.run_retention_maintenance(
    uuid,text,integer,integer,integer,integer) FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='pr_agent_maintenance') THEN
    REVOKE EXECUTE ON FUNCTION pr_agent_harness.run_retention_maintenance_core(
      uuid,text,integer,integer,integer,integer) FROM pr_agent_maintenance;
    GRANT EXECUTE ON FUNCTION pr_agent_harness.run_retention_maintenance(
      uuid,text,integer,integer,integer,integer) TO pr_agent_maintenance;
  END IF;
END $grants$;
