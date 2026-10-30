CREATE TABLE pr_agent_harness.run_artifacts (
  tenant_id uuid NOT NULL,
  integration_id uuid NOT NULL,
  run_id uuid NOT NULL,
  artifact_hash text NOT NULL CHECK (artifact_hash ~ '^[a-f0-9]{64}$'),
  purpose text NOT NULL CHECK (purpose IN ('step_output','fix_snapshot','evaluation','log','other')),
  content_type text NOT NULL CHECK (length(content_type) BETWEEN 1 AND 200),
  content_encoding text NOT NULL DEFAULT 'gzip' CHECK (content_encoding='gzip'),
  raw_size_bytes integer NOT NULL CHECK (raw_size_bytes BETWEEN 0 AND 33554432),
  compressed_size_bytes integer NOT NULL CHECK (compressed_size_bytes BETWEEN 0 AND 8388608),
  content_compressed bytea,
  retention_expires_at timestamptz NOT NULL DEFAULT (clock_timestamp()+interval '30 days'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  purged_at timestamptz,
  PRIMARY KEY (tenant_id,run_id,artifact_hash),
  UNIQUE (tenant_id,integration_id,run_id,artifact_hash),
  FOREIGN KEY (tenant_id,integration_id,run_id)
    REFERENCES pr_agent_harness.agent_runs (tenant_id,integration_id,id) ON DELETE RESTRICT,
  CHECK (compressed_size_bytes=COALESCE(octet_length(content_compressed),compressed_size_bytes)),
  CHECK ((content_compressed IS NULL)=(purged_at IS NOT NULL))
);

CREATE INDEX run_artifacts_retention
  ON pr_agent_harness.run_artifacts (retention_expires_at,tenant_id,run_id,artifact_hash)
  WHERE purged_at IS NULL;

CREATE TABLE pr_agent_harness.run_artifact_holds (
  tenant_id uuid NOT NULL,
  integration_id uuid NOT NULL,
  run_id uuid NOT NULL,
  artifact_hash text NOT NULL,
  hold_key text NOT NULL CHECK (length(hold_key) BETWEEN 1 AND 200),
  hold_kind text NOT NULL CHECK (hold_kind IN ('fix','evolution','qualification','legal','other')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,run_id,artifact_hash,hold_key),
  FOREIGN KEY (tenant_id,integration_id,run_id,artifact_hash)
    REFERENCES pr_agent_harness.run_artifacts (tenant_id,integration_id,run_id,artifact_hash) ON DELETE RESTRICT
);

CREATE TABLE pr_agent_harness.run_artifact_hold_releases (
  tenant_id uuid NOT NULL,
  integration_id uuid NOT NULL,
  run_id uuid NOT NULL,
  artifact_hash text NOT NULL,
  hold_key text NOT NULL,
  released_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,run_id,artifact_hash,hold_key),
  FOREIGN KEY (tenant_id,run_id,artifact_hash,hold_key)
    REFERENCES pr_agent_harness.run_artifact_holds (tenant_id,run_id,artifact_hash,hold_key) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,integration_id,run_id,artifact_hash)
    REFERENCES pr_agent_harness.run_artifacts (tenant_id,integration_id,run_id,artifact_hash) ON DELETE RESTRICT
);

ALTER TABLE pr_agent_harness.agent_steps
  ADD COLUMN result_ref text CHECK (result_ref IS NULL OR result_ref ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT agent_steps_result_ref_fk
    FOREIGN KEY (tenant_id,run_id,result_ref)
    REFERENCES pr_agent_harness.run_artifacts (tenant_id,run_id,artifact_hash) ON DELETE RESTRICT;

ALTER TABLE pr_agent_harness.tool_calls
  ADD CONSTRAINT tool_calls_artifact_result_ref_format
    CHECK (result_ref IS NULL OR result_ref ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT tool_calls_artifact_result_ref_fk
    FOREIGN KEY (tenant_id,run_id,result_ref)
    REFERENCES pr_agent_harness.run_artifacts (tenant_id,run_id,artifact_hash) ON DELETE RESTRICT;

CREATE FUNCTION pr_agent_harness.lock_available_run_artifact(
  requested_tenant_id uuid, requested_integration_id uuid, requested_run_id uuid, requested_artifact_hash text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pr_agent_harness AS $$
DECLARE run_available boolean; available boolean;
BEGIN
  IF nullif(current_setting('app.tenant_id',true),'')::uuid IS DISTINCT FROM requested_tenant_id THEN
    RAISE EXCEPTION 'artifact tenant scope mismatch' USING ERRCODE='42501';
  END IF;
  SELECT content_purged_at IS NULL INTO run_available FROM pr_agent_harness.agent_runs
  WHERE tenant_id=requested_tenant_id AND integration_id=requested_integration_id
    AND id=requested_run_id
  FOR UPDATE;
  IF NOT COALESCE(run_available,false) THEN RETURN false; END IF;
  SELECT true INTO available FROM pr_agent_harness.run_artifacts
  WHERE tenant_id=requested_tenant_id AND integration_id=requested_integration_id
    AND run_id=requested_run_id AND artifact_hash=requested_artifact_hash
    AND content_compressed IS NOT NULL AND purged_at IS NULL
  FOR UPDATE;
  RETURN COALESCE(available,false);
END $$;

REVOKE ALL ON FUNCTION pr_agent_harness.lock_available_run_artifact(uuid,uuid,uuid,text) FROM PUBLIC;

CREATE FUNCTION pr_agent_harness.enforce_run_artifact_quota() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pr_agent_harness AS $$
DECLARE used_bytes bigint;
BEGIN
  IF NEW.content_compressed IS NULL OR NEW.purged_at IS NOT NULL THEN
    RAISE EXCEPTION 'new artifact content must be present';
  END IF;
  PERFORM 1 FROM pr_agent_harness.agent_runs r
    WHERE r.tenant_id=NEW.tenant_id AND r.integration_id=NEW.integration_id AND r.id=NEW.run_id
    FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'artifact Run scope is unavailable'; END IF;
  SELECT COALESCE(sum(a.raw_size_bytes),0) INTO used_bytes
    FROM pr_agent_harness.run_artifacts a
    WHERE a.tenant_id=NEW.tenant_id AND a.run_id=NEW.run_id;
  IF used_bytes+NEW.raw_size_bytes>134217728 THEN
    RAISE EXCEPTION 'Run artifact raw byte quota exceeded';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER run_artifacts_quota BEFORE INSERT ON pr_agent_harness.run_artifacts
FOR EACH ROW EXECUTE FUNCTION pr_agent_harness.enforce_run_artifact_quota();

CREATE FUNCTION pr_agent_harness.guard_run_artifact_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pr_agent_harness AS $$
BEGIN
  IF NOT pr_agent_harness.is_harness_admin() THEN RAISE EXCEPTION 'run artifacts are immutable'; END IF;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'run artifact metadata cannot be deleted'; END IF;
  IF OLD.content_compressed IS NOT NULL AND NEW.content_compressed IS NULL AND OLD.purged_at IS NULL
      AND NEW.purged_at IS NOT NULL
      AND (to_jsonb(NEW)-'content_compressed'-'purged_at')=(to_jsonb(OLD)-'content_compressed'-'purged_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'run artifact metadata is immutable';
END $$;

CREATE TRIGGER run_artifacts_immutable BEFORE UPDATE OR DELETE ON pr_agent_harness.run_artifacts
FOR EACH ROW EXECUTE FUNCTION pr_agent_harness.guard_run_artifact_mutation();

ALTER TABLE pr_agent_harness.run_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.run_artifacts FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.run_artifact_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.run_artifact_holds FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.run_artifact_hold_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.run_artifact_hold_releases FORCE ROW LEVEL SECURITY;

CREATE POLICY run_artifacts_tenant ON pr_agent_harness.run_artifacts
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY run_artifact_holds_tenant ON pr_agent_harness.run_artifact_holds
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY run_artifact_hold_releases_tenant ON pr_agent_harness.run_artifact_hold_releases
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

DO $$
DECLARE owner_name text;
BEGIN
  SELECT pg_get_userbyid(nspowner) INTO STRICT owner_name FROM pg_namespace WHERE nspname='pr_agent_harness';
  EXECUTE format('CREATE POLICY schema_owner_maintenance ON pr_agent_harness.run_artifacts TO %I USING (true) WITH CHECK (true)',owner_name);
  EXECUTE format('CREATE POLICY schema_owner_maintenance ON pr_agent_harness.run_artifact_holds TO %I USING (true) WITH CHECK (true)',owner_name);
  EXECUTE format('CREATE POLICY schema_owner_maintenance ON pr_agent_harness.run_artifact_hold_releases TO %I USING (true) WITH CHECK (true)',owner_name);
END $$;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='pr_agent_app') THEN
    GRANT SELECT,INSERT ON pr_agent_harness.run_artifacts,
      pr_agent_harness.run_artifact_holds,pr_agent_harness.run_artifact_hold_releases TO pr_agent_app;
    REVOKE UPDATE,DELETE ON pr_agent_harness.run_artifacts,
      pr_agent_harness.run_artifact_holds,pr_agent_harness.run_artifact_hold_releases FROM pr_agent_app;
    GRANT EXECUTE ON FUNCTION pr_agent_harness.lock_available_run_artifact(uuid,uuid,uuid,text) TO pr_agent_app;
  END IF;
END $grants$;
