CREATE TABLE pr_agent_harness.feedback_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, integration_id uuid NOT NULL,
  source_run_id uuid NOT NULL, artifact_hash text NOT NULL CHECK (artifact_hash ~ '^[a-f0-9]{64}$'),
  command_key text NOT NULL CHECK (length(command_key) BETWEEN 1 AND 200),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  actor_type text NOT NULL CHECK (actor_type IN ('user','service')), actor_id text NOT NULL,
  observation_json jsonb NOT NULL CHECK (jsonb_typeof(observation_json)='object'),
  content_purged_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,source_run_id,command_key), UNIQUE (tenant_id,integration_id,id),
  FOREIGN KEY (tenant_id,integration_id,source_run_id)
    REFERENCES pr_agent_harness.agent_runs (tenant_id,integration_id,id) ON DELETE RESTRICT
);

CREATE TABLE pr_agent_harness.review_annotations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, integration_id uuid NOT NULL,
  source_run_id uuid NOT NULL, artifact_hash text NOT NULL CHECK (artifact_hash ~ '^[a-f0-9]{64}$'),
  rubric_version text NOT NULL CHECK (rubric_version='review-quality.v1'),
  label_set_hash text NOT NULL CHECK (label_set_hash ~ '^[a-f0-9]{64}$'),
  label_set_json jsonb NOT NULL CHECK (jsonb_typeof(label_set_json)='object'),
  provenance_json jsonb NOT NULL CHECK (jsonb_typeof(provenance_json)='object'),
  actor_type text NOT NULL CHECK (actor_type IN ('user','service')), actor_id text NOT NULL,
  command_key text NOT NULL CHECK (length(command_key) BETWEEN 1 AND 200),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  supersedes_annotation_id uuid, superseded_by_annotation_id uuid,
  content_purged_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,source_run_id,command_key), UNIQUE (tenant_id,source_run_id,id),
  FOREIGN KEY (tenant_id,integration_id,source_run_id)
    REFERENCES pr_agent_harness.agent_runs (tenant_id,integration_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,source_run_id,supersedes_annotation_id)
    REFERENCES pr_agent_harness.review_annotations (tenant_id,source_run_id,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id,source_run_id,superseded_by_annotation_id)
    REFERENCES pr_agent_harness.review_annotations (tenant_id,source_run_id,id) DEFERRABLE INITIALLY DEFERRED,
  CHECK (supersedes_annotation_id IS NULL OR supersedes_annotation_id<>id),
  CHECK (superseded_by_annotation_id IS NULL OR superseded_by_annotation_id<>id)
);
CREATE UNIQUE INDEX review_annotations_one_active_actor
  ON pr_agent_harness.review_annotations (tenant_id,source_run_id,rubric_version,actor_type,actor_id)
  WHERE superseded_by_annotation_id IS NULL;
CREATE INDEX review_annotations_consensus
  ON pr_agent_harness.review_annotations (tenant_id,source_run_id,rubric_version,label_set_hash,created_at)
  WHERE superseded_by_annotation_id IS NULL AND content_purged_at IS NULL;

CREATE TABLE pr_agent_harness.review_annotation_arbitrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, integration_id uuid NOT NULL,
  source_run_id uuid NOT NULL, artifact_hash text NOT NULL CHECK (artifact_hash ~ '^[a-f0-9]{64}$'),
  rubric_version text NOT NULL CHECK (rubric_version='review-quality.v1'),
  left_annotation_id uuid NOT NULL, left_label_set_hash text NOT NULL CHECK (left_label_set_hash ~ '^[a-f0-9]{64}$'),
  right_annotation_id uuid NOT NULL, right_label_set_hash text NOT NULL CHECK (right_label_set_hash ~ '^[a-f0-9]{64}$'),
  chosen_label_set_hash text NOT NULL CHECK (chosen_label_set_hash ~ '^[a-f0-9]{64}$'),
  actor_type text NOT NULL CHECK (actor_type IN ('user','service')), actor_id text NOT NULL,
  command_key text NOT NULL CHECK (length(command_key) BETWEEN 1 AND 200),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'), reason text NOT NULL CHECK (length(reason) BETWEEN 20 AND 4000),
  content_purged_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,source_run_id,command_key), UNIQUE (tenant_id,source_run_id,id),
  FOREIGN KEY (tenant_id,integration_id,source_run_id)
    REFERENCES pr_agent_harness.agent_runs (tenant_id,integration_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,source_run_id,left_annotation_id)
    REFERENCES pr_agent_harness.review_annotations (tenant_id,source_run_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,source_run_id,right_annotation_id)
    REFERENCES pr_agent_harness.review_annotations (tenant_id,source_run_id,id) ON DELETE RESTRICT,
  CHECK (left_annotation_id<>right_annotation_id), CHECK (left_label_set_hash<>right_label_set_hash),
  CHECK (chosen_label_set_hash IN (left_label_set_hash,right_label_set_hash))
);

CREATE TABLE pr_agent_harness.trusted_review_label_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, integration_id uuid NOT NULL,
  source_run_id uuid NOT NULL, artifact_hash text NOT NULL CHECK (artifact_hash ~ '^[a-f0-9]{64}$'),
  rubric_version text NOT NULL CHECK (rubric_version='review-quality.v1'),
  label_set_hash text NOT NULL CHECK (label_set_hash ~ '^[a-f0-9]{64}$'),
  label_set_json jsonb NOT NULL CHECK (jsonb_typeof(label_set_json)='object'),
  version bigint NOT NULL CHECK (version>0), active boolean NOT NULL DEFAULT true, supersedes_label_set_id uuid,
  resolution_kind text NOT NULL CHECK (resolution_kind IN ('consensus','arbitration')),
  resolution_json jsonb NOT NULL CHECK (jsonb_typeof(resolution_json)='object'), arbitration_id uuid,
  content_purged_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,integration_id,id), UNIQUE (tenant_id,id), UNIQUE (tenant_id,source_run_id,rubric_version,version),
  FOREIGN KEY (tenant_id,integration_id,source_run_id)
    REFERENCES pr_agent_harness.agent_runs (tenant_id,integration_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,source_run_id,arbitration_id)
    REFERENCES pr_agent_harness.review_annotation_arbitrations (tenant_id,source_run_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,supersedes_label_set_id)
    REFERENCES pr_agent_harness.trusted_review_label_sets (tenant_id,id) ON DELETE RESTRICT,
  CHECK ((resolution_kind='consensus' AND arbitration_id IS NULL)
      OR (resolution_kind='arbitration' AND arbitration_id IS NOT NULL))
);
CREATE UNIQUE INDEX trusted_review_label_sets_one_active
  ON pr_agent_harness.trusted_review_label_sets (tenant_id,source_run_id,rubric_version) WHERE active;

CREATE TABLE pr_agent_harness.eval_datasets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200), status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','frozen','retired')),
  version bigint NOT NULL DEFAULT 1 CHECK (version>=1),
  curator_actor_type text NOT NULL CHECK (curator_actor_type IN ('user','service')), curator_actor_id text NOT NULL,
  split_policy_json jsonb NOT NULL CHECK (jsonb_typeof(split_policy_json)='object'),
  split_policy_hash text NOT NULL CHECK (split_policy_hash ~ '^[a-f0-9]{64}$'),
  manifest_hash text CHECK (manifest_hash IS NULL OR manifest_hash ~ '^[a-f0-9]{64}$'),
  case_count integer NOT NULL DEFAULT 0 CHECK (case_count>=0), dev_count integer NOT NULL DEFAULT 0 CHECK (dev_count>=0),
  validation_count integer NOT NULL DEFAULT 0 CHECK (validation_count>=0),
  holdout_count integer NOT NULL DEFAULT 0 CHECK (holdout_count>=0), frozen_at timestamptz, content_purged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,curator_actor_type,curator_actor_id,name), UNIQUE (tenant_id,id),
  CHECK ((status='draft' AND manifest_hash IS NULL AND frozen_at IS NULL)
      OR (status IN ('frozen','retired') AND manifest_hash IS NOT NULL AND frozen_at IS NOT NULL
          AND case_count=dev_count+validation_count+holdout_count))
);
CREATE INDEX eval_datasets_status ON pr_agent_harness.eval_datasets
  (tenant_id,curator_actor_type,curator_actor_id,status,created_at,id);

CREATE TABLE pr_agent_harness.eval_fixtures (
  id text NOT NULL CHECK (id ~ '^[a-f0-9]{64}$'), tenant_id uuid NOT NULL, integration_id uuid NOT NULL, run_id uuid NOT NULL,
  repository text NOT NULL CHECK (length(repository) BETWEEN 1 AND 512), base_sha text NOT NULL, head_sha text NOT NULL,
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'), source_step_id uuid NOT NULL,
  source_step_output_hash text NOT NULL CHECK (source_step_output_hash ~ '^[a-f0-9]{64}$'),
  artifact_hash text NOT NULL CHECK (artifact_hash ~ '^[a-f0-9]{64}$'), fixture_hash text NOT NULL CHECK (fixture_hash ~ '^[a-f0-9]{64}$'),
  input_json jsonb NOT NULL CHECK (jsonb_typeof(input_json)='object'), files_manifest_json jsonb NOT NULL CHECK (jsonb_typeof(files_manifest_json)='array'),
  coverage_json jsonb NOT NULL CHECK (jsonb_typeof(coverage_json)='object'), ci_json jsonb NOT NULL CHECK (jsonb_typeof(ci_json)='object'),
  total_bytes integer NOT NULL CHECK (total_bytes BETWEEN 0 AND 52428800), content_purged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,run_id),
  FOREIGN KEY (tenant_id,integration_id,run_id) REFERENCES pr_agent_harness.agent_runs (tenant_id,integration_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,run_id,source_step_id) REFERENCES pr_agent_harness.agent_steps (tenant_id,run_id,id) ON DELETE RESTRICT
);

CREATE TABLE pr_agent_harness.eval_fixture_files (
  tenant_id uuid NOT NULL, fixture_id text NOT NULL, path text NOT NULL CHECK (length(path) BETWEEN 1 AND 512
    AND path !~ '(^/|\\|(^|/)\.\.?(/|$))'), kind text NOT NULL CHECK (kind IN ('source','manifest','ci')),
  content_text text, content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 0 AND 52428800), content_purged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY (tenant_id,fixture_id,path),
  FOREIGN KEY (tenant_id,fixture_id) REFERENCES pr_agent_harness.eval_fixtures (tenant_id,id) ON DELETE RESTRICT,
  CHECK ((content_purged_at IS NULL AND content_text IS NOT NULL) OR content_purged_at IS NOT NULL)
);
CREATE INDEX eval_fixture_files_kind ON pr_agent_harness.eval_fixture_files (tenant_id,fixture_id,kind,path);

CREATE TABLE pr_agent_harness.eval_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, integration_id uuid NOT NULL,
  dataset_id uuid NOT NULL, source_run_id uuid NOT NULL, fixture_id text NOT NULL, label_set_id uuid NOT NULL,
  source_artifact_hash text NOT NULL CHECK (source_artifact_hash ~ '^[a-f0-9]{64}$'),
  fixture_hash text NOT NULL CHECK (fixture_hash ~ '^[a-f0-9]{64}$'), label_set_hash text NOT NULL CHECK (label_set_hash ~ '^[a-f0-9]{64}$'),
  label_set_json jsonb NOT NULL CHECK (jsonb_typeof(label_set_json)='object'),
  lineage_hash text NOT NULL CHECK (lineage_hash ~ '^[a-f0-9]{64}$'), shingle_hash text NOT NULL CHECK (shingle_hash ~ '^[a-f0-9]{64}$'),
  shingle_hashes_json jsonb NOT NULL CHECK (jsonb_typeof(shingle_hashes_json)='array' AND jsonb_array_length(shingle_hashes_json)<=256),
  source_created_at timestamptz NOT NULL, repository text NOT NULL CHECK (length(repository) BETWEEN 1 AND 512),
  pull_number integer NOT NULL CHECK (pull_number>0), split text CHECK (split IN ('development','validation','holdout')),
  ordinal integer CHECK (ordinal IS NULL OR ordinal>=0), content_purged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE (tenant_id,dataset_id,source_run_id),
  UNIQUE (tenant_id,dataset_id,ordinal),
  FOREIGN KEY (tenant_id,dataset_id) REFERENCES pr_agent_harness.eval_datasets (tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,integration_id,source_run_id) REFERENCES pr_agent_harness.agent_runs (tenant_id,integration_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,fixture_id) REFERENCES pr_agent_harness.eval_fixtures (tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,label_set_id) REFERENCES pr_agent_harness.trusted_review_label_sets (tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX eval_cases_split ON pr_agent_harness.eval_cases (tenant_id,dataset_id,split,ordinal,id);
CREATE INDEX eval_cases_lineage ON pr_agent_harness.eval_cases (tenant_id,integration_id,lineage_hash);
CREATE INDEX eval_cases_shingle ON pr_agent_harness.eval_cases (tenant_id,integration_id,shingle_hash);

CREATE FUNCTION pr_agent_harness.is_harness_admin() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user),false)
$$;

CREATE FUNCTION pr_agent_harness.guard_evolution_raw_content() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER feedback_observations_immutable BEFORE UPDATE OR DELETE ON pr_agent_harness.feedback_observations
  FOR EACH ROW EXECUTE FUNCTION pr_agent_harness.guard_evolution_raw_content();
CREATE TRIGGER review_annotations_immutable BEFORE UPDATE OR DELETE ON pr_agent_harness.review_annotations
  FOR EACH ROW EXECUTE FUNCTION pr_agent_harness.guard_evolution_raw_content();
CREATE TRIGGER review_annotation_arbitrations_immutable BEFORE UPDATE OR DELETE ON pr_agent_harness.review_annotation_arbitrations
  FOR EACH ROW EXECUTE FUNCTION pr_agent_harness.guard_evolution_raw_content();
CREATE TRIGGER trusted_review_label_sets_immutable BEFORE UPDATE OR DELETE ON pr_agent_harness.trusted_review_label_sets
  FOR EACH ROW EXECUTE FUNCTION pr_agent_harness.guard_evolution_raw_content();

CREATE FUNCTION pr_agent_harness.guard_frozen_eval_dataset() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER eval_cases_frozen_guard BEFORE INSERT OR UPDATE OR DELETE ON pr_agent_harness.eval_cases
  FOR EACH ROW EXECUTE FUNCTION pr_agent_harness.guard_frozen_eval_dataset();

CREATE FUNCTION pr_agent_harness.guard_frozen_eval_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER eval_fixtures_frozen_guard BEFORE UPDATE OR DELETE ON pr_agent_harness.eval_fixtures
  FOR EACH ROW EXECUTE FUNCTION pr_agent_harness.guard_frozen_eval_fixture();

CREATE FUNCTION pr_agent_harness.guard_frozen_eval_fixture_file() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER eval_fixture_files_frozen_guard BEFORE INSERT OR UPDATE OR DELETE ON pr_agent_harness.eval_fixture_files
  FOR EACH ROW EXECUTE FUNCTION pr_agent_harness.guard_frozen_eval_fixture_file();

CREATE FUNCTION pr_agent_harness.guard_eval_dataset_state() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER eval_datasets_state_guard BEFORE UPDATE OR DELETE ON pr_agent_harness.eval_datasets
  FOR EACH ROW EXECUTE FUNCTION pr_agent_harness.guard_eval_dataset_state();

ALTER TABLE pr_agent_harness.feedback_observations ENABLE ROW LEVEL SECURITY; ALTER TABLE pr_agent_harness.feedback_observations FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.review_annotations ENABLE ROW LEVEL SECURITY; ALTER TABLE pr_agent_harness.review_annotations FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.review_annotation_arbitrations ENABLE ROW LEVEL SECURITY; ALTER TABLE pr_agent_harness.review_annotation_arbitrations FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.trusted_review_label_sets ENABLE ROW LEVEL SECURITY; ALTER TABLE pr_agent_harness.trusted_review_label_sets FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.eval_datasets ENABLE ROW LEVEL SECURITY; ALTER TABLE pr_agent_harness.eval_datasets FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.eval_fixtures ENABLE ROW LEVEL SECURITY; ALTER TABLE pr_agent_harness.eval_fixtures FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.eval_fixture_files ENABLE ROW LEVEL SECURITY; ALTER TABLE pr_agent_harness.eval_fixture_files FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.eval_cases ENABLE ROW LEVEL SECURITY; ALTER TABLE pr_agent_harness.eval_cases FORCE ROW LEVEL SECURITY;

CREATE POLICY feedback_observations_tenant ON pr_agent_harness.feedback_observations USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY review_annotations_tenant ON pr_agent_harness.review_annotations USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY review_annotation_arbitrations_tenant ON pr_agent_harness.review_annotation_arbitrations USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY trusted_review_label_sets_tenant ON pr_agent_harness.trusted_review_label_sets USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY eval_datasets_tenant ON pr_agent_harness.eval_datasets USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY eval_fixtures_tenant ON pr_agent_harness.eval_fixtures USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY eval_fixture_files_tenant ON pr_agent_harness.eval_fixture_files USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY eval_cases_tenant ON pr_agent_harness.eval_cases USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

COMMENT ON TABLE pr_agent_harness.feedback_observations IS 'Idempotent user observations; never a trusted evaluation label.';
COMMENT ON TABLE pr_agent_harness.trusted_review_label_sets IS 'Immutable complete ground truth created only by exact two-actor consensus or third-actor arbitration.';
