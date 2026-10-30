ALTER TABLE pr_agent_harness.verification_jobs
  ADD COLUMN verifier_capability_hash text
    CHECK (verifier_capability_hash IS NULL OR verifier_capability_hash ~ '^[a-f0-9]{64}$'),
  ADD COLUMN result_identity_hash text
    CHECK (result_identity_hash IS NULL OR result_identity_hash ~ '^[a-f0-9]{64}$');

DROP FUNCTION pr_agent_harness.claim_verification_job(text,integer);
DROP FUNCTION pr_agent_harness.complete_verification_job(uuid,uuid,text,bigint,jsonb,text);

CREATE FUNCTION pr_agent_harness.claim_verification_job(
  requested_owner text, requested_lease_seconds integer, requested_verifier_capability_hash text
) RETURNS TABLE (
  id uuid, tenant_id uuid, integration_id uuid, run_id uuid, proposal_id text,
  proposal_hash text, source_bundle_ref text, source_bundle_hash text, policy_hash text,
  verifier_capability_hash text, verification_input_hash text, trusted_command_hash text,
  dependency_lock_hash text, dependency_lock_path text, sandbox_policy_hash text, image_digest text,
  claimed_run_epoch bigint, lease_epoch bigint, lease_expires_at timestamptz, attempt_count integer,
  deadline_at timestamptz, proposal_json jsonb
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pr_agent_harness AS $$
BEGIN
  IF length(requested_owner) NOT BETWEEN 1 AND 200
      OR requested_lease_seconds NOT BETWEEN 5 AND 300
      OR requested_verifier_capability_hash IS NULL
      OR requested_verifier_capability_hash !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'invalid verifier lease request';
  END IF;
  WITH terminal AS (
    SELECT q.id FROM pr_agent_harness.verification_jobs q
    WHERE q.verifier_capability_hash=requested_verifier_capability_hash
      AND q.status IN ('queued','leased')
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
    WHERE j.verifier_capability_hash=requested_verifier_capability_hash
      AND (j.status='queued' OR (j.status='leased' AND j.lease_expires_at<=clock_timestamp()))
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
    c.source_bundle_ref,c.source_bundle_hash,c.policy_hash,c.verifier_capability_hash,
    c.verification_input_hash,c.trusted_command_hash,c.dependency_lock_hash,c.dependency_lock_path,
    c.sandbox_policy_hash,c.image_digest,c.claimed_run_epoch,c.lease_epoch,c.lease_expires_at,
    c.attempt_count,c.deadline_at,p.proposal_json
  FROM claimed c JOIN pr_agent_harness.fix_proposals p
    ON p.tenant_id=c.tenant_id AND p.run_id=c.run_id AND p.id=c.proposal_id;
END; $$;
REVOKE ALL ON FUNCTION pr_agent_harness.claim_verification_job(text,integer,text) FROM PUBLIC;

CREATE FUNCTION pr_agent_harness.complete_verification_job(
  requested_tenant_id uuid, requested_job_id uuid, requested_owner text, requested_epoch bigint,
  requested_result jsonb, requested_result_hash text, requested_verification_input_hash text,
  requested_verifier_capability_hash text, requested_result_identity_hash text
) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pr_agent_harness AS $$
  WITH updated AS (
    UPDATE pr_agent_harness.verification_jobs SET status='succeeded',result_json=requested_result,
      result_hash=requested_result_hash,result_identity_hash=requested_result_identity_hash,
      lease_owner=NULL,lease_expires_at=NULL,completed_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE tenant_id=requested_tenant_id AND id=requested_job_id AND status='leased'
      AND lease_owner=requested_owner AND lease_epoch=requested_epoch
      AND lease_expires_at>clock_timestamp() AND deadline_at>clock_timestamp()
      AND verification_input_hash=requested_verification_input_hash
      AND verifier_capability_hash=requested_verifier_capability_hash
      AND jsonb_typeof(requested_result)='object'
      AND requested_result_hash ~ '^[a-f0-9]{64}$'
      AND requested_result_identity_hash ~ '^[a-f0-9]{64}$'
    RETURNING true
  ) SELECT EXISTS(SELECT 1 FROM updated)
$$;
REVOKE ALL ON FUNCTION pr_agent_harness.complete_verification_job(uuid,uuid,text,bigint,jsonb,text,text,text,text) FROM PUBLIC;

CREATE FUNCTION pr_agent_harness.relinquish_verification_job(
  requested_tenant_id uuid, requested_job_id uuid, requested_owner text, requested_epoch bigint
) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pr_agent_harness AS $$
  WITH updated AS (
    UPDATE pr_agent_harness.verification_jobs SET status='queued',
      lease_owner=NULL,lease_expires_at=NULL,heartbeat_at=NULL,
      attempt_count=GREATEST(attempt_count-1,0),available_at=clock_timestamp(),
      error_code=NULL,updated_at=clock_timestamp()
    WHERE tenant_id=requested_tenant_id AND id=requested_job_id AND status='leased'
      AND lease_owner=requested_owner AND lease_epoch=requested_epoch
      AND lease_expires_at>clock_timestamp() AND deadline_at>clock_timestamp()
    RETURNING true
  ) SELECT EXISTS(SELECT 1 FROM updated)
$$;
REVOKE ALL ON FUNCTION pr_agent_harness.relinquish_verification_job(uuid,uuid,text,bigint) FROM PUBLIC;

DROP INDEX pr_agent_harness.verification_jobs_claim;
CREATE INDEX verification_jobs_claim ON pr_agent_harness.verification_jobs
  (verifier_capability_hash,available_at,tenant_id,id) WHERE status='queued';
