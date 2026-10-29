CREATE TABLE pr_agent_harness.evolution_proposal_sources (
  tenant_id uuid NOT NULL,
  proposal_run_id uuid NOT NULL,
  dataset_id uuid NOT NULL,
  dataset_version bigint NOT NULL CHECK (dataset_version > 0),
  dataset_manifest_hash text NOT NULL CHECK (dataset_manifest_hash ~ '^[a-f0-9]{64}$'),
  baseline_prompt_hash text NOT NULL CHECK (baseline_prompt_hash ~ '^[a-f0-9]{64}$'),
  baseline_tool_hash text NOT NULL CHECK (baseline_tool_hash ~ '^[a-f0-9]{64}$'),
  source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  source_json jsonb NOT NULL CHECK (jsonb_typeof(source_json)='object'),
  created_by_actor_type text NOT NULL CHECK (created_by_actor_type IN ('user','service')),
  created_by_actor_id text NOT NULL CHECK (length(created_by_actor_id) BETWEEN 1 AND 512),
  content_purged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,proposal_run_id),
  FOREIGN KEY (tenant_id,proposal_run_id)
    REFERENCES pr_agent_harness.agent_runs (tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,dataset_id)
    REFERENCES pr_agent_harness.eval_datasets (tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE pr_agent_harness.evolution_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  proposal_run_id uuid NOT NULL,
  dataset_id uuid NOT NULL,
  dataset_version bigint NOT NULL CHECK (dataset_version > 0),
  dataset_manifest_hash text NOT NULL CHECK (dataset_manifest_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'research_draft' CHECK (status='research_draft'),
  candidate_json jsonb NOT NULL CHECK (jsonb_typeof(candidate_json)='object'),
  candidate_hash text NOT NULL CHECK (candidate_hash ~ '^[a-f0-9]{64}$'),
  baseline_prompt_hash text NOT NULL CHECK (baseline_prompt_hash ~ '^[a-f0-9]{64}$'),
  baseline_tool_hash text NOT NULL CHECK (baseline_tool_hash ~ '^[a-f0-9]{64}$'),
  model_config_hash text NOT NULL CHECK (model_config_hash ~ '^[a-f0-9]{64}$'),
  source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  provenance_json jsonb NOT NULL CHECK (jsonb_typeof(provenance_json)='object'),
  created_by_actor_type text NOT NULL CHECK (created_by_actor_type IN ('user','service')),
  created_by_actor_id text NOT NULL CHECK (length(created_by_actor_id) BETWEEN 1 AND 512),
  content_purged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,proposal_run_id),
  FOREIGN KEY (tenant_id,proposal_run_id)
    REFERENCES pr_agent_harness.evolution_proposal_sources (tenant_id,proposal_run_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,dataset_id)
    REFERENCES pr_agent_harness.eval_datasets (tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX evolution_candidates_dataset ON pr_agent_harness.evolution_candidates
  (tenant_id,dataset_id,status,created_at,id);

CREATE FUNCTION pr_agent_harness.guard_evolution_candidate_content() RETURNS trigger LANGUAGE plpgsql AS $$
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
        AND c.proposal_run_id=(old_row->>'proposal_run_id')::uuid AND c.content_purged_at IS NULL) THEN
      RAISE EXCEPTION 'candidate reference prevents proposal source purge';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME='evolution_candidates'
     AND (new_row-'candidate_json'-'content_purged_at')=(old_row-'candidate_json'-'content_purged_at')
     AND new_row->'candidate_json'='{"purged":true}'::jsonb THEN
    IF EXISTS (SELECT 1 FROM pr_agent_harness.eval_runs e
      WHERE e.tenant_id=(old_row->>'tenant_id')::uuid AND e.candidate_id=(old_row->>'id')::uuid) THEN
      RAISE EXCEPTION 'evaluation reference prevents candidate purge';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid evolution proposal purge';
END $$;
CREATE TRIGGER evolution_proposal_sources_immutable BEFORE UPDATE OR DELETE
  ON pr_agent_harness.evolution_proposal_sources FOR EACH ROW
  EXECUTE FUNCTION pr_agent_harness.guard_evolution_candidate_content();
CREATE TRIGGER evolution_candidates_immutable BEFORE UPDATE OR DELETE
  ON pr_agent_harness.evolution_candidates FOR EACH ROW
  EXECUTE FUNCTION pr_agent_harness.guard_evolution_candidate_content();

CREATE UNIQUE INDEX eval_cases_tenant_dataset_identity
  ON pr_agent_harness.eval_cases (tenant_id,dataset_id,id);

CREATE TABLE pr_agent_harness.eval_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  dataset_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  curator_actor_type text NOT NULL CHECK (curator_actor_type IN ('user','service')),
  curator_actor_id text NOT NULL CHECK (length(curator_actor_id) BETWEEN 1 AND 512),
  split text NOT NULL CHECK (split IN ('development','validation','holdout')),
  command_key text NOT NULL CHECK (length(command_key) BETWEEN 1 AND 200),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  repetitions integer NOT NULL DEFAULT 3 CHECK (repetitions=3),
  manifest_hash text NOT NULL CHECK (manifest_hash ~ '^[a-f0-9]{64}$'),
  baseline_component_hash text NOT NULL CHECK (baseline_component_hash ~ '^[a-f0-9]{64}$'),
  candidate_component_hash text NOT NULL CHECK (candidate_component_hash ~ '^[a-f0-9]{64}$'),
  model_version_hash text NOT NULL CHECK (model_version_hash ~ '^[a-f0-9]{64}$'),
  runtime_version_hash text NOT NULL CHECK (runtime_version_hash ~ '^[a-f0-9]{64}$'),
  scheduling_policy_json jsonb NOT NULL CHECK (jsonb_typeof(scheduling_policy_json)='object'),
  scheduling_policy_hash text NOT NULL CHECK (scheduling_policy_hash ~ '^[a-f0-9]{64}$'),
  total_result_count integer NOT NULL CHECK (total_result_count >= 0),
  planned_result_count integer NOT NULL CHECK (planned_result_count >= 0),
  completed_result_count integer NOT NULL DEFAULT 0 CHECK (completed_result_count >= 0),
  failed_result_count integer NOT NULL DEFAULT 0 CHECK (failed_result_count >= 0),
  lease_owner text,
  lease_epoch bigint NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deadline_at timestamptz NOT NULL,
  error_code text,
  metrics_json jsonb CHECK (metrics_json IS NULL OR jsonb_typeof(metrics_json)='object'),
  metrics_hash text CHECK (metrics_hash IS NULL OR metrics_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,curator_actor_type,curator_actor_id,command_key),
  FOREIGN KEY (tenant_id,dataset_id)
    REFERENCES pr_agent_harness.eval_datasets (tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,candidate_id)
    REFERENCES pr_agent_harness.evolution_candidates (tenant_id,id) ON DELETE RESTRICT,
  CHECK ((lease_owner IS NULL)=(lease_expires_at IS NULL)),
  CHECK ((status IN ('succeeded','failed','cancelled'))=(completed_at IS NOT NULL)),
  CHECK ((metrics_json IS NULL)=(metrics_hash IS NULL))
);
CREATE INDEX eval_runs_claim ON pr_agent_harness.eval_runs
  (tenant_id,status,available_at,deadline_at,created_at,id)
  WHERE status IN ('queued','running');

CREATE TABLE pr_agent_harness.eval_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  eval_run_id uuid NOT NULL,
  dataset_id uuid NOT NULL,
  case_id uuid NOT NULL,
  integration_id uuid NOT NULL,
  variant text NOT NULL CHECK (variant IN ('baseline','candidate')),
  repetition integer NOT NULL CHECK (repetition BETWEEN 1 AND 3),
  seed_hash text NOT NULL CHECK (seed_hash ~ '^[a-f0-9]{64}$'),
  child_run_id uuid,
  fixture_hash text NOT NULL CHECK (fixture_hash ~ '^[a-f0-9]{64}$'),
  label_set_id uuid NOT NULL,
  label_set_hash text NOT NULL CHECK (label_set_hash ~ '^[a-f0-9]{64}$'),
  component_hash text NOT NULL CHECK (component_hash ~ '^[a-f0-9]{64}$'),
  expected_workflow_hash text NOT NULL CHECK (expected_workflow_hash ~ '^[a-f0-9]{64}$'),
  expected_prompt_hash text NOT NULL CHECK (expected_prompt_hash ~ '^[a-f0-9]{64}$'),
  expected_model_hash text NOT NULL CHECK (expected_model_hash ~ '^[a-f0-9]{64}$'),
  expected_tool_hash text NOT NULL CHECK (expected_tool_hash ~ '^[a-f0-9]{64}$'),
  expected_policy_hash text NOT NULL CHECK (expected_policy_hash ~ '^[a-f0-9]{64}$'),
  expected_runtime_hash text NOT NULL CHECK (expected_runtime_hash ~ '^[a-f0-9]{64}$'),
  expected_verifier_hash text NOT NULL CHECK (expected_verifier_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','queued','running','succeeded','failed','cancelled')),
  artifact_hash text CHECK (artifact_hash IS NULL OR artifact_hash ~ '^[a-f0-9]{64}$'),
  score_json jsonb CHECK (score_json IS NULL OR jsonb_typeof(score_json)='object'),
  score_hash text CHECK (score_hash IS NULL OR score_hash ~ '^[a-f0-9]{64}$'),
  usage_json jsonb CHECK (usage_json IS NULL OR jsonb_typeof(usage_json)='object'),
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,eval_run_id,case_id,variant,repetition),
  FOREIGN KEY (tenant_id,eval_run_id)
    REFERENCES pr_agent_harness.eval_runs (tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,dataset_id,case_id)
    REFERENCES pr_agent_harness.eval_cases (tenant_id,dataset_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,label_set_id)
    REFERENCES pr_agent_harness.trusted_review_label_sets (tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,integration_id,child_run_id)
    REFERENCES pr_agent_harness.agent_runs (tenant_id,integration_id,id) ON DELETE RESTRICT,
  CHECK ((score_json IS NULL)=(score_hash IS NULL)),
  CHECK ((status IN ('succeeded','failed','cancelled'))=(completed_at IS NOT NULL))
);
CREATE INDEX eval_results_status ON pr_agent_harness.eval_results
  (tenant_id,eval_run_id,status,variant,repetition,case_id);

CREATE FUNCTION pr_agent_harness.guard_eval_run_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER eval_runs_lifecycle_guard BEFORE UPDATE OR DELETE ON pr_agent_harness.eval_runs
  FOR EACH ROW EXECUTE FUNCTION pr_agent_harness.guard_eval_run_lifecycle();

CREATE FUNCTION pr_agent_harness.guard_eval_result_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER eval_results_lifecycle_guard BEFORE UPDATE OR DELETE ON pr_agent_harness.eval_results
  FOR EACH ROW EXECUTE FUNCTION pr_agent_harness.guard_eval_result_lifecycle();

ALTER TABLE pr_agent_harness.evolution_proposal_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.evolution_proposal_sources FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.evolution_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.evolution_candidates FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.eval_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.eval_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.eval_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.eval_results FORCE ROW LEVEL SECURITY;

CREATE POLICY evolution_proposal_sources_tenant ON pr_agent_harness.evolution_proposal_sources
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY evolution_candidates_tenant ON pr_agent_harness.evolution_candidates
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY eval_runs_tenant ON pr_agent_harness.eval_runs
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY eval_results_tenant ON pr_agent_harness.eval_results
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

COMMENT ON TABLE pr_agent_harness.evolution_candidates IS
  'Immutable research-draft review text candidates; promotion is deliberately outside P3b.';
COMMENT ON TABLE pr_agent_harness.eval_results IS
  'Complete baseline and candidate replay matrix; failures are retained and never selectively dropped.';
