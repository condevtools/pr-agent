ALTER TABLE pr_agent_harness.integration_bindings
  ADD COLUMN github_app_id bigint,
  ADD COLUMN github_account_id bigint,
  ADD COLUMN provider_access_state text NOT NULL DEFAULT 'verified',
  ADD COLUMN provider_access_version bigint NOT NULL DEFAULT 0,
  ADD COLUMN provider_access_checked_at timestamptz,
  ADD COLUMN provider_access_reason text,
  ADD CONSTRAINT integration_bindings_github_app_id_check
    CHECK (github_app_id IS NULL OR github_app_id > 0),
  ADD CONSTRAINT integration_bindings_github_account_id_check
    CHECK (github_account_id IS NULL OR github_account_id > 0),
  ADD CONSTRAINT integration_bindings_provider_access_state_check
    CHECK (provider_access_state IN ('verified','revoked','unknown')),
  ADD CONSTRAINT integration_bindings_provider_access_version_check
    CHECK (provider_access_version >= 0),
  ADD CONSTRAINT integration_bindings_github_metadata_shape_check
    CHECK (platform = 'github' OR (github_app_id IS NULL AND github_account_id IS NULL));

CREATE TABLE pr_agent_harness.github_provider_lifecycle_receipts (
  github_app_id bigint NOT NULL CHECK (github_app_id > 0),
  delivery_id text NOT NULL CHECK (length(delivery_id) BETWEEN 1 AND 200),
  requested_state text NOT NULL CHECK (requested_state IN ('revoked','unknown')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (github_app_id,delivery_id)
);
REVOKE ALL ON pr_agent_harness.github_provider_lifecycle_receipts FROM PUBLIC;

-- Persistent restrictive provider facts. repository_id=0 means the entire
-- installation; a live administrator revalidation restores one binding only
-- and intentionally does not erase this provider-event history.
CREATE TABLE pr_agent_harness.github_provider_access_restrictions (
  github_app_id bigint NOT NULL CHECK (github_app_id > 0),
  installation_id bigint NOT NULL CHECK (installation_id > 0),
  repository_id bigint NOT NULL CHECK (repository_id >= 0),
  access_state text NOT NULL CHECK (access_state IN ('revoked','unknown')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 200),
  delivery_id text NOT NULL CHECK (length(delivery_id) BETWEEN 1 AND 200),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (github_app_id,installation_id,repository_id)
);
REVOKE ALL ON pr_agent_harness.github_provider_access_restrictions FROM PUBLIC;

CREATE OR REPLACE FUNCTION pr_agent_harness.lock_active_publication_authority(
  requested_tenant_id uuid, requested_integration_id uuid, requested_platform text,
  requested_origin text, requested_repository text, requested_generation bigint
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pr_agent_harness AS $$
DECLARE matched boolean;
BEGIN
  SELECT true INTO matched
  FROM pr_agent_harness.integration_bindings
  WHERE tenant_id=requested_tenant_id AND id=requested_integration_id
    AND platform=requested_platform AND origin=requested_origin
    AND repository=requested_repository AND active
    AND publication_state='active' AND publication_generation=requested_generation
    AND provider_access_state='verified'
  FOR SHARE;
  RETURN COALESCE(matched,false);
END $$;

CREATE OR REPLACE FUNCTION pr_agent_harness.lock_active_review_execution_authority(
  requested_tenant_id uuid, requested_integration_id uuid,
  requested_publication_generation bigint, requested_execution_generation bigint
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pr_agent_harness AS $$
DECLARE matched boolean;
BEGIN
  SELECT true INTO matched
  FROM pr_agent_harness.integration_bindings
  WHERE tenant_id=requested_tenant_id AND id=requested_integration_id AND active
    AND publication_state='active' AND publication_generation=requested_publication_generation
    AND review_execution_mode='harness_async'
    AND execution_mode_generation=requested_execution_generation
    AND review_execution_state='active' AND provider_access_state='verified'
  FOR SHARE;
  RETURN COALESCE(matched,false);
END $$;

CREATE FUNCTION pr_agent_harness.lock_dispatchable_publication_authority(
  requested_tenant_id uuid, requested_integration_id uuid, requested_platform text,
  requested_origin text, requested_repository text, requested_generation bigint
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pr_agent_harness AS $$
DECLARE matched boolean;
BEGIN
  SELECT true INTO matched
  FROM pr_agent_harness.integration_bindings
  WHERE tenant_id=requested_tenant_id AND id=requested_integration_id
    AND platform=requested_platform AND origin=requested_origin
    AND repository=requested_repository AND active
    AND publication_state IN ('active','draining')
    AND publication_generation=requested_generation
    AND provider_access_state='verified'
  FOR SHARE;
  RETURN COALESCE(matched,false);
END $$;

CREATE FUNCTION pr_agent_harness.github_onboarding_list(
  requested_tenant_id uuid, requested_installation_ids bigint[]
) RETURNS SETOF pr_agent_harness.integration_bindings
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,pr_agent_harness AS $$
BEGIN
  IF requested_tenant_id IS NULL
     OR nullif(current_setting('app.tenant_id',true),'') IS NULL
     OR requested_tenant_id<>nullif(current_setting('app.tenant_id',true),'')::uuid THEN
    RAISE EXCEPTION 'GitHub onboarding tenant scope mismatch' USING ERRCODE='42501';
  END IF;
  IF requested_installation_ids IS NULL OR EXISTS (
    SELECT 1 FROM unnest(requested_installation_ids) installation_id
    WHERE installation_id IS NULL OR installation_id<=0
  ) THEN
    RAISE EXCEPTION 'invalid GitHub onboarding installation scope' USING ERRCODE='22023';
  END IF;
  RETURN QUERY SELECT b.* FROM pr_agent_harness.integration_bindings b
  WHERE b.tenant_id=requested_tenant_id AND b.platform='github' AND b.active
    AND (cardinality(requested_installation_ids)=0 OR
      substring(b.credential_ref FROM '^github-app:([1-9][0-9]*)$')::bigint
        = ANY(requested_installation_ids))
  ORDER BY b.repository,b.id;
END;
$$;

CREATE FUNCTION pr_agent_harness.github_onboarding_enroll(
  requested_tenant_id uuid, requested_actor_type text, requested_actor_id text,
  requested_origin text, requested_repository text, requested_app_id bigint,
  requested_installation_id bigint, requested_account_id bigint,
  requested_repository_id bigint, requested_provider_actor_id bigint,
  requested_confirmation text
) RETURNS SETOF pr_agent_harness.integration_bindings
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pr_agent_harness AS $$
DECLARE existing pr_agent_harness.integration_bindings%ROWTYPE;
DECLARE created_id uuid;
DECLARE identity_lock bigint;
DECLARE name_lock bigint;
DECLARE installation_lock bigint;
DECLARE restricted_state text;
DECLARE restricted_reason text;
BEGIN
  IF requested_tenant_id IS NULL
     OR nullif(current_setting('app.tenant_id',true),'') IS NULL
     OR requested_tenant_id<>nullif(current_setting('app.tenant_id',true),'')::uuid THEN
    RAISE EXCEPTION 'GitHub onboarding tenant scope mismatch' USING ERRCODE='42501';
  END IF;
  IF requested_actor_type IS NULL OR requested_actor_id IS NULL OR requested_origin IS NULL
     OR requested_repository IS NULL OR requested_app_id IS NULL
     OR requested_installation_id IS NULL OR requested_account_id IS NULL
     OR requested_repository_id IS NULL OR requested_provider_actor_id IS NULL
     OR requested_confirmation IS NULL
     OR requested_actor_type NOT IN ('user','service') OR length(btrim(requested_actor_id))=0
     OR length(requested_actor_id)>200 OR length(btrim(requested_confirmation))=0
     OR length(requested_confirmation)>2000 OR requested_origin<>'https://api.github.com'
     OR requested_repository !~ '^[a-z0-9_.-]+/[a-z0-9_.-]+$'
     OR requested_app_id<=0 OR requested_installation_id<=0 OR requested_account_id<=0
     OR requested_repository_id<=0 OR requested_provider_actor_id<=0 THEN
    RAISE EXCEPTION 'invalid GitHub onboarding request' USING ERRCODE='22023';
  END IF;
  identity_lock:=hashtextextended(
    'github-onboarding:identity:'||requested_app_id::text||':'||requested_repository_id::text,0);
  name_lock:=hashtextextended(
    'github-onboarding:name:'||requested_origin||':'||requested_repository,0);
  installation_lock:=hashtextextended(
    'github-onboarding:installation:'||requested_app_id::text||':'||requested_installation_id::text,0);
  PERFORM pg_advisory_xact_lock(lock_key)
  FROM (SELECT identity_lock AS lock_key UNION SELECT name_lock UNION SELECT installation_lock) locks
  ORDER BY lock_key;

  SELECT restriction.access_state,restriction.reason
  INTO restricted_state,restricted_reason
  FROM pr_agent_harness.github_provider_access_restrictions restriction
  WHERE restriction.github_app_id=requested_app_id
    AND restriction.installation_id=requested_installation_id
    AND restriction.repository_id IN (0,requested_repository_id)
  ORDER BY (restriction.access_state='revoked') DESC,restriction.repository_id DESC
  LIMIT 1;

  SELECT b.* INTO existing FROM pr_agent_harness.integration_bindings b
  WHERE b.active AND b.platform='github' AND b.origin=requested_origin
    AND (b.provider_repository_id=requested_repository_id::text OR b.repository=requested_repository)
  ORDER BY (b.provider_repository_id=requested_repository_id::text) DESC
  LIMIT 1 FOR UPDATE;

  IF FOUND THEN
    IF existing.tenant_id<>requested_tenant_id THEN
      RAISE EXCEPTION 'repository onboarding conflicts with an existing binding' USING ERRCODE='23505';
    END IF;
    IF existing.publication_state IN ('blocked','draining') THEN
      RETURN QUERY SELECT b.* FROM pr_agent_harness.integration_bindings b WHERE b.id=existing.id;
      RETURN;
    END IF;
    IF existing.repository<>requested_repository THEN
      RAISE EXCEPTION 'repository rename requires explicit revalidation' USING ERRCODE='23505';
    END IF;
    IF existing.provider_repository_id<>requested_repository_id::text
       OR existing.provider_actor_id<>requested_provider_actor_id::text
       OR existing.credential_ref<>'github-app:'||requested_installation_id::text
       OR (existing.github_app_id IS NOT NULL AND existing.github_app_id<>requested_app_id)
       OR (existing.github_account_id IS NOT NULL AND existing.github_account_id<>requested_account_id) THEN
      RAISE EXCEPTION 'repository onboarding conflicts with an existing binding' USING ERRCODE='23505';
    END IF;
    UPDATE pr_agent_harness.integration_bindings
    SET repository=requested_repository,github_app_id=requested_app_id,
        github_account_id=requested_account_id,provider_access_checked_at=clock_timestamp(),
        updated_at=clock_timestamp()
    WHERE id=existing.id;
    INSERT INTO pr_agent_harness.audit_logs
      (tenant_id,actor_type,actor_id,action,decision,resource_type,resource_ref,details_json)
    VALUES (requested_tenant_id,requested_actor_type,requested_actor_id,
      'github.onboarding.adopt','allowed','integration_binding',existing.id::text,
      jsonb_build_object('repositoryId',requested_repository_id,'installationId',requested_installation_id));
    RETURN QUERY SELECT b.* FROM pr_agent_harness.integration_bindings b WHERE b.id=existing.id;
    RETURN;
  END IF;

  created_id:=gen_random_uuid();
  INSERT INTO pr_agent_harness.integration_bindings
    (id,tenant_id,platform,origin,repository,provider_repository_id,provider_actor_id,
     credential_ref,publication_state,publication_generation,authority_version,
     quiescence_receipt,review_execution_mode,execution_mode_generation,
     review_execution_state,github_app_id,github_account_id,provider_access_state,
     provider_access_version,provider_access_checked_at,provider_access_reason)
  VALUES (created_id,requested_tenant_id,'github',requested_origin,requested_repository,
    requested_repository_id::text,requested_provider_actor_id::text,
    'github-app:'||requested_installation_id::text,'active',1,2,
    jsonb_build_object('actor',requested_actor_id,'evidence',requested_confirmation,
      'protocol','github_onboarding_v1'),
    'harness_async',1,'active',requested_app_id,requested_account_id,
    CASE WHEN restricted_state IS NULL THEN 'verified' ELSE 'unknown' END,
    CASE WHEN restricted_state IS NULL THEN 0 ELSE 1 END,
    clock_timestamp(),restricted_reason);
  INSERT INTO pr_agent_harness.audit_logs
    (tenant_id,actor_type,actor_id,action,decision,resource_type,resource_ref,details_json)
  VALUES (requested_tenant_id,requested_actor_type,requested_actor_id,
    CASE WHEN restricted_state IS NULL THEN 'github.onboarding.activate'
      ELSE 'github.onboarding.register_restricted' END,
    'allowed','integration_binding',created_id::text,
    jsonb_build_object('repositoryId',requested_repository_id,
      'installationId',requested_installation_id,'confirmation',requested_confirmation,
      'providerAccessState',CASE WHEN restricted_state IS NULL THEN 'verified' ELSE 'unknown' END,
      'historicalRestrictionState',restricted_state));
  RETURN QUERY SELECT b.* FROM pr_agent_harness.integration_bindings b WHERE b.id=created_id;
END $$;

CREATE FUNCTION pr_agent_harness.github_onboarding_revalidate(
  requested_tenant_id uuid, requested_actor_type text, requested_actor_id text,
  requested_origin text, requested_repository text, requested_app_id bigint,
  requested_installation_id bigint, requested_account_id bigint,
  requested_repository_id bigint, requested_provider_actor_id bigint,
  requested_confirmation text, requested_access_version bigint
) RETURNS SETOF pr_agent_harness.integration_bindings
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pr_agent_harness AS $$
DECLARE existing pr_agent_harness.integration_bindings%ROWTYPE;
DECLARE observed_credential_ref text;
DECLARE observed_installation_id bigint;
DECLARE abandoned_operation_ids text[];
DECLARE affected_batch_id uuid;
BEGIN
  IF requested_tenant_id IS NULL
     OR nullif(current_setting('app.tenant_id',true),'') IS NULL
     OR requested_tenant_id<>nullif(current_setting('app.tenant_id',true),'')::uuid THEN
    RAISE EXCEPTION 'GitHub onboarding tenant scope mismatch' USING ERRCODE='42501';
  END IF;
  IF requested_actor_type IS NULL OR requested_actor_id IS NULL OR requested_origin IS NULL
     OR requested_repository IS NULL OR requested_app_id IS NULL
     OR requested_installation_id IS NULL OR requested_account_id IS NULL
     OR requested_repository_id IS NULL OR requested_provider_actor_id IS NULL
     OR requested_confirmation IS NULL OR requested_access_version IS NULL
     OR requested_actor_type NOT IN ('user','service') OR length(btrim(requested_actor_id))=0
     OR length(requested_actor_id)>200 OR length(btrim(requested_confirmation))=0
     OR length(requested_confirmation)>2000 OR requested_access_version<0
     OR requested_origin<>'https://api.github.com' OR requested_repository !~ '^[a-z0-9_.-]+/[a-z0-9_.-]+$'
     OR requested_app_id<=0 OR requested_installation_id<=0 OR requested_account_id<=0
     OR requested_repository_id<=0 OR requested_provider_actor_id<=0 THEN
    RAISE EXCEPTION 'invalid GitHub revalidation request' USING ERRCODE='22023';
  END IF;
  SELECT b.credential_ref INTO observed_credential_ref
  FROM pr_agent_harness.integration_bindings b
  WHERE b.tenant_id=requested_tenant_id AND b.active AND b.platform='github'
    AND b.provider_repository_id=requested_repository_id::text;
  IF NOT FOUND OR observed_credential_ref !~ '^github-app:[1-9][0-9]*$' THEN
    RAISE EXCEPTION 'repository revalidation conflicts with the binding identity' USING ERRCODE='23505';
  END IF;
  observed_installation_id:=substring(observed_credential_ref FROM '^github-app:([1-9][0-9]*)$')::bigint;
  PERFORM pg_advisory_xact_lock(lock_key)
  FROM (
    SELECT hashtextextended(
      'github-onboarding:identity:'||requested_app_id::text||':'||requested_repository_id::text,0) lock_key
    UNION
    SELECT hashtextextended(
      'github-onboarding:name:'||requested_origin||':'||requested_repository,0)
    UNION
    SELECT hashtextextended('github-onboarding:installation:'||requested_app_id::text||':'||observed_installation_id::text,0)
    UNION
    SELECT hashtextextended('github-onboarding:installation:'||requested_app_id::text||':'||requested_installation_id::text,0)
  ) locks ORDER BY lock_key;

  SELECT b.* INTO existing FROM pr_agent_harness.integration_bindings b
  WHERE b.tenant_id=requested_tenant_id AND b.active AND b.platform='github'
    AND b.provider_repository_id=requested_repository_id::text FOR UPDATE;
  IF NOT FOUND OR existing.origin<>requested_origin
     OR existing.provider_actor_id<>requested_provider_actor_id::text
     OR (existing.github_app_id IS NOT NULL AND existing.github_app_id<>requested_app_id)
     OR (existing.github_account_id IS NOT NULL AND existing.github_account_id<>requested_account_id)
     OR (observed_installation_id<>requested_installation_id
       AND (existing.github_app_id IS NULL OR existing.github_account_id IS NULL)) THEN
    RAISE EXCEPTION 'repository revalidation conflicts with the binding identity' USING ERRCODE='23505';
  END IF;
  IF existing.provider_access_version<>requested_access_version THEN
    RAISE EXCEPTION 'repository provider access version conflict' USING ERRCODE='40001';
  END IF;
  SELECT array_agg(candidate.business_operation_id ORDER BY candidate.business_operation_id)
  INTO abandoned_operation_ids
  FROM (
    SELECT o.business_operation_id
    FROM pr_agent_harness.repository_operations o
    WHERE o.tenant_id=requested_tenant_id AND o.integration_id=existing.id
      AND o.status='prepared' AND o.attempt_count=0 AND o.dispatched_at IS NULL
    ORDER BY o.business_operation_id
    FOR UPDATE
  ) candidate;

  IF cardinality(COALESCE(abandoned_operation_ids,ARRAY[]::text[]))>0 THEN
    UPDATE pr_agent_harness.repository_operations o
    SET status='cancelled',outcome_code='no_effect',remote_id=NULL,
        last_error_code='provider_revalidation_before_dispatch',resolved_at=clock_timestamp(),
        next_reconcile_at=NULL,reconcile_claim_owner=NULL,reconcile_claim_expires_at=NULL,
        version=version+1,updated_at=clock_timestamp()
    WHERE o.tenant_id=requested_tenant_id
      AND o.business_operation_id=ANY(abandoned_operation_ids)
      AND o.status='prepared' AND o.attempt_count=0 AND o.dispatched_at IS NULL;

    INSERT INTO pr_agent_harness.audit_logs
      (tenant_id,actor_type,actor_id,action,decision,reason_code,
       resource_type,resource_ref,details_json)
    SELECT requested_tenant_id,requested_actor_type,requested_actor_id,
      'github.provider_access.prepared_abandoned','allowed',
      'provider_revalidation_before_dispatch','repository_operation',operation_id,
      jsonb_build_object('repositoryId',requested_repository_id,
        'expectedAccessVersion',requested_access_version)
    FROM unnest(abandoned_operation_ids) operation_id;

    FOR affected_batch_id IN
      SELECT DISTINCT pbo.batch_id
      FROM pr_agent_harness.publication_batch_operations pbo
      WHERE pbo.tenant_id=requested_tenant_id
        AND pbo.business_operation_id=ANY(abandoned_operation_ids)
      ORDER BY pbo.batch_id
    LOOP
      PERFORM pr_agent_harness.skip_failed_batch_successors(
        requested_tenant_id,affected_batch_id);
    END LOOP;
  END IF;

  IF EXISTS (SELECT 1 FROM pr_agent_harness.repository_operations o
    WHERE o.tenant_id=requested_tenant_id AND o.integration_id=existing.id
      AND (o.status IN ('in_flight','unknown','manual_review')
        OR (o.status='prepared' AND (o.attempt_count<>0 OR o.dispatched_at IS NOT NULL)))) THEN
    RAISE EXCEPTION 'unresolved publication operations prevent provider revalidation' USING ERRCODE='55000';
  END IF;
  UPDATE pr_agent_harness.integration_bindings
  SET repository=requested_repository,github_app_id=requested_app_id,
      github_account_id=requested_account_id,
      credential_ref='github-app:'||requested_installation_id::text,
      provider_access_state='verified',
      provider_access_version=provider_access_version+1,
      provider_access_checked_at=clock_timestamp(),provider_access_reason=NULL,
      publication_generation=CASE WHEN publication_generation>0
        THEN publication_generation+1 ELSE publication_generation END,
      updated_at=clock_timestamp()
  WHERE id=existing.id;
  INSERT INTO pr_agent_harness.audit_logs
    (tenant_id,actor_type,actor_id,action,decision,resource_type,resource_ref,details_json)
  VALUES (requested_tenant_id,requested_actor_type,requested_actor_id,
    'github.provider_access.revalidate','allowed','integration_binding',existing.id::text,
    jsonb_build_object('priorAccessVersion',requested_access_version,
      'repositoryId',requested_repository_id,'priorInstallationId',observed_installation_id,
      'installationId',requested_installation_id,'confirmation',requested_confirmation,
      'legacyMetadataRecovered',(existing.github_app_id IS NULL OR existing.github_account_id IS NULL)));
  RETURN QUERY SELECT b.* FROM pr_agent_harness.integration_bindings b WHERE b.id=existing.id;
END $$;

CREATE FUNCTION pr_agent_harness.github_onboarding_invalidate(
  requested_app_id bigint, requested_installation_id bigint,
  requested_repository_ids bigint[], requested_state text,
  requested_reason text, requested_delivery_id text
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pr_agent_harness AS $$
DECLARE changed integer;
BEGIN
  IF requested_app_id IS NULL OR requested_installation_id IS NULL
     OR requested_state IS NULL OR requested_reason IS NULL OR requested_delivery_id IS NULL
     OR requested_app_id<=0 OR requested_installation_id<=0
     OR requested_state NOT IN ('revoked','unknown')
     OR length(btrim(requested_reason))=0 OR length(requested_reason)>200
     OR length(btrim(requested_delivery_id))=0 OR length(requested_delivery_id)>200
     OR EXISTS (SELECT 1 FROM unnest(COALESCE(requested_repository_ids,ARRAY[]::bigint[])) v
       WHERE v IS NULL OR v<=0) THEN
    RAISE EXCEPTION 'invalid GitHub provider lifecycle request' USING ERRCODE='22023';
  END IF;
  INSERT INTO pr_agent_harness.github_provider_lifecycle_receipts
    (github_app_id,delivery_id,requested_state,reason)
  VALUES (requested_app_id,requested_delivery_id,requested_state,requested_reason)
  ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN 0; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'github-onboarding:installation:'||requested_app_id::text||':'||requested_installation_id::text,0));
  INSERT INTO pr_agent_harness.github_provider_access_restrictions
    (github_app_id,installation_id,repository_id,access_state,reason,delivery_id)
  SELECT requested_app_id,requested_installation_id,repository_id,
    requested_state,requested_reason,requested_delivery_id
  FROM unnest(CASE WHEN requested_repository_ids IS NULL OR cardinality(requested_repository_ids)=0
    THEN ARRAY[0]::bigint[] ELSE requested_repository_ids END) repository_id
  ON CONFLICT (github_app_id,installation_id,repository_id) DO UPDATE
  SET access_state=CASE
        WHEN pr_agent_harness.github_provider_access_restrictions.access_state='revoked'
          THEN 'revoked'
        ELSE EXCLUDED.access_state
      END,
      reason=CASE
        WHEN pr_agent_harness.github_provider_access_restrictions.access_state='revoked'
          THEN pr_agent_harness.github_provider_access_restrictions.reason
        ELSE EXCLUDED.reason
      END,
      delivery_id=CASE
        WHEN pr_agent_harness.github_provider_access_restrictions.access_state='revoked'
          THEN pr_agent_harness.github_provider_access_restrictions.delivery_id
        ELSE EXCLUDED.delivery_id
      END,
      version=pr_agent_harness.github_provider_access_restrictions.version+1,
      updated_at=clock_timestamp();
  WITH updated AS (
    UPDATE pr_agent_harness.integration_bindings b
    SET provider_access_state=CASE WHEN b.provider_access_state='revoked'
        THEN 'revoked' ELSE requested_state END,
      provider_access_version=b.provider_access_version+1,
      provider_access_checked_at=clock_timestamp(),
      provider_access_reason=CASE WHEN b.provider_access_state='revoked'
        THEN COALESCE(b.provider_access_reason,requested_reason) ELSE requested_reason END,
      updated_at=clock_timestamp()
    WHERE b.active AND b.platform='github'
      AND b.credential_ref='github-app:'||requested_installation_id::text
      AND (b.github_app_id IS NULL OR b.github_app_id=requested_app_id)
      AND (requested_repository_ids IS NULL OR cardinality(requested_repository_ids)=0
        OR b.provider_repository_id::bigint=ANY(requested_repository_ids))
    RETURNING b.*
  ), audited AS (
    INSERT INTO pr_agent_harness.audit_logs
      (tenant_id,actor_type,actor_id,action,decision,resource_type,resource_ref,details_json)
    SELECT tenant_id,'service','github-webhook:'||requested_app_id::text,
      'github.provider_access.invalidate','allowed','integration_binding',id::text,
      jsonb_build_object('state',provider_access_state,'reason',requested_reason,
        'deliveryId',requested_delivery_id)
    FROM updated RETURNING 1
  ) SELECT count(*)::integer INTO changed FROM audited;
  RETURN changed;
END $$;

REVOKE ALL ON FUNCTION pr_agent_harness.github_onboarding_list(uuid,bigint[]),
  pr_agent_harness.github_onboarding_enroll(uuid,text,text,text,text,bigint,bigint,bigint,bigint,bigint,text),
  pr_agent_harness.github_onboarding_revalidate(uuid,text,text,text,text,bigint,bigint,bigint,bigint,bigint,text,bigint),
  pr_agent_harness.github_onboarding_invalidate(bigint,bigint,bigint[],text,text,text)
FROM PUBLIC;
REVOKE ALL ON FUNCTION pr_agent_harness.lock_dispatchable_publication_authority(
  uuid,uuid,text,text,text,bigint) FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='pr_agent_onboarding') THEN
    GRANT USAGE ON SCHEMA pr_agent_harness TO pr_agent_onboarding;
    GRANT EXECUTE ON FUNCTION pr_agent_harness.github_onboarding_list(uuid,bigint[]),
      pr_agent_harness.github_onboarding_enroll(uuid,text,text,text,text,bigint,bigint,bigint,bigint,bigint,text),
      pr_agent_harness.github_onboarding_revalidate(uuid,text,text,text,text,bigint,bigint,bigint,bigint,bigint,text,bigint),
      pr_agent_harness.github_onboarding_invalidate(bigint,bigint,bigint[],text,text,text)
    TO pr_agent_onboarding;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='pr_agent_app') THEN
    GRANT EXECUTE ON FUNCTION pr_agent_harness.lock_dispatchable_publication_authority(
      uuid,uuid,text,text,text,bigint) TO pr_agent_app;
  END IF;
END $grants$;
