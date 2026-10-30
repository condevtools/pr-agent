ALTER TABLE pr_agent_harness.integration_bindings
  ADD COLUMN review_deep_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN fix_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN evolution_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN default_review_workflow text NOT NULL DEFAULT 'review.single.v1'
    CHECK (default_review_workflow IN ('review.single.v1','review.deep.v1')),
  ADD CONSTRAINT default_deep_review_requires_capability
    CHECK (default_review_workflow<>'review.deep.v1' OR review_deep_enabled);

CREATE TABLE pr_agent_harness.runtime_process_heartbeats (
  process_role text NOT NULL CHECK (process_role IN ('worker','recovery','verifier')),
  instance_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  capability_report jsonb NOT NULL CHECK (jsonb_typeof(capability_report)='object'),
  PRIMARY KEY (process_role,instance_id)
);
CREATE INDEX runtime_process_heartbeats_freshness
  ON pr_agent_harness.runtime_process_heartbeats (process_role,heartbeat_at DESC);

CREATE FUNCTION pr_agent_harness.lock_current_binding_capability(
  requested_tenant_id uuid, requested_integration_id uuid, requested_capability text
) RETURNS TABLE(authority_version bigint,capability_enabled boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pr_agent_harness AS $$
BEGIN
  IF requested_capability NOT IN ('review.single','review.deep','fix','evolution') THEN
    RAISE EXCEPTION 'invalid integration capability';
  END IF;
  RETURN QUERY
    SELECT b.authority_version,
      CASE requested_capability
        WHEN 'review.single' THEN true
        WHEN 'review.deep' THEN b.review_deep_enabled
        WHEN 'fix' THEN b.fix_enabled
        ELSE b.evolution_enabled
      END
    FROM pr_agent_harness.integration_bindings b
    WHERE b.tenant_id=requested_tenant_id AND b.id=requested_integration_id AND b.active
    FOR SHARE OF b;
END $$;

REVOKE ALL ON pr_agent_harness.runtime_process_heartbeats FROM PUBLIC;
CREATE FUNCTION pr_agent_harness.record_runtime_process_heartbeat(
  requested_role text, requested_instance_id uuid, requested_report jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pr_agent_harness AS $$
BEGIN
  IF requested_role NOT IN ('worker','recovery','verifier')
     OR jsonb_typeof(requested_report)<>'object' THEN
    RAISE EXCEPTION 'invalid runtime process heartbeat';
  END IF;
  IF (requested_role='verifier' AND session_user<>'pr_agent_verifier')
     OR (requested_role<>'verifier' AND session_user<>'pr_agent_app') THEN
    RAISE EXCEPTION 'runtime process heartbeat role mismatch' USING ERRCODE='42501';
  END IF;
  INSERT INTO pr_agent_harness.runtime_process_heartbeats
    (process_role,instance_id,capability_report)
  VALUES (requested_role,requested_instance_id,requested_report)
  ON CONFLICT (process_role,instance_id) DO UPDATE
  SET heartbeat_at=clock_timestamp(),capability_report=EXCLUDED.capability_report;
END $$;

CREATE FUNCTION pr_agent_harness.remove_runtime_process_heartbeat(
  requested_role text, requested_instance_id uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pr_agent_harness AS $$
BEGIN
  IF (requested_role='verifier' AND session_user<>'pr_agent_verifier')
     OR (requested_role IN ('worker','recovery') AND session_user<>'pr_agent_app')
     OR requested_role NOT IN ('worker','recovery','verifier') THEN
    RAISE EXCEPTION 'runtime process heartbeat role mismatch' USING ERRCODE='42501';
  END IF;
  DELETE FROM pr_agent_harness.runtime_process_heartbeats
  WHERE process_role=requested_role AND instance_id=requested_instance_id;
END $$;

REVOKE ALL ON FUNCTION pr_agent_harness.record_runtime_process_heartbeat(text,uuid,jsonb),
  pr_agent_harness.remove_runtime_process_heartbeat(text,uuid),
  pr_agent_harness.lock_current_binding_capability(uuid,uuid,text) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='pr_agent_app') THEN
    GRANT SELECT ON pr_agent_harness.integration_bindings TO pr_agent_app;
    GRANT SELECT ON pr_agent_harness.runtime_process_heartbeats TO pr_agent_app;
    GRANT EXECUTE ON FUNCTION pr_agent_harness.record_runtime_process_heartbeat(text,uuid,jsonb),
      pr_agent_harness.remove_runtime_process_heartbeat(text,uuid),
      pr_agent_harness.lock_current_binding_capability(uuid,uuid,text) TO pr_agent_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='pr_agent_verifier') THEN
    GRANT EXECUTE ON FUNCTION pr_agent_harness.record_runtime_process_heartbeat(text,uuid,jsonb),
      pr_agent_harness.remove_runtime_process_heartbeat(text,uuid) TO pr_agent_verifier;
  END IF;
END $$;
