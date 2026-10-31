-- Langfuse quality control plane. Provider calls happen outside PostgreSQL;
-- these tables retain immutable prompt candidates, durable synchronization
-- intents, trace correlation, and untrusted human-score imports.

ALTER TABLE pr_agent_harness.agent_runs
  ADD CONSTRAINT agent_runs_tenant_integration_identity
  UNIQUE (tenant_id,integration_id,id);

CREATE TABLE pr_agent_harness.quality_prompt_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, integration_id uuid NOT NULL,
  prompt_key text NOT NULL CHECK (prompt_key ~ '^[a-z][a-z0-9_.-]{0,119}$'),
  remote_prompt_name text NOT NULL CHECK (remote_prompt_name ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$'),
  remote_prompt_version integer NOT NULL CHECK (remote_prompt_version>0),
  template_json jsonb NOT NULL CHECK (jsonb_typeof(template_json) IN ('string','array')),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  variables text[] NOT NULL DEFAULT '{}'::text[],
  source_fingerprint text NOT NULL CHECK (source_fingerprint ~ '^[0-9a-f]{64}$'),
  target_fingerprint text NOT NULL CHECK (target_fingerprint ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate','active','retired')),
  imported_by_actor_type text NOT NULL CHECK (imported_by_actor_type IN ('user','service','system')),
  imported_by_actor_id text NOT NULL CHECK (length(imported_by_actor_id) BETWEEN 1 AND 240),
  activation_command_key text CHECK (activation_command_key IS NULL OR length(activation_command_key) BETWEEN 1 AND 240),
  approved_by_actor_type text CHECK (approved_by_actor_type IS NULL OR approved_by_actor_type IN ('user','service','system')),
  approved_by_actor_id text CHECK (approved_by_actor_id IS NULL OR length(approved_by_actor_id) BETWEEN 1 AND 240),
  approved_at timestamptz, retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK (version>0),
  CONSTRAINT quality_prompt_binding_fk FOREIGN KEY (tenant_id,integration_id)
    REFERENCES pr_agent_harness.integration_bindings (tenant_id,id) ON DELETE RESTRICT,
  CONSTRAINT quality_prompt_remote_identity UNIQUE
    (tenant_id,integration_id,prompt_key,remote_prompt_name,remote_prompt_version),
  CONSTRAINT quality_prompt_approval_shape CHECK ((status='candidate')=(approved_at IS NULL)),
  CONSTRAINT quality_prompt_approval_actor_shape CHECK
    ((approved_at IS NULL)=(approved_by_actor_type IS NULL)
      AND (approved_at IS NULL)=(approved_by_actor_id IS NULL)
      AND (approved_at IS NULL)=(activation_command_key IS NULL)),
  CONSTRAINT quality_prompt_retired_shape CHECK ((status='retired')=(retired_at IS NOT NULL))
);
CREATE UNIQUE INDEX quality_prompt_one_active
  ON pr_agent_harness.quality_prompt_versions (tenant_id,integration_id,prompt_key) WHERE status='active';
CREATE UNIQUE INDEX quality_prompt_activation_command
  ON pr_agent_harness.quality_prompt_versions (tenant_id,integration_id,activation_command_key)
  WHERE activation_command_key IS NOT NULL;
CREATE INDEX quality_prompt_list ON pr_agent_harness.quality_prompt_versions
  (tenant_id,integration_id,prompt_key,status,remote_prompt_version DESC,id);

CREATE TABLE pr_agent_harness.quality_sync_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, integration_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN
    ('prompt_pull','dataset_export','evaluation_export','annotation_queue','annotation_pull','scores_export')),
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 240),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 240),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  target_fingerprint text NOT NULL CHECK (target_fingerprint ~ '^[0-9a-f]{64}$'),
  payload_json jsonb NOT NULL CHECK (jsonb_typeof(payload_json)='object'),
  principal_json jsonb NOT NULL CHECK (jsonb_typeof(principal_json)='object'),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','retry_wait','succeeded','dead_letter')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count>=0),
  max_attempts integer NOT NULL DEFAULT 8 CHECK (max_attempts BETWEEN 1 AND 32),
  max_age_seconds integer NOT NULL DEFAULT 86400 CHECK (max_age_seconds BETWEEN 60 AND 604800),
  retry_started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_owner text CHECK (lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 240),
  lease_epoch bigint NOT NULL DEFAULT 0 CHECK (lease_epoch>=0), lease_expires_at timestamptz,
  result_json jsonb CHECK (result_json IS NULL OR jsonb_typeof(result_json)='object'),
  error_code text CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 160),
  retry_command_key text CHECK (retry_command_key IS NULL OR length(retry_command_key) BETWEEN 1 AND 240),
  completed_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), version bigint NOT NULL DEFAULT 1 CHECK (version>0),
  CONSTRAINT quality_sync_binding_fk FOREIGN KEY (tenant_id,integration_id)
    REFERENCES pr_agent_harness.integration_bindings (tenant_id,id) ON DELETE RESTRICT,
  CONSTRAINT quality_sync_idempotency UNIQUE (tenant_id,integration_id,kind,idempotency_key),
  CONSTRAINT quality_sync_external_identity UNIQUE (tenant_id,integration_id,external_id),
  CONSTRAINT quality_sync_lease_shape CHECK
    ((status='running')=(lease_owner IS NOT NULL) AND (lease_owner IS NULL)=(lease_expires_at IS NULL)),
  CONSTRAINT quality_sync_terminal_shape CHECK
    ((status IN ('succeeded','dead_letter'))=(completed_at IS NOT NULL)),
  CONSTRAINT quality_sync_result_shape CHECK (status<>'succeeded' OR result_json IS NOT NULL)
);
CREATE INDEX quality_sync_claim ON pr_agent_harness.quality_sync_jobs
  (tenant_id,integration_id,available_at,created_at,id) WHERE status IN ('queued','retry_wait','running');
CREATE INDEX quality_sync_status ON pr_agent_harness.quality_sync_jobs
  (tenant_id,integration_id,status,updated_at DESC,id);

CREATE TABLE pr_agent_harness.quality_trace_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, integration_id uuid NOT NULL,
  run_id uuid NOT NULL, run_attempt integer NOT NULL CHECK (run_attempt>0),
  trace_id text NOT NULL CHECK (trace_id ~ '^[0-9a-f]{32}$'),
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 240),
  target_fingerprint text NOT NULL CHECK (target_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT quality_trace_run_fk FOREIGN KEY (tenant_id,integration_id,run_id)
    REFERENCES pr_agent_harness.agent_runs (tenant_id,integration_id,id) ON DELETE RESTRICT,
  CONSTRAINT quality_trace_run_attempt UNIQUE (tenant_id,integration_id,run_id,run_attempt),
  CONSTRAINT quality_trace_remote_identity UNIQUE (tenant_id,integration_id,trace_id),
  CONSTRAINT quality_trace_external_identity UNIQUE (tenant_id,integration_id,external_id),
  CONSTRAINT quality_trace_scoped_identity UNIQUE (tenant_id,integration_id,run_id,id)
);
CREATE INDEX quality_trace_run ON pr_agent_harness.quality_trace_links
  (tenant_id,integration_id,run_id,run_attempt);

CREATE TABLE pr_agent_harness.quality_annotation_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, integration_id uuid NOT NULL,
  source_run_id uuid NOT NULL, trace_link_id uuid NOT NULL,
  remote_score_id text NOT NULL CHECK (length(remote_score_id) BETWEEN 1 AND 240),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  score_json jsonb NOT NULL CHECK (jsonb_typeof(score_json)='object'),
  state text NOT NULL DEFAULT 'pending_review' CHECK (state IN ('pending_review','promoted','rejected')),
  imported_by_actor_type text NOT NULL CHECK (imported_by_actor_type IN ('service','system')),
  imported_by_actor_id text NOT NULL CHECK (length(imported_by_actor_id) BETWEEN 1 AND 240),
  review_command_key text CHECK (review_command_key IS NULL OR length(review_command_key) BETWEEN 1 AND 240),
  reviewed_by_actor_type text CHECK (reviewed_by_actor_type IS NULL OR reviewed_by_actor_type IN ('user','service','system')),
  reviewed_by_actor_id text CHECK (reviewed_by_actor_id IS NULL OR length(reviewed_by_actor_id) BETWEEN 1 AND 240),
  reviewed_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), version bigint NOT NULL DEFAULT 1 CHECK (version>0),
  CONSTRAINT quality_annotation_trace_fk FOREIGN KEY (tenant_id,integration_id,source_run_id,trace_link_id)
    REFERENCES pr_agent_harness.quality_trace_links (tenant_id,integration_id,run_id,id) ON DELETE RESTRICT,
  CONSTRAINT quality_annotation_remote_identity UNIQUE (tenant_id,integration_id,remote_score_id),
  CONSTRAINT quality_annotation_review_command UNIQUE (tenant_id,integration_id,review_command_key),
  CONSTRAINT quality_annotation_review_shape CHECK
    ((state='pending_review')=(reviewed_at IS NULL)
      AND (reviewed_at IS NULL)=(reviewed_by_actor_type IS NULL)
      AND (reviewed_at IS NULL)=(reviewed_by_actor_id IS NULL)
      AND (reviewed_at IS NULL)=(review_command_key IS NULL))
);
CREATE INDEX quality_annotation_review_queue ON pr_agent_harness.quality_annotation_imports
  (tenant_id,integration_id,state,created_at,id);

REVOKE ALL ON pr_agent_harness.quality_prompt_versions,pr_agent_harness.quality_sync_jobs,
  pr_agent_harness.quality_trace_links,pr_agent_harness.quality_annotation_imports FROM PUBLIC;

ALTER TABLE pr_agent_harness.quality_prompt_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.quality_prompt_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.quality_sync_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.quality_sync_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.quality_trace_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.quality_trace_links FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.quality_annotation_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.quality_annotation_imports FORCE ROW LEVEL SECURITY;

CREATE POLICY quality_prompt_tenant ON pr_agent_harness.quality_prompt_versions
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY quality_sync_tenant ON pr_agent_harness.quality_sync_jobs
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY quality_trace_tenant ON pr_agent_harness.quality_trace_links
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY quality_annotation_tenant ON pr_agent_harness.quality_annotation_imports
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

DO $owner_policy$
DECLARE owner_name text;
BEGIN
  SELECT pg_get_userbyid(nspowner) INTO STRICT owner_name FROM pg_namespace WHERE nspname='pr_agent_harness';
  EXECUTE format('CREATE POLICY schema_owner_maintenance ON pr_agent_harness.quality_prompt_versions TO %I USING (true) WITH CHECK (true)',owner_name);
  EXECUTE format('CREATE POLICY schema_owner_maintenance ON pr_agent_harness.quality_sync_jobs TO %I USING (true) WITH CHECK (true)',owner_name);
  EXECUTE format('CREATE POLICY schema_owner_maintenance ON pr_agent_harness.quality_trace_links TO %I USING (true) WITH CHECK (true)',owner_name);
  EXECUTE format('CREATE POLICY schema_owner_maintenance ON pr_agent_harness.quality_annotation_imports TO %I USING (true) WITH CHECK (true)',owner_name);
END $owner_policy$;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='pr_agent_app') THEN
    GRANT USAGE ON SCHEMA pr_agent_harness TO pr_agent_app;
    GRANT SELECT,INSERT,UPDATE,DELETE ON pr_agent_harness.quality_prompt_versions,
      pr_agent_harness.quality_sync_jobs TO pr_agent_app;
    GRANT SELECT,INSERT ON pr_agent_harness.quality_trace_links TO pr_agent_app;
    GRANT SELECT,INSERT,UPDATE ON pr_agent_harness.quality_annotation_imports TO pr_agent_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='pr_agent_maintenance') THEN
    GRANT USAGE ON SCHEMA pr_agent_harness TO pr_agent_maintenance;
    GRANT SELECT,DELETE ON pr_agent_harness.quality_prompt_versions,
      pr_agent_harness.quality_sync_jobs,pr_agent_harness.quality_trace_links,
      pr_agent_harness.quality_annotation_imports TO pr_agent_maintenance;
  END IF;
END $grants$;
