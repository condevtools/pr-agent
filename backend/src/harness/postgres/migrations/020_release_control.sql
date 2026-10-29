CREATE TABLE pr_agent_harness.evolution_release_qualifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, integration_id uuid NOT NULL,
  candidate_id uuid NOT NULL, dataset_id uuid NOT NULL, dataset_version bigint NOT NULL CHECK (dataset_version>0),
  validation_evaluation_id uuid NOT NULL, holdout_evaluation_id uuid NOT NULL,
  policy_json jsonb NOT NULL CHECK (jsonb_typeof(policy_json)='object'),
  policy_hash text NOT NULL CHECK (policy_hash ~ '^[a-f0-9]{64}$'),
  evidence_json jsonb NOT NULL CHECK (jsonb_typeof(evidence_json)='object'),
  evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
  created_by_actor_type text NOT NULL CHECK (created_by_actor_type IN ('user','service')),
  created_by_actor_id text NOT NULL CHECK (length(created_by_actor_id) BETWEEN 1 AND 512),
  command_key text NOT NULL CHECK (length(command_key) BETWEEN 1 AND 200),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,integration_id,id),
  UNIQUE (tenant_id,integration_id,id,candidate_id),
  UNIQUE (tenant_id,integration_id,created_by_actor_type,created_by_actor_id,command_key),
  FOREIGN KEY (tenant_id,integration_id) REFERENCES pr_agent_harness.integration_bindings (tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,candidate_id) REFERENCES pr_agent_harness.evolution_candidates (tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,dataset_id) REFERENCES pr_agent_harness.eval_datasets (tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,validation_evaluation_id) REFERENCES pr_agent_harness.eval_runs (tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,holdout_evaluation_id) REFERENCES pr_agent_harness.eval_runs (tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE pr_agent_harness.evolution_release_assignments (
  tenant_id uuid NOT NULL, integration_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('evaluated_experimental','approved_canary','promoted','rolled_back')),
  routing text NOT NULL CHECK (routing IN ('off','shadow','canary','full')),
  candidate_id uuid, qualification_id uuid, version bigint NOT NULL CHECK (version>0),
  fraction_bps integer NOT NULL CHECK (fraction_bps BETWEEN 0 AND 10000),
  salt text NOT NULL CHECK (salt ~ '^[a-f0-9]{64}$'), activated_at timestamptz, promoted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY (tenant_id,integration_id),
  FOREIGN KEY (tenant_id,integration_id) REFERENCES pr_agent_harness.integration_bindings (tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,candidate_id) REFERENCES pr_agent_harness.evolution_candidates (tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,integration_id,qualification_id,candidate_id)
    REFERENCES pr_agent_harness.evolution_release_qualifications (tenant_id,integration_id,id,candidate_id) ON DELETE RESTRICT,
  CHECK ((candidate_id IS NULL)=(qualification_id IS NULL)),
  CHECK ((routing='off' AND fraction_bps=0) OR (routing='shadow' AND fraction_bps=10000)
    OR (routing='canary' AND fraction_bps BETWEEN 1 AND 500) OR (routing='full' AND fraction_bps=10000))
);

CREATE TABLE pr_agent_harness.evolution_release_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, integration_id uuid NOT NULL,
  target text NOT NULL CHECK (target IN ('shadow','canary','promote')), candidate_id uuid NOT NULL,
  qualification_id uuid NOT NULL, expected_assignment_version bigint NOT NULL CHECK (expected_assignment_version>=0),
  candidate_bps integer NOT NULL CHECK (candidate_bps BETWEEN 1 AND 10000),
  maker_actor_type text NOT NULL CHECK (maker_actor_type='user'), maker_actor_id text NOT NULL,
  command_key text NOT NULL CHECK (length(command_key) BETWEEN 1 AND 200),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','rejected','revoked','consumed','expired')),
  expires_at timestamptz NOT NULL, consumed_at timestamptz,
  revoke_command_key text CHECK (revoke_command_key IS NULL OR length(revoke_command_key) BETWEEN 1 AND 200),
  revoke_request_hash text CHECK (revoke_request_hash IS NULL OR revoke_request_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,integration_id,id),
  UNIQUE (tenant_id,integration_id,id,candidate_id,qualification_id),
  UNIQUE (tenant_id,integration_id,maker_actor_id,command_key),
  FOREIGN KEY (tenant_id,integration_id) REFERENCES pr_agent_harness.integration_bindings (tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,candidate_id) REFERENCES pr_agent_harness.evolution_candidates (tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,integration_id,qualification_id,candidate_id)
    REFERENCES pr_agent_harness.evolution_release_qualifications (tenant_id,integration_id,id,candidate_id) ON DELETE RESTRICT
);
CREATE INDEX evolution_release_requests_open ON pr_agent_harness.evolution_release_requests
  (tenant_id,integration_id,status,expires_at,id) WHERE status='open';

CREATE TABLE pr_agent_harness.evolution_release_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, integration_id uuid NOT NULL,
  request_id uuid NOT NULL, decision text NOT NULL CHECK (decision IN ('approve','reject')),
  checker_actor_type text NOT NULL CHECK (checker_actor_type='user'), checker_actor_id text NOT NULL,
  command_key text NOT NULL CHECK (length(command_key) BETWEEN 1 AND 200),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,integration_id,checker_actor_id,command_key), UNIQUE (tenant_id,request_id),
  FOREIGN KEY (tenant_id,integration_id,request_id)
    REFERENCES pr_agent_harness.evolution_release_requests (tenant_id,integration_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,integration_id) REFERENCES pr_agent_harness.integration_bindings (tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE pr_agent_harness.evolution_release_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, integration_id uuid NOT NULL,
  request_id uuid, kind text NOT NULL CHECK (kind IN ('shadow','canary','promote','rollback')),
  assignment_version bigint NOT NULL CHECK (assignment_version>0),
  before_json jsonb NOT NULL CHECK (jsonb_typeof(before_json)='object'),
  after_json jsonb NOT NULL CHECK (jsonb_typeof(after_json)='object'),
  evidence_json jsonb NOT NULL CHECK (jsonb_typeof(evidence_json)='object'),
  evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
  actor_type text NOT NULL CHECK (actor_type IN ('user','service','system')), actor_id text NOT NULL,
  command_key text NOT NULL CHECK (length(command_key) BETWEEN 1 AND 200),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,integration_id,id),
  UNIQUE (tenant_id,integration_id,id,assignment_version),
  UNIQUE (tenant_id,integration_id,assignment_version), UNIQUE (tenant_id,request_id),
  UNIQUE (tenant_id,integration_id,actor_type,actor_id,command_key),
  FOREIGN KEY (tenant_id,integration_id,request_id)
    REFERENCES pr_agent_harness.evolution_release_requests (tenant_id,integration_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,integration_id) REFERENCES pr_agent_harness.integration_bindings (tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX evolution_release_receipts_scope ON pr_agent_harness.evolution_release_receipts
  (tenant_id,integration_id,assignment_version);
CREATE TABLE pr_agent_harness.evolution_run_assignments (
  tenant_id uuid NOT NULL, integration_id uuid NOT NULL, run_id uuid NOT NULL,
  assignment_version bigint NOT NULL CHECK (assignment_version>=0),
  selection text NOT NULL CHECK (selection IN ('baseline','control','candidate')),
  routing text NOT NULL CHECK (routing IN ('off','shadow','canary','full')),
  bucket integer NOT NULL CHECK (bucket BETWEEN 0 AND 9999), candidate_id uuid, qualification_id uuid,
  release_receipt_id uuid,
  review_text_json jsonb NOT NULL CHECK (jsonb_typeof(review_text_json)='object'),
  review_text_hash text NOT NULL CHECK (review_text_hash ~ '^[a-f0-9]{64}$'),
  prompt_hash text NOT NULL CHECK (prompt_hash ~ '^[a-f0-9]{64}$'),
  tool_hash text NOT NULL CHECK (tool_hash ~ '^[a-f0-9]{64}$'),
  selection_hash text NOT NULL CHECK (selection_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY (tenant_id,run_id),
  FOREIGN KEY (tenant_id,integration_id,run_id) REFERENCES pr_agent_harness.agent_runs (tenant_id,integration_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,candidate_id) REFERENCES pr_agent_harness.evolution_candidates (tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,integration_id,qualification_id,candidate_id)
    REFERENCES pr_agent_harness.evolution_release_qualifications (tenant_id,integration_id,id,candidate_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,integration_id,release_receipt_id,assignment_version)
    REFERENCES pr_agent_harness.evolution_release_receipts (tenant_id,integration_id,id,assignment_version) ON DELETE RESTRICT,
  CHECK ((candidate_id IS NULL)=(qualification_id IS NULL)),
  CHECK ((selection='baseline' AND candidate_id IS NULL AND release_receipt_id IS NULL)
    OR (selection<>'baseline' AND candidate_id IS NOT NULL AND release_receipt_id IS NOT NULL))
);
CREATE INDEX evolution_run_assignments_metrics ON pr_agent_harness.evolution_run_assignments
  (tenant_id,integration_id,assignment_version,selection,created_at,run_id);

-- P3c deliberately rejects chained candidate promotion because its offline baseline is always the
-- product baseline. Rollback therefore restores that known baseline. Release history must still
-- prevent either the candidate or its proposal source from being scrubbed.
CREATE OR REPLACE FUNCTION pr_agent_harness.guard_evolution_candidate_content() RETURNS trigger LANGUAGE plpgsql AS $$
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

CREATE FUNCTION pr_agent_harness.guard_release_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'release evidence and receipts are immutable'; END $$;
CREATE TRIGGER release_qualifications_immutable BEFORE UPDATE OR DELETE ON pr_agent_harness.evolution_release_qualifications
  FOR EACH ROW EXECUTE FUNCTION pr_agent_harness.guard_release_append_only();
CREATE TRIGGER release_decisions_immutable BEFORE UPDATE OR DELETE ON pr_agent_harness.evolution_release_decisions
  FOR EACH ROW EXECUTE FUNCTION pr_agent_harness.guard_release_append_only();
CREATE TRIGGER release_receipts_immutable BEFORE UPDATE OR DELETE ON pr_agent_harness.evolution_release_receipts
  FOR EACH ROW EXECUTE FUNCTION pr_agent_harness.guard_release_append_only();
CREATE TRIGGER run_assignments_immutable BEFORE UPDATE OR DELETE ON pr_agent_harness.evolution_run_assignments
  FOR EACH ROW EXECUTE FUNCTION pr_agent_harness.guard_release_append_only();

CREATE FUNCTION pr_agent_harness.guard_release_request_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER release_requests_lifecycle BEFORE UPDATE OR DELETE ON pr_agent_harness.evolution_release_requests
  FOR EACH ROW EXECUTE FUNCTION pr_agent_harness.guard_release_request_lifecycle();

CREATE FUNCTION pr_agent_harness.guard_release_assignment_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'release assignments cannot be deleted'; END IF;
  IF NEW.version<>OLD.version+1 OR NEW.tenant_id<>OLD.tenant_id OR NEW.integration_id<>OLD.integration_id
     OR NEW.created_at<>OLD.created_at THEN RAISE EXCEPTION 'invalid release assignment CAS'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER release_assignments_lifecycle BEFORE UPDATE OR DELETE ON pr_agent_harness.evolution_release_assignments
  FOR EACH ROW EXECUTE FUNCTION pr_agent_harness.guard_release_assignment_lifecycle();

ALTER TABLE pr_agent_harness.evolution_release_qualifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.evolution_release_qualifications FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.evolution_release_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.evolution_release_assignments FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.evolution_release_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.evolution_release_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.evolution_release_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.evolution_release_decisions FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.evolution_release_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.evolution_release_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.evolution_run_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.evolution_run_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY release_qualifications_tenant ON pr_agent_harness.evolution_release_qualifications
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY release_assignments_tenant ON pr_agent_harness.evolution_release_assignments
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY release_requests_tenant ON pr_agent_harness.evolution_release_requests
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY release_decisions_tenant ON pr_agent_harness.evolution_release_decisions
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY release_receipts_tenant ON pr_agent_harness.evolution_release_receipts
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY run_assignments_tenant ON pr_agent_harness.evolution_run_assignments
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
