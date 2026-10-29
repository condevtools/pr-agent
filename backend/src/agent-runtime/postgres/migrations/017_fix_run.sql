ALTER TABLE pr_agent_harness.repository_operations
  DROP CONSTRAINT repository_operations_operation_type_check,
  ADD CONSTRAINT repository_operations_operation_type_check
    CHECK (operation_type IN ('publication','fix_branch','fix_commit','fix_draft_pr'));

CREATE TABLE pr_agent_harness.fix_run_sources (
  tenant_id uuid NOT NULL, integration_id uuid NOT NULL, run_id uuid NOT NULL,
  source_review_run_id uuid NOT NULL, finding_id text NOT NULL CHECK (finding_id ~ '^[a-f0-9]{64}$'),
  repository text NOT NULL CHECK (length(repository) BETWEEN 1 AND 512),
  base_sha text NOT NULL, head_sha text NOT NULL, source_bundle_ref text NOT NULL,
  source_bundle_hash text NOT NULL CHECK (source_bundle_hash ~ '^[a-f0-9]{64}$'),
  allowed_paths_json jsonb NOT NULL CHECK (jsonb_typeof(allowed_paths_json)='array'),
  source_json jsonb NOT NULL CHECK (jsonb_typeof(source_json)='object'),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'), content_purged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,run_id),
  FOREIGN KEY (tenant_id,integration_id,run_id) REFERENCES pr_agent_harness.agent_runs (tenant_id,integration_id,id),
  FOREIGN KEY (tenant_id,integration_id,source_review_run_id) REFERENCES pr_agent_harness.agent_runs (tenant_id,integration_id,id),
  FOREIGN KEY (tenant_id,source_review_run_id,finding_id) REFERENCES pr_agent_harness.finding_candidates (tenant_id,run_id,id)
);

CREATE TABLE pr_agent_harness.fix_run_findings (
  tenant_id uuid NOT NULL, run_id uuid NOT NULL, source_review_run_id uuid NOT NULL,
  finding_id text NOT NULL CHECK (finding_id ~ '^[a-f0-9]{64}$'), gate_decision_id text NOT NULL CHECK (gate_decision_id ~ '^[a-f0-9]{64}$'),
  finding_hash text NOT NULL CHECK (finding_hash ~ '^[a-f0-9]{64}$'), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,run_id,finding_id),
  FOREIGN KEY (tenant_id,run_id) REFERENCES pr_agent_harness.fix_run_sources (tenant_id,run_id),
  FOREIGN KEY (tenant_id,source_review_run_id,finding_id) REFERENCES pr_agent_harness.finding_candidates (tenant_id,run_id,id),
  FOREIGN KEY (tenant_id,gate_decision_id) REFERENCES pr_agent_harness.finding_decisions (tenant_id,id)
);

CREATE TABLE pr_agent_harness.fix_proposals (
  id text NOT NULL CHECK (id ~ '^[a-f0-9]{64}$'), tenant_id uuid NOT NULL, integration_id uuid NOT NULL,
  run_id uuid NOT NULL, source_review_run_id uuid NOT NULL, finding_id text NOT NULL,
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 2), repository text NOT NULL,
  base_sha text NOT NULL, head_sha text NOT NULL, source_bundle_ref text NOT NULL,
  source_bundle_hash text NOT NULL CHECK (source_bundle_hash ~ '^[a-f0-9]{64}$'),
  code_patch text NOT NULL, test_patch text NOT NULL,
  code_patch_hash text NOT NULL CHECK (code_patch_hash ~ '^[a-f0-9]{64}$'),
  test_patch_hash text NOT NULL CHECK (test_patch_hash ~ '^[a-f0-9]{64}$'),
  proposal_hash text NOT NULL CHECK (proposal_hash ~ '^[a-f0-9]{64}$'),
  policy_id text NOT NULL, policy_hash text NOT NULL CHECK (policy_hash ~ '^[a-f0-9]{64}$'),
  trusted_command_hash text NOT NULL CHECK (trusted_command_hash ~ '^[a-f0-9]{64}$'),
  dependency_lock_path text NOT NULL CHECK (length(dependency_lock_path) BETWEEN 1 AND 256),
  dependency_lock_hash text NOT NULL CHECK (dependency_lock_hash ~ '^[a-f0-9]{64}$'),
  sandbox_policy_hash text NOT NULL CHECK (sandbox_policy_hash ~ '^[a-f0-9]{64}$'),
  image_digest text NOT NULL CHECK (image_digest ~ '^sha256:[a-f0-9]{64}$'),
  publisher_policy_hash text NOT NULL CHECK (publisher_policy_hash ~ '^[a-f0-9]{64}$'),
  qualification_status text NOT NULL CHECK (qualification_status IN ('verified','not_verified')),
  proposal_json jsonb NOT NULL CHECK (jsonb_typeof(proposal_json)='object'),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'), content_purged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,run_id,revision), UNIQUE (tenant_id,run_id,id),
  FOREIGN KEY (tenant_id,integration_id,run_id) REFERENCES pr_agent_harness.agent_runs (tenant_id,integration_id,id),
  FOREIGN KEY (tenant_id,run_id,finding_id) REFERENCES pr_agent_harness.fix_run_findings (tenant_id,run_id,finding_id)
);

CREATE TABLE pr_agent_harness.verification_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, integration_id uuid NOT NULL,
  run_id uuid NOT NULL, proposal_id text NOT NULL, proposal_hash text NOT NULL CHECK (proposal_hash ~ '^[a-f0-9]{64}$'),
  source_bundle_ref text NOT NULL, source_bundle_hash text NOT NULL CHECK (source_bundle_hash ~ '^[a-f0-9]{64}$'),
  policy_hash text NOT NULL CHECK (policy_hash ~ '^[a-f0-9]{64}$'),
  verification_input_hash text NOT NULL CHECK (verification_input_hash ~ '^[a-f0-9]{64}$'),
  trusted_command_hash text NOT NULL CHECK (trusted_command_hash ~ '^[a-f0-9]{64}$'),
  dependency_lock_path text NOT NULL CHECK (length(dependency_lock_path) BETWEEN 1 AND 256),
  dependency_lock_hash text NOT NULL CHECK (dependency_lock_hash ~ '^[a-f0-9]{64}$'),
  sandbox_policy_hash text NOT NULL CHECK (sandbox_policy_hash ~ '^[a-f0-9]{64}$'),
  image_digest text NOT NULL CHECK (image_digest ~ '^sha256:[a-f0-9]{64}$'),
  claimed_run_epoch bigint NOT NULL CHECK (claimed_run_epoch>0),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','leased','succeeded','failed')),
  lease_owner text, lease_epoch bigint NOT NULL DEFAULT 0 CHECK (lease_epoch>=0), lease_expires_at timestamptz,
  heartbeat_at timestamptz, attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count>=0),
  max_attempts integer NOT NULL DEFAULT 2 CHECK (max_attempts BETWEEN 1 AND 3), available_at timestamptz NOT NULL DEFAULT now(),
  deadline_at timestamptz NOT NULL, result_json jsonb, result_hash text CHECK (result_hash IS NULL OR result_hash ~ '^[a-f0-9]{64}$'),
  error_code text, content_purged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz,
  UNIQUE (tenant_id,run_id,proposal_id), UNIQUE (tenant_id,run_id,id),
  FOREIGN KEY (tenant_id,integration_id,run_id) REFERENCES pr_agent_harness.agent_runs (tenant_id,integration_id,id),
  FOREIGN KEY (tenant_id,run_id,proposal_id) REFERENCES pr_agent_harness.fix_proposals (tenant_id,run_id,id),
  CHECK ((status='leased')=(lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((status IN ('succeeded','failed'))=(completed_at IS NOT NULL)),
  CHECK (result_json IS NULL OR jsonb_typeof(result_json)='object')
);
CREATE INDEX verification_jobs_claim ON pr_agent_harness.verification_jobs (available_at,tenant_id,id) WHERE status='queued';
CREATE INDEX verification_jobs_expired_lease ON pr_agent_harness.verification_jobs (lease_expires_at,tenant_id,id) WHERE status='leased';

CREATE FUNCTION pr_agent_harness.claim_verification_job(requested_owner text, requested_lease_seconds integer)
RETURNS TABLE (
  id uuid, tenant_id uuid, integration_id uuid, run_id uuid, proposal_id text,
  proposal_hash text, source_bundle_ref text, source_bundle_hash text, policy_hash text,
  verification_input_hash text, trusted_command_hash text, dependency_lock_hash text,
  dependency_lock_path text,
  sandbox_policy_hash text, image_digest text, claimed_run_epoch bigint,
  lease_epoch bigint, lease_expires_at timestamptz, attempt_count integer, deadline_at timestamptz,
  proposal_json jsonb
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pr_agent_harness AS $$
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
REVOKE ALL ON FUNCTION pr_agent_harness.claim_verification_job(text,integer) FROM PUBLIC;

CREATE FUNCTION pr_agent_harness.heartbeat_verification_job(
  requested_tenant_id uuid, requested_job_id uuid, requested_owner text,
  requested_epoch bigint, requested_lease_seconds integer
) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pr_agent_harness AS $$
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
REVOKE ALL ON FUNCTION pr_agent_harness.heartbeat_verification_job(uuid,uuid,text,bigint,integer) FROM PUBLIC;

CREATE FUNCTION pr_agent_harness.complete_verification_job(
  requested_tenant_id uuid, requested_job_id uuid, requested_owner text, requested_epoch bigint,
  requested_result jsonb, requested_result_hash text
) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pr_agent_harness AS $$
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
$$;
REVOKE ALL ON FUNCTION pr_agent_harness.complete_verification_job(uuid,uuid,text,bigint,jsonb,text) FROM PUBLIC;

CREATE FUNCTION pr_agent_harness.fail_verification_job(
  requested_tenant_id uuid, requested_job_id uuid, requested_owner text, requested_epoch bigint,
  requested_error_code text, requested_retry_delay_seconds integer
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pr_agent_harness AS $$
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
REVOKE ALL ON FUNCTION pr_agent_harness.fail_verification_job(uuid,uuid,text,bigint,text,integer) FROM PUBLIC;

CREATE TABLE pr_agent_harness.fix_verifications (
  id text NOT NULL CHECK (id ~ '^[a-f0-9]{64}$'), tenant_id uuid NOT NULL, integration_id uuid NOT NULL,
  run_id uuid NOT NULL, proposal_id text NOT NULL, verification_job_id uuid NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('proven','suggestion_only','failed')),
  proposal_hash text NOT NULL CHECK (proposal_hash ~ '^[a-f0-9]{64}$'), policy_hash text NOT NULL CHECK (policy_hash ~ '^[a-f0-9]{64}$'),
  result_hash text NOT NULL CHECK (result_hash ~ '^[a-f0-9]{64}$'), result_json jsonb NOT NULL CHECK (jsonb_typeof(result_json)='object'),
  content_purged_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,run_id,proposal_id),
  FOREIGN KEY (tenant_id,integration_id,run_id) REFERENCES pr_agent_harness.agent_runs (tenant_id,integration_id,id),
  FOREIGN KEY (tenant_id,run_id,proposal_id) REFERENCES pr_agent_harness.fix_proposals (tenant_id,run_id,id),
  FOREIGN KEY (tenant_id,run_id,verification_job_id) REFERENCES pr_agent_harness.verification_jobs (tenant_id,run_id,id)
);

CREATE TABLE pr_agent_harness.fix_artifacts (
  id text NOT NULL CHECK (id ~ '^[a-f0-9]{64}$'), tenant_id uuid NOT NULL, integration_id uuid NOT NULL, run_id uuid NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'), artifact_json jsonb NOT NULL CHECK (jsonb_typeof(artifact_json)='object'),
  content_purged_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,run_id),
  FOREIGN KEY (tenant_id,integration_id,run_id) REFERENCES pr_agent_harness.agent_runs (tenant_id,integration_id,id)
);

CREATE TABLE pr_agent_harness.fix_approval_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, integration_id uuid NOT NULL,
  proposal_run_id uuid NOT NULL, proposal_id text NOT NULL, intent_hash text NOT NULL CHECK (intent_hash ~ '^[a-f0-9]{64}$'),
  command_key text NOT NULL CHECK (length(command_key) BETWEEN 1 AND 200), generation integer NOT NULL CHECK (generation>0),
  intent_json jsonb NOT NULL CHECK (jsonb_typeof(intent_json)='object'), maker_actor_type text NOT NULL CHECK (maker_actor_type IN ('user','service')),
  maker_actor_id text NOT NULL, status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','approved','revoked','expired','consumed')),
  version bigint NOT NULL DEFAULT 1 CHECK (version>0), expires_at timestamptz NOT NULL, approved_publish_run_id uuid,
  approved_at timestamptz, revoked_at timestamptz, consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,proposal_run_id,command_key), UNIQUE (tenant_id,proposal_run_id,generation),
  UNIQUE (tenant_id,approved_publish_run_id), UNIQUE (tenant_id,proposal_run_id,id),
  FOREIGN KEY (tenant_id,integration_id,proposal_run_id) REFERENCES pr_agent_harness.agent_runs (tenant_id,integration_id,id),
  FOREIGN KEY (tenant_id,proposal_run_id,proposal_id) REFERENCES pr_agent_harness.fix_proposals (tenant_id,run_id,id),
  FOREIGN KEY (tenant_id,integration_id,approved_publish_run_id) REFERENCES pr_agent_harness.agent_runs (tenant_id,integration_id,id)
);
CREATE UNIQUE INDEX fix_approval_one_active ON pr_agent_harness.fix_approval_requests (tenant_id,proposal_run_id,proposal_id)
  WHERE status IN ('open','approved','consumed');

CREATE TABLE pr_agent_harness.fix_relevance_attestations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, integration_id uuid NOT NULL,
  proposal_run_id uuid NOT NULL, proposal_id text NOT NULL, command_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  proposal_hash text NOT NULL CHECK (proposal_hash ~ '^[a-f0-9]{64}$'),
  test_patch_hash text NOT NULL CHECK (test_patch_hash ~ '^[a-f0-9]{64}$'),
  finding_id text NOT NULL CHECK (finding_id ~ '^[a-f0-9]{64}$'),
  verification_result_hash text NOT NULL CHECK (verification_result_hash ~ '^[a-f0-9]{64}$'),
  rubric_version text NOT NULL CHECK (length(rubric_version) BETWEEN 1 AND 128),
  reason text NOT NULL CHECK (length(reason) BETWEEN 20 AND 4000),
  actor_type text NOT NULL CHECK (actor_type IN ('user','service')), actor_id text NOT NULL,
  attestation_hash text NOT NULL CHECK (attestation_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,proposal_run_id,command_key), UNIQUE (tenant_id,proposal_run_id,proposal_id),
  FOREIGN KEY (tenant_id,integration_id,proposal_run_id) REFERENCES pr_agent_harness.agent_runs (tenant_id,integration_id,id),
  FOREIGN KEY (tenant_id,proposal_run_id,proposal_id) REFERENCES pr_agent_harness.fix_proposals (tenant_id,run_id,id)
);

CREATE TABLE pr_agent_harness.fix_approval_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, proposal_run_id uuid NOT NULL, approval_id uuid NOT NULL,
  command_key text NOT NULL, request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  decision text NOT NULL CHECK (decision IN ('approve','revoke')), actor_type text NOT NULL CHECK (actor_type IN ('user','service')),
  actor_id text NOT NULL, publish_run_id uuid, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,approval_id,command_key),
  FOREIGN KEY (tenant_id,proposal_run_id,approval_id) REFERENCES pr_agent_harness.fix_approval_requests (tenant_id,proposal_run_id,id),
  FOREIGN KEY (tenant_id,publish_run_id) REFERENCES pr_agent_harness.agent_runs (tenant_id,id)
);

CREATE TABLE pr_agent_harness.fix_approval_consumptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, proposal_run_id uuid NOT NULL,
  approval_id uuid NOT NULL, publish_run_id uuid NOT NULL, batch_id uuid NOT NULL,
  operation_set_hash text NOT NULL CHECK (operation_set_hash ~ '^[a-f0-9]{64}$'), intent_hash text NOT NULL CHECK (intent_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,approval_id), UNIQUE (tenant_id,publish_run_id), UNIQUE (tenant_id,batch_id),
  FOREIGN KEY (tenant_id,proposal_run_id,approval_id) REFERENCES pr_agent_harness.fix_approval_requests (tenant_id,proposal_run_id,id),
  FOREIGN KEY (tenant_id,publish_run_id) REFERENCES pr_agent_harness.agent_runs (tenant_id,id),
  FOREIGN KEY (tenant_id,batch_id) REFERENCES pr_agent_harness.publication_batches (tenant_id,id)
);

ALTER TABLE pr_agent_harness.fix_run_sources ENABLE ROW LEVEL SECURITY; ALTER TABLE pr_agent_harness.fix_run_sources FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.fix_run_findings ENABLE ROW LEVEL SECURITY; ALTER TABLE pr_agent_harness.fix_run_findings FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.fix_proposals ENABLE ROW LEVEL SECURITY; ALTER TABLE pr_agent_harness.fix_proposals FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.verification_jobs ENABLE ROW LEVEL SECURITY; ALTER TABLE pr_agent_harness.verification_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.fix_verifications ENABLE ROW LEVEL SECURITY; ALTER TABLE pr_agent_harness.fix_verifications FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.fix_artifacts ENABLE ROW LEVEL SECURITY; ALTER TABLE pr_agent_harness.fix_artifacts FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.fix_approval_requests ENABLE ROW LEVEL SECURITY; ALTER TABLE pr_agent_harness.fix_approval_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.fix_relevance_attestations ENABLE ROW LEVEL SECURITY; ALTER TABLE pr_agent_harness.fix_relevance_attestations FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.fix_approval_decisions ENABLE ROW LEVEL SECURITY; ALTER TABLE pr_agent_harness.fix_approval_decisions FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.fix_approval_consumptions ENABLE ROW LEVEL SECURITY; ALTER TABLE pr_agent_harness.fix_approval_consumptions FORCE ROW LEVEL SECURITY;

CREATE POLICY fix_run_sources_tenant ON pr_agent_harness.fix_run_sources USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY fix_run_findings_tenant ON pr_agent_harness.fix_run_findings USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY fix_proposals_tenant ON pr_agent_harness.fix_proposals USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY verification_jobs_tenant ON pr_agent_harness.verification_jobs USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY fix_verifications_tenant ON pr_agent_harness.fix_verifications USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY fix_artifacts_tenant ON pr_agent_harness.fix_artifacts USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY fix_approval_requests_tenant ON pr_agent_harness.fix_approval_requests USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY fix_relevance_attestations_tenant ON pr_agent_harness.fix_relevance_attestations USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY fix_approval_decisions_tenant ON pr_agent_harness.fix_approval_decisions USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY fix_approval_consumptions_tenant ON pr_agent_harness.fix_approval_consumptions USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

COMMENT ON TABLE pr_agent_harness.fix_proposals IS 'Immutable code/test patch proposals at a fixed reviewed head; revisions never overwrite prior content.';
COMMENT ON TABLE pr_agent_harness.fix_approval_consumptions IS 'One exact approval consumed atomically by one sealed publication batch.';
