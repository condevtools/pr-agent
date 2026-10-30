CREATE FUNCTION pr_agent_harness.read_leased_verification_snapshot(
  requested_tenant_id uuid, requested_job_id uuid, requested_owner text,
  requested_epoch bigint, requested_artifact_hash text
) RETURNS TABLE (
  artifact_hash text, purpose text, content_type text, content_encoding text,
  raw_size_bytes integer, compressed_size_bytes integer, content_compressed bytea
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pr_agent_harness AS $$
BEGIN
  IF session_user<>'pr_agent_verifier' THEN
    RAISE EXCEPTION 'verifier snapshot role mismatch' USING ERRCODE='42501';
  END IF;
  IF length(requested_owner) NOT BETWEEN 1 AND 200 OR requested_epoch<1
      OR requested_artifact_hash !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'invalid verifier snapshot request';
  END IF;
  RETURN QUERY
    SELECT a.artifact_hash,a.purpose,a.content_type,a.content_encoding,
      a.raw_size_bytes,a.compressed_size_bytes,a.content_compressed
    FROM pr_agent_harness.verification_jobs j
    JOIN pr_agent_harness.run_artifacts a
      ON a.tenant_id=j.tenant_id AND a.integration_id=j.integration_id
      AND a.run_id=j.run_id AND a.artifact_hash=j.source_bundle_hash
    WHERE j.tenant_id=requested_tenant_id AND j.id=requested_job_id
      AND j.status='leased' AND j.lease_owner=requested_owner AND j.lease_epoch=requested_epoch
      AND j.lease_expires_at>clock_timestamp() AND j.deadline_at>clock_timestamp()
      AND j.source_bundle_hash=requested_artifact_hash
      AND j.source_bundle_ref='artifact:'||requested_artifact_hash
      AND a.purpose='fix_snapshot' AND a.content_compressed IS NOT NULL AND a.purged_at IS NULL;
END $$;

REVOKE ALL ON FUNCTION pr_agent_harness.read_leased_verification_snapshot(uuid,uuid,text,bigint,text) FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='pr_agent_verifier') THEN
    GRANT EXECUTE ON FUNCTION
      pr_agent_harness.read_leased_verification_snapshot(uuid,uuid,text,bigint,text)
      TO pr_agent_verifier;
    REVOKE SELECT,INSERT,UPDATE,DELETE ON pr_agent_harness.run_artifacts,
      pr_agent_harness.run_artifact_holds,pr_agent_harness.run_artifact_hold_releases
      FROM pr_agent_verifier;
  END IF;
END $$;
