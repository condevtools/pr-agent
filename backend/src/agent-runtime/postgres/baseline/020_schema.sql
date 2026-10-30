-- Consolidated schema after migrations 001–020; generated from PostgreSQL 17.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
SET LOCAL check_function_bodies = false;





CREATE FUNCTION pr_agent_harness.claim_verification_job(requested_owner text, requested_lease_seconds integer) RETURNS TABLE(id uuid, tenant_id uuid, integration_id uuid, run_id uuid, proposal_id text, proposal_hash text, source_bundle_ref text, source_bundle_hash text, policy_hash text, verification_input_hash text, trusted_command_hash text, dependency_lock_hash text, dependency_lock_path text, sandbox_policy_hash text, image_digest text, claimed_run_epoch bigint, lease_epoch bigint, lease_expires_at timestamp with time zone, attempt_count integer, deadline_at timestamp with time zone, proposal_json jsonb)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pr_agent_harness'
    AS $$
BEGIN
  IF length(requested_owner) NOT BETWEEN 1 AND 200 OR requested_lease_seconds NOT BETWEEN 5 AND 300 THEN
    RAISE EXCEPTION 'invalid verifier lease request';
  END IF;
  WITH terminal AS (
    SELECT q.id FROM pr_agent_harness.verification_jobs q
    WHERE q.status IN ('queued','leased')
      AND (q.status='queued' OR q.lease_expires_at<=clock_timestamp())
      AND (q.deadline_at<=clock_timestamp() OR q.attempt_count>=q.max_attempts)
    ORDER BY LEAST(q.deadline_at,COALESCE(q.lease_expires_at,q.available_at)),q.tenant_id,q.id
    FOR UPDATE OF q SKIP LOCKED LIMIT 100
  )
  UPDATE pr_agent_harness.verification_jobs j
  SET status='failed',error_code=CASE WHEN j.deadline_at<=clock_timestamp() THEN 'verification_deadline_expired'
      ELSE 'verification_attempts_exhausted' END,
      lease_owner=NULL,lease_expires_at=NULL,completed_at=clock_timestamp(),updated_at=clock_timestamp()
  FROM terminal t WHERE j.id=t.id;
  RETURN QUERY
  WITH candidate AS (
    SELECT j.id FROM pr_agent_harness.verification_jobs j
    JOIN pr_agent_harness.agent_runs r ON r.tenant_id=j.tenant_id AND r.id=j.run_id
    JOIN pr_agent_harness.fix_proposals p
      ON p.tenant_id=j.tenant_id AND p.run_id=j.run_id AND p.id=j.proposal_id
    WHERE (j.status='queued' OR (j.status='leased' AND j.lease_expires_at<=clock_timestamp()))
      AND j.available_at<=clock_timestamp() AND j.deadline_at>clock_timestamp()
      AND j.attempt_count<j.max_attempts AND r.status NOT IN ('failed','cancelled')
      AND p.content_purged_at IS NULL AND p.proposal_hash=j.proposal_hash
      AND p.proposal_json->>'proposalHash'=j.proposal_hash
    ORDER BY j.available_at,j.tenant_id,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1
  ), claimed AS (
    UPDATE pr_agent_harness.verification_jobs j
    SET status='leased',lease_owner=requested_owner,lease_epoch=j.lease_epoch+1,
        lease_expires_at=clock_timestamp()+make_interval(secs=>requested_lease_seconds),
        heartbeat_at=clock_timestamp(),attempt_count=j.attempt_count+1,updated_at=clock_timestamp()
    FROM candidate c WHERE j.id=c.id
    RETURNING j.*
  )
  SELECT c.id,c.tenant_id,c.integration_id,c.run_id,c.proposal_id,c.proposal_hash,
    c.source_bundle_ref,c.source_bundle_hash,c.policy_hash,c.verification_input_hash,
    c.trusted_command_hash,c.dependency_lock_hash,c.dependency_lock_path,c.sandbox_policy_hash,c.image_digest,
    c.claimed_run_epoch,c.lease_epoch,c.lease_expires_at,c.attempt_count,c.deadline_at,p.proposal_json
  FROM claimed c JOIN pr_agent_harness.fix_proposals p
    ON p.tenant_id=c.tenant_id AND p.run_id=c.run_id AND p.id=c.proposal_id;
END; $$;



CREATE FUNCTION pr_agent_harness.complete_verification_job(requested_tenant_id uuid, requested_job_id uuid, requested_owner text, requested_epoch bigint, requested_result jsonb, requested_result_hash text) RETURNS boolean
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pr_agent_harness'
    AS $_$
  WITH updated AS (
    UPDATE pr_agent_harness.verification_jobs SET status='succeeded',result_json=requested_result,
      result_hash=requested_result_hash,lease_owner=NULL,lease_expires_at=NULL,
      completed_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE tenant_id=requested_tenant_id AND id=requested_job_id AND status='leased'
      AND lease_owner=requested_owner AND lease_epoch=requested_epoch
      AND lease_expires_at>clock_timestamp() AND deadline_at>clock_timestamp()
      AND jsonb_typeof(requested_result)='object' AND requested_result_hash ~ '^[a-f0-9]{64}$'
    RETURNING true
  ) SELECT EXISTS(SELECT 1 FROM updated)
$_$;



CREATE FUNCTION pr_agent_harness.fail_verification_job(requested_tenant_id uuid, requested_job_id uuid, requested_owner text, requested_epoch bigint, requested_error_code text, requested_retry_delay_seconds integer) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pr_agent_harness'
    AS $$
DECLARE resulting_status text;
BEGIN
  UPDATE pr_agent_harness.verification_jobs SET
    status=CASE WHEN attempt_count<max_attempts AND deadline_at>clock_timestamp()+make_interval(secs=>requested_retry_delay_seconds)
      THEN 'queued' ELSE 'failed' END,
    available_at=clock_timestamp()+make_interval(secs=>requested_retry_delay_seconds), error_code=left(requested_error_code,200),
    lease_owner=NULL,lease_expires_at=NULL,
    completed_at=CASE WHEN attempt_count<max_attempts AND deadline_at>clock_timestamp()+make_interval(secs=>requested_retry_delay_seconds)
      THEN NULL ELSE clock_timestamp() END, updated_at=clock_timestamp()
  WHERE tenant_id=requested_tenant_id AND id=requested_job_id AND status='leased'
    AND lease_owner=requested_owner AND lease_epoch=requested_epoch AND lease_expires_at>clock_timestamp()
    AND requested_retry_delay_seconds BETWEEN 0 AND 300 AND length(requested_error_code) BETWEEN 1 AND 200
  RETURNING status INTO resulting_status;
  RETURN resulting_status;
END; $$;



CREATE FUNCTION pr_agent_harness.guard_eval_dataset_state() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'evaluation datasets cannot be deleted'; END IF;
  IF OLD.status='frozen' AND NEW.status='retired' AND pr_agent_harness.is_harness_admin()
     AND (to_jsonb(NEW)-'status'-'updated_at')=(to_jsonb(OLD)-'status'-'updated_at') THEN RETURN NEW; END IF;
  IF OLD.status IN ('frozen','retired')
     AND NOT (pr_agent_harness.is_harness_admin()
       AND (to_jsonb(NEW)-'content_purged_at'-'updated_at')=(to_jsonb(OLD)-'content_purged_at'-'updated_at')
       AND NEW.content_purged_at IS NOT NULL) THEN
    RAISE EXCEPTION 'frozen evaluation dataset is immutable';
  END IF;
  IF OLD.status='draft' AND NEW.status NOT IN ('draft','frozen') THEN RAISE EXCEPTION 'invalid evaluation dataset transition'; END IF;
  RETURN NEW;
END $$;



CREATE FUNCTION pr_agent_harness.guard_eval_result_lifecycle() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE old_row jsonb := to_jsonb(OLD); new_row jsonb := to_jsonb(NEW);
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'evaluation results cannot be deleted'; END IF;
  IF (new_row-'child_run_id'-'status'-'artifact_hash'-'score_json'-'score_hash'-'usage_json'
      -'latency_ms'-'error_code'-'updated_at'-'completed_at')
     <>(old_row-'child_run_id'-'status'-'artifact_hash'-'score_json'-'score_hash'-'usage_json'
      -'latency_ms'-'error_code'-'updated_at'-'completed_at') THEN
    RAISE EXCEPTION 'evaluation result identity is immutable';
  END IF;
  IF OLD.status IN ('succeeded','failed','cancelled') THEN RAISE EXCEPTION 'terminal evaluation result is immutable'; END IF;
  IF NOT ((OLD.status='pending' AND NEW.status IN ('queued','failed','cancelled'))
       OR (OLD.status='queued' AND NEW.status IN ('running','succeeded','failed','cancelled'))
       OR (OLD.status='running' AND NEW.status IN ('succeeded','failed','cancelled'))) THEN
    RAISE EXCEPTION 'invalid evaluation result transition';
  END IF;
  IF OLD.child_run_id IS NOT NULL AND NEW.child_run_id IS DISTINCT FROM OLD.child_run_id THEN
    RAISE EXCEPTION 'evaluation child Run cannot be replaced';
  END IF;
  IF NEW.status IN ('queued','running','succeeded') AND NEW.child_run_id IS NULL THEN
    RAISE EXCEPTION 'queued evaluation result requires a child Run';
  END IF;
  RETURN NEW;
END $$;



CREATE FUNCTION pr_agent_harness.guard_eval_run_lifecycle() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE old_row jsonb := to_jsonb(OLD); new_row jsonb := to_jsonb(NEW);
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'evaluation Runs cannot be deleted'; END IF;
  IF pr_agent_harness.is_harness_admin() AND OLD.status='queued' AND NEW.status='queued'
     AND (new_row-'available_at'-'updated_at')=(old_row-'available_at'-'updated_at') THEN RETURN NEW; END IF;
  IF (new_row-'status'-'version'-'completed_result_count'-'failed_result_count'-'lease_owner'-'lease_epoch'
      -'lease_expires_at'-'heartbeat_at'-'available_at'-'error_code'-'metrics_json'-'metrics_hash'
      -'updated_at'-'completed_at')
     <>(old_row-'status'-'version'-'completed_result_count'-'failed_result_count'-'lease_owner'-'lease_epoch'
      -'lease_expires_at'-'heartbeat_at'-'available_at'-'error_code'-'metrics_json'-'metrics_hash'
      -'updated_at'-'completed_at') THEN RAISE EXCEPTION 'evaluation Run identity is immutable'; END IF;
  IF OLD.status IN ('succeeded','failed','cancelled') THEN RAISE EXCEPTION 'terminal evaluation Run is immutable'; END IF;
  IF NOT ((OLD.status='queued' AND NEW.status IN ('running','failed','cancelled'))
       OR (OLD.status='running' AND NEW.status IN ('running','queued','succeeded','failed','cancelled'))) THEN
    RAISE EXCEPTION 'invalid evaluation Run transition';
  END IF;
  IF NEW.version<=OLD.version OR NEW.completed_result_count<OLD.completed_result_count
     OR NEW.failed_result_count<OLD.failed_result_count THEN RAISE EXCEPTION 'evaluation Run lifecycle must advance'; END IF;
  IF NEW.status='running' AND (NEW.lease_owner IS NULL OR NEW.lease_expires_at IS NULL) THEN
    RAISE EXCEPTION 'running evaluation Run requires a lease';
  END IF;
  IF NEW.status<>'running' AND (NEW.lease_owner IS NOT NULL OR NEW.lease_expires_at IS NOT NULL) THEN
    RAISE EXCEPTION 'non-running evaluation Run cannot retain a lease';
  END IF;
  IF OLD.status='running' AND NEW.status='running' AND NEW.lease_owner IS DISTINCT FROM OLD.lease_owner
     AND NEW.lease_epoch<=OLD.lease_epoch THEN RAISE EXCEPTION 'evaluation lease owner change requires a new epoch'; END IF;
  RETURN NEW;
END $$;



CREATE FUNCTION pr_agent_harness.guard_evolution_candidate_content() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE old_row jsonb := to_jsonb(OLD); new_row jsonb := to_jsonb(NEW);
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'evolution proposal history cannot be deleted'; END IF;
  IF NOT pr_agent_harness.is_harness_admin() OR NEW.content_purged_at IS NULL THEN
    RAISE EXCEPTION 'evolution proposal history is immutable';
  END IF;
  IF TG_TABLE_NAME='evolution_proposal_sources'
     AND (new_row-'source_json'-'content_purged_at')=(old_row-'source_json'-'content_purged_at')
     AND new_row->'source_json'='{"purged":true}'::jsonb THEN
    IF EXISTS (SELECT 1 FROM pr_agent_harness.evolution_candidates c
      WHERE c.tenant_id=(old_row->>'tenant_id')::uuid
        AND c.proposal_run_id=(old_row->>'proposal_run_id')::uuid AND c.content_purged_at IS NULL)
      OR EXISTS (SELECT 1 FROM pr_agent_harness.evolution_candidates c
        JOIN pr_agent_harness.evolution_release_qualifications q
          ON q.tenant_id=c.tenant_id AND q.candidate_id=c.id
        WHERE c.tenant_id=(old_row->>'tenant_id')::uuid
          AND c.proposal_run_id=(old_row->>'proposal_run_id')::uuid) THEN
      RAISE EXCEPTION 'candidate or release reference prevents proposal source purge';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME='evolution_candidates'
     AND (new_row-'candidate_json'-'content_purged_at')=(old_row-'candidate_json'-'content_purged_at')
     AND new_row->'candidate_json'='{"purged":true}'::jsonb THEN
    IF EXISTS (SELECT 1 FROM pr_agent_harness.eval_runs e
      WHERE e.tenant_id=(old_row->>'tenant_id')::uuid AND e.candidate_id=(old_row->>'id')::uuid)
      OR EXISTS (SELECT 1 FROM pr_agent_harness.evolution_release_qualifications q
        WHERE q.tenant_id=(old_row->>'tenant_id')::uuid AND q.candidate_id=(old_row->>'id')::uuid)
      OR EXISTS (SELECT 1 FROM pr_agent_harness.evolution_release_assignments a
        WHERE a.tenant_id=(old_row->>'tenant_id')::uuid AND a.candidate_id=(old_row->>'id')::uuid)
      OR EXISTS (SELECT 1 FROM pr_agent_harness.evolution_release_requests r
        WHERE r.tenant_id=(old_row->>'tenant_id')::uuid AND r.candidate_id=(old_row->>'id')::uuid)
      OR EXISTS (SELECT 1 FROM pr_agent_harness.evolution_run_assignments a
        WHERE a.tenant_id=(old_row->>'tenant_id')::uuid AND a.candidate_id=(old_row->>'id')::uuid) THEN
      RAISE EXCEPTION 'evaluation or release reference prevents candidate purge';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid evolution proposal purge';
END $$;



CREATE FUNCTION pr_agent_harness.guard_evolution_raw_content() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE old_row jsonb := to_jsonb(OLD); new_row jsonb := to_jsonb(NEW);
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'evolution evidence cannot be deleted'; END IF;
  IF TG_TABLE_NAME='review_annotations'
     AND old_row->'superseded_by_annotation_id'='null'::jsonb
     AND new_row->'superseded_by_annotation_id'<>'null'::jsonb
     AND (new_row-'superseded_by_annotation_id')=(old_row-'superseded_by_annotation_id') THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='trusted_review_label_sets'
     AND old_row->'active'='true'::jsonb AND new_row->'active'='false'::jsonb
     AND (new_row-'active')=(old_row-'active') THEN RETURN NEW; END IF;
  IF NOT pr_agent_harness.is_harness_admin() OR NEW.content_purged_at IS NULL THEN
    RAISE EXCEPTION 'evolution raw content is immutable';
  END IF;
  IF TG_TABLE_NAME='feedback_observations'
     AND (new_row-'observation_json'-'content_purged_at')=(old_row-'observation_json'-'content_purged_at')
     AND new_row->'observation_json'='{"purged":true}'::jsonb THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='review_annotations'
     AND (new_row-'label_set_json'-'provenance_json'-'content_purged_at')
       =(old_row-'label_set_json'-'provenance_json'-'content_purged_at')
     AND new_row->'label_set_json'='{"purged":true}'::jsonb
     AND new_row->'provenance_json'='{"purged":true}'::jsonb THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='review_annotation_arbitrations'
     AND (new_row-'reason'-'content_purged_at')=(old_row-'reason'-'content_purged_at')
     AND new_row->>'reason'='content purged by retention' THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='trusted_review_label_sets'
     AND (new_row-'label_set_json'-'resolution_json'-'content_purged_at')
       =(old_row-'label_set_json'-'resolution_json'-'content_purged_at')
     AND new_row->'label_set_json'='{"purged":true}'::jsonb
     AND new_row->'resolution_json'='{"purged":true}'::jsonb THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'invalid evolution raw-content purge';
END $$;



CREATE FUNCTION pr_agent_harness.guard_frozen_eval_dataset() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE current_status text; target_tenant uuid; target_dataset uuid;
BEGIN
  target_tenant := CASE WHEN TG_OP='DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
  target_dataset := CASE WHEN TG_OP='DELETE' THEN OLD.dataset_id ELSE NEW.dataset_id END;
  SELECT status INTO current_status FROM pr_agent_harness.eval_datasets
   WHERE tenant_id=target_tenant AND id=target_dataset FOR UPDATE;
  IF current_status IN ('frozen','retired') THEN
    IF TG_OP='UPDATE' AND pr_agent_harness.is_harness_admin()
       AND (to_jsonb(NEW)-'label_set_json'-'content_purged_at')=(to_jsonb(OLD)-'label_set_json'-'content_purged_at')
       AND NEW.label_set_json='{"purged":true}'::jsonb
       AND NEW.content_purged_at IS NOT NULL THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'frozen evaluation dataset is immutable';
  END IF;
  RETURN COALESCE(NEW,OLD);
END $$;



CREATE FUNCTION pr_agent_harness.guard_frozen_eval_fixture() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE case_reference boolean; all_references_retired boolean; target_tenant uuid; target_fixture text;
BEGIN
  target_tenant := CASE WHEN TG_OP='DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
  target_fixture := CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
  SELECT EXISTS(SELECT 1 FROM pr_agent_harness.eval_cases c
      WHERE c.tenant_id=target_tenant AND c.fixture_id=target_fixture),
    NOT EXISTS(SELECT 1 FROM pr_agent_harness.eval_cases c JOIN pr_agent_harness.eval_datasets d
      ON d.tenant_id=c.tenant_id AND d.id=c.dataset_id
      WHERE c.tenant_id=target_tenant AND c.fixture_id=target_fixture AND d.status<>'retired')
    INTO case_reference,all_references_retired;
  IF case_reference THEN
    IF TG_OP='UPDATE' AND all_references_retired AND pr_agent_harness.is_harness_admin()
       AND (to_jsonb(NEW)-'input_json'-'ci_json'-'content_purged_at')
         =(to_jsonb(OLD)-'input_json'-'ci_json'-'content_purged_at')
       AND NEW.input_json='{"purged":true}'::jsonb AND NEW.ci_json='{"purged":true}'::jsonb
       AND NEW.content_purged_at IS NOT NULL THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'fixture referenced by an evaluation dataset is immutable';
  END IF;
  RETURN COALESCE(NEW,OLD);
END $$;



CREATE FUNCTION pr_agent_harness.guard_frozen_eval_fixture_file() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE case_reference boolean; all_references_retired boolean; target_tenant uuid; target_fixture text;
BEGIN
  target_tenant := CASE WHEN TG_OP='DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
  target_fixture := CASE WHEN TG_OP='DELETE' THEN OLD.fixture_id ELSE NEW.fixture_id END;
  SELECT EXISTS(SELECT 1 FROM pr_agent_harness.eval_cases c
      WHERE c.tenant_id=target_tenant AND c.fixture_id=target_fixture),
    NOT EXISTS(SELECT 1 FROM pr_agent_harness.eval_cases c JOIN pr_agent_harness.eval_datasets d
      ON d.tenant_id=c.tenant_id AND d.id=c.dataset_id
      WHERE c.tenant_id=target_tenant AND c.fixture_id=target_fixture AND d.status<>'retired')
    INTO case_reference,all_references_retired;
  IF case_reference THEN
    IF TG_OP='UPDATE' AND all_references_retired AND pr_agent_harness.is_harness_admin()
       AND (to_jsonb(NEW)-'content_text'-'content_purged_at')=(to_jsonb(OLD)-'content_text'-'content_purged_at')
       AND NEW.content_text IS NULL AND NEW.content_purged_at IS NOT NULL THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'fixture file referenced by an evaluation dataset is immutable';
  END IF;
  RETURN COALESCE(NEW,OLD);
END $$;



CREATE FUNCTION pr_agent_harness.guard_publication_batch_seal() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pr_agent_harness'
    AS $$
DECLARE
  actual_count integer;
  actual_hash text;
  has_missing_payload boolean;
BEGIN
  IF OLD.seal_state = 'sealed' THEN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.integration_id IS DISTINCT FROM OLD.integration_id
      OR NEW.platform IS DISTINCT FROM OLD.platform
      OR NEW.origin IS DISTINCT FROM OLD.origin
      OR NEW.repository IS DISTINCT FROM OLD.repository
      OR NEW.target IS DISTINCT FROM OLD.target
      OR NEW.revision IS DISTINCT FROM OLD.revision
      OR NEW.authority_generation IS DISTINCT FROM OLD.authority_generation
      OR NEW.source_key IS DISTINCT FROM OLD.source_key
      OR NEW.source_hash IS DISTINCT FROM OLD.source_hash
      OR NEW.seal_state IS DISTINCT FROM OLD.seal_state
      OR NEW.sealed_at IS DISTINCT FROM OLD.sealed_at
      OR NEW.operation_count IS DISTINCT FROM OLD.operation_count
      OR NEW.operation_set_hash IS DISTINCT FROM OLD.operation_set_hash THEN
      RAISE EXCEPTION 'sealed publication batch identity is immutable';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.seal_state = 'sealed' THEN
    SELECT count(*)::integer,
           encode(
             public.digest(
               COALESCE(
                 string_agg(
                   pbo.ordinal::text || ':' || pbo.business_operation_id,
                   E'\n' ORDER BY pbo.ordinal
                 ),
                 ''
               ),
               'sha256'
             ),
             'hex'
           ),
           COALESCE(bool_or(ro.payload_json IS NULL), false)
    INTO actual_count, actual_hash, has_missing_payload
    FROM pr_agent_harness.publication_batch_operations pbo
    JOIN pr_agent_harness.repository_operations ro
      ON ro.tenant_id = pbo.tenant_id
     AND ro.business_operation_id = pbo.business_operation_id
    WHERE pbo.tenant_id = OLD.tenant_id AND pbo.batch_id = OLD.id;

    IF actual_count = 0 OR has_missing_payload
      OR NEW.operation_count IS DISTINCT FROM actual_count
      OR NEW.operation_set_hash IS DISTINCT FROM actual_hash
      OR NEW.sealed_at IS NULL THEN
      RAISE EXCEPTION 'publication batch seal does not match its complete frozen operation set';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;



CREATE FUNCTION pr_agent_harness.guard_release_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN RAISE EXCEPTION 'release evidence and receipts are immutable'; END $$;



CREATE FUNCTION pr_agent_harness.guard_release_assignment_lifecycle() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'release assignments cannot be deleted'; END IF;
  IF NEW.version<>OLD.version+1 OR NEW.tenant_id<>OLD.tenant_id OR NEW.integration_id<>OLD.integration_id
     OR NEW.created_at<>OLD.created_at THEN RAISE EXCEPTION 'invalid release assignment CAS'; END IF;
  RETURN NEW;
END $$;



CREATE FUNCTION pr_agent_harness.guard_release_request_lifecycle() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE old_row jsonb:=to_jsonb(OLD); new_row jsonb:=to_jsonb(NEW);
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'release requests cannot be deleted'; END IF;
  IF (new_row-'status'-'consumed_at'-'revoke_command_key'-'revoke_request_hash'-'updated_at')
     <>(old_row-'status'-'consumed_at'-'revoke_command_key'-'revoke_request_hash'-'updated_at') THEN
    RAISE EXCEPTION 'release request identity is immutable'; END IF;
  IF OLD.status<>'open' OR NEW.status NOT IN ('rejected','revoked','consumed','expired') THEN
    RAISE EXCEPTION 'invalid release request transition'; END IF;
  IF (NEW.status='consumed')<>(NEW.consumed_at IS NOT NULL) THEN RAISE EXCEPTION 'consumption time mismatch'; END IF;
  IF (NEW.status='revoked')<>(NEW.revoke_command_key IS NOT NULL AND NEW.revoke_request_hash IS NOT NULL) THEN
    RAISE EXCEPTION 'revocation receipt mismatch'; END IF;
  RETURN NEW;
END $$;



CREATE FUNCTION pr_agent_harness.guard_sealed_batch_links() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pr_agent_harness'
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



CREATE FUNCTION pr_agent_harness.guard_sealed_operation_identity() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pr_agent_harness'
    AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pr_agent_harness.publication_batch_operations pbo
    JOIN pr_agent_harness.publication_batches pb
      ON pb.tenant_id = pbo.tenant_id AND pb.id = pbo.batch_id
    WHERE pbo.tenant_id = OLD.tenant_id
      AND pbo.business_operation_id = OLD.business_operation_id
      AND pb.seal_state = 'sealed'
  ) AND (
    NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.integration_id IS DISTINCT FROM OLD.integration_id
    OR NEW.business_operation_id IS DISTINCT FROM OLD.business_operation_id
    OR NEW.platform IS DISTINCT FROM OLD.platform
    OR NEW.origin IS DISTINCT FROM OLD.origin
    OR NEW.repository IS DISTINCT FROM OLD.repository
    OR NEW.target IS DISTINCT FROM OLD.target
    OR NEW.revision IS DISTINCT FROM OLD.revision
    OR NEW.operation_type IS DISTINCT FROM OLD.operation_type
    OR NEW.authority_generation IS DISTINCT FROM OLD.authority_generation
    OR NEW.publication_slot IS DISTINCT FROM OLD.publication_slot
    OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
    OR NEW.payload_json IS DISTINCT FROM OLD.payload_json
    OR NEW.marker IS DISTINCT FROM OLD.marker
  ) THEN
    RAISE EXCEPTION 'sealed publication operation identity and payload are immutable';
  END IF;
  RETURN NEW;
END;
$$;



CREATE FUNCTION pr_agent_harness.heartbeat_verification_job(requested_tenant_id uuid, requested_job_id uuid, requested_owner text, requested_epoch bigint, requested_lease_seconds integer) RETURNS boolean
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pr_agent_harness'
    AS $$
  WITH updated AS (
    UPDATE pr_agent_harness.verification_jobs SET
      lease_expires_at=clock_timestamp()+make_interval(secs=>requested_lease_seconds),
      heartbeat_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE tenant_id=requested_tenant_id AND id=requested_job_id AND status='leased'
      AND lease_owner=requested_owner AND lease_epoch=requested_epoch
      AND lease_expires_at>clock_timestamp() AND deadline_at>clock_timestamp()
      AND requested_lease_seconds BETWEEN 5 AND 300
    RETURNING true
  ) SELECT EXISTS(SELECT 1 FROM updated)
$$;



CREATE FUNCTION pr_agent_harness.is_harness_admin() RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  SELECT COALESCE((SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user),false)
$$;



CREATE FUNCTION pr_agent_harness.lock_active_legacy_review_execution_authority(requested_tenant_id uuid, requested_integration_id uuid, requested_publication_generation bigint, requested_execution_generation bigint) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pr_agent_harness'
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



CREATE FUNCTION pr_agent_harness.lock_active_publication_authority(requested_tenant_id uuid, requested_integration_id uuid, requested_platform text, requested_origin text, requested_repository text, requested_generation bigint) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pr_agent_harness'
    AS $$
DECLARE
  matched boolean;
BEGIN
  SELECT true INTO matched
  FROM pr_agent_harness.integration_bindings
  WHERE tenant_id = requested_tenant_id
    AND id = requested_integration_id
    AND platform = requested_platform
    AND origin = requested_origin
    AND repository = requested_repository
    AND active
    AND publication_state = 'active'
    AND publication_generation = requested_generation
  FOR SHARE;
  RETURN COALESCE(matched, false);
END;
$$;



COMMENT ON FUNCTION pr_agent_harness.lock_active_publication_authority(requested_tenant_id uuid, requested_integration_id uuid, requested_platform text, requested_origin text, requested_repository text, requested_generation bigint) IS 'Narrow authority assertion and row lock; application roles receive EXECUTE, never registry UPDATE.';



CREATE FUNCTION pr_agent_harness.lock_active_review_execution_authority(requested_tenant_id uuid, requested_integration_id uuid, requested_publication_generation bigint, requested_execution_generation bigint) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pr_agent_harness'
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



CREATE FUNCTION pr_agent_harness.lock_resolvable_publication_authority(requested_tenant_id uuid, requested_integration_id uuid, requested_generation bigint) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pr_agent_harness'
    AS $$
DECLARE
  matched boolean;
BEGIN
  SELECT true INTO matched
  FROM pr_agent_harness.integration_bindings
  WHERE tenant_id = requested_tenant_id
    AND id = requested_integration_id
    AND active
    AND publication_state IN ('active', 'draining')
    AND publication_generation = requested_generation
  FOR SHARE;
  RETURN COALESCE(matched, false);
END;
$$;



COMMENT ON FUNCTION pr_agent_harness.lock_resolvable_publication_authority(requested_tenant_id uuid, requested_integration_id uuid, requested_generation bigint) IS 'Locks matching active or draining authority while an administrator resolves a frozen operation.';



CREATE FUNCTION pr_agent_harness.lock_resumable_legacy_review_execution_authority(requested_tenant_id uuid, requested_integration_id uuid, requested_publication_generation bigint, requested_execution_generation bigint) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pr_agent_harness'
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



CREATE FUNCTION pr_agent_harness.lock_resumable_review_execution_authority(requested_tenant_id uuid, requested_integration_id uuid, requested_publication_generation bigint, requested_execution_generation bigint) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pr_agent_harness'
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



CREATE FUNCTION pr_agent_harness.reset_publication_recovery_on_retry() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pr_agent_harness'
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



CREATE FUNCTION pr_agent_harness.skip_cancelled_run_publications(requested_tenant_id uuid, requested_run_id uuid) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pr_agent_harness'
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



CREATE FUNCTION pr_agent_harness.skip_failed_batch_successors(requested_tenant_id uuid, requested_batch_id uuid) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pr_agent_harness'
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





CREATE TABLE pr_agent_harness.agent_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    integration_id uuid NOT NULL,
    created_by_actor_type text NOT NULL,
    created_by_actor_id text NOT NULL,
    create_scope text NOT NULL,
    create_key text NOT NULL,
    request_hash text NOT NULL,
    run_type text NOT NULL,
    base_sha text NOT NULL,
    head_sha text NOT NULL,
    workflow_version_hash text NOT NULL,
    prompt_version_hash text NOT NULL,
    model_version_hash text NOT NULL,
    tool_version_hash text NOT NULL,
    policy_version_hash text NOT NULL,
    runtime_version_hash text NOT NULL,
    input_json jsonb NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    version bigint DEFAULT 0 NOT NULL,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    lease_epoch bigint DEFAULT 0 NOT NULL,
    next_event_seq bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    authority_generation bigint DEFAULT 0 NOT NULL,
    runtime_config_json jsonb DEFAULT '{"pollMs": 1000, "sweeperMs": 5000, "leaseTtlMs": 60000, "heartbeatMs": 15000}'::jsonb NOT NULL,
    limits_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    deadline_at timestamp with time zone DEFAULT (now() + '00:15:00'::interval) NOT NULL,
    cancel_requested_at timestamp with time zone,
    outcome_code text,
    error_code text,
    execution_attempt_count integer DEFAULT 0 NOT NULL,
    execution_mode_generation bigint DEFAULT 0 NOT NULL,
    checkpoint_version bigint DEFAULT 0 NOT NULL,
    parent_run_id uuid,
    event_retention_floor bigint DEFAULT 1 NOT NULL,
    publication_outcome_generation bigint DEFAULT 0 NOT NULL,
    next_outcome_scan_at timestamp with time zone DEFAULT now() NOT NULL,
    waiting_batch_id uuid,
    waiting_operation_set_hash text,
    content_purged_at timestamp with time zone,
    CONSTRAINT agent_runs_authority_generation_check CHECK ((authority_generation >= 0)),
    CONSTRAINT agent_runs_base_sha_check CHECK ((length(base_sha) > 0)),
    CONSTRAINT agent_runs_checkpoint_version_check CHECK ((checkpoint_version >= 0)),
    CONSTRAINT agent_runs_create_key_check CHECK ((length(create_key) > 0)),
    CONSTRAINT agent_runs_create_scope_check CHECK ((length(create_scope) > 0)),
    CONSTRAINT agent_runs_created_by_actor_id_check CHECK ((length(created_by_actor_id) > 0)),
    CONSTRAINT agent_runs_created_by_actor_type_check CHECK ((created_by_actor_type = ANY (ARRAY['user'::text, 'service'::text, 'system'::text]))),
    CONSTRAINT agent_runs_deadline_after_create CHECK ((deadline_at > created_at)),
    CONSTRAINT agent_runs_event_retention_floor_check CHECK ((event_retention_floor > 0)),
    CONSTRAINT agent_runs_execution_attempt_count_check CHECK ((execution_attempt_count >= 0)),
    CONSTRAINT agent_runs_execution_mode_generation_check CHECK ((execution_mode_generation >= 0)),
    CONSTRAINT agent_runs_head_sha_check CHECK ((length(head_sha) > 0)),
    CONSTRAINT agent_runs_input_json_check CHECK ((jsonb_typeof(input_json) = 'object'::text)),
    CONSTRAINT agent_runs_lease_epoch_check CHECK ((lease_epoch >= 0)),
    CONSTRAINT agent_runs_lease_pair CHECK (((lease_owner IS NULL) = (lease_expires_at IS NULL))),
    CONSTRAINT agent_runs_limits_json_check CHECK ((jsonb_typeof(limits_json) = 'object'::text)),
    CONSTRAINT agent_runs_model_version_hash_check CHECK ((model_version_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT agent_runs_next_event_seq_check CHECK ((next_event_seq > 0)),
    CONSTRAINT agent_runs_not_own_parent CHECK (((parent_run_id IS NULL) OR (parent_run_id <> id))),
    CONSTRAINT agent_runs_policy_version_hash_check CHECK ((policy_version_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT agent_runs_prompt_version_hash_check CHECK ((prompt_version_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT agent_runs_publication_outcome_generation_check CHECK ((publication_outcome_generation >= 0)),
    CONSTRAINT agent_runs_request_hash_check CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT agent_runs_run_type_check CHECK ((length(run_type) > 0)),
    CONSTRAINT agent_runs_running_epoch CHECK (((status <> 'running'::text) OR (lease_epoch > 0))),
    CONSTRAINT agent_runs_running_has_lease CHECK (((status = 'running'::text) = (lease_owner IS NOT NULL))),
    CONSTRAINT agent_runs_runtime_config_json_check CHECK ((jsonb_typeof(runtime_config_json) = 'object'::text)),
    CONSTRAINT agent_runs_runtime_version_hash_check CHECK ((runtime_version_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT agent_runs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'waiting_for_user'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text, 'retry_wait'::text, 'waiting_for_reconciliation'::text]))),
    CONSTRAINT agent_runs_terminal_time CHECK (((status = ANY (ARRAY['succeeded'::text, 'failed'::text, 'cancelled'::text])) = (finished_at IS NOT NULL))),
    CONSTRAINT agent_runs_tool_version_hash_check CHECK ((tool_version_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT agent_runs_version_check CHECK ((version >= 0)),
    CONSTRAINT agent_runs_waiting_batch_shape CHECK ((((waiting_batch_id IS NULL) AND (waiting_operation_set_hash IS NULL)) OR ((waiting_batch_id IS NOT NULL) AND (waiting_operation_set_hash ~ '^[a-f0-9]{64}$'::text)))),
    CONSTRAINT agent_runs_workflow_version_hash_check CHECK ((workflow_version_hash ~ '^[0-9a-f]{64}$'::text))
);

ALTER TABLE ONLY pr_agent_harness.agent_runs FORCE ROW LEVEL SECURITY;



COMMENT ON COLUMN pr_agent_harness.agent_runs.content_purged_at IS 'Administrative retention timestamp. input_json is replaced with an empty object; identity and hashes remain.';



CREATE TABLE pr_agent_harness.agent_steps (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    run_id uuid NOT NULL,
    step_key text NOT NULL,
    step_kind text NOT NULL,
    input_hash text NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    output_hash text,
    output_json jsonb,
    last_lease_epoch bigint NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    content_purged_at timestamp with time zone,
    CONSTRAINT agent_steps_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT agent_steps_completion_shape CHECK ((((status = 'running'::text) AND (output_hash IS NULL) AND (output_json IS NULL) AND (completed_at IS NULL)) OR ((status = ANY (ARRAY['succeeded'::text, 'failed'::text])) AND (output_hash IS NOT NULL) AND (output_json IS NOT NULL) AND (completed_at IS NOT NULL)))),
    CONSTRAINT agent_steps_input_hash_check CHECK ((input_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT agent_steps_last_lease_epoch_check CHECK ((last_lease_epoch > 0)),
    CONSTRAINT agent_steps_output_hash_check CHECK (((output_hash IS NULL) OR (output_hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT agent_steps_output_json_check CHECK (((output_json IS NULL) OR (jsonb_typeof(output_json) = 'object'::text))),
    CONSTRAINT agent_steps_status_check CHECK ((status = ANY (ARRAY['running'::text, 'succeeded'::text, 'failed'::text]))),
    CONSTRAINT agent_steps_step_key_check CHECK ((length(step_key) > 0)),
    CONSTRAINT agent_steps_step_kind_check CHECK ((step_kind = ANY (ARRAY['tool'::text, 'model'::text, 'publication'::text, 'coordination'::text, 'verification'::text])))
);

ALTER TABLE ONLY pr_agent_harness.agent_steps FORCE ROW LEVEL SECURITY;



COMMENT ON TABLE pr_agent_harness.agent_steps IS 'Logical action steps. Retries create attempts without changing the stable step identity.';



CREATE TABLE pr_agent_harness.audit_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    run_id uuid,
    actor_type text NOT NULL,
    actor_id text,
    action text NOT NULL,
    decision text NOT NULL,
    reason_code text,
    resource_type text,
    resource_ref text,
    details_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT audit_logs_decision_check CHECK ((decision = ANY (ARRAY['allowed'::text, 'denied'::text, 'error'::text]))),
    CONSTRAINT audit_logs_details_json_check CHECK ((jsonb_typeof(details_json) = 'object'::text))
);

ALTER TABLE ONLY pr_agent_harness.audit_logs FORCE ROW LEVEL SECURITY;



CREATE TABLE pr_agent_harness.checkpoints (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    run_id uuid NOT NULL,
    sequence bigint NOT NULL,
    checkpoint_kind text DEFAULT 'step_completed'::text NOT NULL,
    publication_batch_id uuid,
    step_id uuid,
    step_attempt_id uuid,
    schema_version integer NOT NULL,
    runtime_version_hash text NOT NULL,
    state_hash text NOT NULL,
    state_json jsonb NOT NULL,
    lease_epoch bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    content_purged_at timestamp with time zone,
    CONSTRAINT checkpoints_checkpoint_kind_check CHECK ((checkpoint_kind = ANY (ARRAY['step_completed'::text, 'publication_frozen'::text]))),
    CONSTRAINT checkpoints_lease_epoch_check CHECK ((lease_epoch > 0)),
    CONSTRAINT checkpoints_runtime_version_hash_check CHECK ((runtime_version_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT checkpoints_schema_version_check CHECK ((schema_version > 0)),
    CONSTRAINT checkpoints_sequence_check CHECK ((sequence > 0)),
    CONSTRAINT checkpoints_state_hash_check CHECK ((state_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT checkpoints_state_json_check CHECK ((jsonb_typeof(state_json) = 'object'::text)),
    CONSTRAINT checkpoints_step_shape CHECK ((((checkpoint_kind = 'step_completed'::text) AND (step_id IS NOT NULL) AND (step_attempt_id IS NOT NULL) AND (publication_batch_id IS NULL)) OR ((checkpoint_kind = 'publication_frozen'::text) AND (step_id IS NULL) AND (step_attempt_id IS NULL) AND (publication_batch_id IS NOT NULL))))
);

ALTER TABLE ONLY pr_agent_harness.checkpoints FORCE ROW LEVEL SECURITY;



COMMENT ON TABLE pr_agent_harness.checkpoints IS 'Fenced, versioned recovery state accepted atomically with a completed logical step.';



CREATE TABLE pr_agent_harness.dead_letter_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    run_id uuid NOT NULL,
    job_id uuid NOT NULL,
    final_run_epoch bigint NOT NULL,
    attempt_count integer NOT NULL,
    reason_code text NOT NULL,
    details_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT dead_letter_jobs_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT dead_letter_jobs_details_json_check CHECK ((jsonb_typeof(details_json) = 'object'::text)),
    CONSTRAINT dead_letter_jobs_final_run_epoch_check CHECK ((final_run_epoch >= 0)),
    CONSTRAINT dead_letter_jobs_reason_code_check CHECK ((length(reason_code) > 0))
);

ALTER TABLE ONLY pr_agent_harness.dead_letter_jobs FORCE ROW LEVEL SECURITY;



COMMENT ON TABLE pr_agent_harness.dead_letter_jobs IS 'Terminal scheduling failures. A dead-letter record never grants Run execution authority.';



CREATE TABLE pr_agent_harness.eval_cases (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    integration_id uuid NOT NULL,
    dataset_id uuid NOT NULL,
    source_run_id uuid NOT NULL,
    fixture_id text NOT NULL,
    label_set_id uuid NOT NULL,
    source_artifact_hash text NOT NULL,
    fixture_hash text NOT NULL,
    label_set_hash text NOT NULL,
    label_set_json jsonb NOT NULL,
    lineage_hash text NOT NULL,
    shingle_hash text NOT NULL,
    shingle_hashes_json jsonb NOT NULL,
    source_created_at timestamp with time zone NOT NULL,
    repository text NOT NULL,
    pull_number integer NOT NULL,
    split text,
    ordinal integer,
    content_purged_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT eval_cases_fixture_hash_check CHECK ((fixture_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT eval_cases_label_set_hash_check CHECK ((label_set_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT eval_cases_label_set_json_check CHECK ((jsonb_typeof(label_set_json) = 'object'::text)),
    CONSTRAINT eval_cases_lineage_hash_check CHECK ((lineage_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT eval_cases_ordinal_check CHECK (((ordinal IS NULL) OR (ordinal >= 0))),
    CONSTRAINT eval_cases_pull_number_check CHECK ((pull_number > 0)),
    CONSTRAINT eval_cases_repository_check CHECK (((length(repository) >= 1) AND (length(repository) <= 512))),
    CONSTRAINT eval_cases_shingle_hash_check CHECK ((shingle_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT eval_cases_shingle_hashes_json_check CHECK (((jsonb_typeof(shingle_hashes_json) = 'array'::text) AND (jsonb_array_length(shingle_hashes_json) <= 256))),
    CONSTRAINT eval_cases_source_artifact_hash_check CHECK ((source_artifact_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT eval_cases_split_check CHECK ((split = ANY (ARRAY['development'::text, 'validation'::text, 'holdout'::text])))
);

ALTER TABLE ONLY pr_agent_harness.eval_cases FORCE ROW LEVEL SECURITY;



CREATE TABLE pr_agent_harness.eval_datasets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    name text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    curator_actor_type text NOT NULL,
    curator_actor_id text NOT NULL,
    split_policy_json jsonb NOT NULL,
    split_policy_hash text NOT NULL,
    manifest_hash text,
    case_count integer DEFAULT 0 NOT NULL,
    dev_count integer DEFAULT 0 NOT NULL,
    validation_count integer DEFAULT 0 NOT NULL,
    holdout_count integer DEFAULT 0 NOT NULL,
    frozen_at timestamp with time zone,
    content_purged_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT eval_datasets_case_count_check CHECK ((case_count >= 0)),
    CONSTRAINT eval_datasets_check CHECK ((((status = 'draft'::text) AND (manifest_hash IS NULL) AND (frozen_at IS NULL)) OR ((status = ANY (ARRAY['frozen'::text, 'retired'::text])) AND (manifest_hash IS NOT NULL) AND (frozen_at IS NOT NULL) AND (case_count = ((dev_count + validation_count) + holdout_count))))),
    CONSTRAINT eval_datasets_curator_actor_type_check CHECK ((curator_actor_type = ANY (ARRAY['user'::text, 'service'::text]))),
    CONSTRAINT eval_datasets_dev_count_check CHECK ((dev_count >= 0)),
    CONSTRAINT eval_datasets_holdout_count_check CHECK ((holdout_count >= 0)),
    CONSTRAINT eval_datasets_manifest_hash_check CHECK (((manifest_hash IS NULL) OR (manifest_hash ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT eval_datasets_name_check CHECK (((length(name) >= 1) AND (length(name) <= 200))),
    CONSTRAINT eval_datasets_split_policy_hash_check CHECK ((split_policy_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT eval_datasets_split_policy_json_check CHECK ((jsonb_typeof(split_policy_json) = 'object'::text)),
    CONSTRAINT eval_datasets_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'frozen'::text, 'retired'::text]))),
    CONSTRAINT eval_datasets_validation_count_check CHECK ((validation_count >= 0)),
    CONSTRAINT eval_datasets_version_check CHECK ((version >= 1))
);

ALTER TABLE ONLY pr_agent_harness.eval_datasets FORCE ROW LEVEL SECURITY;



CREATE TABLE pr_agent_harness.eval_fixture_files (
    tenant_id uuid NOT NULL,
    fixture_id text NOT NULL,
    path text NOT NULL,
    kind text NOT NULL,
    content_text text,
    content_hash text NOT NULL,
    size_bytes integer NOT NULL,
    content_purged_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT eval_fixture_files_check CHECK ((((content_purged_at IS NULL) AND (content_text IS NOT NULL)) OR (content_purged_at IS NOT NULL))),
    CONSTRAINT eval_fixture_files_content_hash_check CHECK ((content_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT eval_fixture_files_kind_check CHECK ((kind = ANY (ARRAY['source'::text, 'manifest'::text, 'ci'::text]))),
    CONSTRAINT eval_fixture_files_path_check CHECK (((length(path) BETWEEN 1 AND 512) AND (path !~ '(^/|\\|(^|/)\.\.?(/|$))'::text))),
    CONSTRAINT eval_fixture_files_size_bytes_check CHECK (((size_bytes >= 0) AND (size_bytes <= 52428800)))
);

ALTER TABLE ONLY pr_agent_harness.eval_fixture_files FORCE ROW LEVEL SECURITY;



CREATE TABLE pr_agent_harness.eval_fixtures (
    id text NOT NULL,
    tenant_id uuid NOT NULL,
    integration_id uuid NOT NULL,
    run_id uuid NOT NULL,
    repository text NOT NULL,
    base_sha text NOT NULL,
    head_sha text NOT NULL,
    input_hash text NOT NULL,
    source_step_id uuid NOT NULL,
    source_step_output_hash text NOT NULL,
    artifact_hash text NOT NULL,
    fixture_hash text NOT NULL,
    input_json jsonb NOT NULL,
    files_manifest_json jsonb NOT NULL,
    coverage_json jsonb NOT NULL,
    ci_json jsonb NOT NULL,
    total_bytes integer NOT NULL,
    content_purged_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT eval_fixtures_artifact_hash_check CHECK ((artifact_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT eval_fixtures_ci_json_check CHECK ((jsonb_typeof(ci_json) = 'object'::text)),
    CONSTRAINT eval_fixtures_coverage_json_check CHECK ((jsonb_typeof(coverage_json) = 'object'::text)),
    CONSTRAINT eval_fixtures_files_manifest_json_check CHECK ((jsonb_typeof(files_manifest_json) = 'array'::text)),
    CONSTRAINT eval_fixtures_fixture_hash_check CHECK ((fixture_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT eval_fixtures_id_check CHECK ((id ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT eval_fixtures_input_hash_check CHECK ((input_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT eval_fixtures_input_json_check CHECK ((jsonb_typeof(input_json) = 'object'::text)),
    CONSTRAINT eval_fixtures_repository_check CHECK (((length(repository) >= 1) AND (length(repository) <= 512))),
    CONSTRAINT eval_fixtures_source_step_output_hash_check CHECK ((source_step_output_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT eval_fixtures_total_bytes_check CHECK (((total_bytes >= 0) AND (total_bytes <= 52428800)))
);

ALTER TABLE ONLY pr_agent_harness.eval_fixtures FORCE ROW LEVEL SECURITY;



CREATE TABLE pr_agent_harness.eval_results (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    eval_run_id uuid NOT NULL,
    dataset_id uuid NOT NULL,
    case_id uuid NOT NULL,
    integration_id uuid NOT NULL,
    variant text NOT NULL,
    repetition integer NOT NULL,
    seed_hash text NOT NULL,
    child_run_id uuid,
    fixture_hash text NOT NULL,
    label_set_id uuid NOT NULL,
    label_set_hash text NOT NULL,
    component_hash text NOT NULL,
    expected_workflow_hash text NOT NULL,
    expected_prompt_hash text NOT NULL,
    expected_model_hash text NOT NULL,
    expected_tool_hash text NOT NULL,
    expected_policy_hash text NOT NULL,
    expected_runtime_hash text NOT NULL,
    expected_verifier_hash text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    artifact_hash text,
    score_json jsonb,
    score_hash text,
    usage_json jsonb,
    latency_ms integer,
    error_code text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT eval_results_artifact_hash_check CHECK (((artifact_hash IS NULL) OR (artifact_hash ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT eval_results_check CHECK (((score_json IS NULL) = (score_hash IS NULL))),
    CONSTRAINT eval_results_check1 CHECK (((status = ANY (ARRAY['succeeded'::text, 'failed'::text, 'cancelled'::text])) = (completed_at IS NOT NULL))),
    CONSTRAINT eval_results_component_hash_check CHECK ((component_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT eval_results_expected_model_hash_check CHECK ((expected_model_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT eval_results_expected_policy_hash_check CHECK ((expected_policy_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT eval_results_expected_prompt_hash_check CHECK ((expected_prompt_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT eval_results_expected_runtime_hash_check CHECK ((expected_runtime_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT eval_results_expected_tool_hash_check CHECK ((expected_tool_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT eval_results_expected_verifier_hash_check CHECK ((expected_verifier_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT eval_results_expected_workflow_hash_check CHECK ((expected_workflow_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT eval_results_fixture_hash_check CHECK ((fixture_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT eval_results_label_set_hash_check CHECK ((label_set_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT eval_results_latency_ms_check CHECK (((latency_ms IS NULL) OR (latency_ms >= 0))),
    CONSTRAINT eval_results_repetition_check CHECK (((repetition >= 1) AND (repetition <= 3))),
    CONSTRAINT eval_results_score_hash_check CHECK (((score_hash IS NULL) OR (score_hash ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT eval_results_score_json_check CHECK (((score_json IS NULL) OR (jsonb_typeof(score_json) = 'object'::text))),
    CONSTRAINT eval_results_seed_hash_check CHECK ((seed_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT eval_results_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text]))),
    CONSTRAINT eval_results_usage_json_check CHECK (((usage_json IS NULL) OR (jsonb_typeof(usage_json) = 'object'::text))),
    CONSTRAINT eval_results_variant_check CHECK ((variant = ANY (ARRAY['baseline'::text, 'candidate'::text])))
);

ALTER TABLE ONLY pr_agent_harness.eval_results FORCE ROW LEVEL SECURITY;



COMMENT ON TABLE pr_agent_harness.eval_results IS 'Complete baseline and candidate replay matrix; failures are retained and never selectively dropped.';



CREATE TABLE pr_agent_harness.eval_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    dataset_id uuid NOT NULL,
    candidate_id uuid NOT NULL,
    curator_actor_type text NOT NULL,
    curator_actor_id text NOT NULL,
    split text NOT NULL,
    command_key text NOT NULL,
    request_hash text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    version bigint DEFAULT 0 NOT NULL,
    repetitions integer DEFAULT 3 NOT NULL,
    manifest_hash text NOT NULL,
    baseline_component_hash text NOT NULL,
    candidate_component_hash text NOT NULL,
    model_version_hash text NOT NULL,
    runtime_version_hash text NOT NULL,
    scheduling_policy_json jsonb NOT NULL,
    scheduling_policy_hash text NOT NULL,
    total_result_count integer NOT NULL,
    planned_result_count integer NOT NULL,
    completed_result_count integer DEFAULT 0 NOT NULL,
    failed_result_count integer DEFAULT 0 NOT NULL,
    lease_owner text,
    lease_epoch bigint DEFAULT 0 NOT NULL,
    lease_expires_at timestamp with time zone,
    heartbeat_at timestamp with time zone,
    available_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    deadline_at timestamp with time zone NOT NULL,
    error_code text,
    metrics_json jsonb,
    metrics_hash text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT eval_runs_baseline_component_hash_check CHECK ((baseline_component_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT eval_runs_candidate_component_hash_check CHECK ((candidate_component_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT eval_runs_check CHECK (((lease_owner IS NULL) = (lease_expires_at IS NULL))),
    CONSTRAINT eval_runs_check1 CHECK (((status = ANY (ARRAY['succeeded'::text, 'failed'::text, 'cancelled'::text])) = (completed_at IS NOT NULL))),
    CONSTRAINT eval_runs_check2 CHECK (((metrics_json IS NULL) = (metrics_hash IS NULL))),
    CONSTRAINT eval_runs_command_key_check CHECK (((length(command_key) >= 1) AND (length(command_key) <= 200))),
    CONSTRAINT eval_runs_completed_result_count_check CHECK ((completed_result_count >= 0)),
    CONSTRAINT eval_runs_curator_actor_id_check CHECK (((length(curator_actor_id) >= 1) AND (length(curator_actor_id) <= 512))),
    CONSTRAINT eval_runs_curator_actor_type_check CHECK ((curator_actor_type = ANY (ARRAY['user'::text, 'service'::text]))),
    CONSTRAINT eval_runs_failed_result_count_check CHECK ((failed_result_count >= 0)),
    CONSTRAINT eval_runs_lease_epoch_check CHECK ((lease_epoch >= 0)),
    CONSTRAINT eval_runs_manifest_hash_check CHECK ((manifest_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT eval_runs_metrics_hash_check CHECK (((metrics_hash IS NULL) OR (metrics_hash ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT eval_runs_metrics_json_check CHECK (((metrics_json IS NULL) OR (jsonb_typeof(metrics_json) = 'object'::text))),
    CONSTRAINT eval_runs_model_version_hash_check CHECK ((model_version_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT eval_runs_planned_result_count_check CHECK ((planned_result_count >= 0)),
    CONSTRAINT eval_runs_repetitions_check CHECK ((repetitions = 3)),
    CONSTRAINT eval_runs_request_hash_check CHECK ((request_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT eval_runs_runtime_version_hash_check CHECK ((runtime_version_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT eval_runs_scheduling_policy_hash_check CHECK ((scheduling_policy_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT eval_runs_scheduling_policy_json_check CHECK ((jsonb_typeof(scheduling_policy_json) = 'object'::text)),
    CONSTRAINT eval_runs_split_check CHECK ((split = ANY (ARRAY['development'::text, 'validation'::text, 'holdout'::text]))),
    CONSTRAINT eval_runs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text]))),
    CONSTRAINT eval_runs_total_result_count_check CHECK ((total_result_count >= 0)),
    CONSTRAINT eval_runs_version_check CHECK ((version >= 0))
);

ALTER TABLE ONLY pr_agent_harness.eval_runs FORCE ROW LEVEL SECURITY;



CREATE TABLE pr_agent_harness.evidence_records (
    id text NOT NULL,
    tenant_id uuid NOT NULL,
    integration_id uuid NOT NULL,
    run_id uuid NOT NULL,
    step_id uuid NOT NULL,
    step_attempt_id uuid NOT NULL,
    tool_call_id uuid NOT NULL,
    repository text NOT NULL,
    head_sha text NOT NULL,
    evidence_kind text NOT NULL,
    tool_name text NOT NULL,
    request_hash text NOT NULL,
    content_hash text NOT NULL,
    path text,
    start_line integer,
    end_line integer,
    summary text NOT NULL,
    truncated boolean DEFAULT false NOT NULL,
    result_json jsonb NOT NULL,
    content_purged_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT evidence_records_content_hash_check CHECK ((content_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT evidence_records_end_line_check CHECK (((end_line IS NULL) OR (end_line > 0))),
    CONSTRAINT evidence_records_evidence_kind_check CHECK ((evidence_kind = ANY (ARRAY['file_range'::text, 'changed_files_search'::text, 'symbol_references'::text, 'manifest'::text, 'ci_status'::text]))),
    CONSTRAINT evidence_records_head_sha_check CHECK (((length(head_sha) >= 1) AND (length(head_sha) <= 128))),
    CONSTRAINT evidence_records_id_check CHECK ((id ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT evidence_records_location_shape CHECK ((((start_line IS NULL) AND (end_line IS NULL)) OR ((path IS NOT NULL) AND (start_line IS NOT NULL) AND (end_line IS NOT NULL) AND (end_line >= start_line)))),
    CONSTRAINT evidence_records_repository_check CHECK (((length(repository) >= 1) AND (length(repository) <= 512))),
    CONSTRAINT evidence_records_request_hash_check CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT evidence_records_result_json_check CHECK ((jsonb_typeof(result_json) = 'object'::text)),
    CONSTRAINT evidence_records_start_line_check CHECK (((start_line IS NULL) OR (start_line > 0))),
    CONSTRAINT evidence_records_summary_check CHECK ((length(summary) <= 4096)),
    CONSTRAINT evidence_records_tool_name_check CHECK ((tool_name = ANY (ARRAY['read_file_range'::text, 'search_changed_files'::text, 'find_symbol_references'::text, 'read_manifest'::text, 'read_ci_status'::text])))
);

ALTER TABLE ONLY pr_agent_harness.evidence_records FORCE ROW LEVEL SECURITY;



COMMENT ON TABLE pr_agent_harness.evidence_records IS 'Immutable, fixed-revision evidence derived only from successful durable read-only tool steps.';



CREATE TABLE pr_agent_harness.evolution_candidates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    proposal_run_id uuid NOT NULL,
    dataset_id uuid NOT NULL,
    dataset_version bigint NOT NULL,
    dataset_manifest_hash text NOT NULL,
    status text DEFAULT 'research_draft'::text NOT NULL,
    candidate_json jsonb NOT NULL,
    candidate_hash text NOT NULL,
    baseline_prompt_hash text NOT NULL,
    baseline_tool_hash text NOT NULL,
    model_config_hash text NOT NULL,
    source_hash text NOT NULL,
    provenance_json jsonb NOT NULL,
    created_by_actor_type text NOT NULL,
    created_by_actor_id text NOT NULL,
    content_purged_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT evolution_candidates_baseline_prompt_hash_check CHECK ((baseline_prompt_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT evolution_candidates_baseline_tool_hash_check CHECK ((baseline_tool_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT evolution_candidates_candidate_hash_check CHECK ((candidate_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT evolution_candidates_candidate_json_check CHECK ((jsonb_typeof(candidate_json) = 'object'::text)),
    CONSTRAINT evolution_candidates_created_by_actor_id_check CHECK (((length(created_by_actor_id) >= 1) AND (length(created_by_actor_id) <= 512))),
    CONSTRAINT evolution_candidates_created_by_actor_type_check CHECK ((created_by_actor_type = ANY (ARRAY['user'::text, 'service'::text]))),
    CONSTRAINT evolution_candidates_dataset_manifest_hash_check CHECK ((dataset_manifest_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT evolution_candidates_dataset_version_check CHECK ((dataset_version > 0)),
    CONSTRAINT evolution_candidates_model_config_hash_check CHECK ((model_config_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT evolution_candidates_provenance_json_check CHECK ((jsonb_typeof(provenance_json) = 'object'::text)),
    CONSTRAINT evolution_candidates_source_hash_check CHECK ((source_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT evolution_candidates_status_check CHECK ((status = 'research_draft'::text))
);

ALTER TABLE ONLY pr_agent_harness.evolution_candidates FORCE ROW LEVEL SECURITY;



COMMENT ON TABLE pr_agent_harness.evolution_candidates IS 'Immutable research-draft review text candidates; promotion is deliberately outside P3b.';



CREATE TABLE pr_agent_harness.evolution_proposal_sources (
    tenant_id uuid NOT NULL,
    proposal_run_id uuid NOT NULL,
    dataset_id uuid NOT NULL,
    dataset_version bigint NOT NULL,
    dataset_manifest_hash text NOT NULL,
    baseline_prompt_hash text NOT NULL,
    baseline_tool_hash text NOT NULL,
    source_hash text NOT NULL,
    source_json jsonb NOT NULL,
    created_by_actor_type text NOT NULL,
    created_by_actor_id text NOT NULL,
    content_purged_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT evolution_proposal_sources_baseline_prompt_hash_check CHECK ((baseline_prompt_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT evolution_proposal_sources_baseline_tool_hash_check CHECK ((baseline_tool_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT evolution_proposal_sources_created_by_actor_id_check CHECK (((length(created_by_actor_id) >= 1) AND (length(created_by_actor_id) <= 512))),
    CONSTRAINT evolution_proposal_sources_created_by_actor_type_check CHECK ((created_by_actor_type = ANY (ARRAY['user'::text, 'service'::text]))),
    CONSTRAINT evolution_proposal_sources_dataset_manifest_hash_check CHECK ((dataset_manifest_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT evolution_proposal_sources_dataset_version_check CHECK ((dataset_version > 0)),
    CONSTRAINT evolution_proposal_sources_source_hash_check CHECK ((source_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT evolution_proposal_sources_source_json_check CHECK ((jsonb_typeof(source_json) = 'object'::text))
);

ALTER TABLE ONLY pr_agent_harness.evolution_proposal_sources FORCE ROW LEVEL SECURITY;



CREATE TABLE pr_agent_harness.evolution_release_assignments (
    tenant_id uuid NOT NULL,
    integration_id uuid NOT NULL,
    state text NOT NULL,
    routing text NOT NULL,
    candidate_id uuid,
    qualification_id uuid,
    version bigint NOT NULL,
    fraction_bps integer NOT NULL,
    salt text NOT NULL,
    activated_at timestamp with time zone,
    promoted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT evolution_release_assignments_check CHECK (((candidate_id IS NULL) = (qualification_id IS NULL))),
    CONSTRAINT evolution_release_assignments_check1 CHECK ((((routing = 'off'::text) AND (fraction_bps = 0)) OR ((routing = 'shadow'::text) AND (fraction_bps = 10000)) OR ((routing = 'canary'::text) AND ((fraction_bps >= 1) AND (fraction_bps <= 500))) OR ((routing = 'full'::text) AND (fraction_bps = 10000)))),
    CONSTRAINT evolution_release_assignments_fraction_bps_check CHECK (((fraction_bps >= 0) AND (fraction_bps <= 10000))),
    CONSTRAINT evolution_release_assignments_routing_check CHECK ((routing = ANY (ARRAY['off'::text, 'shadow'::text, 'canary'::text, 'full'::text]))),
    CONSTRAINT evolution_release_assignments_salt_check CHECK ((salt ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT evolution_release_assignments_state_check CHECK ((state = ANY (ARRAY['evaluated_experimental'::text, 'approved_canary'::text, 'promoted'::text, 'rolled_back'::text]))),
    CONSTRAINT evolution_release_assignments_version_check CHECK ((version > 0))
);

ALTER TABLE ONLY pr_agent_harness.evolution_release_assignments FORCE ROW LEVEL SECURITY;



CREATE TABLE pr_agent_harness.evolution_release_decisions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    integration_id uuid NOT NULL,
    request_id uuid NOT NULL,
    decision text NOT NULL,
    checker_actor_type text NOT NULL,
    checker_actor_id text NOT NULL,
    command_key text NOT NULL,
    request_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT evolution_release_decisions_checker_actor_type_check CHECK ((checker_actor_type = 'user'::text)),
    CONSTRAINT evolution_release_decisions_command_key_check CHECK (((length(command_key) >= 1) AND (length(command_key) <= 200))),
    CONSTRAINT evolution_release_decisions_decision_check CHECK ((decision = ANY (ARRAY['approve'::text, 'reject'::text]))),
    CONSTRAINT evolution_release_decisions_request_hash_check CHECK ((request_hash ~ '^[a-f0-9]{64}$'::text))
);

ALTER TABLE ONLY pr_agent_harness.evolution_release_decisions FORCE ROW LEVEL SECURITY;



CREATE TABLE pr_agent_harness.evolution_release_qualifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    integration_id uuid NOT NULL,
    candidate_id uuid NOT NULL,
    dataset_id uuid NOT NULL,
    dataset_version bigint NOT NULL,
    validation_evaluation_id uuid NOT NULL,
    holdout_evaluation_id uuid NOT NULL,
    policy_json jsonb NOT NULL,
    policy_hash text NOT NULL,
    evidence_json jsonb NOT NULL,
    evidence_hash text NOT NULL,
    created_by_actor_type text NOT NULL,
    created_by_actor_id text NOT NULL,
    command_key text NOT NULL,
    request_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT evolution_release_qualifications_command_key_check CHECK (((length(command_key) >= 1) AND (length(command_key) <= 200))),
    CONSTRAINT evolution_release_qualifications_created_by_actor_id_check CHECK (((length(created_by_actor_id) >= 1) AND (length(created_by_actor_id) <= 512))),
    CONSTRAINT evolution_release_qualifications_created_by_actor_type_check CHECK ((created_by_actor_type = ANY (ARRAY['user'::text, 'service'::text]))),
    CONSTRAINT evolution_release_qualifications_dataset_version_check CHECK ((dataset_version > 0)),
    CONSTRAINT evolution_release_qualifications_evidence_hash_check CHECK ((evidence_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT evolution_release_qualifications_evidence_json_check CHECK ((jsonb_typeof(evidence_json) = 'object'::text)),
    CONSTRAINT evolution_release_qualifications_policy_hash_check CHECK ((policy_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT evolution_release_qualifications_policy_json_check CHECK ((jsonb_typeof(policy_json) = 'object'::text)),
    CONSTRAINT evolution_release_qualifications_request_hash_check CHECK ((request_hash ~ '^[a-f0-9]{64}$'::text))
);

ALTER TABLE ONLY pr_agent_harness.evolution_release_qualifications FORCE ROW LEVEL SECURITY;



CREATE TABLE pr_agent_harness.evolution_release_receipts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    integration_id uuid NOT NULL,
    request_id uuid,
    kind text NOT NULL,
    assignment_version bigint NOT NULL,
    before_json jsonb NOT NULL,
    after_json jsonb NOT NULL,
    evidence_json jsonb NOT NULL,
    evidence_hash text NOT NULL,
    actor_type text NOT NULL,
    actor_id text NOT NULL,
    command_key text NOT NULL,
    request_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT evolution_release_receipts_actor_type_check CHECK ((actor_type = ANY (ARRAY['user'::text, 'service'::text, 'system'::text]))),
    CONSTRAINT evolution_release_receipts_after_json_check CHECK ((jsonb_typeof(after_json) = 'object'::text)),
    CONSTRAINT evolution_release_receipts_assignment_version_check CHECK ((assignment_version > 0)),
    CONSTRAINT evolution_release_receipts_before_json_check CHECK ((jsonb_typeof(before_json) = 'object'::text)),
    CONSTRAINT evolution_release_receipts_command_key_check CHECK (((length(command_key) >= 1) AND (length(command_key) <= 200))),
    CONSTRAINT evolution_release_receipts_evidence_hash_check CHECK ((evidence_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT evolution_release_receipts_evidence_json_check CHECK ((jsonb_typeof(evidence_json) = 'object'::text)),
    CONSTRAINT evolution_release_receipts_kind_check CHECK ((kind = ANY (ARRAY['shadow'::text, 'canary'::text, 'promote'::text, 'rollback'::text]))),
    CONSTRAINT evolution_release_receipts_request_hash_check CHECK ((request_hash ~ '^[a-f0-9]{64}$'::text))
);

ALTER TABLE ONLY pr_agent_harness.evolution_release_receipts FORCE ROW LEVEL SECURITY;



CREATE TABLE pr_agent_harness.evolution_release_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    integration_id uuid NOT NULL,
    target text NOT NULL,
    candidate_id uuid NOT NULL,
    qualification_id uuid NOT NULL,
    expected_assignment_version bigint NOT NULL,
    candidate_bps integer NOT NULL,
    maker_actor_type text NOT NULL,
    maker_actor_id text NOT NULL,
    command_key text NOT NULL,
    request_hash text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    revoke_command_key text,
    revoke_request_hash text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT evolution_release_requests_candidate_bps_check CHECK (((candidate_bps >= 1) AND (candidate_bps <= 10000))),
    CONSTRAINT evolution_release_requests_command_key_check CHECK (((length(command_key) >= 1) AND (length(command_key) <= 200))),
    CONSTRAINT evolution_release_requests_expected_assignment_version_check CHECK ((expected_assignment_version >= 0)),
    CONSTRAINT evolution_release_requests_maker_actor_type_check CHECK ((maker_actor_type = 'user'::text)),
    CONSTRAINT evolution_release_requests_request_hash_check CHECK ((request_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT evolution_release_requests_revoke_command_key_check CHECK (((revoke_command_key IS NULL) OR ((length(revoke_command_key) >= 1) AND (length(revoke_command_key) <= 200)))),
    CONSTRAINT evolution_release_requests_revoke_request_hash_check CHECK (((revoke_request_hash IS NULL) OR (revoke_request_hash ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT evolution_release_requests_status_check CHECK ((status = ANY (ARRAY['open'::text, 'rejected'::text, 'revoked'::text, 'consumed'::text, 'expired'::text]))),
    CONSTRAINT evolution_release_requests_target_check CHECK ((target = ANY (ARRAY['shadow'::text, 'canary'::text, 'promote'::text])))
);

ALTER TABLE ONLY pr_agent_harness.evolution_release_requests FORCE ROW LEVEL SECURITY;



CREATE TABLE pr_agent_harness.evolution_run_assignments (
    tenant_id uuid NOT NULL,
    integration_id uuid NOT NULL,
    run_id uuid NOT NULL,
    assignment_version bigint NOT NULL,
    selection text NOT NULL,
    routing text NOT NULL,
    bucket integer NOT NULL,
    candidate_id uuid,
    qualification_id uuid,
    release_receipt_id uuid,
    review_text_json jsonb NOT NULL,
    review_text_hash text NOT NULL,
    prompt_hash text NOT NULL,
    tool_hash text NOT NULL,
    selection_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT evolution_run_assignments_assignment_version_check CHECK ((assignment_version >= 0)),
    CONSTRAINT evolution_run_assignments_bucket_check CHECK (((bucket >= 0) AND (bucket <= 9999))),
    CONSTRAINT evolution_run_assignments_check CHECK (((candidate_id IS NULL) = (qualification_id IS NULL))),
    CONSTRAINT evolution_run_assignments_check1 CHECK ((((selection = 'baseline'::text) AND (candidate_id IS NULL) AND (release_receipt_id IS NULL)) OR ((selection <> 'baseline'::text) AND (candidate_id IS NOT NULL) AND (release_receipt_id IS NOT NULL)))),
    CONSTRAINT evolution_run_assignments_prompt_hash_check CHECK ((prompt_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT evolution_run_assignments_review_text_hash_check CHECK ((review_text_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT evolution_run_assignments_review_text_json_check CHECK ((jsonb_typeof(review_text_json) = 'object'::text)),
    CONSTRAINT evolution_run_assignments_routing_check CHECK ((routing = ANY (ARRAY['off'::text, 'shadow'::text, 'canary'::text, 'full'::text]))),
    CONSTRAINT evolution_run_assignments_selection_check CHECK ((selection = ANY (ARRAY['baseline'::text, 'control'::text, 'candidate'::text]))),
    CONSTRAINT evolution_run_assignments_selection_hash_check CHECK ((selection_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT evolution_run_assignments_tool_hash_check CHECK ((tool_hash ~ '^[a-f0-9]{64}$'::text))
);

ALTER TABLE ONLY pr_agent_harness.evolution_run_assignments FORCE ROW LEVEL SECURITY;



CREATE TABLE pr_agent_harness.feedback_observations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    integration_id uuid NOT NULL,
    source_run_id uuid NOT NULL,
    artifact_hash text NOT NULL,
    command_key text NOT NULL,
    request_hash text NOT NULL,
    actor_type text NOT NULL,
    actor_id text NOT NULL,
    observation_json jsonb NOT NULL,
    content_purged_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT feedback_observations_actor_type_check CHECK ((actor_type = ANY (ARRAY['user'::text, 'service'::text]))),
    CONSTRAINT feedback_observations_artifact_hash_check CHECK ((artifact_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT feedback_observations_command_key_check CHECK (((length(command_key) >= 1) AND (length(command_key) <= 200))),
    CONSTRAINT feedback_observations_observation_json_check CHECK ((jsonb_typeof(observation_json) = 'object'::text)),
    CONSTRAINT feedback_observations_request_hash_check CHECK ((request_hash ~ '^[a-f0-9]{64}$'::text))
);

ALTER TABLE ONLY pr_agent_harness.feedback_observations FORCE ROW LEVEL SECURITY;



COMMENT ON TABLE pr_agent_harness.feedback_observations IS 'Idempotent user observations; never a trusted evaluation label.';



CREATE TABLE pr_agent_harness.finding_candidates (
    id text NOT NULL,
    tenant_id uuid NOT NULL,
    integration_id uuid NOT NULL,
    run_id uuid NOT NULL,
    step_id uuid NOT NULL,
    source_role text NOT NULL,
    head_sha text NOT NULL,
    content_hash text NOT NULL,
    record_json jsonb NOT NULL,
    content_purged_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT finding_candidates_content_hash_check CHECK ((content_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT finding_candidates_head_sha_check CHECK (((length(head_sha) >= 1) AND (length(head_sha) <= 128))),
    CONSTRAINT finding_candidates_id_check CHECK ((id ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT finding_candidates_record_json_check CHECK ((jsonb_typeof(record_json) = 'object'::text)),
    CONSTRAINT finding_candidates_source_role_check CHECK ((source_role = ANY (ARRAY['security'::text, 'correctness'::text])))
);

ALTER TABLE ONLY pr_agent_harness.finding_candidates FORCE ROW LEVEL SECURITY;



CREATE TABLE pr_agent_harness.finding_decisions (
    id text NOT NULL,
    tenant_id uuid NOT NULL,
    integration_id uuid NOT NULL,
    run_id uuid NOT NULL,
    step_id uuid NOT NULL,
    candidate_id text NOT NULL,
    stage text NOT NULL,
    head_sha text NOT NULL,
    content_hash text NOT NULL,
    record_json jsonb NOT NULL,
    content_purged_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT finding_decisions_candidate_id_check CHECK ((candidate_id ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT finding_decisions_content_hash_check CHECK ((content_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT finding_decisions_head_sha_check CHECK (((length(head_sha) >= 1) AND (length(head_sha) <= 128))),
    CONSTRAINT finding_decisions_id_check CHECK ((id ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT finding_decisions_record_json_check CHECK ((jsonb_typeof(record_json) = 'object'::text)),
    CONSTRAINT finding_decisions_stage_check CHECK ((stage = ANY (ARRAY['critic'::text, 'gate'::text])))
);

ALTER TABLE ONLY pr_agent_harness.finding_decisions FORCE ROW LEVEL SECURITY;



CREATE TABLE pr_agent_harness.fix_approval_consumptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    proposal_run_id uuid NOT NULL,
    approval_id uuid NOT NULL,
    publish_run_id uuid NOT NULL,
    batch_id uuid NOT NULL,
    operation_set_hash text NOT NULL,
    intent_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT fix_approval_consumptions_intent_hash_check CHECK ((intent_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT fix_approval_consumptions_operation_set_hash_check CHECK ((operation_set_hash ~ '^[a-f0-9]{64}$'::text))
);

ALTER TABLE ONLY pr_agent_harness.fix_approval_consumptions FORCE ROW LEVEL SECURITY;



COMMENT ON TABLE pr_agent_harness.fix_approval_consumptions IS 'One exact approval consumed atomically by one sealed publication batch.';



CREATE TABLE pr_agent_harness.fix_approval_decisions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    proposal_run_id uuid NOT NULL,
    approval_id uuid NOT NULL,
    command_key text NOT NULL,
    request_hash text NOT NULL,
    decision text NOT NULL,
    actor_type text NOT NULL,
    actor_id text NOT NULL,
    publish_run_id uuid,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT fix_approval_decisions_actor_type_check CHECK ((actor_type = ANY (ARRAY['user'::text, 'service'::text]))),
    CONSTRAINT fix_approval_decisions_decision_check CHECK ((decision = ANY (ARRAY['approve'::text, 'revoke'::text]))),
    CONSTRAINT fix_approval_decisions_request_hash_check CHECK ((request_hash ~ '^[a-f0-9]{64}$'::text))
);

ALTER TABLE ONLY pr_agent_harness.fix_approval_decisions FORCE ROW LEVEL SECURITY;



CREATE TABLE pr_agent_harness.fix_approval_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    integration_id uuid NOT NULL,
    proposal_run_id uuid NOT NULL,
    proposal_id text NOT NULL,
    intent_hash text NOT NULL,
    command_key text NOT NULL,
    generation integer NOT NULL,
    intent_json jsonb NOT NULL,
    maker_actor_type text NOT NULL,
    maker_actor_id text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    approved_publish_run_id uuid,
    approved_at timestamp with time zone,
    revoked_at timestamp with time zone,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT fix_approval_requests_command_key_check CHECK (((length(command_key) >= 1) AND (length(command_key) <= 200))),
    CONSTRAINT fix_approval_requests_generation_check CHECK ((generation > 0)),
    CONSTRAINT fix_approval_requests_intent_hash_check CHECK ((intent_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT fix_approval_requests_intent_json_check CHECK ((jsonb_typeof(intent_json) = 'object'::text)),
    CONSTRAINT fix_approval_requests_maker_actor_type_check CHECK ((maker_actor_type = ANY (ARRAY['user'::text, 'service'::text]))),
    CONSTRAINT fix_approval_requests_status_check CHECK ((status = ANY (ARRAY['open'::text, 'approved'::text, 'revoked'::text, 'expired'::text, 'consumed'::text]))),
    CONSTRAINT fix_approval_requests_version_check CHECK ((version > 0))
);

ALTER TABLE ONLY pr_agent_harness.fix_approval_requests FORCE ROW LEVEL SECURITY;



CREATE TABLE pr_agent_harness.fix_artifacts (
    id text NOT NULL,
    tenant_id uuid NOT NULL,
    integration_id uuid NOT NULL,
    run_id uuid NOT NULL,
    content_hash text NOT NULL,
    artifact_json jsonb NOT NULL,
    content_purged_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT fix_artifacts_artifact_json_check CHECK ((jsonb_typeof(artifact_json) = 'object'::text)),
    CONSTRAINT fix_artifacts_content_hash_check CHECK ((content_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT fix_artifacts_id_check CHECK ((id ~ '^[a-f0-9]{64}$'::text))
);

ALTER TABLE ONLY pr_agent_harness.fix_artifacts FORCE ROW LEVEL SECURITY;



CREATE TABLE pr_agent_harness.fix_proposals (
    id text NOT NULL,
    tenant_id uuid NOT NULL,
    integration_id uuid NOT NULL,
    run_id uuid NOT NULL,
    source_review_run_id uuid NOT NULL,
    finding_id text NOT NULL,
    revision integer NOT NULL,
    repository text NOT NULL,
    base_sha text NOT NULL,
    head_sha text NOT NULL,
    source_bundle_ref text NOT NULL,
    source_bundle_hash text NOT NULL,
    code_patch text NOT NULL,
    test_patch text NOT NULL,
    code_patch_hash text NOT NULL,
    test_patch_hash text NOT NULL,
    proposal_hash text NOT NULL,
    policy_id text NOT NULL,
    policy_hash text NOT NULL,
    trusted_command_hash text NOT NULL,
    dependency_lock_path text NOT NULL,
    dependency_lock_hash text NOT NULL,
    sandbox_policy_hash text NOT NULL,
    image_digest text NOT NULL,
    publisher_policy_hash text NOT NULL,
    qualification_status text NOT NULL,
    proposal_json jsonb NOT NULL,
    content_hash text NOT NULL,
    content_purged_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT fix_proposals_code_patch_hash_check CHECK ((code_patch_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT fix_proposals_content_hash_check CHECK ((content_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT fix_proposals_dependency_lock_hash_check CHECK ((dependency_lock_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT fix_proposals_dependency_lock_path_check CHECK (((length(dependency_lock_path) >= 1) AND (length(dependency_lock_path) <= 256))),
    CONSTRAINT fix_proposals_id_check CHECK ((id ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT fix_proposals_image_digest_check CHECK ((image_digest ~ '^sha256:[a-f0-9]{64}$'::text)),
    CONSTRAINT fix_proposals_policy_hash_check CHECK ((policy_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT fix_proposals_proposal_hash_check CHECK ((proposal_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT fix_proposals_proposal_json_check CHECK ((jsonb_typeof(proposal_json) = 'object'::text)),
    CONSTRAINT fix_proposals_publisher_policy_hash_check CHECK ((publisher_policy_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT fix_proposals_qualification_status_check CHECK ((qualification_status = ANY (ARRAY['verified'::text, 'not_verified'::text]))),
    CONSTRAINT fix_proposals_revision_check CHECK (((revision >= 1) AND (revision <= 2))),
    CONSTRAINT fix_proposals_sandbox_policy_hash_check CHECK ((sandbox_policy_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT fix_proposals_source_bundle_hash_check CHECK ((source_bundle_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT fix_proposals_test_patch_hash_check CHECK ((test_patch_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT fix_proposals_trusted_command_hash_check CHECK ((trusted_command_hash ~ '^[a-f0-9]{64}$'::text))
);

ALTER TABLE ONLY pr_agent_harness.fix_proposals FORCE ROW LEVEL SECURITY;



COMMENT ON TABLE pr_agent_harness.fix_proposals IS 'Immutable code/test patch proposals at a fixed reviewed head; revisions never overwrite prior content.';



CREATE TABLE pr_agent_harness.fix_relevance_attestations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    integration_id uuid NOT NULL,
    proposal_run_id uuid NOT NULL,
    proposal_id text NOT NULL,
    command_key text NOT NULL,
    request_hash text NOT NULL,
    proposal_hash text NOT NULL,
    test_patch_hash text NOT NULL,
    finding_id text NOT NULL,
    verification_result_hash text NOT NULL,
    rubric_version text NOT NULL,
    reason text NOT NULL,
    actor_type text NOT NULL,
    actor_id text NOT NULL,
    attestation_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT fix_relevance_attestations_actor_type_check CHECK ((actor_type = ANY (ARRAY['user'::text, 'service'::text]))),
    CONSTRAINT fix_relevance_attestations_attestation_hash_check CHECK ((attestation_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT fix_relevance_attestations_finding_id_check CHECK ((finding_id ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT fix_relevance_attestations_proposal_hash_check CHECK ((proposal_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT fix_relevance_attestations_reason_check CHECK (((length(reason) >= 20) AND (length(reason) <= 4000))),
    CONSTRAINT fix_relevance_attestations_request_hash_check CHECK ((request_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT fix_relevance_attestations_rubric_version_check CHECK (((length(rubric_version) >= 1) AND (length(rubric_version) <= 128))),
    CONSTRAINT fix_relevance_attestations_test_patch_hash_check CHECK ((test_patch_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT fix_relevance_attestations_verification_result_hash_check CHECK ((verification_result_hash ~ '^[a-f0-9]{64}$'::text))
);

ALTER TABLE ONLY pr_agent_harness.fix_relevance_attestations FORCE ROW LEVEL SECURITY;



CREATE TABLE pr_agent_harness.fix_run_findings (
    tenant_id uuid NOT NULL,
    run_id uuid NOT NULL,
    source_review_run_id uuid NOT NULL,
    finding_id text NOT NULL,
    gate_decision_id text NOT NULL,
    finding_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT fix_run_findings_finding_hash_check CHECK ((finding_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT fix_run_findings_finding_id_check CHECK ((finding_id ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT fix_run_findings_gate_decision_id_check CHECK ((gate_decision_id ~ '^[a-f0-9]{64}$'::text))
);

ALTER TABLE ONLY pr_agent_harness.fix_run_findings FORCE ROW LEVEL SECURITY;



CREATE TABLE pr_agent_harness.fix_run_sources (
    tenant_id uuid NOT NULL,
    integration_id uuid NOT NULL,
    run_id uuid NOT NULL,
    source_review_run_id uuid NOT NULL,
    finding_id text NOT NULL,
    repository text NOT NULL,
    base_sha text NOT NULL,
    head_sha text NOT NULL,
    source_bundle_ref text NOT NULL,
    source_bundle_hash text NOT NULL,
    allowed_paths_json jsonb NOT NULL,
    source_json jsonb NOT NULL,
    content_hash text NOT NULL,
    content_purged_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT fix_run_sources_allowed_paths_json_check CHECK ((jsonb_typeof(allowed_paths_json) = 'array'::text)),
    CONSTRAINT fix_run_sources_content_hash_check CHECK ((content_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT fix_run_sources_finding_id_check CHECK ((finding_id ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT fix_run_sources_repository_check CHECK (((length(repository) >= 1) AND (length(repository) <= 512))),
    CONSTRAINT fix_run_sources_source_bundle_hash_check CHECK ((source_bundle_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT fix_run_sources_source_json_check CHECK ((jsonb_typeof(source_json) = 'object'::text))
);

ALTER TABLE ONLY pr_agent_harness.fix_run_sources FORCE ROW LEVEL SECURITY;



CREATE TABLE pr_agent_harness.fix_verifications (
    id text NOT NULL,
    tenant_id uuid NOT NULL,
    integration_id uuid NOT NULL,
    run_id uuid NOT NULL,
    proposal_id text NOT NULL,
    verification_job_id uuid NOT NULL,
    verdict text NOT NULL,
    proposal_hash text NOT NULL,
    policy_hash text NOT NULL,
    result_hash text NOT NULL,
    result_json jsonb NOT NULL,
    content_purged_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT fix_verifications_id_check CHECK ((id ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT fix_verifications_policy_hash_check CHECK ((policy_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT fix_verifications_proposal_hash_check CHECK ((proposal_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT fix_verifications_result_hash_check CHECK ((result_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT fix_verifications_result_json_check CHECK ((jsonb_typeof(result_json) = 'object'::text)),
    CONSTRAINT fix_verifications_verdict_check CHECK ((verdict = ANY (ARRAY['proven'::text, 'suggestion_only'::text, 'failed'::text])))
);

ALTER TABLE ONLY pr_agent_harness.fix_verifications FORCE ROW LEVEL SECURITY;



CREATE TABLE pr_agent_harness.integration_bindings (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    platform text NOT NULL,
    origin text NOT NULL,
    repository text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    provider_repository_id text,
    provider_actor_id text,
    credential_ref text,
    publication_state text DEFAULT 'blocked'::text NOT NULL,
    publication_generation bigint DEFAULT 0 NOT NULL,
    authority_version bigint DEFAULT 0 NOT NULL,
    quiescence_receipt jsonb,
    review_execution_mode text DEFAULT 'legacy_sync'::text NOT NULL,
    execution_mode_generation bigint DEFAULT 0 NOT NULL,
    review_execution_state text DEFAULT 'active'::text NOT NULL,
    execution_drain_receipt jsonb,
    execution_resume_receipt jsonb,
    execution_switch_receipt jsonb,
    CONSTRAINT integration_active_authority CHECK (((publication_state = 'blocked'::text) OR ((provider_repository_id IS NOT NULL) AND (provider_actor_id IS NOT NULL) AND (credential_ref IS NOT NULL) AND (publication_generation > 0) AND (quiescence_receipt IS NOT NULL)))),
    CONSTRAINT integration_bindings_async_execution_shape CHECK (((review_execution_mode = 'legacy_sync'::text) OR ((publication_state = ANY (ARRAY['active'::text, 'draining'::text])) AND (publication_generation > 0) AND (execution_mode_generation > 0)))),
    CONSTRAINT integration_bindings_authority_version_check CHECK ((authority_version >= 0)),
    CONSTRAINT integration_bindings_execution_mode_generation_check CHECK ((execution_mode_generation >= 0)),
    CONSTRAINT integration_bindings_origin_check CHECK ((length(origin) > 0)),
    CONSTRAINT integration_bindings_platform_check CHECK ((platform = ANY (ARRAY['github'::text, 'gitlab'::text]))),
    CONSTRAINT integration_bindings_publication_generation_check CHECK ((publication_generation >= 0)),
    CONSTRAINT integration_bindings_publication_state_check CHECK ((publication_state = ANY (ARRAY['blocked'::text, 'active'::text, 'draining'::text]))),
    CONSTRAINT integration_bindings_repository_check CHECK ((length(repository) > 0)),
    CONSTRAINT integration_bindings_review_execution_mode_check CHECK ((review_execution_mode = ANY (ARRAY['legacy_sync'::text, 'harness_async'::text]))),
    CONSTRAINT integration_bindings_review_execution_state_check CHECK ((review_execution_state = ANY (ARRAY['active'::text, 'draining'::text]))),
    CONSTRAINT integration_provider_actor_id CHECK (((provider_actor_id IS NULL) OR (provider_actor_id ~ '^[1-9][0-9]*$'::text))),
    CONSTRAINT integration_provider_repository_id CHECK (((provider_repository_id IS NULL) OR (provider_repository_id ~ '^[1-9][0-9]*$'::text)))
);



COMMENT ON TABLE pr_agent_harness.integration_bindings IS 'Trusted server-side platform-to-tenant registry. It is not exposed as a tenant-selected API resource.';



COMMENT ON COLUMN pr_agent_harness.integration_bindings.quiescence_receipt IS 'Operator evidence of stopped/drained pre-ledger publishers; PG cannot fence an old binary that does not consult this registry.';



COMMENT ON COLUMN pr_agent_harness.integration_bindings.review_execution_state IS 'Admission state for review execution. Draining blocks new work while existing Runs may finish.';



COMMENT ON COLUMN pr_agent_harness.integration_bindings.execution_drain_receipt IS 'Administrative evidence for the most recent execution drain.';



COMMENT ON COLUMN pr_agent_harness.integration_bindings.execution_resume_receipt IS 'Administrative evidence for aborting an execution drain without changing mode generation.';



COMMENT ON COLUMN pr_agent_harness.integration_bindings.execution_switch_receipt IS 'Administrative evidence for the most recent execution mode switch.';



CREATE TABLE pr_agent_harness.job_queue (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    run_id uuid NOT NULL,
    job_kind text NOT NULL,
    status text DEFAULT 'ready'::text NOT NULL,
    dispatch_generation bigint DEFAULT 1 NOT NULL,
    priority integer DEFAULT 0 NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 5 NOT NULL,
    claimed_run_epoch bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    last_error_code text,
    expected_run_version bigint,
    expected_batch_id uuid,
    expected_operation_set_hash text,
    outcome_generation bigint,
    command_receipt_id uuid,
    wait_id uuid,
    wait_version bigint,
    job_payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT job_queue_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT job_queue_claimed_run_epoch_check CHECK ((claimed_run_epoch > 0)),
    CONSTRAINT job_queue_dispatch_generation_check CHECK ((dispatch_generation > 0)),
    CONSTRAINT job_queue_expected_operation_set_hash_check CHECK ((expected_operation_set_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT job_queue_expected_run_version_check CHECK ((expected_run_version >= 0)),
    CONSTRAINT job_queue_job_kind_check CHECK ((job_kind = ANY (ARRAY['start'::text, 'resume'::text, 'retry'::text, 'recover'::text, 'publication_outcome'::text, 'manual_resume'::text]))),
    CONSTRAINT job_queue_job_payload_json_check CHECK ((jsonb_typeof(job_payload_json) = 'object'::text)),
    CONSTRAINT job_queue_max_attempts_check CHECK ((max_attempts > 0)),
    CONSTRAINT job_queue_outcome_generation_check CHECK ((outcome_generation > 0)),
    CONSTRAINT job_queue_running_epoch CHECK (((status <> 'running'::text) OR (claimed_run_epoch IS NOT NULL))),
    CONSTRAINT job_queue_status_check CHECK ((status = ANY (ARRAY['ready'::text, 'running'::text, 'retry_wait'::text, 'completed'::text, 'cancelled'::text, 'dead_letter'::text]))),
    CONSTRAINT job_queue_wait_version_check CHECK ((wait_version > 0))
);

ALTER TABLE ONLY pr_agent_harness.job_queue FORCE ROW LEVEL SECURITY;



CREATE TABLE pr_agent_harness.model_budget_reservations (
    tenant_id uuid NOT NULL,
    run_id uuid NOT NULL,
    model_call_id uuid NOT NULL,
    reserved_input_tokens bigint NOT NULL,
    reserved_output_tokens bigint NOT NULL,
    reserved_cost_micros bigint NOT NULL,
    actual_input_tokens bigint,
    actual_output_tokens bigint,
    actual_cost_micros bigint,
    status text DEFAULT 'reserved'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT model_budget_actual_shape CHECK ((((status = 'settled'::text) AND (actual_input_tokens IS NOT NULL) AND (actual_output_tokens IS NOT NULL) AND (actual_cost_micros IS NOT NULL)) OR ((status <> 'settled'::text) AND (actual_input_tokens IS NULL) AND (actual_output_tokens IS NULL) AND (actual_cost_micros IS NULL)))),
    CONSTRAINT model_budget_reservations_actual_cost_micros_check CHECK ((actual_cost_micros >= 0)),
    CONSTRAINT model_budget_reservations_actual_input_tokens_check CHECK ((actual_input_tokens >= 0)),
    CONSTRAINT model_budget_reservations_actual_output_tokens_check CHECK ((actual_output_tokens >= 0)),
    CONSTRAINT model_budget_reservations_reserved_cost_micros_check CHECK ((reserved_cost_micros >= 0)),
    CONSTRAINT model_budget_reservations_reserved_input_tokens_check CHECK ((reserved_input_tokens >= 0)),
    CONSTRAINT model_budget_reservations_reserved_output_tokens_check CHECK ((reserved_output_tokens >= 0)),
    CONSTRAINT model_budget_reservations_status_check CHECK ((status = ANY (ARRAY['reserved'::text, 'settled'::text, 'released'::text, 'pending'::text])))
);

ALTER TABLE ONLY pr_agent_harness.model_budget_reservations FORCE ROW LEVEL SECURITY;



COMMENT ON TABLE pr_agent_harness.model_budget_reservations IS 'Unknown provider cost remains pending and consumes the Run envelope.';



CREATE TABLE pr_agent_harness.model_calls (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    run_id uuid NOT NULL,
    step_id uuid NOT NULL,
    step_attempt_id uuid NOT NULL,
    physical_ordinal integer NOT NULL,
    provider text NOT NULL,
    model text NOT NULL,
    request_kind text NOT NULL,
    request_hash text NOT NULL,
    request_metadata_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    input_token_bound bigint NOT NULL,
    output_token_bound bigint NOT NULL,
    provider_request_id text,
    provider_model_version text,
    response_json jsonb,
    response_hash text,
    status text DEFAULT 'prepared'::text NOT NULL,
    error_code text,
    lease_epoch bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone,
    finished_at timestamp with time zone,
    content_purged_at timestamp with time zone,
    CONSTRAINT model_calls_input_token_bound_check CHECK ((input_token_bound >= 0)),
    CONSTRAINT model_calls_lease_epoch_check CHECK ((lease_epoch > 0)),
    CONSTRAINT model_calls_model_check CHECK ((length(model) > 0)),
    CONSTRAINT model_calls_output_token_bound_check CHECK ((output_token_bound >= 0)),
    CONSTRAINT model_calls_physical_ordinal_check CHECK ((physical_ordinal > 0)),
    CONSTRAINT model_calls_provider_check CHECK ((provider = ANY (ARRAY['openai'::text, 'openai-compatible'::text, 'anthropic'::text, 'gemini'::text]))),
    CONSTRAINT model_calls_request_hash_check CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT model_calls_request_kind_check CHECK ((length(request_kind) > 0)),
    CONSTRAINT model_calls_request_metadata_json_check CHECK ((jsonb_typeof(request_metadata_json) = 'object'::text)),
    CONSTRAINT model_calls_response_hash_check CHECK (((response_hash IS NULL) OR (response_hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT model_calls_result_shape CHECK ((((status = ANY (ARRAY['prepared'::text, 'in_flight'::text, 'unknown'::text])) AND (finished_at IS NULL)) OR ((status = ANY (ARRAY['succeeded'::text, 'failed_definite'::text])) AND (finished_at IS NOT NULL)))),
    CONSTRAINT model_calls_status_check CHECK ((status = ANY (ARRAY['prepared'::text, 'in_flight'::text, 'succeeded'::text, 'failed_definite'::text, 'unknown'::text]))),
    CONSTRAINT model_calls_success_response CHECK (((status <> 'succeeded'::text) OR ((response_json IS NOT NULL) AND (response_hash IS NOT NULL))))
);

ALTER TABLE ONLY pr_agent_harness.model_calls FORCE ROW LEVEL SECURITY;



COMMENT ON TABLE pr_agent_harness.model_calls IS 'One row per physical provider request. Ordinal is attempt-local; compatibility fallback is a new ordinal.';



COMMENT ON COLUMN pr_agent_harness.model_calls.content_purged_at IS 'Administrative retention timestamp. Raw request metadata and response content are removed; hashes and usage remain.';



CREATE TABLE pr_agent_harness.model_pricing_snapshots (
    tenant_id uuid NOT NULL,
    pricing_hash text NOT NULL,
    pricing_version text NOT NULL,
    provider text NOT NULL,
    model text NOT NULL,
    currency text NOT NULL,
    rates_json jsonb NOT NULL,
    policy_json jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT model_pricing_snapshots_currency_check CHECK ((currency ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT model_pricing_snapshots_model_check CHECK ((length(model) > 0)),
    CONSTRAINT model_pricing_snapshots_policy_json_check CHECK ((jsonb_typeof(policy_json) = 'object'::text)),
    CONSTRAINT model_pricing_snapshots_pricing_hash_check CHECK ((pricing_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT model_pricing_snapshots_pricing_version_check CHECK ((length(pricing_version) > 0)),
    CONSTRAINT model_pricing_snapshots_provider_check CHECK ((provider = ANY (ARRAY['openai'::text, 'openai-compatible'::text, 'anthropic'::text, 'gemini'::text]))),
    CONSTRAINT model_pricing_snapshots_rates_json_check CHECK ((jsonb_typeof(rates_json) = 'object'::text))
);

ALTER TABLE ONLY pr_agent_harness.model_pricing_snapshots FORCE ROW LEVEL SECURITY;



CREATE TABLE pr_agent_harness.publication_batch_operations (
    tenant_id uuid NOT NULL,
    batch_id uuid NOT NULL,
    ordinal integer NOT NULL,
    business_operation_id text NOT NULL,
    action_state text DEFAULT 'active'::text NOT NULL,
    skipped_at timestamp with time zone,
    skip_reason text,
    CONSTRAINT publication_batch_operations_action_shape CHECK ((((action_state = 'active'::text) AND (skipped_at IS NULL) AND (skip_reason IS NULL)) OR ((action_state = 'skipped'::text) AND (skipped_at IS NOT NULL) AND (skip_reason = ANY (ARRAY['batch_predecessor_failed'::text, 'run_cancelled_before_dispatch'::text]))))),
    CONSTRAINT publication_batch_operations_action_state_check CHECK ((action_state = ANY (ARRAY['active'::text, 'skipped'::text]))),
    CONSTRAINT publication_batch_operations_business_operation_id_check CHECK ((business_operation_id ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT publication_batch_operations_ordinal_check CHECK ((ordinal >= 0))
);

ALTER TABLE ONLY pr_agent_harness.publication_batch_operations FORCE ROW LEVEL SECURITY;



COMMENT ON TABLE pr_agent_harness.publication_batch_operations IS 'Complete ordered operation set frozen before any external publication call.';



COMMENT ON COLUMN pr_agent_harness.publication_batch_operations.action_state IS 'Per-batch disposition. Skipping never rewrites a shared operation still actionable from another batch.';



CREATE TABLE pr_agent_harness.publication_batches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    integration_id uuid NOT NULL,
    platform text NOT NULL,
    origin text NOT NULL,
    repository text NOT NULL,
    target text NOT NULL,
    revision text NOT NULL,
    authority_generation bigint NOT NULL,
    source_key text NOT NULL,
    source_hash text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    seal_state text DEFAULT 'building'::text NOT NULL,
    sealed_at timestamp with time zone,
    operation_count integer,
    operation_set_hash text,
    execution_mode_generation bigint DEFAULT 0 NOT NULL,
    CONSTRAINT publication_batches_authority_generation_check CHECK ((authority_generation >= 0)),
    CONSTRAINT publication_batches_execution_mode_generation_check CHECK ((execution_mode_generation >= 0)),
    CONSTRAINT publication_batches_operation_count_check CHECK ((operation_count >= 0)),
    CONSTRAINT publication_batches_operation_set_hash_check CHECK (((operation_set_hash IS NULL) OR (operation_set_hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT publication_batches_origin_check CHECK ((length(origin) > 0)),
    CONSTRAINT publication_batches_platform_check CHECK ((platform = ANY (ARRAY['github'::text, 'gitlab'::text]))),
    CONSTRAINT publication_batches_repository_check CHECK ((length(repository) > 0)),
    CONSTRAINT publication_batches_revision_check CHECK ((length(revision) > 0)),
    CONSTRAINT publication_batches_seal_shape CHECK ((((seal_state = 'building'::text) AND (sealed_at IS NULL) AND (operation_count IS NULL) AND (operation_set_hash IS NULL)) OR ((seal_state = 'sealed'::text) AND (sealed_at IS NOT NULL) AND (operation_count IS NOT NULL) AND (operation_set_hash IS NOT NULL)))),
    CONSTRAINT publication_batches_seal_state_check CHECK ((seal_state = ANY (ARRAY['building'::text, 'sealed'::text]))),
    CONSTRAINT publication_batches_source_hash_check CHECK ((source_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT publication_batches_source_key_check CHECK ((length(source_key) > 0)),
    CONSTRAINT publication_batches_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'waiting_reconciliation'::text, 'succeeded'::text, 'failed_definite'::text]))),
    CONSTRAINT publication_batches_target_check CHECK ((length(target) > 0))
);

ALTER TABLE ONLY pr_agent_harness.publication_batches FORCE ROW LEVEL SECURITY;



COMMENT ON TABLE pr_agent_harness.publication_batches IS 'Immutable, ordered publication decisions keyed by their upstream source event.';



CREATE TABLE pr_agent_harness.publication_command_receipts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    business_operation_id text NOT NULL,
    command_key text NOT NULL,
    request_hash text NOT NULL,
    decision text NOT NULL,
    actor_type text NOT NULL,
    actor_id text NOT NULL,
    evidence_json jsonb NOT NULL,
    remote_id text,
    previous_status text NOT NULL,
    resulting_status text NOT NULL,
    previous_version bigint NOT NULL,
    resulting_version bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT publication_command_receipts_actor_id_check CHECK ((length(actor_id) > 0)),
    CONSTRAINT publication_command_receipts_actor_type_check CHECK ((actor_type = ANY (ARRAY['user'::text, 'service'::text]))),
    CONSTRAINT publication_command_receipts_business_operation_id_check CHECK ((business_operation_id ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT publication_command_receipts_check CHECK ((resulting_version > previous_version)),
    CONSTRAINT publication_command_receipts_command_key_check CHECK ((length(command_key) > 0)),
    CONSTRAINT publication_command_receipts_decision_check CHECK ((decision = ANY (ARRAY['confirm_occurred'::text, 'confirm_not_occurred'::text, 'authorize_retry'::text, 'abandon_publication'::text]))),
    CONSTRAINT publication_command_receipts_evidence_json_check CHECK ((jsonb_typeof(evidence_json) = 'object'::text)),
    CONSTRAINT publication_command_receipts_previous_version_check CHECK ((previous_version >= 0)),
    CONSTRAINT publication_command_receipts_request_hash_check CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text))
);

ALTER TABLE ONLY pr_agent_harness.publication_command_receipts FORCE ROW LEVEL SECURITY;



COMMENT ON TABLE pr_agent_harness.publication_command_receipts IS 'Idempotent administrator assertions and retry authorizations for unresolved publication operations.';



CREATE TABLE pr_agent_harness.publication_slots (
    tenant_id uuid NOT NULL,
    integration_id uuid NOT NULL,
    target text NOT NULL,
    publication_slot text NOT NULL,
    active_business_operation_id text NOT NULL,
    generation bigint DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT publication_slots_active_business_operation_id_check CHECK ((active_business_operation_id ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT publication_slots_generation_check CHECK ((generation > 0)),
    CONSTRAINT publication_slots_publication_slot_check CHECK ((length(publication_slot) > 0)),
    CONSTRAINT publication_slots_target_check CHECK ((length(target) > 0))
);

ALTER TABLE ONLY pr_agent_harness.publication_slots FORCE ROW LEVEL SECURITY;



CREATE TABLE pr_agent_harness.repository_operations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    integration_id uuid NOT NULL,
    business_operation_id text NOT NULL,
    platform text NOT NULL,
    origin text NOT NULL,
    repository text NOT NULL,
    target text NOT NULL,
    revision text NOT NULL,
    operation_type text DEFAULT 'publication'::text NOT NULL,
    publication_slot text NOT NULL,
    payload_hash text NOT NULL,
    marker text NOT NULL,
    status text DEFAULT 'prepared'::text NOT NULL,
    outcome_code text,
    remote_id text,
    attempt_count integer DEFAULT 0 NOT NULL,
    version bigint DEFAULT 0 NOT NULL,
    last_error_code text,
    prepared_at timestamp with time zone DEFAULT now() NOT NULL,
    dispatched_at timestamp with time zone,
    resolved_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    authority_generation bigint,
    payload_json jsonb,
    evidence_json jsonb,
    command_receipt_json jsonb,
    next_reconcile_at timestamp with time zone,
    reconcile_attempt_count integer DEFAULT 0 NOT NULL,
    reconcile_claim_owner text,
    reconcile_claim_version bigint DEFAULT 0 NOT NULL,
    reconcile_claim_expires_at timestamp with time zone,
    CONSTRAINT repository_operations_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT repository_operations_authority_generation_check CHECK ((authority_generation >= 0)),
    CONSTRAINT repository_operations_business_operation_id_check CHECK ((business_operation_id ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT repository_operations_marker_check CHECK ((length(marker) > 0)),
    CONSTRAINT repository_operations_operation_type_check CHECK ((operation_type = ANY (ARRAY['publication'::text, 'fix_branch'::text, 'fix_commit'::text, 'fix_draft_pr'::text]))),
    CONSTRAINT repository_operations_origin_check CHECK ((length(origin) > 0)),
    CONSTRAINT repository_operations_outcome_code_check CHECK ((outcome_code = ANY (ARRAY['current'::text, 'stale'::text, 'rejected'::text, 'no_effect'::text, 'not_occurred_confirmed'::text, 'publication_abandoned'::text]))),
    CONSTRAINT repository_operations_payload_hash_check CHECK ((payload_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT repository_operations_platform_check CHECK ((platform = ANY (ARRAY['github'::text, 'gitlab'::text]))),
    CONSTRAINT repository_operations_publication_slot_check CHECK ((length(publication_slot) > 0)),
    CONSTRAINT repository_operations_reconcile_attempt_count_check CHECK ((reconcile_attempt_count >= 0)),
    CONSTRAINT repository_operations_reconcile_claim_shape CHECK ((((reconcile_claim_owner IS NULL) AND (reconcile_claim_expires_at IS NULL)) OR ((length(reconcile_claim_owner) > 0) AND (reconcile_claim_expires_at IS NOT NULL)))),
    CONSTRAINT repository_operations_reconcile_claim_version_check CHECK ((reconcile_claim_version >= 0)),
    CONSTRAINT repository_operations_repository_check CHECK ((length(repository) > 0)),
    CONSTRAINT repository_operations_resolution_shape CHECK ((((status = 'succeeded'::text) AND (outcome_code = ANY (ARRAY['current'::text, 'stale'::text])) AND (remote_id IS NOT NULL) AND (resolved_at IS NOT NULL)) OR ((status = 'failed_definite'::text) AND (outcome_code = ANY (ARRAY['stale'::text, 'rejected'::text, 'no_effect'::text, 'publication_abandoned'::text])) AND (remote_id IS NULL) AND (resolved_at IS NOT NULL)) OR ((status = 'cancelled'::text) AND (resolved_at IS NOT NULL)) OR ((status = ANY (ARRAY['prepared'::text, 'in_flight'::text, 'unknown'::text, 'manual_review'::text])) AND (resolved_at IS NULL)))),
    CONSTRAINT repository_operations_revision_check CHECK ((length(revision) > 0)),
    CONSTRAINT repository_operations_status_check CHECK ((status = ANY (ARRAY['prepared'::text, 'in_flight'::text, 'succeeded'::text, 'unknown'::text, 'manual_review'::text, 'failed_definite'::text, 'cancelled'::text]))),
    CONSTRAINT repository_operations_target_check CHECK ((length(target) > 0)),
    CONSTRAINT repository_operations_version_check CHECK ((version >= 0))
);

ALTER TABLE ONLY pr_agent_harness.repository_operations FORCE ROW LEVEL SECURITY;



COMMENT ON COLUMN pr_agent_harness.repository_operations.authority_generation IS 'Repository publication authority generation frozen into operation identity; NULL only for blocked generation-0 prototypes.';



COMMENT ON COLUMN pr_agent_harness.repository_operations.payload_json IS 'Canonical frozen dispatch payload. NULL only for operations created before migration 003.';



COMMENT ON COLUMN pr_agent_harness.repository_operations.evidence_json IS 'Structured reconciliation or rejection evidence; never used to regenerate a dispatch payload.';



COMMENT ON COLUMN pr_agent_harness.repository_operations.command_receipt_json IS 'Structured provider command receipt retained independently from reconciliation evidence.';



COMMENT ON COLUMN pr_agent_harness.repository_operations.next_reconcile_at IS 'Earliest independent reconciliation scan time; NULL means immediately due.';



COMMENT ON COLUMN pr_agent_harness.repository_operations.reconcile_claim_expires_at IS 'Short worker claim expiry. Expiry permits another lookup, never another dispatch.';



CREATE TABLE pr_agent_harness.review_annotation_arbitrations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    integration_id uuid NOT NULL,
    source_run_id uuid NOT NULL,
    artifact_hash text NOT NULL,
    rubric_version text NOT NULL,
    left_annotation_id uuid NOT NULL,
    left_label_set_hash text NOT NULL,
    right_annotation_id uuid NOT NULL,
    right_label_set_hash text NOT NULL,
    chosen_label_set_hash text NOT NULL,
    actor_type text NOT NULL,
    actor_id text NOT NULL,
    command_key text NOT NULL,
    request_hash text NOT NULL,
    reason text NOT NULL,
    content_purged_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT review_annotation_arbitrations_actor_type_check CHECK ((actor_type = ANY (ARRAY['user'::text, 'service'::text]))),
    CONSTRAINT review_annotation_arbitrations_artifact_hash_check CHECK ((artifact_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT review_annotation_arbitrations_check CHECK ((left_annotation_id <> right_annotation_id)),
    CONSTRAINT review_annotation_arbitrations_check1 CHECK ((left_label_set_hash <> right_label_set_hash)),
    CONSTRAINT review_annotation_arbitrations_check2 CHECK (((chosen_label_set_hash = left_label_set_hash) OR (chosen_label_set_hash = right_label_set_hash))),
    CONSTRAINT review_annotation_arbitrations_chosen_label_set_hash_check CHECK ((chosen_label_set_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT review_annotation_arbitrations_command_key_check CHECK (((length(command_key) >= 1) AND (length(command_key) <= 200))),
    CONSTRAINT review_annotation_arbitrations_left_label_set_hash_check CHECK ((left_label_set_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT review_annotation_arbitrations_reason_check CHECK (((length(reason) >= 20) AND (length(reason) <= 4000))),
    CONSTRAINT review_annotation_arbitrations_request_hash_check CHECK ((request_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT review_annotation_arbitrations_right_label_set_hash_check CHECK ((right_label_set_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT review_annotation_arbitrations_rubric_version_check CHECK ((rubric_version = 'review-quality.v1'::text))
);

ALTER TABLE ONLY pr_agent_harness.review_annotation_arbitrations FORCE ROW LEVEL SECURITY;



CREATE TABLE pr_agent_harness.review_annotations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    integration_id uuid NOT NULL,
    source_run_id uuid NOT NULL,
    artifact_hash text NOT NULL,
    rubric_version text NOT NULL,
    label_set_hash text NOT NULL,
    label_set_json jsonb NOT NULL,
    provenance_json jsonb NOT NULL,
    actor_type text NOT NULL,
    actor_id text NOT NULL,
    command_key text NOT NULL,
    request_hash text NOT NULL,
    supersedes_annotation_id uuid,
    superseded_by_annotation_id uuid,
    content_purged_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT review_annotations_actor_type_check CHECK ((actor_type = ANY (ARRAY['user'::text, 'service'::text]))),
    CONSTRAINT review_annotations_artifact_hash_check CHECK ((artifact_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT review_annotations_check CHECK (((supersedes_annotation_id IS NULL) OR (supersedes_annotation_id <> id))),
    CONSTRAINT review_annotations_check1 CHECK (((superseded_by_annotation_id IS NULL) OR (superseded_by_annotation_id <> id))),
    CONSTRAINT review_annotations_command_key_check CHECK (((length(command_key) >= 1) AND (length(command_key) <= 200))),
    CONSTRAINT review_annotations_label_set_hash_check CHECK ((label_set_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT review_annotations_label_set_json_check CHECK ((jsonb_typeof(label_set_json) = 'object'::text)),
    CONSTRAINT review_annotations_provenance_json_check CHECK ((jsonb_typeof(provenance_json) = 'object'::text)),
    CONSTRAINT review_annotations_request_hash_check CHECK ((request_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT review_annotations_rubric_version_check CHECK ((rubric_version = 'review-quality.v1'::text))
);

ALTER TABLE ONLY pr_agent_harness.review_annotations FORCE ROW LEVEL SECURITY;



CREATE TABLE pr_agent_harness.review_artifacts (
    id text NOT NULL,
    tenant_id uuid NOT NULL,
    integration_id uuid NOT NULL,
    run_id uuid NOT NULL,
    workflow_id text NOT NULL,
    publication_mode text NOT NULL,
    head_sha text NOT NULL,
    content_hash text NOT NULL,
    artifact_json jsonb NOT NULL,
    content_purged_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT review_artifacts_artifact_json_check CHECK ((jsonb_typeof(artifact_json) = 'object'::text)),
    CONSTRAINT review_artifacts_content_hash_check CHECK ((content_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT review_artifacts_head_sha_check CHECK (((length(head_sha) >= 1) AND (length(head_sha) <= 128))),
    CONSTRAINT review_artifacts_id_check CHECK ((id ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT review_artifacts_publication_mode_check CHECK ((publication_mode = 'shadow'::text)),
    CONSTRAINT review_artifacts_workflow_id_check CHECK ((workflow_id = 'review.deep.v1'::text))
);

ALTER TABLE ONLY pr_agent_harness.review_artifacts FORCE ROW LEVEL SECURITY;



COMMENT ON TABLE pr_agent_harness.review_artifacts IS 'Immutable deep-review shadow artifact; raw content is removable by the administrative retention protocol.';



CREATE TABLE pr_agent_harness.run_budget_envelopes (
    tenant_id uuid NOT NULL,
    run_id uuid NOT NULL,
    period_key text NOT NULL,
    currency text NOT NULL,
    pricing_hash text NOT NULL,
    input_token_limit bigint NOT NULL,
    output_token_limit bigint NOT NULL,
    cost_limit_micros bigint NOT NULL,
    allocated_input_tokens bigint DEFAULT 0 NOT NULL,
    allocated_output_tokens bigint DEFAULT 0 NOT NULL,
    allocated_cost_micros bigint DEFAULT 0 NOT NULL,
    actual_input_tokens bigint DEFAULT 0 NOT NULL,
    actual_output_tokens bigint DEFAULT 0 NOT NULL,
    actual_cost_micros bigint DEFAULT 0 NOT NULL,
    overdrawn boolean DEFAULT false NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    closed_at timestamp with time zone,
    CONSTRAINT run_budget_close_shape CHECK (((status = 'closed'::text) = (closed_at IS NOT NULL))),
    CONSTRAINT run_budget_envelopes_actual_cost_micros_check CHECK ((actual_cost_micros >= 0)),
    CONSTRAINT run_budget_envelopes_actual_input_tokens_check CHECK ((actual_input_tokens >= 0)),
    CONSTRAINT run_budget_envelopes_actual_output_tokens_check CHECK ((actual_output_tokens >= 0)),
    CONSTRAINT run_budget_envelopes_allocated_cost_micros_check CHECK ((allocated_cost_micros >= 0)),
    CONSTRAINT run_budget_envelopes_allocated_input_tokens_check CHECK ((allocated_input_tokens >= 0)),
    CONSTRAINT run_budget_envelopes_allocated_output_tokens_check CHECK ((allocated_output_tokens >= 0)),
    CONSTRAINT run_budget_envelopes_cost_limit_micros_check CHECK ((cost_limit_micros >= 0)),
    CONSTRAINT run_budget_envelopes_input_token_limit_check CHECK ((input_token_limit >= 0)),
    CONSTRAINT run_budget_envelopes_output_token_limit_check CHECK ((output_token_limit >= 0)),
    CONSTRAINT run_budget_envelopes_status_check CHECK ((status = ANY (ARRAY['active'::text, 'pending_reconciliation'::text, 'closed'::text])))
);

ALTER TABLE ONLY pr_agent_harness.run_budget_envelopes FORCE ROW LEVEL SECURITY;



COMMENT ON TABLE pr_agent_harness.run_budget_envelopes IS 'A Run reserves its full envelope from the shared tenant account before intake commits.';



CREATE TABLE pr_agent_harness.run_command_receipts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    integration_id uuid NOT NULL,
    run_id uuid NOT NULL,
    command_kind text NOT NULL,
    command_key text NOT NULL,
    request_hash text NOT NULL,
    actor_type text NOT NULL,
    actor_id text NOT NULL,
    request_json jsonb NOT NULL,
    result_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'accepted'::text NOT NULL,
    accepted_version bigint NOT NULL,
    resulting_version bigint,
    new_run_id uuid,
    job_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT run_command_receipts_accepted_version_check CHECK ((accepted_version >= 0)),
    CONSTRAINT run_command_receipts_actor_id_check CHECK ((length(actor_id) > 0)),
    CONSTRAINT run_command_receipts_actor_type_check CHECK ((actor_type = ANY (ARRAY['user'::text, 'service'::text]))),
    CONSTRAINT run_command_receipts_command_key_check CHECK (((length(command_key) >= 1) AND (length(command_key) <= 200))),
    CONSTRAINT run_command_receipts_command_kind_check CHECK ((command_kind = ANY (ARRAY['cancel'::text, 'resume'::text, 'retry'::text, 'recover'::text, 'rerun'::text]))),
    CONSTRAINT run_command_receipts_request_hash_check CHECK ((request_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT run_command_receipts_request_json_check CHECK ((jsonb_typeof(request_json) = 'object'::text)),
    CONSTRAINT run_command_receipts_result_json_check CHECK ((jsonb_typeof(result_json) = 'object'::text)),
    CONSTRAINT run_command_receipts_resulting_version_check CHECK ((resulting_version >= 0)),
    CONSTRAINT run_command_receipts_status_check CHECK ((status = ANY (ARRAY['accepted'::text, 'completed'::text, 'rejected'::text])))
);

ALTER TABLE ONLY pr_agent_harness.run_command_receipts FORCE ROW LEVEL SECURITY;



COMMENT ON TABLE pr_agent_harness.run_command_receipts IS 'Authorized idempotent Run control requests. A receipt does not grant a Run lease.';



CREATE TABLE pr_agent_harness.run_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    run_id uuid NOT NULL,
    sequence bigint NOT NULL,
    event_type text NOT NULL,
    schema_version integer DEFAULT 1 NOT NULL,
    visibility text DEFAULT 'internal'::text NOT NULL,
    actor_type text NOT NULL,
    actor_id text,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    event_key text,
    CONSTRAINT run_events_actor_type_check CHECK ((actor_type = ANY (ARRAY['user'::text, 'service'::text, 'system'::text, 'worker'::text]))),
    CONSTRAINT run_events_event_type_check CHECK ((length(event_type) > 0)),
    CONSTRAINT run_events_payload_json_check CHECK ((jsonb_typeof(payload_json) = 'object'::text)),
    CONSTRAINT run_events_schema_version_check CHECK ((schema_version > 0)),
    CONSTRAINT run_events_sequence_check CHECK ((sequence > 0)),
    CONSTRAINT run_events_visibility_check CHECK ((visibility = ANY (ARRAY['public'::text, 'internal'::text, 'sensitive'::text])))
);

ALTER TABLE ONLY pr_agent_harness.run_events FORCE ROW LEVEL SECURITY;



CREATE TABLE pr_agent_harness.run_publication_batches (
    tenant_id uuid NOT NULL,
    run_id uuid NOT NULL,
    batch_id uuid NOT NULL,
    step_id uuid,
    lease_epoch bigint NOT NULL,
    operation_set_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT run_publication_batches_lease_epoch_check CHECK ((lease_epoch > 0)),
    CONSTRAINT run_publication_batches_operation_set_hash_check CHECK ((operation_set_hash ~ '^[0-9a-f]{64}$'::text))
);

ALTER TABLE ONLY pr_agent_harness.run_publication_batches FORCE ROW LEVEL SECURITY;



CREATE TABLE pr_agent_harness.run_wait_decisions (
    tenant_id uuid NOT NULL,
    run_id uuid NOT NULL,
    wait_id uuid NOT NULL,
    command_receipt_id uuid NOT NULL,
    decision text NOT NULL,
    evidence_json jsonb NOT NULL,
    remote_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT run_wait_decisions_decision_check CHECK ((decision = ANY (ARRAY['confirm_occurred'::text, 'confirm_not_occurred'::text, 'authorize_retry'::text, 'abandon_publication'::text]))),
    CONSTRAINT run_wait_decisions_evidence_json_check CHECK ((jsonb_typeof(evidence_json) = 'object'::text))
);

ALTER TABLE ONLY pr_agent_harness.run_wait_decisions FORCE ROW LEVEL SECURITY;



CREATE TABLE pr_agent_harness.run_waits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    run_id uuid NOT NULL,
    batch_id uuid NOT NULL,
    operation_set_hash text NOT NULL,
    business_operation_id text NOT NULL,
    operation_version bigint NOT NULL,
    intent_hash text NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    allowed_decisions jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    consumed_at timestamp with time zone,
    CONSTRAINT run_waits_allowed_decisions_check CHECK ((jsonb_typeof(allowed_decisions) = 'array'::text)),
    CONSTRAINT run_waits_intent_hash_check CHECK ((intent_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT run_waits_operation_set_hash_check CHECK ((operation_set_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT run_waits_operation_version_check CHECK ((operation_version >= 0)),
    CONSTRAINT run_waits_status_check CHECK ((status = ANY (ARRAY['open'::text, 'consumed'::text, 'superseded'::text]))),
    CONSTRAINT run_waits_version_check CHECK ((version > 0))
);

ALTER TABLE ONLY pr_agent_harness.run_waits FORCE ROW LEVEL SECURITY;



COMMENT ON TABLE pr_agent_harness.run_waits IS 'Exact immutable publication intent awaiting a single authorized decision.';



CREATE TABLE pr_agent_harness.step_attempts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    run_id uuid NOT NULL,
    step_id uuid NOT NULL,
    attempt_number integer NOT NULL,
    lease_owner text NOT NULL,
    lease_epoch bigint NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    error_code text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT step_attempts_attempt_number_check CHECK ((attempt_number > 0)),
    CONSTRAINT step_attempts_completion_shape CHECK ((((status = 'running'::text) AND (completed_at IS NULL)) OR ((status <> 'running'::text) AND (completed_at IS NOT NULL)))),
    CONSTRAINT step_attempts_lease_epoch_check CHECK ((lease_epoch > 0)),
    CONSTRAINT step_attempts_lease_owner_check CHECK ((length(lease_owner) > 0)),
    CONSTRAINT step_attempts_status_check CHECK ((status = ANY (ARRAY['running'::text, 'succeeded'::text, 'failed'::text, 'abandoned'::text])))
);

ALTER TABLE ONLY pr_agent_harness.step_attempts FORCE ROW LEVEL SECURITY;



CREATE TABLE pr_agent_harness.tenant_budget_accounts (
    tenant_id uuid NOT NULL,
    period_key text NOT NULL,
    currency text NOT NULL,
    input_token_limit bigint NOT NULL,
    output_token_limit bigint NOT NULL,
    cost_limit_micros bigint NOT NULL,
    reserved_input_tokens bigint DEFAULT 0 NOT NULL,
    reserved_output_tokens bigint DEFAULT 0 NOT NULL,
    reserved_cost_micros bigint DEFAULT 0 NOT NULL,
    spent_input_tokens bigint DEFAULT 0 NOT NULL,
    spent_output_tokens bigint DEFAULT 0 NOT NULL,
    spent_cost_micros bigint DEFAULT 0 NOT NULL,
    overdrawn boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenant_budget_accounts_cost_limit_micros_check CHECK ((cost_limit_micros >= 0)),
    CONSTRAINT tenant_budget_accounts_currency_check CHECK ((currency ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT tenant_budget_accounts_input_token_limit_check CHECK ((input_token_limit >= 0)),
    CONSTRAINT tenant_budget_accounts_output_token_limit_check CHECK ((output_token_limit >= 0)),
    CONSTRAINT tenant_budget_accounts_period_key_check CHECK ((length(period_key) > 0)),
    CONSTRAINT tenant_budget_accounts_reserved_cost_micros_check CHECK ((reserved_cost_micros >= 0)),
    CONSTRAINT tenant_budget_accounts_reserved_input_tokens_check CHECK ((reserved_input_tokens >= 0)),
    CONSTRAINT tenant_budget_accounts_reserved_output_tokens_check CHECK ((reserved_output_tokens >= 0)),
    CONSTRAINT tenant_budget_accounts_spent_cost_micros_check CHECK ((spent_cost_micros >= 0)),
    CONSTRAINT tenant_budget_accounts_spent_input_tokens_check CHECK ((spent_input_tokens >= 0)),
    CONSTRAINT tenant_budget_accounts_spent_output_tokens_check CHECK ((spent_output_tokens >= 0))
);

ALTER TABLE ONLY pr_agent_harness.tenant_budget_accounts FORCE ROW LEVEL SECURITY;



CREATE TABLE pr_agent_harness.tool_calls (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    run_id uuid NOT NULL,
    step_id uuid NOT NULL,
    step_attempt_id uuid NOT NULL,
    tool_kind text NOT NULL,
    tool_name text NOT NULL,
    request_hash text NOT NULL,
    status text DEFAULT 'in_flight'::text NOT NULL,
    side_effect text DEFAULT 'read_only'::text NOT NULL,
    result_hash text,
    result_ref text,
    error_code text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    content_purged_at timestamp with time zone,
    CONSTRAINT tool_calls_completion_shape CHECK ((((status = ANY (ARRAY['prepared'::text, 'in_flight'::text])) AND (completed_at IS NULL)) OR ((status = ANY (ARRAY['succeeded'::text, 'failed_definite'::text, 'unknown'::text])) AND (completed_at IS NOT NULL)))),
    CONSTRAINT tool_calls_request_hash_check CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT tool_calls_result_hash_check CHECK (((result_hash IS NULL) OR (result_hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT tool_calls_side_effect_check CHECK ((side_effect = 'read_only'::text)),
    CONSTRAINT tool_calls_status_check CHECK ((status = ANY (ARRAY['prepared'::text, 'in_flight'::text, 'succeeded'::text, 'failed_definite'::text, 'unknown'::text]))),
    CONSTRAINT tool_calls_tool_kind_check CHECK ((tool_kind = ANY (ARRAY['provider_read'::text, 'repository_read'::text, 'sandbox_read'::text, 'mcp_read'::text]))),
    CONSTRAINT tool_calls_tool_name_check CHECK ((length(tool_name) > 0))
);

ALTER TABLE ONLY pr_agent_harness.tool_calls FORCE ROW LEVEL SECURITY;



CREATE TABLE pr_agent_harness.trusted_review_label_sets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    integration_id uuid NOT NULL,
    source_run_id uuid NOT NULL,
    artifact_hash text NOT NULL,
    rubric_version text NOT NULL,
    label_set_hash text NOT NULL,
    label_set_json jsonb NOT NULL,
    version bigint NOT NULL,
    active boolean DEFAULT true NOT NULL,
    supersedes_label_set_id uuid,
    resolution_kind text NOT NULL,
    resolution_json jsonb NOT NULL,
    arbitration_id uuid,
    content_purged_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT trusted_review_label_sets_artifact_hash_check CHECK ((artifact_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT trusted_review_label_sets_check CHECK ((((resolution_kind = 'consensus'::text) AND (arbitration_id IS NULL)) OR ((resolution_kind = 'arbitration'::text) AND (arbitration_id IS NOT NULL)))),
    CONSTRAINT trusted_review_label_sets_label_set_hash_check CHECK ((label_set_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT trusted_review_label_sets_label_set_json_check CHECK ((jsonb_typeof(label_set_json) = 'object'::text)),
    CONSTRAINT trusted_review_label_sets_resolution_json_check CHECK ((jsonb_typeof(resolution_json) = 'object'::text)),
    CONSTRAINT trusted_review_label_sets_resolution_kind_check CHECK ((resolution_kind = ANY (ARRAY['consensus'::text, 'arbitration'::text]))),
    CONSTRAINT trusted_review_label_sets_rubric_version_check CHECK ((rubric_version = 'review-quality.v1'::text)),
    CONSTRAINT trusted_review_label_sets_version_check CHECK ((version > 0))
);

ALTER TABLE ONLY pr_agent_harness.trusted_review_label_sets FORCE ROW LEVEL SECURITY;



COMMENT ON TABLE pr_agent_harness.trusted_review_label_sets IS 'Immutable complete ground truth created only by exact two-actor consensus or third-actor arbitration.';



CREATE TABLE pr_agent_harness.usage_records (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    run_id uuid NOT NULL,
    model_call_id uuid NOT NULL,
    measurement_status text NOT NULL,
    input_tokens bigint,
    cached_input_tokens bigint,
    cache_write_input_tokens bigint,
    output_tokens bigint,
    reasoning_tokens bigint,
    tool_input_tokens bigint,
    total_tokens bigint,
    cost_micros bigint,
    currency text NOT NULL,
    pricing_hash text NOT NULL,
    original_usage_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    measured_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    content_purged_at timestamp with time zone,
    CONSTRAINT usage_measurement_shape CHECK ((((measurement_status = 'actual'::text) AND (input_tokens IS NOT NULL) AND (output_tokens IS NOT NULL) AND (cost_micros IS NOT NULL)) OR ((measurement_status = 'unavailable'::text) AND (input_tokens IS NULL) AND (cached_input_tokens IS NULL) AND (cache_write_input_tokens IS NULL) AND (output_tokens IS NULL) AND (reasoning_tokens IS NULL) AND (tool_input_tokens IS NULL) AND (total_tokens IS NULL) AND (cost_micros IS NULL)))),
    CONSTRAINT usage_records_cache_write_input_tokens_check CHECK ((cache_write_input_tokens >= 0)),
    CONSTRAINT usage_records_cached_input_tokens_check CHECK ((cached_input_tokens >= 0)),
    CONSTRAINT usage_records_cost_micros_check CHECK ((cost_micros >= 0)),
    CONSTRAINT usage_records_currency_check CHECK ((currency ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT usage_records_input_tokens_check CHECK ((input_tokens >= 0)),
    CONSTRAINT usage_records_measurement_status_check CHECK ((measurement_status = ANY (ARRAY['actual'::text, 'unavailable'::text]))),
    CONSTRAINT usage_records_original_usage_json_check CHECK ((jsonb_typeof(original_usage_json) = 'object'::text)),
    CONSTRAINT usage_records_output_tokens_check CHECK ((output_tokens >= 0)),
    CONSTRAINT usage_records_reasoning_tokens_check CHECK ((reasoning_tokens >= 0)),
    CONSTRAINT usage_records_tool_input_tokens_check CHECK ((tool_input_tokens >= 0)),
    CONSTRAINT usage_records_total_tokens_check CHECK ((total_tokens >= 0))
);

ALTER TABLE ONLY pr_agent_harness.usage_records FORCE ROW LEVEL SECURITY;



CREATE TABLE pr_agent_harness.verification_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    integration_id uuid NOT NULL,
    run_id uuid NOT NULL,
    proposal_id text NOT NULL,
    proposal_hash text NOT NULL,
    source_bundle_ref text NOT NULL,
    source_bundle_hash text NOT NULL,
    policy_hash text NOT NULL,
    verification_input_hash text NOT NULL,
    trusted_command_hash text NOT NULL,
    dependency_lock_path text NOT NULL,
    dependency_lock_hash text NOT NULL,
    sandbox_policy_hash text NOT NULL,
    image_digest text NOT NULL,
    claimed_run_epoch bigint NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    lease_owner text,
    lease_epoch bigint DEFAULT 0 NOT NULL,
    lease_expires_at timestamp with time zone,
    heartbeat_at timestamp with time zone,
    attempt_count integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 2 NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    deadline_at timestamp with time zone NOT NULL,
    result_json jsonb,
    result_hash text,
    error_code text,
    content_purged_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT verification_jobs_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT verification_jobs_check CHECK (((status = 'leased'::text) = ((lease_owner IS NOT NULL) AND (lease_expires_at IS NOT NULL)))),
    CONSTRAINT verification_jobs_check1 CHECK (((status = ANY (ARRAY['succeeded'::text, 'failed'::text])) = (completed_at IS NOT NULL))),
    CONSTRAINT verification_jobs_claimed_run_epoch_check CHECK ((claimed_run_epoch > 0)),
    CONSTRAINT verification_jobs_dependency_lock_hash_check CHECK ((dependency_lock_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT verification_jobs_dependency_lock_path_check CHECK (((length(dependency_lock_path) >= 1) AND (length(dependency_lock_path) <= 256))),
    CONSTRAINT verification_jobs_image_digest_check CHECK ((image_digest ~ '^sha256:[a-f0-9]{64}$'::text)),
    CONSTRAINT verification_jobs_lease_epoch_check CHECK ((lease_epoch >= 0)),
    CONSTRAINT verification_jobs_max_attempts_check CHECK (((max_attempts >= 1) AND (max_attempts <= 3))),
    CONSTRAINT verification_jobs_policy_hash_check CHECK ((policy_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT verification_jobs_proposal_hash_check CHECK ((proposal_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT verification_jobs_result_hash_check CHECK (((result_hash IS NULL) OR (result_hash ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT verification_jobs_result_json_check CHECK (((result_json IS NULL) OR (jsonb_typeof(result_json) = 'object'::text))),
    CONSTRAINT verification_jobs_sandbox_policy_hash_check CHECK ((sandbox_policy_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT verification_jobs_source_bundle_hash_check CHECK ((source_bundle_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT verification_jobs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'leased'::text, 'succeeded'::text, 'failed'::text]))),
    CONSTRAINT verification_jobs_trusted_command_hash_check CHECK ((trusted_command_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT verification_jobs_verification_input_hash_check CHECK ((verification_input_hash ~ '^[a-f0-9]{64}$'::text))
);

ALTER TABLE ONLY pr_agent_harness.verification_jobs FORCE ROW LEVEL SECURITY;



ALTER TABLE ONLY pr_agent_harness.agent_runs
    ADD CONSTRAINT agent_runs_control_identity UNIQUE (tenant_id, integration_id, id);



ALTER TABLE ONLY pr_agent_harness.agent_runs
    ADD CONSTRAINT agent_runs_create_idempotency UNIQUE (tenant_id, create_scope, create_key);



ALTER TABLE ONLY pr_agent_harness.agent_runs
    ADD CONSTRAINT agent_runs_pkey PRIMARY KEY (id);



ALTER TABLE ONLY pr_agent_harness.agent_runs
    ADD CONSTRAINT agent_runs_tenant_identity UNIQUE (tenant_id, id);



ALTER TABLE ONLY pr_agent_harness.agent_steps
    ADD CONSTRAINT agent_steps_logical_identity UNIQUE (tenant_id, run_id, step_key);



ALTER TABLE ONLY pr_agent_harness.agent_steps
    ADD CONSTRAINT agent_steps_pkey PRIMARY KEY (id);



ALTER TABLE ONLY pr_agent_harness.agent_steps
    ADD CONSTRAINT agent_steps_tenant_identity UNIQUE (tenant_id, run_id, id);



ALTER TABLE ONLY pr_agent_harness.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);



ALTER TABLE ONLY pr_agent_harness.checkpoints
    ADD CONSTRAINT checkpoints_pkey PRIMARY KEY (id);



ALTER TABLE ONLY pr_agent_harness.checkpoints
    ADD CONSTRAINT checkpoints_publication_batch UNIQUE (tenant_id, run_id, publication_batch_id);



ALTER TABLE ONLY pr_agent_harness.checkpoints
    ADD CONSTRAINT checkpoints_sequence UNIQUE (tenant_id, run_id, sequence);



ALTER TABLE ONLY pr_agent_harness.checkpoints
    ADD CONSTRAINT checkpoints_step UNIQUE (tenant_id, run_id, step_id);



ALTER TABLE ONLY pr_agent_harness.checkpoints
    ADD CONSTRAINT checkpoints_tenant_identity UNIQUE (tenant_id, run_id, id);



ALTER TABLE ONLY pr_agent_harness.dead_letter_jobs
    ADD CONSTRAINT dead_letter_jobs_identity UNIQUE (tenant_id, job_id);



ALTER TABLE ONLY pr_agent_harness.dead_letter_jobs
    ADD CONSTRAINT dead_letter_jobs_pkey PRIMARY KEY (id);



ALTER TABLE ONLY pr_agent_harness.eval_cases
    ADD CONSTRAINT eval_cases_pkey PRIMARY KEY (id);



ALTER TABLE ONLY pr_agent_harness.eval_cases
    ADD CONSTRAINT eval_cases_tenant_id_dataset_id_ordinal_key UNIQUE (tenant_id, dataset_id, ordinal);



ALTER TABLE ONLY pr_agent_harness.eval_cases
    ADD CONSTRAINT eval_cases_tenant_id_dataset_id_source_run_id_key UNIQUE (tenant_id, dataset_id, source_run_id);



ALTER TABLE ONLY pr_agent_harness.eval_datasets
    ADD CONSTRAINT eval_datasets_pkey PRIMARY KEY (id);



ALTER TABLE ONLY pr_agent_harness.eval_datasets
    ADD CONSTRAINT eval_datasets_tenant_id_curator_actor_type_curator_actor_id_key UNIQUE (tenant_id, curator_actor_type, curator_actor_id, name);



ALTER TABLE ONLY pr_agent_harness.eval_datasets
    ADD CONSTRAINT eval_datasets_tenant_id_id_key UNIQUE (tenant_id, id);



ALTER TABLE ONLY pr_agent_harness.eval_fixture_files
    ADD CONSTRAINT eval_fixture_files_pkey PRIMARY KEY (tenant_id, fixture_id, path);



ALTER TABLE ONLY pr_agent_harness.eval_fixtures
    ADD CONSTRAINT eval_fixtures_pkey PRIMARY KEY (tenant_id, id);



ALTER TABLE ONLY pr_agent_harness.eval_fixtures
    ADD CONSTRAINT eval_fixtures_tenant_id_run_id_key UNIQUE (tenant_id, run_id);



ALTER TABLE ONLY pr_agent_harness.eval_results
    ADD CONSTRAINT eval_results_pkey PRIMARY KEY (id);



ALTER TABLE ONLY pr_agent_harness.eval_results
    ADD CONSTRAINT eval_results_tenant_id_eval_run_id_case_id_variant_repetiti_key UNIQUE (tenant_id, eval_run_id, case_id, variant, repetition);



ALTER TABLE ONLY pr_agent_harness.eval_results
    ADD CONSTRAINT eval_results_tenant_id_id_key UNIQUE (tenant_id, id);



ALTER TABLE ONLY pr_agent_harness.eval_runs
    ADD CONSTRAINT eval_runs_pkey PRIMARY KEY (id);



ALTER TABLE ONLY pr_agent_harness.eval_runs
    ADD CONSTRAINT eval_runs_tenant_id_curator_actor_type_curator_actor_id_com_key UNIQUE (tenant_id, curator_actor_type, curator_actor_id, command_key);



ALTER TABLE ONLY pr_agent_harness.eval_runs
    ADD CONSTRAINT eval_runs_tenant_id_id_key UNIQUE (tenant_id, id);



ALTER TABLE ONLY pr_agent_harness.evidence_records
    ADD CONSTRAINT evidence_records_pkey PRIMARY KEY (tenant_id, id);



ALTER TABLE ONLY pr_agent_harness.evolution_candidates
    ADD CONSTRAINT evolution_candidates_pkey PRIMARY KEY (id);



ALTER TABLE ONLY pr_agent_harness.evolution_candidates
    ADD CONSTRAINT evolution_candidates_tenant_id_id_key UNIQUE (tenant_id, id);



ALTER TABLE ONLY pr_agent_harness.evolution_candidates
    ADD CONSTRAINT evolution_candidates_tenant_id_proposal_run_id_key UNIQUE (tenant_id, proposal_run_id);



ALTER TABLE ONLY pr_agent_harness.evolution_proposal_sources
    ADD CONSTRAINT evolution_proposal_sources_pkey PRIMARY KEY (tenant_id, proposal_run_id);



ALTER TABLE ONLY pr_agent_harness.evolution_release_assignments
    ADD CONSTRAINT evolution_release_assignments_pkey PRIMARY KEY (tenant_id, integration_id);



ALTER TABLE ONLY pr_agent_harness.evolution_release_decisions
    ADD CONSTRAINT evolution_release_decisions_pkey PRIMARY KEY (id);



ALTER TABLE ONLY pr_agent_harness.evolution_release_decisions
    ADD CONSTRAINT evolution_release_decisions_tenant_id_id_key UNIQUE (tenant_id, id);



ALTER TABLE ONLY pr_agent_harness.evolution_release_decisions
    ADD CONSTRAINT evolution_release_decisions_tenant_id_integration_id_checke_key UNIQUE (tenant_id, integration_id, checker_actor_id, command_key);



ALTER TABLE ONLY pr_agent_harness.evolution_release_decisions
    ADD CONSTRAINT evolution_release_decisions_tenant_id_request_id_key UNIQUE (tenant_id, request_id);



ALTER TABLE ONLY pr_agent_harness.evolution_release_qualifications
    ADD CONSTRAINT evolution_release_qualificati_tenant_id_integration_id_crea_key UNIQUE (tenant_id, integration_id, created_by_actor_type, created_by_actor_id, command_key);



ALTER TABLE ONLY pr_agent_harness.evolution_release_qualifications
    ADD CONSTRAINT evolution_release_qualificati_tenant_id_integration_id_id_c_key UNIQUE (tenant_id, integration_id, id, candidate_id);



ALTER TABLE ONLY pr_agent_harness.evolution_release_qualifications
    ADD CONSTRAINT evolution_release_qualification_tenant_id_integration_id_id_key UNIQUE (tenant_id, integration_id, id);



ALTER TABLE ONLY pr_agent_harness.evolution_release_qualifications
    ADD CONSTRAINT evolution_release_qualifications_pkey PRIMARY KEY (id);



ALTER TABLE ONLY pr_agent_harness.evolution_release_qualifications
    ADD CONSTRAINT evolution_release_qualifications_tenant_id_id_key UNIQUE (tenant_id, id);



ALTER TABLE ONLY pr_agent_harness.evolution_release_receipts
    ADD CONSTRAINT evolution_release_receipts_pkey PRIMARY KEY (id);



ALTER TABLE ONLY pr_agent_harness.evolution_release_receipts
    ADD CONSTRAINT evolution_release_receipts_tenant_id_id_key UNIQUE (tenant_id, id);



ALTER TABLE ONLY pr_agent_harness.evolution_release_receipts
    ADD CONSTRAINT evolution_release_receipts_tenant_id_integration_id_actor_t_key UNIQUE (tenant_id, integration_id, actor_type, actor_id, command_key);



ALTER TABLE ONLY pr_agent_harness.evolution_release_receipts
    ADD CONSTRAINT evolution_release_receipts_tenant_id_integration_id_assignm_key UNIQUE (tenant_id, integration_id, assignment_version);



ALTER TABLE ONLY pr_agent_harness.evolution_release_receipts
    ADD CONSTRAINT evolution_release_receipts_tenant_id_integration_id_id_assi_key UNIQUE (tenant_id, integration_id, id, assignment_version);



ALTER TABLE ONLY pr_agent_harness.evolution_release_receipts
    ADD CONSTRAINT evolution_release_receipts_tenant_id_integration_id_id_key UNIQUE (tenant_id, integration_id, id);



ALTER TABLE ONLY pr_agent_harness.evolution_release_receipts
    ADD CONSTRAINT evolution_release_receipts_tenant_id_request_id_key UNIQUE (tenant_id, request_id);



ALTER TABLE ONLY pr_agent_harness.evolution_release_requests
    ADD CONSTRAINT evolution_release_requests_pkey PRIMARY KEY (id);



ALTER TABLE ONLY pr_agent_harness.evolution_release_requests
    ADD CONSTRAINT evolution_release_requests_tenant_id_id_key UNIQUE (tenant_id, id);



ALTER TABLE ONLY pr_agent_harness.evolution_release_requests
    ADD CONSTRAINT evolution_release_requests_tenant_id_integration_id_id_cand_key UNIQUE (tenant_id, integration_id, id, candidate_id, qualification_id);



ALTER TABLE ONLY pr_agent_harness.evolution_release_requests
    ADD CONSTRAINT evolution_release_requests_tenant_id_integration_id_id_key UNIQUE (tenant_id, integration_id, id);



ALTER TABLE ONLY pr_agent_harness.evolution_release_requests
    ADD CONSTRAINT evolution_release_requests_tenant_id_integration_id_maker_a_key UNIQUE (tenant_id, integration_id, maker_actor_id, command_key);



ALTER TABLE ONLY pr_agent_harness.evolution_run_assignments
    ADD CONSTRAINT evolution_run_assignments_pkey PRIMARY KEY (tenant_id, run_id);



ALTER TABLE ONLY pr_agent_harness.feedback_observations
    ADD CONSTRAINT feedback_observations_pkey PRIMARY KEY (id);



ALTER TABLE ONLY pr_agent_harness.feedback_observations
    ADD CONSTRAINT feedback_observations_tenant_id_integration_id_id_key UNIQUE (tenant_id, integration_id, id);



ALTER TABLE ONLY pr_agent_harness.feedback_observations
    ADD CONSTRAINT feedback_observations_tenant_id_source_run_id_command_key_key UNIQUE (tenant_id, source_run_id, command_key);



ALTER TABLE ONLY pr_agent_harness.finding_candidates
    ADD CONSTRAINT finding_candidates_pkey PRIMARY KEY (tenant_id, run_id, id);



ALTER TABLE ONLY pr_agent_harness.finding_decisions
    ADD CONSTRAINT finding_decisions_pkey PRIMARY KEY (tenant_id, id);



ALTER TABLE ONLY pr_agent_harness.finding_decisions
    ADD CONSTRAINT finding_decisions_stage_unique UNIQUE (tenant_id, run_id, stage, candidate_id);



ALTER TABLE ONLY pr_agent_harness.fix_approval_consumptions
    ADD CONSTRAINT fix_approval_consumptions_pkey PRIMARY KEY (id);



ALTER TABLE ONLY pr_agent_harness.fix_approval_consumptions
    ADD CONSTRAINT fix_approval_consumptions_tenant_id_approval_id_key UNIQUE (tenant_id, approval_id);



ALTER TABLE ONLY pr_agent_harness.fix_approval_consumptions
    ADD CONSTRAINT fix_approval_consumptions_tenant_id_batch_id_key UNIQUE (tenant_id, batch_id);



ALTER TABLE ONLY pr_agent_harness.fix_approval_consumptions
    ADD CONSTRAINT fix_approval_consumptions_tenant_id_publish_run_id_key UNIQUE (tenant_id, publish_run_id);



ALTER TABLE ONLY pr_agent_harness.fix_approval_decisions
    ADD CONSTRAINT fix_approval_decisions_pkey PRIMARY KEY (id);



ALTER TABLE ONLY pr_agent_harness.fix_approval_decisions
    ADD CONSTRAINT fix_approval_decisions_tenant_id_approval_id_command_key_key UNIQUE (tenant_id, approval_id, command_key);



ALTER TABLE ONLY pr_agent_harness.fix_approval_requests
    ADD CONSTRAINT fix_approval_requests_pkey PRIMARY KEY (id);



ALTER TABLE ONLY pr_agent_harness.fix_approval_requests
    ADD CONSTRAINT fix_approval_requests_tenant_id_approved_publish_run_id_key UNIQUE (tenant_id, approved_publish_run_id);



ALTER TABLE ONLY pr_agent_harness.fix_approval_requests
    ADD CONSTRAINT fix_approval_requests_tenant_id_proposal_run_id_command_key_key UNIQUE (tenant_id, proposal_run_id, command_key);



ALTER TABLE ONLY pr_agent_harness.fix_approval_requests
    ADD CONSTRAINT fix_approval_requests_tenant_id_proposal_run_id_generation_key UNIQUE (tenant_id, proposal_run_id, generation);



ALTER TABLE ONLY pr_agent_harness.fix_approval_requests
    ADD CONSTRAINT fix_approval_requests_tenant_id_proposal_run_id_id_key UNIQUE (tenant_id, proposal_run_id, id);



ALTER TABLE ONLY pr_agent_harness.fix_artifacts
    ADD CONSTRAINT fix_artifacts_pkey PRIMARY KEY (tenant_id, id);



ALTER TABLE ONLY pr_agent_harness.fix_artifacts
    ADD CONSTRAINT fix_artifacts_tenant_id_run_id_key UNIQUE (tenant_id, run_id);



ALTER TABLE ONLY pr_agent_harness.fix_proposals
    ADD CONSTRAINT fix_proposals_pkey PRIMARY KEY (tenant_id, id);



ALTER TABLE ONLY pr_agent_harness.fix_proposals
    ADD CONSTRAINT fix_proposals_tenant_id_run_id_id_key UNIQUE (tenant_id, run_id, id);



ALTER TABLE ONLY pr_agent_harness.fix_proposals
    ADD CONSTRAINT fix_proposals_tenant_id_run_id_revision_key UNIQUE (tenant_id, run_id, revision);



ALTER TABLE ONLY pr_agent_harness.fix_relevance_attestations
    ADD CONSTRAINT fix_relevance_attestations_pkey PRIMARY KEY (id);



ALTER TABLE ONLY pr_agent_harness.fix_relevance_attestations
    ADD CONSTRAINT fix_relevance_attestations_tenant_id_proposal_run_id_comman_key UNIQUE (tenant_id, proposal_run_id, command_key);



ALTER TABLE ONLY pr_agent_harness.fix_relevance_attestations
    ADD CONSTRAINT fix_relevance_attestations_tenant_id_proposal_run_id_propos_key UNIQUE (tenant_id, proposal_run_id, proposal_id);



ALTER TABLE ONLY pr_agent_harness.fix_run_findings
    ADD CONSTRAINT fix_run_findings_pkey PRIMARY KEY (tenant_id, run_id, finding_id);



ALTER TABLE ONLY pr_agent_harness.fix_run_sources
    ADD CONSTRAINT fix_run_sources_pkey PRIMARY KEY (tenant_id, run_id);



ALTER TABLE ONLY pr_agent_harness.fix_verifications
    ADD CONSTRAINT fix_verifications_pkey PRIMARY KEY (tenant_id, id);



ALTER TABLE ONLY pr_agent_harness.fix_verifications
    ADD CONSTRAINT fix_verifications_tenant_id_run_id_proposal_id_key UNIQUE (tenant_id, run_id, proposal_id);



ALTER TABLE ONLY pr_agent_harness.integration_bindings
    ADD CONSTRAINT integration_bindings_pkey PRIMARY KEY (id);



ALTER TABLE ONLY pr_agent_harness.integration_bindings
    ADD CONSTRAINT integration_bindings_provider_target UNIQUE (platform, origin, repository);



ALTER TABLE ONLY pr_agent_harness.integration_bindings
    ADD CONSTRAINT integration_bindings_tenant_identity UNIQUE (tenant_id, id);



ALTER TABLE ONLY pr_agent_harness.job_queue
    ADD CONSTRAINT job_queue_pkey PRIMARY KEY (id);



ALTER TABLE ONLY pr_agent_harness.job_queue
    ADD CONSTRAINT job_queue_tenant_identity UNIQUE (tenant_id, run_id, id);



ALTER TABLE ONLY pr_agent_harness.model_budget_reservations
    ADD CONSTRAINT model_budget_reservations_pkey PRIMARY KEY (tenant_id, model_call_id);



ALTER TABLE ONLY pr_agent_harness.model_calls
    ADD CONSTRAINT model_calls_physical_attempt UNIQUE (tenant_id, run_id, step_attempt_id, physical_ordinal);



ALTER TABLE ONLY pr_agent_harness.model_calls
    ADD CONSTRAINT model_calls_pkey PRIMARY KEY (id);



ALTER TABLE ONLY pr_agent_harness.model_calls
    ADD CONSTRAINT model_calls_tenant_identity UNIQUE (tenant_id, run_id, id);



ALTER TABLE ONLY pr_agent_harness.model_pricing_snapshots
    ADD CONSTRAINT model_pricing_snapshots_pkey PRIMARY KEY (tenant_id, pricing_hash);



ALTER TABLE ONLY pr_agent_harness.publication_batch_operations
    ADD CONSTRAINT publication_batch_operations_pkey PRIMARY KEY (tenant_id, batch_id, ordinal);



ALTER TABLE ONLY pr_agent_harness.publication_batch_operations
    ADD CONSTRAINT publication_batch_operations_unique_operation UNIQUE (tenant_id, batch_id, business_operation_id);



ALTER TABLE ONLY pr_agent_harness.publication_batches
    ADD CONSTRAINT publication_batches_pkey PRIMARY KEY (id);



ALTER TABLE ONLY pr_agent_harness.publication_batches
    ADD CONSTRAINT publication_batches_source_identity UNIQUE (tenant_id, integration_id, source_key);



ALTER TABLE ONLY pr_agent_harness.publication_batches
    ADD CONSTRAINT publication_batches_tenant_identity UNIQUE (tenant_id, id);



ALTER TABLE ONLY pr_agent_harness.publication_command_receipts
    ADD CONSTRAINT publication_command_receipts_command_identity UNIQUE (tenant_id, command_key);



ALTER TABLE ONLY pr_agent_harness.publication_command_receipts
    ADD CONSTRAINT publication_command_receipts_pkey PRIMARY KEY (id);



ALTER TABLE ONLY pr_agent_harness.publication_command_receipts
    ADD CONSTRAINT publication_command_receipts_tenant_identity UNIQUE (tenant_id, id);



ALTER TABLE ONLY pr_agent_harness.publication_slots
    ADD CONSTRAINT publication_slots_pkey PRIMARY KEY (tenant_id, integration_id, target, publication_slot);



ALTER TABLE ONLY pr_agent_harness.repository_operations
    ADD CONSTRAINT repository_operations_pkey PRIMARY KEY (id);



ALTER TABLE ONLY pr_agent_harness.repository_operations
    ADD CONSTRAINT repository_operations_tenant_identity UNIQUE (tenant_id, business_operation_id);



ALTER TABLE ONLY pr_agent_harness.review_annotation_arbitrations
    ADD CONSTRAINT review_annotation_arbitration_tenant_id_source_run_id_comma_key UNIQUE (tenant_id, source_run_id, command_key);



ALTER TABLE ONLY pr_agent_harness.review_annotation_arbitrations
    ADD CONSTRAINT review_annotation_arbitrations_pkey PRIMARY KEY (id);



ALTER TABLE ONLY pr_agent_harness.review_annotation_arbitrations
    ADD CONSTRAINT review_annotation_arbitrations_tenant_id_source_run_id_id_key UNIQUE (tenant_id, source_run_id, id);



ALTER TABLE ONLY pr_agent_harness.review_annotations
    ADD CONSTRAINT review_annotations_pkey PRIMARY KEY (id);



ALTER TABLE ONLY pr_agent_harness.review_annotations
    ADD CONSTRAINT review_annotations_tenant_id_source_run_id_command_key_key UNIQUE (tenant_id, source_run_id, command_key);



ALTER TABLE ONLY pr_agent_harness.review_annotations
    ADD CONSTRAINT review_annotations_tenant_id_source_run_id_id_key UNIQUE (tenant_id, source_run_id, id);



ALTER TABLE ONLY pr_agent_harness.review_artifacts
    ADD CONSTRAINT review_artifacts_pkey PRIMARY KEY (tenant_id, id);



ALTER TABLE ONLY pr_agent_harness.review_artifacts
    ADD CONSTRAINT review_artifacts_run_unique UNIQUE (tenant_id, run_id);



ALTER TABLE ONLY pr_agent_harness.run_budget_envelopes
    ADD CONSTRAINT run_budget_envelopes_pkey PRIMARY KEY (tenant_id, run_id);



ALTER TABLE ONLY pr_agent_harness.run_command_receipts
    ADD CONSTRAINT run_command_receipts_pkey PRIMARY KEY (id);



ALTER TABLE ONLY pr_agent_harness.run_command_receipts
    ADD CONSTRAINT run_command_receipts_tenant_id_run_id_command_key_key UNIQUE (tenant_id, run_id, command_key);



ALTER TABLE ONLY pr_agent_harness.run_command_receipts
    ADD CONSTRAINT run_command_receipts_tenant_id_run_id_id_key UNIQUE (tenant_id, run_id, id);



ALTER TABLE ONLY pr_agent_harness.run_events
    ADD CONSTRAINT run_events_pkey PRIMARY KEY (id);



ALTER TABLE ONLY pr_agent_harness.run_events
    ADD CONSTRAINT run_events_sequence UNIQUE (tenant_id, run_id, sequence);



ALTER TABLE ONLY pr_agent_harness.run_publication_batches
    ADD CONSTRAINT run_publication_batches_batch_unique UNIQUE (tenant_id, batch_id);



ALTER TABLE ONLY pr_agent_harness.run_publication_batches
    ADD CONSTRAINT run_publication_batches_pkey PRIMARY KEY (tenant_id, run_id, batch_id);



ALTER TABLE ONLY pr_agent_harness.run_wait_decisions
    ADD CONSTRAINT run_wait_decisions_pkey PRIMARY KEY (tenant_id, run_id, wait_id);



ALTER TABLE ONLY pr_agent_harness.run_wait_decisions
    ADD CONSTRAINT run_wait_decisions_tenant_id_run_id_command_receipt_id_key UNIQUE (tenant_id, run_id, command_receipt_id);



ALTER TABLE ONLY pr_agent_harness.run_waits
    ADD CONSTRAINT run_waits_pkey PRIMARY KEY (id);



ALTER TABLE ONLY pr_agent_harness.run_waits
    ADD CONSTRAINT run_waits_tenant_id_run_id_business_operation_id_operation__key UNIQUE (tenant_id, run_id, business_operation_id, operation_version);



ALTER TABLE ONLY pr_agent_harness.run_waits
    ADD CONSTRAINT run_waits_tenant_id_run_id_id_key UNIQUE (tenant_id, run_id, id);



ALTER TABLE ONLY pr_agent_harness.step_attempts
    ADD CONSTRAINT step_attempts_number UNIQUE (tenant_id, step_id, attempt_number);



ALTER TABLE ONLY pr_agent_harness.step_attempts
    ADD CONSTRAINT step_attempts_pkey PRIMARY KEY (id);



ALTER TABLE ONLY pr_agent_harness.step_attempts
    ADD CONSTRAINT step_attempts_step_identity UNIQUE (tenant_id, run_id, step_id, id);



ALTER TABLE ONLY pr_agent_harness.step_attempts
    ADD CONSTRAINT step_attempts_tenant_identity UNIQUE (tenant_id, run_id, id);



ALTER TABLE ONLY pr_agent_harness.tenant_budget_accounts
    ADD CONSTRAINT tenant_budget_accounts_pkey PRIMARY KEY (tenant_id, period_key, currency);



ALTER TABLE ONLY pr_agent_harness.tool_calls
    ADD CONSTRAINT tool_calls_physical_attempt UNIQUE (tenant_id, run_id, step_attempt_id);



ALTER TABLE ONLY pr_agent_harness.tool_calls
    ADD CONSTRAINT tool_calls_pkey PRIMARY KEY (id);



ALTER TABLE ONLY pr_agent_harness.tool_calls
    ADD CONSTRAINT tool_calls_tenant_identity UNIQUE (tenant_id, run_id, id);



ALTER TABLE ONLY pr_agent_harness.trusted_review_label_sets
    ADD CONSTRAINT trusted_review_label_sets_pkey PRIMARY KEY (id);



ALTER TABLE ONLY pr_agent_harness.trusted_review_label_sets
    ADD CONSTRAINT trusted_review_label_sets_tenant_id_id_key UNIQUE (tenant_id, id);



ALTER TABLE ONLY pr_agent_harness.trusted_review_label_sets
    ADD CONSTRAINT trusted_review_label_sets_tenant_id_integration_id_id_key UNIQUE (tenant_id, integration_id, id);



ALTER TABLE ONLY pr_agent_harness.trusted_review_label_sets
    ADD CONSTRAINT trusted_review_label_sets_tenant_id_source_run_id_rubric_ve_key UNIQUE (tenant_id, source_run_id, rubric_version, version);



ALTER TABLE ONLY pr_agent_harness.usage_records
    ADD CONSTRAINT usage_model_unique UNIQUE (tenant_id, model_call_id);



ALTER TABLE ONLY pr_agent_harness.usage_records
    ADD CONSTRAINT usage_records_pkey PRIMARY KEY (id);



ALTER TABLE ONLY pr_agent_harness.verification_jobs
    ADD CONSTRAINT verification_jobs_pkey PRIMARY KEY (id);



ALTER TABLE ONLY pr_agent_harness.verification_jobs
    ADD CONSTRAINT verification_jobs_tenant_id_run_id_id_key UNIQUE (tenant_id, run_id, id);



ALTER TABLE ONLY pr_agent_harness.verification_jobs
    ADD CONSTRAINT verification_jobs_tenant_id_run_id_proposal_id_key UNIQUE (tenant_id, run_id, proposal_id);



CREATE INDEX agent_runs_outcome_scan ON pr_agent_harness.agent_runs USING btree (tenant_id, integration_id, next_outcome_scan_at) WHERE (status = ANY (ARRAY['waiting_for_reconciliation'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text]));



CREATE INDEX agent_runs_retention_candidates ON pr_agent_harness.agent_runs USING btree (tenant_id, finished_at, id) WHERE ((status = ANY (ARRAY['succeeded'::text, 'failed'::text, 'cancelled'::text])) AND (content_purged_at IS NULL));



CREATE INDEX agent_runs_status ON pr_agent_harness.agent_runs USING btree (tenant_id, status, updated_at, id);



CREATE INDEX agent_steps_run_order ON pr_agent_harness.agent_steps USING btree (tenant_id, run_id, created_at, id);



CREATE INDEX audit_logs_run_recent ON pr_agent_harness.audit_logs USING btree (tenant_id, run_id, created_at DESC);



CREATE INDEX checkpoints_run_latest ON pr_agent_harness.checkpoints USING btree (tenant_id, run_id, sequence DESC);



CREATE INDEX eval_cases_lineage ON pr_agent_harness.eval_cases USING btree (tenant_id, integration_id, lineage_hash);



CREATE INDEX eval_cases_shingle ON pr_agent_harness.eval_cases USING btree (tenant_id, integration_id, shingle_hash);



CREATE INDEX eval_cases_split ON pr_agent_harness.eval_cases USING btree (tenant_id, dataset_id, split, ordinal, id);



CREATE UNIQUE INDEX eval_cases_tenant_dataset_identity ON pr_agent_harness.eval_cases USING btree (tenant_id, dataset_id, id);



CREATE INDEX eval_datasets_status ON pr_agent_harness.eval_datasets USING btree (tenant_id, curator_actor_type, curator_actor_id, status, created_at, id);



CREATE INDEX eval_fixture_files_kind ON pr_agent_harness.eval_fixture_files USING btree (tenant_id, fixture_id, kind, path);



CREATE INDEX eval_results_status ON pr_agent_harness.eval_results USING btree (tenant_id, eval_run_id, status, variant, repetition, case_id);



CREATE INDEX eval_runs_claim ON pr_agent_harness.eval_runs USING btree (tenant_id, status, available_at, deadline_at, created_at, id) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text]));



CREATE INDEX evidence_records_run ON pr_agent_harness.evidence_records USING btree (tenant_id, run_id, created_at, id);



CREATE INDEX evolution_candidates_dataset ON pr_agent_harness.evolution_candidates USING btree (tenant_id, dataset_id, status, created_at, id);



CREATE INDEX evolution_release_receipts_scope ON pr_agent_harness.evolution_release_receipts USING btree (tenant_id, integration_id, assignment_version);



CREATE INDEX evolution_release_requests_open ON pr_agent_harness.evolution_release_requests USING btree (tenant_id, integration_id, status, expires_at, id) WHERE (status = 'open'::text);



CREATE INDEX evolution_run_assignments_metrics ON pr_agent_harness.evolution_run_assignments USING btree (tenant_id, integration_id, assignment_version, selection, created_at, run_id);



CREATE INDEX finding_candidates_run ON pr_agent_harness.finding_candidates USING btree (tenant_id, run_id, created_at, id);



CREATE INDEX finding_decisions_run ON pr_agent_harness.finding_decisions USING btree (tenant_id, run_id, stage, created_at, id);



CREATE UNIQUE INDEX fix_approval_one_active ON pr_agent_harness.fix_approval_requests USING btree (tenant_id, proposal_run_id, proposal_id) WHERE (status = ANY (ARRAY['open'::text, 'approved'::text, 'consumed'::text]));



CREATE UNIQUE INDEX integration_bindings_immutable_target ON pr_agent_harness.integration_bindings USING btree (platform, origin, provider_repository_id) WHERE (provider_repository_id IS NOT NULL);



CREATE INDEX job_queue_claimable ON pr_agent_harness.job_queue USING btree (available_at, priority DESC, tenant_id, id) WHERE (status = ANY (ARRAY['ready'::text, 'retry_wait'::text]));



CREATE UNIQUE INDEX job_queue_manual_receipt_once ON pr_agent_harness.job_queue USING btree (tenant_id, run_id, command_receipt_id) WHERE (job_kind = 'manual_resume'::text);



CREATE UNIQUE INDEX job_queue_one_active_per_run ON pr_agent_harness.job_queue USING btree (tenant_id, run_id) WHERE (status = ANY (ARRAY['ready'::text, 'running'::text, 'retry_wait'::text]));



CREATE UNIQUE INDEX job_queue_publication_outcome_once ON pr_agent_harness.job_queue USING btree (tenant_id, run_id, outcome_generation, expected_operation_set_hash) WHERE (job_kind = 'publication_outcome'::text);



CREATE INDEX job_queue_ready ON pr_agent_harness.job_queue USING btree (available_at, priority DESC, tenant_id, id) WHERE (status = ANY (ARRAY['ready'::text, 'retry_wait'::text]));



CREATE INDEX model_calls_recovery ON pr_agent_harness.model_calls USING btree (tenant_id, run_id, step_id, step_attempt_id, physical_ordinal) WHERE (status = ANY (ARRAY['prepared'::text, 'in_flight'::text, 'unknown'::text]));



CREATE INDEX publication_batches_recoverable ON pr_agent_harness.publication_batches USING btree (tenant_id, integration_id, updated_at, id) WHERE (status = ANY (ARRAY['pending'::text, 'waiting_reconciliation'::text]));



CREATE INDEX publication_command_receipts_operation_history ON pr_agent_harness.publication_command_receipts USING btree (tenant_id, business_operation_id, created_at, id);



CREATE INDEX repository_operations_reconcile ON pr_agent_harness.repository_operations USING btree (tenant_id, status, updated_at, business_operation_id) WHERE (status = ANY (ARRAY['in_flight'::text, 'unknown'::text, 'manual_review'::text]));



CREATE INDEX repository_operations_recovery_due ON pr_agent_harness.repository_operations USING btree (tenant_id, integration_id, next_reconcile_at, updated_at, business_operation_id) WHERE (status = ANY (ARRAY['in_flight'::text, 'unknown'::text]));



CREATE INDEX review_annotations_consensus ON pr_agent_harness.review_annotations USING btree (tenant_id, source_run_id, rubric_version, label_set_hash, created_at) WHERE ((superseded_by_annotation_id IS NULL) AND (content_purged_at IS NULL));



CREATE UNIQUE INDEX review_annotations_one_active_actor ON pr_agent_harness.review_annotations USING btree (tenant_id, source_run_id, rubric_version, actor_type, actor_id) WHERE (superseded_by_annotation_id IS NULL);



CREATE INDEX run_budget_pending ON pr_agent_harness.run_budget_envelopes USING btree (tenant_id, status, updated_at) WHERE (status = 'pending_reconciliation'::text);



CREATE UNIQUE INDEX run_events_idempotent_fact ON pr_agent_harness.run_events USING btree (tenant_id, run_id, event_key) WHERE (event_key IS NOT NULL);



CREATE INDEX run_events_replay ON pr_agent_harness.run_events USING btree (tenant_id, run_id, sequence);



CREATE UNIQUE INDEX run_waits_one_open ON pr_agent_harness.run_waits USING btree (tenant_id, run_id) WHERE (status = 'open'::text);



CREATE UNIQUE INDEX trusted_review_label_sets_one_active ON pr_agent_harness.trusted_review_label_sets USING btree (tenant_id, source_run_id, rubric_version) WHERE active;



CREATE INDEX verification_jobs_claim ON pr_agent_harness.verification_jobs USING btree (available_at, tenant_id, id) WHERE (status = 'queued'::text);



CREATE INDEX verification_jobs_expired_lease ON pr_agent_harness.verification_jobs USING btree (lease_expires_at, tenant_id, id) WHERE (status = 'leased'::text);



CREATE TRIGGER eval_cases_frozen_guard BEFORE INSERT OR DELETE OR UPDATE ON pr_agent_harness.eval_cases FOR EACH ROW EXECUTE FUNCTION pr_agent_harness.guard_frozen_eval_dataset();



CREATE TRIGGER eval_datasets_state_guard BEFORE DELETE OR UPDATE ON pr_agent_harness.eval_datasets FOR EACH ROW EXECUTE FUNCTION pr_agent_harness.guard_eval_dataset_state();



CREATE TRIGGER eval_fixture_files_frozen_guard BEFORE INSERT OR DELETE OR UPDATE ON pr_agent_harness.eval_fixture_files FOR EACH ROW EXECUTE FUNCTION pr_agent_harness.guard_frozen_eval_fixture_file();



CREATE TRIGGER eval_fixtures_frozen_guard BEFORE DELETE OR UPDATE ON pr_agent_harness.eval_fixtures FOR EACH ROW EXECUTE FUNCTION pr_agent_harness.guard_frozen_eval_fixture();



CREATE TRIGGER eval_results_lifecycle_guard BEFORE DELETE OR UPDATE ON pr_agent_harness.eval_results FOR EACH ROW EXECUTE FUNCTION pr_agent_harness.guard_eval_result_lifecycle();



CREATE TRIGGER eval_runs_lifecycle_guard BEFORE DELETE OR UPDATE ON pr_agent_harness.eval_runs FOR EACH ROW EXECUTE FUNCTION pr_agent_harness.guard_eval_run_lifecycle();



CREATE TRIGGER evolution_candidates_immutable BEFORE DELETE OR UPDATE ON pr_agent_harness.evolution_candidates FOR EACH ROW EXECUTE FUNCTION pr_agent_harness.guard_evolution_candidate_content();



CREATE TRIGGER evolution_proposal_sources_immutable BEFORE DELETE OR UPDATE ON pr_agent_harness.evolution_proposal_sources FOR EACH ROW EXECUTE FUNCTION pr_agent_harness.guard_evolution_candidate_content();



CREATE TRIGGER feedback_observations_immutable BEFORE DELETE OR UPDATE ON pr_agent_harness.feedback_observations FOR EACH ROW EXECUTE FUNCTION pr_agent_harness.guard_evolution_raw_content();



CREATE TRIGGER publication_batch_operations_guard_sealed BEFORE INSERT OR DELETE OR UPDATE ON pr_agent_harness.publication_batch_operations FOR EACH ROW EXECUTE FUNCTION pr_agent_harness.guard_sealed_batch_links();



CREATE TRIGGER publication_batches_guard_seal BEFORE UPDATE ON pr_agent_harness.publication_batches FOR EACH ROW EXECUTE FUNCTION pr_agent_harness.guard_publication_batch_seal();



CREATE TRIGGER release_assignments_lifecycle BEFORE DELETE OR UPDATE ON pr_agent_harness.evolution_release_assignments FOR EACH ROW EXECUTE FUNCTION pr_agent_harness.guard_release_assignment_lifecycle();



CREATE TRIGGER release_decisions_immutable BEFORE DELETE OR UPDATE ON pr_agent_harness.evolution_release_decisions FOR EACH ROW EXECUTE FUNCTION pr_agent_harness.guard_release_append_only();



CREATE TRIGGER release_qualifications_immutable BEFORE DELETE OR UPDATE ON pr_agent_harness.evolution_release_qualifications FOR EACH ROW EXECUTE FUNCTION pr_agent_harness.guard_release_append_only();



CREATE TRIGGER release_receipts_immutable BEFORE DELETE OR UPDATE ON pr_agent_harness.evolution_release_receipts FOR EACH ROW EXECUTE FUNCTION pr_agent_harness.guard_release_append_only();



CREATE TRIGGER release_requests_lifecycle BEFORE DELETE OR UPDATE ON pr_agent_harness.evolution_release_requests FOR EACH ROW EXECUTE FUNCTION pr_agent_harness.guard_release_request_lifecycle();



CREATE TRIGGER repository_operations_guard_sealed_identity BEFORE UPDATE ON pr_agent_harness.repository_operations FOR EACH ROW EXECUTE FUNCTION pr_agent_harness.guard_sealed_operation_identity();



CREATE TRIGGER repository_operations_reset_recovery_on_retry BEFORE UPDATE OF status ON pr_agent_harness.repository_operations FOR EACH ROW EXECUTE FUNCTION pr_agent_harness.reset_publication_recovery_on_retry();



CREATE TRIGGER review_annotation_arbitrations_immutable BEFORE DELETE OR UPDATE ON pr_agent_harness.review_annotation_arbitrations FOR EACH ROW EXECUTE FUNCTION pr_agent_harness.guard_evolution_raw_content();



CREATE TRIGGER review_annotations_immutable BEFORE DELETE OR UPDATE ON pr_agent_harness.review_annotations FOR EACH ROW EXECUTE FUNCTION pr_agent_harness.guard_evolution_raw_content();



CREATE TRIGGER run_assignments_immutable BEFORE DELETE OR UPDATE ON pr_agent_harness.evolution_run_assignments FOR EACH ROW EXECUTE FUNCTION pr_agent_harness.guard_release_append_only();



CREATE TRIGGER trusted_review_label_sets_immutable BEFORE DELETE OR UPDATE ON pr_agent_harness.trusted_review_label_sets FOR EACH ROW EXECUTE FUNCTION pr_agent_harness.guard_evolution_raw_content();



ALTER TABLE ONLY pr_agent_harness.agent_runs
    ADD CONSTRAINT agent_runs_integration_fk FOREIGN KEY (tenant_id, integration_id) REFERENCES pr_agent_harness.integration_bindings(tenant_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.agent_runs
    ADD CONSTRAINT agent_runs_parent_fk FOREIGN KEY (tenant_id, parent_run_id) REFERENCES pr_agent_harness.agent_runs(tenant_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.agent_runs
    ADD CONSTRAINT agent_runs_waiting_batch_fk FOREIGN KEY (tenant_id, waiting_batch_id) REFERENCES pr_agent_harness.publication_batches(tenant_id, id);



ALTER TABLE ONLY pr_agent_harness.agent_steps
    ADD CONSTRAINT agent_steps_run_fk FOREIGN KEY (tenant_id, run_id) REFERENCES pr_agent_harness.agent_runs(tenant_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.audit_logs
    ADD CONSTRAINT audit_logs_run_fk FOREIGN KEY (tenant_id, run_id) REFERENCES pr_agent_harness.agent_runs(tenant_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.checkpoints
    ADD CONSTRAINT checkpoints_attempt_fk FOREIGN KEY (tenant_id, run_id, step_attempt_id) REFERENCES pr_agent_harness.step_attempts(tenant_id, run_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.checkpoints
    ADD CONSTRAINT checkpoints_publication_batch_fk FOREIGN KEY (tenant_id, publication_batch_id) REFERENCES pr_agent_harness.publication_batches(tenant_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.checkpoints
    ADD CONSTRAINT checkpoints_step_fk FOREIGN KEY (tenant_id, run_id, step_id) REFERENCES pr_agent_harness.agent_steps(tenant_id, run_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.dead_letter_jobs
    ADD CONSTRAINT dead_letter_jobs_job_fk FOREIGN KEY (tenant_id, run_id, job_id) REFERENCES pr_agent_harness.job_queue(tenant_id, run_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.dead_letter_jobs
    ADD CONSTRAINT dead_letter_jobs_run_fk FOREIGN KEY (tenant_id, run_id) REFERENCES pr_agent_harness.agent_runs(tenant_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.eval_cases
    ADD CONSTRAINT eval_cases_tenant_id_dataset_id_fkey FOREIGN KEY (tenant_id, dataset_id) REFERENCES pr_agent_harness.eval_datasets(tenant_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.eval_cases
    ADD CONSTRAINT eval_cases_tenant_id_fixture_id_fkey FOREIGN KEY (tenant_id, fixture_id) REFERENCES pr_agent_harness.eval_fixtures(tenant_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.eval_cases
    ADD CONSTRAINT eval_cases_tenant_id_integration_id_source_run_id_fkey FOREIGN KEY (tenant_id, integration_id, source_run_id) REFERENCES pr_agent_harness.agent_runs(tenant_id, integration_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.eval_cases
    ADD CONSTRAINT eval_cases_tenant_id_label_set_id_fkey FOREIGN KEY (tenant_id, label_set_id) REFERENCES pr_agent_harness.trusted_review_label_sets(tenant_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.eval_fixture_files
    ADD CONSTRAINT eval_fixture_files_tenant_id_fixture_id_fkey FOREIGN KEY (tenant_id, fixture_id) REFERENCES pr_agent_harness.eval_fixtures(tenant_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.eval_fixtures
    ADD CONSTRAINT eval_fixtures_tenant_id_integration_id_run_id_fkey FOREIGN KEY (tenant_id, integration_id, run_id) REFERENCES pr_agent_harness.agent_runs(tenant_id, integration_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.eval_fixtures
    ADD CONSTRAINT eval_fixtures_tenant_id_run_id_source_step_id_fkey FOREIGN KEY (tenant_id, run_id, source_step_id) REFERENCES pr_agent_harness.agent_steps(tenant_id, run_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.eval_results
    ADD CONSTRAINT eval_results_tenant_id_dataset_id_case_id_fkey FOREIGN KEY (tenant_id, dataset_id, case_id) REFERENCES pr_agent_harness.eval_cases(tenant_id, dataset_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.eval_results
    ADD CONSTRAINT eval_results_tenant_id_eval_run_id_fkey FOREIGN KEY (tenant_id, eval_run_id) REFERENCES pr_agent_harness.eval_runs(tenant_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.eval_results
    ADD CONSTRAINT eval_results_tenant_id_integration_id_child_run_id_fkey FOREIGN KEY (tenant_id, integration_id, child_run_id) REFERENCES pr_agent_harness.agent_runs(tenant_id, integration_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.eval_results
    ADD CONSTRAINT eval_results_tenant_id_label_set_id_fkey FOREIGN KEY (tenant_id, label_set_id) REFERENCES pr_agent_harness.trusted_review_label_sets(tenant_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.eval_runs
    ADD CONSTRAINT eval_runs_tenant_id_candidate_id_fkey FOREIGN KEY (tenant_id, candidate_id) REFERENCES pr_agent_harness.evolution_candidates(tenant_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.eval_runs
    ADD CONSTRAINT eval_runs_tenant_id_dataset_id_fkey FOREIGN KEY (tenant_id, dataset_id) REFERENCES pr_agent_harness.eval_datasets(tenant_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.evidence_records
    ADD CONSTRAINT evidence_records_attempt_fk FOREIGN KEY (tenant_id, run_id, step_attempt_id) REFERENCES pr_agent_harness.step_attempts(tenant_id, run_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.evidence_records
    ADD CONSTRAINT evidence_records_run_fk FOREIGN KEY (tenant_id, integration_id, run_id) REFERENCES pr_agent_harness.agent_runs(tenant_id, integration_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.evidence_records
    ADD CONSTRAINT evidence_records_step_fk FOREIGN KEY (tenant_id, run_id, step_id) REFERENCES pr_agent_harness.agent_steps(tenant_id, run_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.evidence_records
    ADD CONSTRAINT evidence_records_tool_fk FOREIGN KEY (tenant_id, run_id, tool_call_id) REFERENCES pr_agent_harness.tool_calls(tenant_id, run_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.evolution_candidates
    ADD CONSTRAINT evolution_candidates_tenant_id_dataset_id_fkey FOREIGN KEY (tenant_id, dataset_id) REFERENCES pr_agent_harness.eval_datasets(tenant_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.evolution_candidates
    ADD CONSTRAINT evolution_candidates_tenant_id_proposal_run_id_fkey FOREIGN KEY (tenant_id, proposal_run_id) REFERENCES pr_agent_harness.evolution_proposal_sources(tenant_id, proposal_run_id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.evolution_proposal_sources
    ADD CONSTRAINT evolution_proposal_sources_tenant_id_dataset_id_fkey FOREIGN KEY (tenant_id, dataset_id) REFERENCES pr_agent_harness.eval_datasets(tenant_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.evolution_proposal_sources
    ADD CONSTRAINT evolution_proposal_sources_tenant_id_proposal_run_id_fkey FOREIGN KEY (tenant_id, proposal_run_id) REFERENCES pr_agent_harness.agent_runs(tenant_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.evolution_release_assignments
    ADD CONSTRAINT evolution_release_assignments_tenant_id_candidate_id_fkey FOREIGN KEY (tenant_id, candidate_id) REFERENCES pr_agent_harness.evolution_candidates(tenant_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.evolution_release_assignments
    ADD CONSTRAINT evolution_release_assignments_tenant_id_integration_id_fkey FOREIGN KEY (tenant_id, integration_id) REFERENCES pr_agent_harness.integration_bindings(tenant_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.evolution_release_assignments
    ADD CONSTRAINT evolution_release_assignments_tenant_id_integration_id_qua_fkey FOREIGN KEY (tenant_id, integration_id, qualification_id, candidate_id) REFERENCES pr_agent_harness.evolution_release_qualifications(tenant_id, integration_id, id, candidate_id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.evolution_release_decisions
    ADD CONSTRAINT evolution_release_decisions_tenant_id_integration_id_fkey FOREIGN KEY (tenant_id, integration_id) REFERENCES pr_agent_harness.integration_bindings(tenant_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.evolution_release_decisions
    ADD CONSTRAINT evolution_release_decisions_tenant_id_integration_id_reque_fkey FOREIGN KEY (tenant_id, integration_id, request_id) REFERENCES pr_agent_harness.evolution_release_requests(tenant_id, integration_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.evolution_release_qualifications
    ADD CONSTRAINT evolution_release_qualificati_tenant_id_holdout_evaluation_fkey FOREIGN KEY (tenant_id, holdout_evaluation_id) REFERENCES pr_agent_harness.eval_runs(tenant_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.evolution_release_qualifications
    ADD CONSTRAINT evolution_release_qualificati_tenant_id_validation_evaluat_fkey FOREIGN KEY (tenant_id, validation_evaluation_id) REFERENCES pr_agent_harness.eval_runs(tenant_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.evolution_release_qualifications
    ADD CONSTRAINT evolution_release_qualifications_tenant_id_candidate_id_fkey FOREIGN KEY (tenant_id, candidate_id) REFERENCES pr_agent_harness.evolution_candidates(tenant_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.evolution_release_qualifications
    ADD CONSTRAINT evolution_release_qualifications_tenant_id_dataset_id_fkey FOREIGN KEY (tenant_id, dataset_id) REFERENCES pr_agent_harness.eval_datasets(tenant_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.evolution_release_qualifications
    ADD CONSTRAINT evolution_release_qualifications_tenant_id_integration_id_fkey FOREIGN KEY (tenant_id, integration_id) REFERENCES pr_agent_harness.integration_bindings(tenant_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.evolution_release_receipts
    ADD CONSTRAINT evolution_release_receipts_tenant_id_integration_id_fkey FOREIGN KEY (tenant_id, integration_id) REFERENCES pr_agent_harness.integration_bindings(tenant_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.evolution_release_receipts
    ADD CONSTRAINT evolution_release_receipts_tenant_id_integration_id_reques_fkey FOREIGN KEY (tenant_id, integration_id, request_id) REFERENCES pr_agent_harness.evolution_release_requests(tenant_id, integration_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.evolution_release_requests
    ADD CONSTRAINT evolution_release_requests_tenant_id_candidate_id_fkey FOREIGN KEY (tenant_id, candidate_id) REFERENCES pr_agent_harness.evolution_candidates(tenant_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.evolution_release_requests
    ADD CONSTRAINT evolution_release_requests_tenant_id_integration_id_fkey FOREIGN KEY (tenant_id, integration_id) REFERENCES pr_agent_harness.integration_bindings(tenant_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.evolution_release_requests
    ADD CONSTRAINT evolution_release_requests_tenant_id_integration_id_qualif_fkey FOREIGN KEY (tenant_id, integration_id, qualification_id, candidate_id) REFERENCES pr_agent_harness.evolution_release_qualifications(tenant_id, integration_id, id, candidate_id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.evolution_run_assignments
    ADD CONSTRAINT evolution_run_assignments_tenant_id_candidate_id_fkey FOREIGN KEY (tenant_id, candidate_id) REFERENCES pr_agent_harness.evolution_candidates(tenant_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.evolution_run_assignments
    ADD CONSTRAINT evolution_run_assignments_tenant_id_integration_id_qualifi_fkey FOREIGN KEY (tenant_id, integration_id, qualification_id, candidate_id) REFERENCES pr_agent_harness.evolution_release_qualifications(tenant_id, integration_id, id, candidate_id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.evolution_run_assignments
    ADD CONSTRAINT evolution_run_assignments_tenant_id_integration_id_release_fkey FOREIGN KEY (tenant_id, integration_id, release_receipt_id, assignment_version) REFERENCES pr_agent_harness.evolution_release_receipts(tenant_id, integration_id, id, assignment_version) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.evolution_run_assignments
    ADD CONSTRAINT evolution_run_assignments_tenant_id_integration_id_run_id_fkey FOREIGN KEY (tenant_id, integration_id, run_id) REFERENCES pr_agent_harness.agent_runs(tenant_id, integration_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.feedback_observations
    ADD CONSTRAINT feedback_observations_tenant_id_integration_id_source_run__fkey FOREIGN KEY (tenant_id, integration_id, source_run_id) REFERENCES pr_agent_harness.agent_runs(tenant_id, integration_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.finding_candidates
    ADD CONSTRAINT finding_candidates_run_fk FOREIGN KEY (tenant_id, integration_id, run_id) REFERENCES pr_agent_harness.agent_runs(tenant_id, integration_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.finding_candidates
    ADD CONSTRAINT finding_candidates_step_fk FOREIGN KEY (tenant_id, run_id, step_id) REFERENCES pr_agent_harness.agent_steps(tenant_id, run_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.finding_decisions
    ADD CONSTRAINT finding_decisions_candidate_fk FOREIGN KEY (tenant_id, run_id, candidate_id) REFERENCES pr_agent_harness.finding_candidates(tenant_id, run_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.finding_decisions
    ADD CONSTRAINT finding_decisions_run_fk FOREIGN KEY (tenant_id, integration_id, run_id) REFERENCES pr_agent_harness.agent_runs(tenant_id, integration_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.finding_decisions
    ADD CONSTRAINT finding_decisions_step_fk FOREIGN KEY (tenant_id, run_id, step_id) REFERENCES pr_agent_harness.agent_steps(tenant_id, run_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.fix_approval_consumptions
    ADD CONSTRAINT fix_approval_consumptions_tenant_id_batch_id_fkey FOREIGN KEY (tenant_id, batch_id) REFERENCES pr_agent_harness.publication_batches(tenant_id, id);



ALTER TABLE ONLY pr_agent_harness.fix_approval_consumptions
    ADD CONSTRAINT fix_approval_consumptions_tenant_id_proposal_run_id_approv_fkey FOREIGN KEY (tenant_id, proposal_run_id, approval_id) REFERENCES pr_agent_harness.fix_approval_requests(tenant_id, proposal_run_id, id);



ALTER TABLE ONLY pr_agent_harness.fix_approval_consumptions
    ADD CONSTRAINT fix_approval_consumptions_tenant_id_publish_run_id_fkey FOREIGN KEY (tenant_id, publish_run_id) REFERENCES pr_agent_harness.agent_runs(tenant_id, id);



ALTER TABLE ONLY pr_agent_harness.fix_approval_decisions
    ADD CONSTRAINT fix_approval_decisions_tenant_id_proposal_run_id_approval__fkey FOREIGN KEY (tenant_id, proposal_run_id, approval_id) REFERENCES pr_agent_harness.fix_approval_requests(tenant_id, proposal_run_id, id);



ALTER TABLE ONLY pr_agent_harness.fix_approval_decisions
    ADD CONSTRAINT fix_approval_decisions_tenant_id_publish_run_id_fkey FOREIGN KEY (tenant_id, publish_run_id) REFERENCES pr_agent_harness.agent_runs(tenant_id, id);



ALTER TABLE ONLY pr_agent_harness.fix_approval_requests
    ADD CONSTRAINT fix_approval_requests_tenant_id_integration_id_approved_pu_fkey FOREIGN KEY (tenant_id, integration_id, approved_publish_run_id) REFERENCES pr_agent_harness.agent_runs(tenant_id, integration_id, id);



ALTER TABLE ONLY pr_agent_harness.fix_approval_requests
    ADD CONSTRAINT fix_approval_requests_tenant_id_integration_id_proposal_ru_fkey FOREIGN KEY (tenant_id, integration_id, proposal_run_id) REFERENCES pr_agent_harness.agent_runs(tenant_id, integration_id, id);



ALTER TABLE ONLY pr_agent_harness.fix_approval_requests
    ADD CONSTRAINT fix_approval_requests_tenant_id_proposal_run_id_proposal_i_fkey FOREIGN KEY (tenant_id, proposal_run_id, proposal_id) REFERENCES pr_agent_harness.fix_proposals(tenant_id, run_id, id);



ALTER TABLE ONLY pr_agent_harness.fix_artifacts
    ADD CONSTRAINT fix_artifacts_tenant_id_integration_id_run_id_fkey FOREIGN KEY (tenant_id, integration_id, run_id) REFERENCES pr_agent_harness.agent_runs(tenant_id, integration_id, id);



ALTER TABLE ONLY pr_agent_harness.fix_proposals
    ADD CONSTRAINT fix_proposals_tenant_id_integration_id_run_id_fkey FOREIGN KEY (tenant_id, integration_id, run_id) REFERENCES pr_agent_harness.agent_runs(tenant_id, integration_id, id);



ALTER TABLE ONLY pr_agent_harness.fix_proposals
    ADD CONSTRAINT fix_proposals_tenant_id_run_id_finding_id_fkey FOREIGN KEY (tenant_id, run_id, finding_id) REFERENCES pr_agent_harness.fix_run_findings(tenant_id, run_id, finding_id);



ALTER TABLE ONLY pr_agent_harness.fix_relevance_attestations
    ADD CONSTRAINT fix_relevance_attestations_tenant_id_integration_id_propos_fkey FOREIGN KEY (tenant_id, integration_id, proposal_run_id) REFERENCES pr_agent_harness.agent_runs(tenant_id, integration_id, id);



ALTER TABLE ONLY pr_agent_harness.fix_relevance_attestations
    ADD CONSTRAINT fix_relevance_attestations_tenant_id_proposal_run_id_propo_fkey FOREIGN KEY (tenant_id, proposal_run_id, proposal_id) REFERENCES pr_agent_harness.fix_proposals(tenant_id, run_id, id);



ALTER TABLE ONLY pr_agent_harness.fix_run_findings
    ADD CONSTRAINT fix_run_findings_tenant_id_gate_decision_id_fkey FOREIGN KEY (tenant_id, gate_decision_id) REFERENCES pr_agent_harness.finding_decisions(tenant_id, id);



ALTER TABLE ONLY pr_agent_harness.fix_run_findings
    ADD CONSTRAINT fix_run_findings_tenant_id_run_id_fkey FOREIGN KEY (tenant_id, run_id) REFERENCES pr_agent_harness.fix_run_sources(tenant_id, run_id);



ALTER TABLE ONLY pr_agent_harness.fix_run_findings
    ADD CONSTRAINT fix_run_findings_tenant_id_source_review_run_id_finding_id_fkey FOREIGN KEY (tenant_id, source_review_run_id, finding_id) REFERENCES pr_agent_harness.finding_candidates(tenant_id, run_id, id);



ALTER TABLE ONLY pr_agent_harness.fix_run_sources
    ADD CONSTRAINT fix_run_sources_tenant_id_integration_id_run_id_fkey FOREIGN KEY (tenant_id, integration_id, run_id) REFERENCES pr_agent_harness.agent_runs(tenant_id, integration_id, id);



ALTER TABLE ONLY pr_agent_harness.fix_run_sources
    ADD CONSTRAINT fix_run_sources_tenant_id_integration_id_source_review_run_fkey FOREIGN KEY (tenant_id, integration_id, source_review_run_id) REFERENCES pr_agent_harness.agent_runs(tenant_id, integration_id, id);



ALTER TABLE ONLY pr_agent_harness.fix_run_sources
    ADD CONSTRAINT fix_run_sources_tenant_id_source_review_run_id_finding_id_fkey FOREIGN KEY (tenant_id, source_review_run_id, finding_id) REFERENCES pr_agent_harness.finding_candidates(tenant_id, run_id, id);



ALTER TABLE ONLY pr_agent_harness.fix_verifications
    ADD CONSTRAINT fix_verifications_tenant_id_integration_id_run_id_fkey FOREIGN KEY (tenant_id, integration_id, run_id) REFERENCES pr_agent_harness.agent_runs(tenant_id, integration_id, id);



ALTER TABLE ONLY pr_agent_harness.fix_verifications
    ADD CONSTRAINT fix_verifications_tenant_id_run_id_proposal_id_fkey FOREIGN KEY (tenant_id, run_id, proposal_id) REFERENCES pr_agent_harness.fix_proposals(tenant_id, run_id, id);



ALTER TABLE ONLY pr_agent_harness.fix_verifications
    ADD CONSTRAINT fix_verifications_tenant_id_run_id_verification_job_id_fkey FOREIGN KEY (tenant_id, run_id, verification_job_id) REFERENCES pr_agent_harness.verification_jobs(tenant_id, run_id, id);



ALTER TABLE ONLY pr_agent_harness.job_queue
    ADD CONSTRAINT job_queue_run_fk FOREIGN KEY (tenant_id, run_id) REFERENCES pr_agent_harness.agent_runs(tenant_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.job_queue
    ADD CONSTRAINT job_queue_tenant_id_run_id_command_receipt_id_fkey FOREIGN KEY (tenant_id, run_id, command_receipt_id) REFERENCES pr_agent_harness.run_command_receipts(tenant_id, run_id, id);



ALTER TABLE ONLY pr_agent_harness.job_queue
    ADD CONSTRAINT job_queue_tenant_id_run_id_expected_batch_id_fkey FOREIGN KEY (tenant_id, run_id, expected_batch_id) REFERENCES pr_agent_harness.run_publication_batches(tenant_id, run_id, batch_id);



ALTER TABLE ONLY pr_agent_harness.job_queue
    ADD CONSTRAINT job_queue_tenant_id_run_id_wait_id_fkey FOREIGN KEY (tenant_id, run_id, wait_id) REFERENCES pr_agent_harness.run_waits(tenant_id, run_id, id);



ALTER TABLE ONLY pr_agent_harness.model_budget_reservations
    ADD CONSTRAINT model_budget_call_fk FOREIGN KEY (tenant_id, run_id, model_call_id) REFERENCES pr_agent_harness.model_calls(tenant_id, run_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.model_calls
    ADD CONSTRAINT model_calls_attempt_fk FOREIGN KEY (tenant_id, run_id, step_id, step_attempt_id) REFERENCES pr_agent_harness.step_attempts(tenant_id, run_id, step_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.model_calls
    ADD CONSTRAINT model_calls_step_fk FOREIGN KEY (tenant_id, run_id, step_id) REFERENCES pr_agent_harness.agent_steps(tenant_id, run_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.publication_batch_operations
    ADD CONSTRAINT publication_batch_operations_batch_fk FOREIGN KEY (tenant_id, batch_id) REFERENCES pr_agent_harness.publication_batches(tenant_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.publication_batch_operations
    ADD CONSTRAINT publication_batch_operations_operation_fk FOREIGN KEY (tenant_id, business_operation_id) REFERENCES pr_agent_harness.repository_operations(tenant_id, business_operation_id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.publication_batches
    ADD CONSTRAINT publication_batches_integration_fk FOREIGN KEY (tenant_id, integration_id) REFERENCES pr_agent_harness.integration_bindings(tenant_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.publication_command_receipts
    ADD CONSTRAINT publication_command_receipts_operation_fk FOREIGN KEY (tenant_id, business_operation_id) REFERENCES pr_agent_harness.repository_operations(tenant_id, business_operation_id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.publication_slots
    ADD CONSTRAINT publication_slots_integration_fk FOREIGN KEY (tenant_id, integration_id) REFERENCES pr_agent_harness.integration_bindings(tenant_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.publication_slots
    ADD CONSTRAINT publication_slots_operation_fk FOREIGN KEY (tenant_id, active_business_operation_id) REFERENCES pr_agent_harness.repository_operations(tenant_id, business_operation_id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.repository_operations
    ADD CONSTRAINT repository_operations_integration_fk FOREIGN KEY (tenant_id, integration_id) REFERENCES pr_agent_harness.integration_bindings(tenant_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.review_annotation_arbitrations
    ADD CONSTRAINT review_annotation_arbitration_tenant_id_integration_id_sou_fkey FOREIGN KEY (tenant_id, integration_id, source_run_id) REFERENCES pr_agent_harness.agent_runs(tenant_id, integration_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.review_annotation_arbitrations
    ADD CONSTRAINT review_annotation_arbitration_tenant_id_source_run_id_left_fkey FOREIGN KEY (tenant_id, source_run_id, left_annotation_id) REFERENCES pr_agent_harness.review_annotations(tenant_id, source_run_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.review_annotation_arbitrations
    ADD CONSTRAINT review_annotation_arbitration_tenant_id_source_run_id_righ_fkey FOREIGN KEY (tenant_id, source_run_id, right_annotation_id) REFERENCES pr_agent_harness.review_annotations(tenant_id, source_run_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.review_annotations
    ADD CONSTRAINT review_annotations_tenant_id_integration_id_source_run_id_fkey FOREIGN KEY (tenant_id, integration_id, source_run_id) REFERENCES pr_agent_harness.agent_runs(tenant_id, integration_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.review_annotations
    ADD CONSTRAINT review_annotations_tenant_id_source_run_id_superseded_by_a_fkey FOREIGN KEY (tenant_id, source_run_id, superseded_by_annotation_id) REFERENCES pr_agent_harness.review_annotations(tenant_id, source_run_id, id) DEFERRABLE INITIALLY DEFERRED;



ALTER TABLE ONLY pr_agent_harness.review_annotations
    ADD CONSTRAINT review_annotations_tenant_id_source_run_id_supersedes_anno_fkey FOREIGN KEY (tenant_id, source_run_id, supersedes_annotation_id) REFERENCES pr_agent_harness.review_annotations(tenant_id, source_run_id, id) DEFERRABLE INITIALLY DEFERRED;



ALTER TABLE ONLY pr_agent_harness.review_artifacts
    ADD CONSTRAINT review_artifacts_run_fk FOREIGN KEY (tenant_id, integration_id, run_id) REFERENCES pr_agent_harness.agent_runs(tenant_id, integration_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.run_budget_envelopes
    ADD CONSTRAINT run_budget_account_fk FOREIGN KEY (tenant_id, period_key, currency) REFERENCES pr_agent_harness.tenant_budget_accounts(tenant_id, period_key, currency) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.run_budget_envelopes
    ADD CONSTRAINT run_budget_pricing_fk FOREIGN KEY (tenant_id, pricing_hash) REFERENCES pr_agent_harness.model_pricing_snapshots(tenant_id, pricing_hash) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.run_budget_envelopes
    ADD CONSTRAINT run_budget_run_fk FOREIGN KEY (tenant_id, run_id) REFERENCES pr_agent_harness.agent_runs(tenant_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.run_command_receipts
    ADD CONSTRAINT run_command_receipts_tenant_id_integration_id_new_run_id_fkey FOREIGN KEY (tenant_id, integration_id, new_run_id) REFERENCES pr_agent_harness.agent_runs(tenant_id, integration_id, id);



ALTER TABLE ONLY pr_agent_harness.run_command_receipts
    ADD CONSTRAINT run_command_receipts_tenant_id_integration_id_run_id_fkey FOREIGN KEY (tenant_id, integration_id, run_id) REFERENCES pr_agent_harness.agent_runs(tenant_id, integration_id, id);



ALTER TABLE ONLY pr_agent_harness.run_command_receipts
    ADD CONSTRAINT run_command_receipts_tenant_id_run_id_job_id_fkey FOREIGN KEY (tenant_id, run_id, job_id) REFERENCES pr_agent_harness.job_queue(tenant_id, run_id, id);



ALTER TABLE ONLY pr_agent_harness.run_events
    ADD CONSTRAINT run_events_run_fk FOREIGN KEY (tenant_id, run_id) REFERENCES pr_agent_harness.agent_runs(tenant_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.run_publication_batches
    ADD CONSTRAINT run_publication_batches_batch_fk FOREIGN KEY (tenant_id, batch_id) REFERENCES pr_agent_harness.publication_batches(tenant_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.run_publication_batches
    ADD CONSTRAINT run_publication_batches_run_fk FOREIGN KEY (tenant_id, run_id) REFERENCES pr_agent_harness.agent_runs(tenant_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.run_publication_batches
    ADD CONSTRAINT run_publication_batches_step_fk FOREIGN KEY (tenant_id, run_id, step_id) REFERENCES pr_agent_harness.agent_steps(tenant_id, run_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.run_wait_decisions
    ADD CONSTRAINT run_wait_decisions_tenant_id_run_id_command_receipt_id_fkey FOREIGN KEY (tenant_id, run_id, command_receipt_id) REFERENCES pr_agent_harness.run_command_receipts(tenant_id, run_id, id);



ALTER TABLE ONLY pr_agent_harness.run_wait_decisions
    ADD CONSTRAINT run_wait_decisions_tenant_id_run_id_wait_id_fkey FOREIGN KEY (tenant_id, run_id, wait_id) REFERENCES pr_agent_harness.run_waits(tenant_id, run_id, id);



ALTER TABLE ONLY pr_agent_harness.run_waits
    ADD CONSTRAINT run_waits_tenant_id_business_operation_id_fkey FOREIGN KEY (tenant_id, business_operation_id) REFERENCES pr_agent_harness.repository_operations(tenant_id, business_operation_id);



ALTER TABLE ONLY pr_agent_harness.run_waits
    ADD CONSTRAINT run_waits_tenant_id_run_id_batch_id_fkey FOREIGN KEY (tenant_id, run_id, batch_id) REFERENCES pr_agent_harness.run_publication_batches(tenant_id, run_id, batch_id);



ALTER TABLE ONLY pr_agent_harness.step_attempts
    ADD CONSTRAINT step_attempts_step_fk FOREIGN KEY (tenant_id, run_id, step_id) REFERENCES pr_agent_harness.agent_steps(tenant_id, run_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.tool_calls
    ADD CONSTRAINT tool_calls_attempt_fk FOREIGN KEY (tenant_id, run_id, step_attempt_id) REFERENCES pr_agent_harness.step_attempts(tenant_id, run_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.tool_calls
    ADD CONSTRAINT tool_calls_step_fk FOREIGN KEY (tenant_id, run_id, step_id) REFERENCES pr_agent_harness.agent_steps(tenant_id, run_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.trusted_review_label_sets
    ADD CONSTRAINT trusted_review_label_sets_tenant_id_integration_id_source__fkey FOREIGN KEY (tenant_id, integration_id, source_run_id) REFERENCES pr_agent_harness.agent_runs(tenant_id, integration_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.trusted_review_label_sets
    ADD CONSTRAINT trusted_review_label_sets_tenant_id_source_run_id_arbitrat_fkey FOREIGN KEY (tenant_id, source_run_id, arbitration_id) REFERENCES pr_agent_harness.review_annotation_arbitrations(tenant_id, source_run_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.trusted_review_label_sets
    ADD CONSTRAINT trusted_review_label_sets_tenant_id_supersedes_label_set_i_fkey FOREIGN KEY (tenant_id, supersedes_label_set_id) REFERENCES pr_agent_harness.trusted_review_label_sets(tenant_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.usage_records
    ADD CONSTRAINT usage_call_fk FOREIGN KEY (tenant_id, run_id, model_call_id) REFERENCES pr_agent_harness.model_calls(tenant_id, run_id, id) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.usage_records
    ADD CONSTRAINT usage_pricing_fk FOREIGN KEY (tenant_id, pricing_hash) REFERENCES pr_agent_harness.model_pricing_snapshots(tenant_id, pricing_hash) ON DELETE RESTRICT;



ALTER TABLE ONLY pr_agent_harness.verification_jobs
    ADD CONSTRAINT verification_jobs_tenant_id_integration_id_run_id_fkey FOREIGN KEY (tenant_id, integration_id, run_id) REFERENCES pr_agent_harness.agent_runs(tenant_id, integration_id, id);



ALTER TABLE ONLY pr_agent_harness.verification_jobs
    ADD CONSTRAINT verification_jobs_tenant_id_run_id_proposal_id_fkey FOREIGN KEY (tenant_id, run_id, proposal_id) REFERENCES pr_agent_harness.fix_proposals(tenant_id, run_id, id);



ALTER TABLE pr_agent_harness.agent_runs ENABLE ROW LEVEL SECURITY;


CREATE POLICY agent_runs_tenant_policy ON pr_agent_harness.agent_runs USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



ALTER TABLE pr_agent_harness.agent_steps ENABLE ROW LEVEL SECURITY;


CREATE POLICY agent_steps_tenant_policy ON pr_agent_harness.agent_steps USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



ALTER TABLE pr_agent_harness.audit_logs ENABLE ROW LEVEL SECURITY;


CREATE POLICY audit_logs_tenant_policy ON pr_agent_harness.audit_logs USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



ALTER TABLE pr_agent_harness.checkpoints ENABLE ROW LEVEL SECURITY;


CREATE POLICY checkpoints_tenant_policy ON pr_agent_harness.checkpoints USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



ALTER TABLE pr_agent_harness.dead_letter_jobs ENABLE ROW LEVEL SECURITY;


CREATE POLICY dead_letter_jobs_tenant_policy ON pr_agent_harness.dead_letter_jobs USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



ALTER TABLE pr_agent_harness.eval_cases ENABLE ROW LEVEL SECURITY;


CREATE POLICY eval_cases_tenant ON pr_agent_harness.eval_cases USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



ALTER TABLE pr_agent_harness.eval_datasets ENABLE ROW LEVEL SECURITY;


CREATE POLICY eval_datasets_tenant ON pr_agent_harness.eval_datasets USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



ALTER TABLE pr_agent_harness.eval_fixture_files ENABLE ROW LEVEL SECURITY;


CREATE POLICY eval_fixture_files_tenant ON pr_agent_harness.eval_fixture_files USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



ALTER TABLE pr_agent_harness.eval_fixtures ENABLE ROW LEVEL SECURITY;


CREATE POLICY eval_fixtures_tenant ON pr_agent_harness.eval_fixtures USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



ALTER TABLE pr_agent_harness.eval_results ENABLE ROW LEVEL SECURITY;


CREATE POLICY eval_results_tenant ON pr_agent_harness.eval_results USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



ALTER TABLE pr_agent_harness.eval_runs ENABLE ROW LEVEL SECURITY;


CREATE POLICY eval_runs_tenant ON pr_agent_harness.eval_runs USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



ALTER TABLE pr_agent_harness.evidence_records ENABLE ROW LEVEL SECURITY;


CREATE POLICY evidence_records_tenant_policy ON pr_agent_harness.evidence_records USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



ALTER TABLE pr_agent_harness.evolution_candidates ENABLE ROW LEVEL SECURITY;


CREATE POLICY evolution_candidates_tenant ON pr_agent_harness.evolution_candidates USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



ALTER TABLE pr_agent_harness.evolution_proposal_sources ENABLE ROW LEVEL SECURITY;


CREATE POLICY evolution_proposal_sources_tenant ON pr_agent_harness.evolution_proposal_sources USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



ALTER TABLE pr_agent_harness.evolution_release_assignments ENABLE ROW LEVEL SECURITY;


ALTER TABLE pr_agent_harness.evolution_release_decisions ENABLE ROW LEVEL SECURITY;


ALTER TABLE pr_agent_harness.evolution_release_qualifications ENABLE ROW LEVEL SECURITY;


ALTER TABLE pr_agent_harness.evolution_release_receipts ENABLE ROW LEVEL SECURITY;


ALTER TABLE pr_agent_harness.evolution_release_requests ENABLE ROW LEVEL SECURITY;


ALTER TABLE pr_agent_harness.evolution_run_assignments ENABLE ROW LEVEL SECURITY;


ALTER TABLE pr_agent_harness.feedback_observations ENABLE ROW LEVEL SECURITY;


CREATE POLICY feedback_observations_tenant ON pr_agent_harness.feedback_observations USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



ALTER TABLE pr_agent_harness.finding_candidates ENABLE ROW LEVEL SECURITY;


CREATE POLICY finding_candidates_tenant_policy ON pr_agent_harness.finding_candidates USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



ALTER TABLE pr_agent_harness.finding_decisions ENABLE ROW LEVEL SECURITY;


CREATE POLICY finding_decisions_tenant_policy ON pr_agent_harness.finding_decisions USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



ALTER TABLE pr_agent_harness.fix_approval_consumptions ENABLE ROW LEVEL SECURITY;


CREATE POLICY fix_approval_consumptions_tenant ON pr_agent_harness.fix_approval_consumptions USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



ALTER TABLE pr_agent_harness.fix_approval_decisions ENABLE ROW LEVEL SECURITY;


CREATE POLICY fix_approval_decisions_tenant ON pr_agent_harness.fix_approval_decisions USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



ALTER TABLE pr_agent_harness.fix_approval_requests ENABLE ROW LEVEL SECURITY;


CREATE POLICY fix_approval_requests_tenant ON pr_agent_harness.fix_approval_requests USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



ALTER TABLE pr_agent_harness.fix_artifacts ENABLE ROW LEVEL SECURITY;


CREATE POLICY fix_artifacts_tenant ON pr_agent_harness.fix_artifacts USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



ALTER TABLE pr_agent_harness.fix_proposals ENABLE ROW LEVEL SECURITY;


CREATE POLICY fix_proposals_tenant ON pr_agent_harness.fix_proposals USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



ALTER TABLE pr_agent_harness.fix_relevance_attestations ENABLE ROW LEVEL SECURITY;


CREATE POLICY fix_relevance_attestations_tenant ON pr_agent_harness.fix_relevance_attestations USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



ALTER TABLE pr_agent_harness.fix_run_findings ENABLE ROW LEVEL SECURITY;


CREATE POLICY fix_run_findings_tenant ON pr_agent_harness.fix_run_findings USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



ALTER TABLE pr_agent_harness.fix_run_sources ENABLE ROW LEVEL SECURITY;


CREATE POLICY fix_run_sources_tenant ON pr_agent_harness.fix_run_sources USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



ALTER TABLE pr_agent_harness.fix_verifications ENABLE ROW LEVEL SECURITY;


CREATE POLICY fix_verifications_tenant ON pr_agent_harness.fix_verifications USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



ALTER TABLE pr_agent_harness.job_queue ENABLE ROW LEVEL SECURITY;


CREATE POLICY job_queue_tenant_policy ON pr_agent_harness.job_queue USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



ALTER TABLE pr_agent_harness.model_budget_reservations ENABLE ROW LEVEL SECURITY;


ALTER TABLE pr_agent_harness.model_calls ENABLE ROW LEVEL SECURITY;


CREATE POLICY model_calls_tenant_policy ON pr_agent_harness.model_calls USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



ALTER TABLE pr_agent_harness.model_pricing_snapshots ENABLE ROW LEVEL SECURITY;


CREATE POLICY model_pricing_tenant_policy ON pr_agent_harness.model_pricing_snapshots USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



CREATE POLICY model_reservations_tenant_policy ON pr_agent_harness.model_budget_reservations USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



ALTER TABLE pr_agent_harness.publication_batch_operations ENABLE ROW LEVEL SECURITY;


CREATE POLICY publication_batch_operations_tenant_policy ON pr_agent_harness.publication_batch_operations USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



ALTER TABLE pr_agent_harness.publication_batches ENABLE ROW LEVEL SECURITY;


CREATE POLICY publication_batches_tenant_policy ON pr_agent_harness.publication_batches USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



ALTER TABLE pr_agent_harness.publication_command_receipts ENABLE ROW LEVEL SECURITY;


CREATE POLICY publication_command_receipts_tenant_policy ON pr_agent_harness.publication_command_receipts USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



ALTER TABLE pr_agent_harness.publication_slots ENABLE ROW LEVEL SECURITY;


CREATE POLICY publication_slots_tenant_policy ON pr_agent_harness.publication_slots USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



CREATE POLICY release_assignments_tenant ON pr_agent_harness.evolution_release_assignments USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



CREATE POLICY release_decisions_tenant ON pr_agent_harness.evolution_release_decisions USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



CREATE POLICY release_qualifications_tenant ON pr_agent_harness.evolution_release_qualifications USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



CREATE POLICY release_receipts_tenant ON pr_agent_harness.evolution_release_receipts USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



CREATE POLICY release_requests_tenant ON pr_agent_harness.evolution_release_requests USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



ALTER TABLE pr_agent_harness.repository_operations ENABLE ROW LEVEL SECURITY;


CREATE POLICY repository_operations_tenant_policy ON pr_agent_harness.repository_operations USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



ALTER TABLE pr_agent_harness.review_annotation_arbitrations ENABLE ROW LEVEL SECURITY;


CREATE POLICY review_annotation_arbitrations_tenant ON pr_agent_harness.review_annotation_arbitrations USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



ALTER TABLE pr_agent_harness.review_annotations ENABLE ROW LEVEL SECURITY;


CREATE POLICY review_annotations_tenant ON pr_agent_harness.review_annotations USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



ALTER TABLE pr_agent_harness.review_artifacts ENABLE ROW LEVEL SECURITY;


CREATE POLICY review_artifacts_tenant_policy ON pr_agent_harness.review_artifacts USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



CREATE POLICY run_assignments_tenant ON pr_agent_harness.evolution_run_assignments USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



ALTER TABLE pr_agent_harness.run_budget_envelopes ENABLE ROW LEVEL SECURITY;


CREATE POLICY run_budget_tenant_policy ON pr_agent_harness.run_budget_envelopes USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



ALTER TABLE pr_agent_harness.run_command_receipts ENABLE ROW LEVEL SECURITY;


CREATE POLICY run_command_receipts_tenant ON pr_agent_harness.run_command_receipts USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



ALTER TABLE pr_agent_harness.run_events ENABLE ROW LEVEL SECURITY;


CREATE POLICY run_events_tenant_policy ON pr_agent_harness.run_events USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



ALTER TABLE pr_agent_harness.run_publication_batches ENABLE ROW LEVEL SECURITY;


CREATE POLICY run_publication_batches_tenant_policy ON pr_agent_harness.run_publication_batches USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



ALTER TABLE pr_agent_harness.run_wait_decisions ENABLE ROW LEVEL SECURITY;


CREATE POLICY run_wait_decisions_tenant ON pr_agent_harness.run_wait_decisions USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



ALTER TABLE pr_agent_harness.run_waits ENABLE ROW LEVEL SECURITY;


CREATE POLICY run_waits_tenant ON pr_agent_harness.run_waits USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



ALTER TABLE pr_agent_harness.step_attempts ENABLE ROW LEVEL SECURITY;


CREATE POLICY step_attempts_tenant_policy ON pr_agent_harness.step_attempts USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



ALTER TABLE pr_agent_harness.tenant_budget_accounts ENABLE ROW LEVEL SECURITY;


CREATE POLICY tenant_budget_tenant_policy ON pr_agent_harness.tenant_budget_accounts USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



ALTER TABLE pr_agent_harness.tool_calls ENABLE ROW LEVEL SECURITY;


CREATE POLICY tool_calls_tenant_policy ON pr_agent_harness.tool_calls USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



ALTER TABLE pr_agent_harness.trusted_review_label_sets ENABLE ROW LEVEL SECURITY;


CREATE POLICY trusted_review_label_sets_tenant ON pr_agent_harness.trusted_review_label_sets USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



ALTER TABLE pr_agent_harness.usage_records ENABLE ROW LEVEL SECURITY;


CREATE POLICY usage_records_tenant_policy ON pr_agent_harness.usage_records USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



ALTER TABLE pr_agent_harness.verification_jobs ENABLE ROW LEVEL SECURITY;


CREATE POLICY verification_jobs_tenant ON pr_agent_harness.verification_jobs USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));



REVOKE ALL ON FUNCTION pr_agent_harness.claim_verification_job(requested_owner text, requested_lease_seconds integer) FROM PUBLIC;



REVOKE ALL ON FUNCTION pr_agent_harness.complete_verification_job(requested_tenant_id uuid, requested_job_id uuid, requested_owner text, requested_epoch bigint, requested_result jsonb, requested_result_hash text) FROM PUBLIC;



REVOKE ALL ON FUNCTION pr_agent_harness.fail_verification_job(requested_tenant_id uuid, requested_job_id uuid, requested_owner text, requested_epoch bigint, requested_error_code text, requested_retry_delay_seconds integer) FROM PUBLIC;



REVOKE ALL ON FUNCTION pr_agent_harness.heartbeat_verification_job(requested_tenant_id uuid, requested_job_id uuid, requested_owner text, requested_epoch bigint, requested_lease_seconds integer) FROM PUBLIC;



REVOKE ALL ON FUNCTION pr_agent_harness.lock_active_legacy_review_execution_authority(requested_tenant_id uuid, requested_integration_id uuid, requested_publication_generation bigint, requested_execution_generation bigint) FROM PUBLIC;



REVOKE ALL ON FUNCTION pr_agent_harness.lock_active_publication_authority(requested_tenant_id uuid, requested_integration_id uuid, requested_platform text, requested_origin text, requested_repository text, requested_generation bigint) FROM PUBLIC;



REVOKE ALL ON FUNCTION pr_agent_harness.lock_active_review_execution_authority(requested_tenant_id uuid, requested_integration_id uuid, requested_publication_generation bigint, requested_execution_generation bigint) FROM PUBLIC;



REVOKE ALL ON FUNCTION pr_agent_harness.lock_resolvable_publication_authority(requested_tenant_id uuid, requested_integration_id uuid, requested_generation bigint) FROM PUBLIC;



REVOKE ALL ON FUNCTION pr_agent_harness.lock_resumable_legacy_review_execution_authority(requested_tenant_id uuid, requested_integration_id uuid, requested_publication_generation bigint, requested_execution_generation bigint) FROM PUBLIC;



REVOKE ALL ON FUNCTION pr_agent_harness.lock_resumable_review_execution_authority(requested_tenant_id uuid, requested_integration_id uuid, requested_publication_generation bigint, requested_execution_generation bigint) FROM PUBLIC;



REVOKE ALL ON FUNCTION pr_agent_harness.skip_cancelled_run_publications(requested_tenant_id uuid, requested_run_id uuid) FROM PUBLIC;



REVOKE ALL ON FUNCTION pr_agent_harness.skip_failed_batch_successors(requested_tenant_id uuid, requested_batch_id uuid) FROM PUBLIC;
SET LOCAL check_function_bodies = true;
