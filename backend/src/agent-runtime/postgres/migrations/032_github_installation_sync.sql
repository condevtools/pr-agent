-- Durable GitHub App installation reconciliation. Provider inventory is fetched
-- outside PostgreSQL; only complete snapshots may enter these bounded APIs.

ALTER TABLE pr_agent_harness.github_provider_lifecycle_receipts
  ADD COLUMN installation_id bigint CHECK (installation_id IS NULL OR installation_id>0),
  ADD COLUMN delivery_class text NOT NULL DEFAULT 'restrictive'
    CHECK (delivery_class IN ('positive','restrictive','discovery')),
  ADD COLUMN requested_epoch bigint CHECK (requested_epoch IS NULL OR requested_epoch>0),
  ADD COLUMN result text NOT NULL DEFAULT 'accepted'
    CHECK (result IN ('accepted','duplicate'));

ALTER TABLE pr_agent_harness.github_provider_access_restrictions
  ADD COLUMN restricted_epoch bigint NOT NULL DEFAULT 1 CHECK (restricted_epoch>0),
  ADD COLUMN resolved_epoch bigint CHECK (resolved_epoch IS NULL OR resolved_epoch>0),
  ADD COLUMN resolved_by_snapshot_epoch bigint
    CHECK (resolved_by_snapshot_epoch IS NULL OR resolved_by_snapshot_epoch>0),
  ADD CONSTRAINT github_provider_restriction_resolution_shape CHECK
    ((resolved_epoch IS NULL)=(resolved_by_snapshot_epoch IS NULL));

CREATE TABLE pr_agent_harness.github_account_tenant_mappings (
  github_app_id bigint NOT NULL CHECK (github_app_id>0),
  github_account_id bigint NOT NULL CHECK (github_account_id>0),
  tenant_id uuid NOT NULL,
  mapping_source text NOT NULL CHECK (mapping_source IN ('auto_created','adopted_binding')),
  version bigint NOT NULL DEFAULT 1 CHECK (version>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (github_app_id,github_account_id)
);

CREATE TABLE pr_agent_harness.github_installation_sync_state (
  github_app_id bigint NOT NULL CHECK (github_app_id>0),
  installation_id bigint NOT NULL CHECK (installation_id>0),
  github_account_id bigint CHECK (github_account_id IS NULL OR github_account_id>0),
  provider_actor_id bigint CHECK (provider_actor_id IS NULL OR provider_actor_id>0),
  requested_epoch bigint NOT NULL DEFAULT 0 CHECK (requested_epoch>=0),
  restrictive_epoch bigint NOT NULL DEFAULT 0 CHECK (restrictive_epoch>=0),
  applied_epoch bigint NOT NULL DEFAULT 0 CHECK (applied_epoch>=0),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','applying','retry','idle','conflict')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count>=0),
  retry_at timestamptz,
  lease_owner text CHECK (lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 200),
  lease_expires_at timestamptz,
  lease_epoch bigint NOT NULL DEFAULT 0 CHECK (lease_epoch>=0),
  claim_epoch bigint CHECK (claim_epoch IS NULL OR claim_epoch>0),
  snapshot_hash text CHECK (snapshot_hash IS NULL OR snapshot_hash ~ '^[0-9a-f]{64}$'),
  snapshot_completed_at timestamptz,
  last_complete_snapshot_at timestamptz,
  last_conflict_count integer NOT NULL DEFAULT 0 CHECK (last_conflict_count>=0),
  last_error_code text CHECK (last_error_code IS NULL OR length(last_error_code)<=200),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (github_app_id,installation_id),
  CHECK ((lease_owner IS NULL)=(lease_expires_at IS NULL)),
  CHECK ((lease_owner IS NULL)=(claim_epoch IS NULL))
);
CREATE INDEX github_installation_sync_runnable
  ON pr_agent_harness.github_installation_sync_state (status,retry_at,updated_at)
  WHERE status IN ('pending','retry','applying');

CREATE TABLE pr_agent_harness.github_deferred_pull_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  github_app_id bigint NOT NULL CHECK (github_app_id>0),
  delivery_id text NOT NULL CHECK (length(delivery_id) BETWEEN 1 AND 200),
  installation_id bigint NOT NULL CHECK (installation_id>0),
  github_account_id bigint NOT NULL CHECK (github_account_id>0),
  repository_id bigint NOT NULL CHECK (repository_id>0),
  repository text NOT NULL CHECK (repository ~ '^[a-z0-9_.-]+/[a-z0-9_.-]+$'),
  pull_number integer NOT NULL CHECK (pull_number>0),
  action text NOT NULL CHECK (action IN ('opened','edited','synchronize','reopened','closed')),
  source_hash text NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','leased','retry','completed','skipped','conflict','expired')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count>=0),
  retry_at timestamptz,
  lease_owner text CHECK (lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 200),
  lease_expires_at timestamptz,
  lease_epoch bigint NOT NULL DEFAULT 0 CHECK (lease_epoch>=0),
  run_id uuid,
  last_error_code text CHECK (last_error_code IS NULL OR length(last_error_code)<=200),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT (clock_timestamp()+interval '72 hours'),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (github_app_id,delivery_id),
  CHECK ((lease_owner IS NULL)=(lease_expires_at IS NULL)),
  CHECK ((status='leased')=(lease_owner IS NOT NULL)),
  CHECK ((status IN ('completed','skipped','conflict','expired'))=(completed_at IS NOT NULL))
);
CREATE INDEX github_deferred_pull_requests_runnable
  ON pr_agent_harness.github_deferred_pull_requests (status,retry_at,received_at,id)
  WHERE status IN ('pending','retry','leased');

ALTER TABLE pr_agent_harness.agent_runs
  ADD COLUMN source_kind text CHECK (source_kind IS NULL OR source_kind IN ('github_delivery')),
  ADD COLUMN source_key text CHECK (source_key IS NULL OR length(source_key) BETWEEN 1 AND 240),
  ADD COLUMN source_hash text CHECK (source_hash IS NULL OR source_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT agent_runs_source_shape CHECK
    ((source_kind IS NULL AND source_key IS NULL AND source_hash IS NULL)
      OR (source_kind IS NOT NULL AND source_key IS NOT NULL AND source_hash IS NOT NULL));
CREATE UNIQUE INDEX agent_runs_github_delivery_source
  ON pr_agent_harness.agent_runs (tenant_id,source_key)
  WHERE source_kind='github_delivery';

-- Normalize only unambiguous retained review deliveries. Duplicate groups and
-- content-purged rows remain untouched so the handoff lookup can fail closed.
DO $normalize_github_delivery$
DECLARE scoped_tenant uuid;
BEGIN
  FOR scoped_tenant IN SELECT DISTINCT tenant_id FROM pr_agent_harness.agent_runs
    WHERE create_key LIKE 'github:delivery:%' AND run_type LIKE '%review%'
  LOOP
    PERFORM set_config('app.tenant_id',scoped_tenant::text,true);
    WITH candidates AS (
      SELECT r.id,r.create_key,r.input_json#>>'{source,hash}' AS retained_hash,
        count(*) OVER (PARTITION BY r.create_key) AS source_count
      FROM pr_agent_harness.agent_runs r
      WHERE r.tenant_id=scoped_tenant AND r.create_key LIKE 'github:delivery:%'
        AND r.run_type LIKE '%review%'
    ), eligible AS (
      SELECT c.id FROM candidates c JOIN pr_agent_harness.agent_runs r ON r.id=c.id
      WHERE c.source_count=1 AND c.retained_hash ~ '^[0-9a-f]{64}$'
        AND r.input_json#>>'{source,key}'=r.create_key
    )
    UPDATE pr_agent_harness.agent_runs r SET source_kind='github_delivery',source_key=r.create_key,
      source_hash=r.input_json#>>'{source,hash}' FROM eligible e
    WHERE r.tenant_id=scoped_tenant AND r.id=e.id;
  END LOOP;
  PERFORM set_config('app.tenant_id','',true);
END $normalize_github_delivery$;

REVOKE ALL ON pr_agent_harness.github_account_tenant_mappings,
  pr_agent_harness.github_installation_sync_state,
  pr_agent_harness.github_deferred_pull_requests FROM PUBLIC;

CREATE FUNCTION pr_agent_harness.github_installation_sync_request(
  requested_app_id bigint,requested_installation_id bigint,requested_account_id bigint,
  requested_delivery_id text,requested_class text,requested_reason text
) RETURNS TABLE(accepted boolean,requested_epoch bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pr_agent_harness AS $$
DECLARE current_epoch bigint;
BEGIN
  IF requested_app_id IS NULL OR requested_app_id<=0 OR requested_installation_id IS NULL
     OR requested_installation_id<=0 OR (requested_account_id IS NOT NULL AND requested_account_id<=0)
     OR requested_class NOT IN ('positive','discovery')
     OR length(btrim(COALESCE(requested_delivery_id,''))) NOT BETWEEN 1 AND 200
     OR length(btrim(COALESCE(requested_reason,''))) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid GitHub installation sync request' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'github-onboarding:installation:'||requested_app_id::text||':'||requested_installation_id::text,0));
  SELECT s.requested_epoch INTO current_epoch
  FROM pr_agent_harness.github_installation_sync_state s
  WHERE s.github_app_id=requested_app_id AND s.installation_id=requested_installation_id;
  INSERT INTO pr_agent_harness.github_provider_lifecycle_receipts
    (github_app_id,delivery_id,requested_state,reason,installation_id,delivery_class,result)
  VALUES (requested_app_id,requested_delivery_id,'unknown',requested_reason,
    requested_installation_id,requested_class,'accepted') ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false,COALESCE(current_epoch,0); RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM pr_agent_harness.github_installation_sync_state s
    WHERE s.github_app_id=requested_app_id AND s.installation_id=requested_installation_id
      AND s.github_account_id IS NOT NULL AND requested_account_id IS NOT NULL
      AND s.github_account_id<>requested_account_id) THEN
    RAISE EXCEPTION 'installation account identity conflict' USING ERRCODE='23505';
  END IF;
  INSERT INTO pr_agent_harness.github_installation_sync_state
    (github_app_id,installation_id,github_account_id,requested_epoch,status)
  VALUES (requested_app_id,requested_installation_id,requested_account_id,1,'pending')
  ON CONFLICT (github_app_id,installation_id) DO UPDATE SET
    github_account_id=COALESCE(pr_agent_harness.github_installation_sync_state.github_account_id,
      EXCLUDED.github_account_id),
    requested_epoch=pr_agent_harness.github_installation_sync_state.requested_epoch+1,
    status='pending',retry_at=NULL,last_error_code=NULL,lease_owner=NULL,lease_expires_at=NULL,
    claim_epoch=NULL,snapshot_hash=NULL,snapshot_completed_at=NULL,
    requested_at=clock_timestamp(),updated_at=clock_timestamp()
  RETURNING pr_agent_harness.github_installation_sync_state.requested_epoch INTO current_epoch;
  UPDATE pr_agent_harness.github_provider_lifecycle_receipts
  SET requested_epoch=current_epoch WHERE github_app_id=requested_app_id
    AND delivery_id=requested_delivery_id;
  RETURN QUERY SELECT true,current_epoch;
END $$;

CREATE FUNCTION pr_agent_harness.github_installation_restrict_and_request(
  requested_app_id bigint,requested_installation_id bigint,requested_account_id bigint,
  requested_repository_ids bigint[],requested_state text,requested_reason text,requested_delivery_id text
) RETURNS TABLE(accepted boolean,requested_epoch bigint,changed_bindings integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pr_agent_harness AS $$
DECLARE next_epoch bigint; DECLARE changed integer; DECLARE account_conflict boolean;
BEGIN
  IF requested_app_id IS NULL OR requested_app_id<=0 OR requested_installation_id IS NULL
     OR requested_installation_id<=0 OR (requested_account_id IS NOT NULL AND requested_account_id<=0)
     OR requested_state NOT IN ('revoked','unknown')
     OR length(btrim(COALESCE(requested_reason,''))) NOT BETWEEN 1 AND 200
     OR length(btrim(COALESCE(requested_delivery_id,''))) NOT BETWEEN 1 AND 200
     OR EXISTS (SELECT 1 FROM unnest(COALESCE(requested_repository_ids,ARRAY[]::bigint[])) id
       WHERE id IS NULL OR id<=0)
     OR cardinality(COALESCE(requested_repository_ids,ARRAY[]::bigint[]))>10000 THEN
    RAISE EXCEPTION 'invalid GitHub installation restriction request' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'github-onboarding:installation:'||requested_app_id::text||':'||requested_installation_id::text,0));
  SELECT EXISTS (SELECT 1 FROM pr_agent_harness.github_installation_sync_state s
    WHERE s.github_app_id=requested_app_id AND s.installation_id=requested_installation_id
      AND s.github_account_id IS NOT NULL AND requested_account_id IS NOT NULL
      AND s.github_account_id<>requested_account_id) INTO account_conflict;
  INSERT INTO pr_agent_harness.github_provider_lifecycle_receipts
    (github_app_id,delivery_id,requested_state,reason,installation_id,delivery_class,result)
  VALUES (requested_app_id,requested_delivery_id,requested_state,requested_reason,
    requested_installation_id,'restrictive','accepted') ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    SELECT s.requested_epoch INTO next_epoch FROM pr_agent_harness.github_installation_sync_state s
      WHERE s.github_app_id=requested_app_id AND s.installation_id=requested_installation_id;
    RETURN QUERY SELECT false,COALESCE(next_epoch,0),0; RETURN;
  END IF;
  INSERT INTO pr_agent_harness.github_installation_sync_state
    (github_app_id,installation_id,github_account_id,requested_epoch,restrictive_epoch,status)
  VALUES (requested_app_id,requested_installation_id,requested_account_id,1,1,'pending')
  ON CONFLICT (github_app_id,installation_id) DO UPDATE SET
    github_account_id=COALESCE(pr_agent_harness.github_installation_sync_state.github_account_id,
      EXCLUDED.github_account_id),
    requested_epoch=pr_agent_harness.github_installation_sync_state.requested_epoch+1,
    restrictive_epoch=pr_agent_harness.github_installation_sync_state.requested_epoch+1,
    status='pending',retry_at=NULL,
    last_error_code=CASE WHEN account_conflict THEN 'installation_account_identity_conflict' ELSE NULL END,
    lease_owner=NULL,lease_expires_at=NULL,
    claim_epoch=NULL,snapshot_hash=NULL,snapshot_completed_at=NULL,
    requested_at=clock_timestamp(),updated_at=clock_timestamp()
  RETURNING pr_agent_harness.github_installation_sync_state.requested_epoch INTO next_epoch;
  UPDATE pr_agent_harness.github_provider_lifecycle_receipts SET requested_epoch=next_epoch
    WHERE github_app_id=requested_app_id AND delivery_id=requested_delivery_id;
  IF account_conflict THEN
    INSERT INTO pr_agent_harness.audit_logs
      (tenant_id,actor_type,actor_id,action,decision,reason_code,resource_type,resource_ref,details_json)
    SELECT DISTINCT scope.tenant_id,'service','github-webhook:'||requested_app_id::text,
      'github.installation.account_identity','denied','installation_account_identity_conflict',
      'github_installation',requested_installation_id::text,
      jsonb_build_object('deliveryId',requested_delivery_id,'epoch',next_epoch,
        'requestedAccountId',requested_account_id,'preservedAccountId',scope.account_id)
    FROM (
      SELECT m.tenant_id,s.github_account_id account_id
      FROM pr_agent_harness.github_installation_sync_state s
      JOIN pr_agent_harness.github_account_tenant_mappings m
        ON m.github_app_id=s.github_app_id AND m.github_account_id=s.github_account_id
      WHERE s.github_app_id=requested_app_id AND s.installation_id=requested_installation_id
      UNION
      SELECT b.tenant_id,b.github_account_id
      FROM pr_agent_harness.integration_bindings b
      WHERE b.platform='github' AND b.origin='https://api.github.com'
        AND b.credential_ref='github-app:'||requested_installation_id::text
        AND (b.github_app_id IS NULL OR b.github_app_id=requested_app_id)
        AND b.github_account_id IS NOT NULL
    ) scope;
  END IF;
  INSERT INTO pr_agent_harness.github_provider_access_restrictions
    (github_app_id,installation_id,repository_id,access_state,reason,delivery_id,restricted_epoch)
  SELECT requested_app_id,requested_installation_id,id,requested_state,requested_reason,
    requested_delivery_id,next_epoch
  FROM (SELECT DISTINCT value AS id FROM unnest(CASE
    WHEN cardinality(COALESCE(requested_repository_ids,ARRAY[]::bigint[]))=0
      THEN ARRAY[0]::bigint[] ELSE requested_repository_ids END) value) unique_ids
  ON CONFLICT (github_app_id,installation_id,repository_id) DO UPDATE SET
    access_state=CASE WHEN pr_agent_harness.github_provider_access_restrictions.access_state='revoked'
      THEN 'revoked' ELSE EXCLUDED.access_state END,
    reason=EXCLUDED.reason,delivery_id=EXCLUDED.delivery_id,
    restricted_epoch=EXCLUDED.restricted_epoch,resolved_epoch=NULL,resolved_by_snapshot_epoch=NULL,
    version=pr_agent_harness.github_provider_access_restrictions.version+1,updated_at=clock_timestamp();
  WITH fenced AS (
    UPDATE pr_agent_harness.integration_bindings b SET
      provider_access_state=CASE WHEN b.provider_access_state='revoked' THEN 'revoked' ELSE requested_state END,
      provider_access_version=b.provider_access_version+1,
      provider_access_checked_at=clock_timestamp(),provider_access_reason=requested_reason,
      updated_at=clock_timestamp()
    WHERE b.platform='github' AND b.origin='https://api.github.com'
      AND b.credential_ref='github-app:'||requested_installation_id::text
      AND (b.github_app_id IS NULL OR b.github_app_id=requested_app_id)
      AND (cardinality(COALESCE(requested_repository_ids,ARRAY[]::bigint[]))=0
        OR b.provider_repository_id::bigint=ANY(requested_repository_ids))
    RETURNING b.tenant_id,b.id
  ), audited AS (
    INSERT INTO pr_agent_harness.audit_logs
      (tenant_id,actor_type,actor_id,action,decision,resource_type,resource_ref,details_json)
    SELECT tenant_id,'service','github-webhook:'||requested_app_id::text,
      'github.provider_access.invalidate','allowed','integration_binding',id::text,
      jsonb_build_object('deliveryId',requested_delivery_id,'epoch',next_epoch,'reason',requested_reason)
    FROM fenced RETURNING 1
  ) SELECT count(*)::integer INTO changed FROM audited;
  RETURN QUERY SELECT true,next_epoch,changed;
END $$;

CREATE FUNCTION pr_agent_harness.github_installation_sync_claim(
  requested_app_id bigint,requested_owner text,requested_lease_seconds integer)
RETURNS TABLE(github_app_id bigint,installation_id bigint,github_account_id bigint,
  claim_epoch bigint,lease_epoch bigint,lease_expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pr_agent_harness AS $$
BEGIN
  IF requested_app_id IS NULL OR requested_app_id<=0
     OR length(btrim(COALESCE(requested_owner,''))) NOT BETWEEN 1 AND 200
     OR requested_lease_seconds NOT BETWEEN 5 AND 300 THEN
    RAISE EXCEPTION 'invalid GitHub installation sync lease' USING ERRCODE='22023';
  END IF;
  RETURN QUERY WITH candidate AS (
    SELECT s.github_app_id,s.installation_id FROM pr_agent_harness.github_installation_sync_state s
    WHERE s.github_app_id=requested_app_id
      AND ((s.status IN ('pending','retry') AND (s.retry_at IS NULL OR s.retry_at<=clock_timestamp()))
      OR (s.status='applying' AND s.lease_expires_at<=clock_timestamp()))
    ORDER BY s.updated_at,s.github_app_id,s.installation_id FOR UPDATE SKIP LOCKED LIMIT 1
  ), claimed AS (
    UPDATE pr_agent_harness.github_installation_sync_state s SET status='applying',
      lease_owner=requested_owner,lease_expires_at=clock_timestamp()+make_interval(secs=>requested_lease_seconds),
      lease_epoch=s.lease_epoch+1,claim_epoch=s.requested_epoch,attempt_count=s.attempt_count+1,
      snapshot_hash=NULL,snapshot_completed_at=NULL,updated_at=clock_timestamp()
    FROM candidate c WHERE s.github_app_id=c.github_app_id AND s.installation_id=c.installation_id
    RETURNING s.*
  ) SELECT c.github_app_id,c.installation_id,c.github_account_id,c.claim_epoch,c.lease_epoch,c.lease_expires_at
    FROM claimed c;
END $$;

CREATE FUNCTION pr_agent_harness.github_installation_sync_renew(
  requested_app_id bigint,requested_installation_id bigint,requested_owner text,
  requested_lease_epoch bigint,requested_claim_epoch bigint,requested_lease_seconds integer
) RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pr_agent_harness AS $$
DECLARE renewed_until timestamptz;
BEGIN
  IF requested_lease_seconds NOT BETWEEN 5 AND 300 THEN
    RAISE EXCEPTION 'invalid GitHub installation sync lease' USING ERRCODE='22023'; END IF;
  UPDATE pr_agent_harness.github_installation_sync_state SET
    lease_expires_at=clock_timestamp()+make_interval(secs=>requested_lease_seconds),
    updated_at=clock_timestamp()
  WHERE github_app_id=requested_app_id AND installation_id=requested_installation_id
    AND status='applying' AND lease_owner=requested_owner AND lease_epoch=requested_lease_epoch
    AND claim_epoch=requested_claim_epoch AND requested_epoch=requested_claim_epoch
    AND lease_expires_at>clock_timestamp()
  RETURNING lease_expires_at INTO renewed_until;
  IF renewed_until IS NULL THEN
    RAISE EXCEPTION 'stale GitHub snapshot lease or epoch' USING ERRCODE='40001'; END IF;
  RETURN renewed_until;
END $$;

CREATE FUNCTION pr_agent_harness.github_installation_sync_known(requested_app_id bigint)
RETURNS TABLE(installation_id bigint,github_account_id bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pr_agent_harness AS $$
BEGIN
  IF requested_app_id IS NULL OR requested_app_id<=0 THEN
    RAISE EXCEPTION 'invalid GitHub App identity' USING ERRCODE='22023'; END IF;
  RETURN QUERY SELECT s.installation_id,s.github_account_id
  FROM pr_agent_harness.github_installation_sync_state s
  WHERE s.github_app_id=requested_app_id
    AND NOT (s.status='idle' AND s.applied_epoch=s.requested_epoch
      AND EXISTS (SELECT 1 FROM pr_agent_harness.github_provider_access_restrictions r
        WHERE r.github_app_id=s.github_app_id AND r.installation_id=s.installation_id
          AND r.repository_id=0 AND r.reason='provider_snapshot_deleted'
          AND r.resolved_epoch IS NULL AND r.restricted_epoch=s.applied_epoch))
  ORDER BY s.installation_id;
END $$;

CREATE FUNCTION pr_agent_harness.github_installation_sync_fail(
  requested_app_id bigint,requested_installation_id bigint,requested_owner text,
  requested_lease_epoch bigint,requested_claim_epoch bigint,requested_error_code text,requested_retry_at timestamptz
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pr_agent_harness AS $$
DECLARE changed integer;
BEGIN
  IF length(btrim(COALESCE(requested_error_code,''))) NOT BETWEEN 1 AND 200
     OR requested_retry_at IS NULL THEN RAISE EXCEPTION 'invalid sync failure' USING ERRCODE='22023'; END IF;
  UPDATE pr_agent_harness.github_installation_sync_state SET status='retry',retry_at=requested_retry_at,
    last_error_code=requested_error_code,lease_owner=NULL,lease_expires_at=NULL,claim_epoch=NULL,
    snapshot_hash=NULL,snapshot_completed_at=NULL,updated_at=clock_timestamp()
  WHERE github_app_id=requested_app_id AND installation_id=requested_installation_id
    AND lease_owner=requested_owner AND lease_epoch=requested_lease_epoch
    AND claim_epoch=requested_claim_epoch AND requested_epoch=requested_claim_epoch
    AND lease_expires_at>clock_timestamp();
  GET DIAGNOSTICS changed=ROW_COUNT; RETURN changed=1;
END $$;

CREATE FUNCTION pr_agent_harness.github_installation_snapshot_begin(
  requested_app_id bigint,requested_installation_id bigint,requested_owner text,
  requested_lease_epoch bigint,requested_claim_epoch bigint,requested_account_id bigint,
  requested_actor_id bigint,requested_snapshot_hash text,requested_completed_at timestamptz,
  requested_repository_ids bigint[]
) RETURNS TABLE(tenant_id uuid,mapping_source text,status text,known_repository_ids bigint[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pr_agent_harness AS $$
DECLARE mapped pr_agent_harness.github_account_tenant_mappings%ROWTYPE;
DECLARE tenants uuid[]; DECLARE chosen uuid; DECLARE source text; DECLARE calculated_hash text;
BEGIN
  IF requested_account_id IS NULL OR requested_account_id<=0 OR requested_actor_id IS NULL
     OR requested_actor_id<=0 OR requested_snapshot_hash !~ '^[0-9a-f]{64}$'
     OR requested_completed_at IS NULL OR requested_repository_ids IS NULL
     OR cardinality(requested_repository_ids)>10000
     OR EXISTS (SELECT 1 FROM unnest(requested_repository_ids) id WHERE id IS NULL OR id<=0)
     OR (SELECT count(*) FROM unnest(requested_repository_ids) id)
       <> (SELECT count(DISTINCT id) FROM unnest(requested_repository_ids) id) THEN
    RAISE EXCEPTION 'invalid complete GitHub snapshot' USING ERRCODE='22023';
  END IF;
  SELECT encode(public.digest(COALESCE(string_agg(id::text,',' ORDER BY id),''),'sha256'),'hex')
    INTO calculated_hash FROM unnest(requested_repository_ids) id;
  IF calculated_hash<>requested_snapshot_hash THEN
    RAISE EXCEPTION 'GitHub snapshot hash mismatch' USING ERRCODE='22023'; END IF;
  PERFORM 1 FROM pr_agent_harness.github_installation_sync_state s
  WHERE s.github_app_id=requested_app_id AND s.installation_id=requested_installation_id
    AND s.status='applying' AND s.lease_owner=requested_owner AND s.lease_epoch=requested_lease_epoch
    AND s.claim_epoch=requested_claim_epoch AND s.requested_epoch=requested_claim_epoch
    AND (s.github_account_id IS NULL OR s.github_account_id=requested_account_id)
    AND s.lease_expires_at>clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'stale GitHub snapshot lease or epoch' USING ERRCODE='40001'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'github-onboarding:account:'||requested_app_id::text||':'||requested_account_id::text,0));
  SELECT * INTO mapped FROM pr_agent_harness.github_account_tenant_mappings m
    WHERE m.github_app_id=requested_app_id AND m.github_account_id=requested_account_id;
  IF FOUND THEN chosen:=mapped.tenant_id; source:=mapped.mapping_source;
  ELSE
    SELECT array_agg(DISTINCT b.tenant_id ORDER BY b.tenant_id) INTO tenants
    FROM pr_agent_harness.integration_bindings b
    WHERE b.platform='github' AND b.origin='https://api.github.com' AND b.active
      AND b.provider_actor_id=requested_actor_id::text AND (
      (b.github_app_id=requested_app_id AND b.github_account_id=requested_account_id)
      OR (b.provider_repository_id::bigint=ANY(requested_repository_ids)
        AND (b.github_app_id IS NULL OR b.github_app_id=requested_app_id)
        AND (b.github_account_id IS NULL OR b.github_account_id=requested_account_id)));
    IF cardinality(COALESCE(tenants,ARRAY[]::uuid[]))>1 THEN
      INSERT INTO pr_agent_harness.audit_logs
        (tenant_id,actor_type,actor_id,action,decision,reason_code,resource_type,resource_ref,details_json)
      SELECT candidate_tenant,'service','github-installation-sync:'||requested_app_id::text,
        'github.installation.account_mapping','denied','account_tenant_ambiguity',
        'github_account',requested_account_id::text,
        jsonb_build_object('snapshotEpoch',requested_claim_epoch,
          'installationId',requested_installation_id,'candidateTenantCount',cardinality(tenants))
      FROM unnest(tenants) candidate_tenant;
      UPDATE pr_agent_harness.github_installation_sync_state SET status='conflict',
        last_conflict_count=1,last_error_code='account_tenant_ambiguity',
        lease_owner=NULL,lease_expires_at=NULL,
        claim_epoch=NULL,updated_at=clock_timestamp()
      WHERE github_app_id=requested_app_id AND installation_id=requested_installation_id;
      RETURN QUERY SELECT NULL::uuid,NULL::text,'conflict'::text,ARRAY[]::bigint[]; RETURN;
    END IF;
    chosen:=COALESCE(tenants[1],gen_random_uuid());
    source:=CASE WHEN tenants[1] IS NULL THEN 'auto_created' ELSE 'adopted_binding' END;
    INSERT INTO pr_agent_harness.github_account_tenant_mappings
      (github_app_id,github_account_id,tenant_id,mapping_source)
    VALUES (requested_app_id,requested_account_id,chosen,source);
  END IF;
  UPDATE pr_agent_harness.github_installation_sync_state SET github_account_id=requested_account_id,
    provider_actor_id=requested_actor_id,snapshot_hash=requested_snapshot_hash,
    snapshot_completed_at=requested_completed_at,last_conflict_count=0,
    last_error_code=NULL,updated_at=clock_timestamp()
  WHERE github_app_id=requested_app_id AND installation_id=requested_installation_id;
  RETURN QUERY SELECT chosen,source,'applying'::text,
    COALESCE((SELECT array_agg(b.provider_repository_id::bigint ORDER BY b.provider_repository_id::bigint)
      FROM pr_agent_harness.integration_bindings b
      WHERE b.platform='github' AND b.origin='https://api.github.com'
        AND b.github_app_id=requested_app_id
        AND b.github_account_id=requested_account_id
        AND b.credential_ref='github-app:'||requested_installation_id::text),ARRAY[]::bigint[]);
END $$;

CREATE FUNCTION pr_agent_harness.github_installation_snapshot_apply_present(
  requested_app_id bigint,requested_installation_id bigint,requested_owner text,
  requested_lease_epoch bigint,requested_claim_epoch bigint,requested_snapshot_hash text,
  requested_repositories jsonb
) RETURNS TABLE(created integer,restored integer,adopted integer,conflicted integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pr_agent_harness AS $$
DECLARE syncrow pr_agent_harness.github_installation_sync_state%ROWTYPE;
DECLARE mapped pr_agent_harness.github_account_tenant_mappings%ROWTYPE;
DECLARE item jsonb; DECLARE repo_id bigint; DECLARE repo_name text;
DECLARE existing pr_agent_harness.integration_bindings%ROWTYPE;
DECLARE existing_by_id pr_agent_harness.integration_bindings%ROWTYPE;
DECLARE existing_by_name pr_agent_harness.integration_bindings%ROWTYPE;
DECLARE id_found boolean; DECLARE name_found boolean; DECLARE new_id uuid;
DECLARE unsafe boolean; DECLARE c integer:=0; DECLARE r integer:=0; DECLARE a integer:=0; DECLARE x integer:=0;
DECLARE affected_batch uuid;
BEGIN
  IF jsonb_typeof(requested_repositories)<>'array' OR jsonb_array_length(requested_repositories) NOT BETWEEN 1 AND 64
     OR requested_snapshot_hash !~ '^[0-9a-f]{64}$'
     OR (SELECT count(*)<>count(DISTINCT value->>'id') FROM jsonb_array_elements(requested_repositories))
     OR (SELECT count(*)<>count(DISTINCT lower(value->>'fullName')) FROM jsonb_array_elements(requested_repositories)) THEN
    RAISE EXCEPTION 'invalid GitHub snapshot present batch' USING ERRCODE='22023';
  END IF;
  SELECT * INTO syncrow FROM pr_agent_harness.github_installation_sync_state s
  WHERE s.github_app_id=requested_app_id AND s.installation_id=requested_installation_id
    AND s.status='applying' AND s.lease_owner=requested_owner AND s.lease_epoch=requested_lease_epoch
    AND s.claim_epoch=requested_claim_epoch AND s.requested_epoch=requested_claim_epoch
    AND s.snapshot_hash=requested_snapshot_hash AND s.lease_expires_at>clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'stale GitHub snapshot lease or epoch' USING ERRCODE='40001'; END IF;
  SELECT * INTO mapped FROM pr_agent_harness.github_account_tenant_mappings m
    WHERE m.github_app_id=requested_app_id AND m.github_account_id=syncrow.github_account_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'GitHub account mapping unavailable' USING ERRCODE='55000'; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(requested_repositories) LOOP
    BEGIN repo_id:=(item->>'id')::bigint; EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'invalid repository identity' USING ERRCODE='22023'; END;
    repo_name:=lower(item->>'fullName');
    IF repo_id<=0 OR repo_name !~ '^[a-z0-9_.-]+/[a-z0-9_.-]+$' THEN
      RAISE EXCEPTION 'invalid repository snapshot item' USING ERRCODE='22023'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'github-onboarding:identity:'||requested_app_id::text||':'||repo_id::text,0));
    PERFORM b.id FROM pr_agent_harness.integration_bindings b
    WHERE b.platform='github' AND b.origin='https://api.github.com'
      AND (b.provider_repository_id=repo_id::text OR b.repository=repo_name)
    ORDER BY b.id FOR UPDATE;
    SELECT b.* INTO existing_by_id FROM pr_agent_harness.integration_bindings b
    WHERE b.platform='github' AND b.origin='https://api.github.com'
      AND b.provider_repository_id=repo_id::text;
    id_found:=FOUND;
    SELECT b.* INTO existing_by_name FROM pr_agent_harness.integration_bindings b
    WHERE b.platform='github' AND b.origin='https://api.github.com' AND b.repository=repo_name;
    name_found:=FOUND;
    IF id_found AND name_found AND existing_by_id.id<>existing_by_name.id THEN
      x:=x+1;
      INSERT INTO pr_agent_harness.audit_logs
        (tenant_id,actor_type,actor_id,action,decision,reason_code,resource_type,resource_ref,details_json)
      VALUES (mapped.tenant_id,'service','github-installation-sync:'||requested_app_id::text,
        'github.installation.repository_conflict','denied','repository_identity_collision',
        'integration_binding',existing_by_id.id::text,
        jsonb_build_object('repositoryId',repo_id,'repository',repo_name,
          'snapshotEpoch',requested_claim_epoch,'nameBindingId',existing_by_name.id));
      CONTINUE;
    ELSIF id_found THEN existing:=existing_by_id;
    ELSIF name_found THEN existing:=existing_by_name;
    END IF;
    IF (id_found OR name_found) AND existing.tenant_id<>mapped.tenant_id THEN
      x:=x+1;
      INSERT INTO pr_agent_harness.audit_logs
        (tenant_id,actor_type,actor_id,action,decision,reason_code,resource_type,resource_ref,details_json)
      VALUES (mapped.tenant_id,'service','github-installation-sync:'||requested_app_id::text,
        'github.installation.repository_conflict','denied','tenant_conflict','integration_binding',existing.id::text,
        jsonb_build_object('repositoryId',repo_id,'snapshotEpoch',requested_claim_epoch));
      CONTINUE;
    END IF;
    IF NOT id_found AND NOT name_found THEN
      new_id:=gen_random_uuid();
      INSERT INTO pr_agent_harness.integration_bindings
        (id,tenant_id,platform,origin,repository,provider_repository_id,provider_actor_id,
         credential_ref,publication_state,publication_generation,authority_version,quiescence_receipt,
         review_execution_mode,execution_mode_generation,review_execution_state,github_app_id,
         github_account_id,provider_access_state,provider_access_version,provider_access_checked_at)
      VALUES (new_id,mapped.tenant_id,'github','https://api.github.com',repo_name,repo_id::text,
        syncrow.provider_actor_id::text,'github-app:'||requested_installation_id::text,
        'active',1,2,jsonb_build_object('actor','github-installation-sync:'||requested_app_id::text,
          'protocol','github_installation_snapshot_v1','snapshotEpoch',requested_claim_epoch,
          'snapshotHash',requested_snapshot_hash,'installationId',requested_installation_id,
          'accountId',syncrow.github_account_id,'repositoryId',repo_id,
          'completedAt',syncrow.snapshot_completed_at),
        'harness_async',1,'active',requested_app_id,syncrow.github_account_id,'verified',0,clock_timestamp());
      c:=c+1;
      INSERT INTO pr_agent_harness.audit_logs
        (tenant_id,actor_type,actor_id,action,decision,resource_type,resource_ref,details_json)
      VALUES (mapped.tenant_id,'service','github-installation-sync:'||requested_app_id::text,
        'github.installation.enroll','allowed','integration_binding',new_id::text,
        jsonb_build_object('snapshotEpoch',requested_claim_epoch,'snapshotHash',requested_snapshot_hash,
          'repositoryId',repo_id,'installationId',requested_installation_id));
    ELSE
      IF (existing.github_app_id IS NOT NULL AND existing.github_app_id<>requested_app_id)
         OR (existing.github_account_id IS NOT NULL AND existing.github_account_id<>syncrow.github_account_id)
         OR (existing.provider_repository_id IS NOT NULL AND existing.provider_repository_id<>repo_id::text)
         OR (existing.provider_actor_id IS NOT NULL AND existing.provider_actor_id<>syncrow.provider_actor_id::text)
         OR (existing.credential_ref IS NOT NULL AND existing.credential_ref<>('github-app:'||requested_installation_id::text)
           AND (existing.github_account_id IS NULL OR existing.github_account_id<>syncrow.github_account_id)) THEN
        x:=x+1;
        INSERT INTO pr_agent_harness.audit_logs
          (tenant_id,actor_type,actor_id,action,decision,reason_code,resource_type,resource_ref,details_json)
        VALUES (mapped.tenant_id,'service','github-installation-sync:'||requested_app_id::text,
          'github.installation.repository_conflict','denied','provider_identity_conflict',
          'integration_binding',existing.id::text,
          jsonb_build_object('repositoryId',repo_id,'snapshotEpoch',requested_claim_epoch,
            'installationId',requested_installation_id,'accountId',syncrow.github_account_id));
        CONTINUE;
      END IF;
      SELECT EXISTS (SELECT 1 FROM pr_agent_harness.repository_operations o
        WHERE o.tenant_id=existing.tenant_id AND o.integration_id=existing.id
          AND (o.status IN ('in_flight','unknown','manual_review')
            OR (o.status='prepared' AND (o.attempt_count<>0 OR o.dispatched_at IS NOT NULL)))) INTO unsafe;
      IF unsafe AND existing.provider_access_state<>'verified' THEN
        x:=x+1;
        INSERT INTO pr_agent_harness.audit_logs
          (tenant_id,actor_type,actor_id,action,decision,reason_code,resource_type,resource_ref,details_json)
        VALUES (mapped.tenant_id,'service','github-installation-sync:'||requested_app_id::text,
          'github.installation.restore','denied','unresolved_publication_operations',
          'integration_binding',existing.id::text,jsonb_build_object('snapshotEpoch',requested_claim_epoch));
        CONTINUE;
      END IF;
      IF existing.provider_access_state<>'verified' THEN
        UPDATE pr_agent_harness.repository_operations o SET status='cancelled',outcome_code='no_effect',
          remote_id=NULL,last_error_code='provider_revalidation_before_dispatch',resolved_at=clock_timestamp(),
          next_reconcile_at=NULL,reconcile_claim_owner=NULL,reconcile_claim_expires_at=NULL,
          version=version+1,updated_at=clock_timestamp()
        WHERE o.tenant_id=existing.tenant_id AND o.integration_id=existing.id
          AND o.status='prepared' AND o.attempt_count=0 AND o.dispatched_at IS NULL;
        FOR affected_batch IN SELECT DISTINCT pbo.batch_id
          FROM pr_agent_harness.publication_batch_operations pbo
          JOIN pr_agent_harness.repository_operations o ON o.tenant_id=pbo.tenant_id
            AND o.business_operation_id=pbo.business_operation_id
          WHERE o.tenant_id=existing.tenant_id AND o.integration_id=existing.id AND o.status='cancelled'
            AND o.last_error_code='provider_revalidation_before_dispatch'
        LOOP PERFORM pr_agent_harness.skip_failed_batch_successors(existing.tenant_id,affected_batch); END LOOP;
      END IF;
      UPDATE pr_agent_harness.integration_bindings SET repository=repo_name,
        provider_repository_id=repo_id::text,provider_actor_id=syncrow.provider_actor_id::text,
        credential_ref='github-app:'||requested_installation_id::text,github_app_id=requested_app_id,
        github_account_id=syncrow.github_account_id,provider_access_state='verified',
        provider_access_version=provider_access_version+CASE WHEN provider_access_state='verified' THEN 0 ELSE 1 END,
        provider_access_checked_at=clock_timestamp(),provider_access_reason=NULL,
        publication_generation=publication_generation+CASE
          WHEN provider_access_state<>'verified' AND publication_generation>0 THEN 1 ELSE 0 END,
        updated_at=clock_timestamp() WHERE id=existing.id;
      IF existing.github_app_id IS NULL OR existing.github_account_id IS NULL THEN a:=a+1;
      ELSIF existing.provider_access_state<>'verified' THEN r:=r+1; END IF;
      INSERT INTO pr_agent_harness.audit_logs
        (tenant_id,actor_type,actor_id,action,decision,resource_type,resource_ref,details_json)
      VALUES (mapped.tenant_id,'service','github-installation-sync:'||requested_app_id::text,
        CASE WHEN existing.provider_access_state<>'verified' THEN 'github.installation.restore'
          ELSE 'github.installation.adopt' END,'allowed','integration_binding',existing.id::text,
        jsonb_build_object('snapshotEpoch',requested_claim_epoch,'snapshotHash',requested_snapshot_hash,
          'repositoryId',repo_id,'installationId',requested_installation_id,
          'accountId',syncrow.github_account_id,'providerActorId',syncrow.provider_actor_id,
          'completedAt',syncrow.snapshot_completed_at));
    END IF;
    UPDATE pr_agent_harness.github_provider_access_restrictions SET resolved_epoch=requested_claim_epoch,
      resolved_by_snapshot_epoch=requested_claim_epoch,updated_at=clock_timestamp()
    WHERE github_app_id=requested_app_id AND installation_id=requested_installation_id
      AND repository_id=repo_id AND restricted_epoch<=requested_claim_epoch;
  END LOOP;
  UPDATE pr_agent_harness.github_installation_sync_state SET
    last_conflict_count=last_conflict_count+x,updated_at=clock_timestamp()
  WHERE github_app_id=requested_app_id AND installation_id=requested_installation_id
    AND status='applying' AND lease_owner=requested_owner AND lease_epoch=requested_lease_epoch
    AND claim_epoch=requested_claim_epoch AND requested_epoch=requested_claim_epoch
    AND snapshot_hash=requested_snapshot_hash AND lease_expires_at>clock_timestamp();
  RETURN QUERY SELECT c,r,a,x;
END $$;

CREATE FUNCTION pr_agent_harness.github_installation_snapshot_absence_candidates(
  requested_app_id bigint,requested_installation_id bigint,requested_owner text,
  requested_lease_epoch bigint,requested_claim_epoch bigint,requested_snapshot_hash text,
  requested_present_ids bigint[]
) RETURNS SETOF bigint LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pr_agent_harness AS $$
DECLARE syncrow pr_agent_harness.github_installation_sync_state%ROWTYPE;
BEGIN
  SELECT * INTO syncrow FROM pr_agent_harness.github_installation_sync_state s
  WHERE s.github_app_id=requested_app_id AND s.installation_id=requested_installation_id
    AND s.status='applying' AND s.lease_owner=requested_owner AND s.lease_epoch=requested_lease_epoch
    AND s.claim_epoch=requested_claim_epoch AND s.requested_epoch=requested_claim_epoch
    AND s.snapshot_hash=requested_snapshot_hash AND s.lease_expires_at>clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'stale GitHub snapshot lease or epoch' USING ERRCODE='40001'; END IF;
  RETURN QUERY SELECT b.provider_repository_id::bigint
  FROM pr_agent_harness.integration_bindings b
  WHERE b.platform='github' AND b.origin='https://api.github.com'
    AND b.github_app_id=requested_app_id
    AND b.github_account_id=syncrow.github_account_id
    AND b.credential_ref='github-app:'||requested_installation_id::text
    AND NOT (b.provider_repository_id::bigint=ANY(requested_present_ids))
    AND b.provider_access_state<>'revoked'
  ORDER BY b.provider_repository_id::bigint LIMIT 64;
END $$;

CREATE FUNCTION pr_agent_harness.github_installation_snapshot_apply_absent(
  requested_app_id bigint,requested_installation_id bigint,requested_owner text,
  requested_lease_epoch bigint,requested_claim_epoch bigint,requested_snapshot_hash text,
  requested_present_ids bigint[],requested_candidate_ids bigint[]
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pr_agent_harness AS $$
DECLARE syncrow pr_agent_harness.github_installation_sync_state%ROWTYPE; DECLARE changed integer;
DECLARE calculated text;
BEGIN
  IF cardinality(requested_candidate_ids) NOT BETWEEN 1 AND 64
     OR EXISTS (SELECT 1 FROM unnest(requested_candidate_ids) id WHERE id=ANY(requested_present_ids)) THEN
    RAISE EXCEPTION 'invalid GitHub snapshot absence batch' USING ERRCODE='22023'; END IF;
  SELECT encode(public.digest(COALESCE(string_agg(id::text,',' ORDER BY id),''),'sha256'),'hex')
    INTO calculated FROM unnest(requested_present_ids) id;
  IF calculated<>requested_snapshot_hash THEN
    RAISE EXCEPTION 'GitHub snapshot hash mismatch' USING ERRCODE='22023'; END IF;
  SELECT * INTO syncrow FROM pr_agent_harness.github_installation_sync_state s
  WHERE s.github_app_id=requested_app_id AND s.installation_id=requested_installation_id
    AND s.status='applying' AND s.lease_owner=requested_owner AND s.lease_epoch=requested_lease_epoch
    AND s.claim_epoch=requested_claim_epoch AND s.requested_epoch=requested_claim_epoch
    AND s.snapshot_hash=requested_snapshot_hash AND s.lease_expires_at>clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'stale GitHub snapshot lease or epoch' USING ERRCODE='40001'; END IF;
  WITH revoked AS (
    UPDATE pr_agent_harness.integration_bindings b SET provider_access_state='revoked',
      provider_access_version=b.provider_access_version+1,provider_access_checked_at=clock_timestamp(),
      provider_access_reason='repository absent from complete installation snapshot',updated_at=clock_timestamp()
    WHERE b.platform='github' AND b.origin='https://api.github.com'
      AND b.github_app_id=requested_app_id
      AND b.github_account_id=syncrow.github_account_id
      AND b.credential_ref='github-app:'||requested_installation_id::text
      AND b.provider_repository_id::bigint=ANY(requested_candidate_ids)
      AND NOT (b.provider_repository_id::bigint=ANY(requested_present_ids))
      AND b.provider_access_state<>'revoked' RETURNING b.tenant_id,b.id,b.provider_repository_id::bigint repository_id
  ), restrictions AS (
    INSERT INTO pr_agent_harness.github_provider_access_restrictions
      (github_app_id,installation_id,repository_id,access_state,reason,delivery_id,restricted_epoch)
    SELECT requested_app_id,requested_installation_id,repository_id,'revoked',
      'repository absent from complete installation snapshot','snapshot:'||requested_claim_epoch::text,
      requested_claim_epoch FROM revoked
    ON CONFLICT (github_app_id,installation_id,repository_id) DO UPDATE SET access_state='revoked',
      reason=EXCLUDED.reason,delivery_id=EXCLUDED.delivery_id,restricted_epoch=EXCLUDED.restricted_epoch,
      resolved_epoch=NULL,resolved_by_snapshot_epoch=NULL,
      version=pr_agent_harness.github_provider_access_restrictions.version+1,updated_at=clock_timestamp()
    RETURNING repository_id
  ), audited AS (
    INSERT INTO pr_agent_harness.audit_logs
      (tenant_id,actor_type,actor_id,action,decision,resource_type,resource_ref,details_json)
    SELECT tenant_id,'service','github-installation-sync:'||requested_app_id::text,
      'github.installation.absence_revoke','allowed','integration_binding',id::text,
      jsonb_build_object('snapshotEpoch',requested_claim_epoch,'snapshotHash',requested_snapshot_hash,
        'repositoryId',repository_id,'installationId',requested_installation_id)
    FROM revoked RETURNING 1
  ) SELECT count(*)::integer INTO changed FROM restrictions;
  RETURN changed;
END $$;

CREATE FUNCTION pr_agent_harness.github_installation_snapshot_complete(
  requested_app_id bigint,requested_installation_id bigint,requested_owner text,
  requested_lease_epoch bigint,requested_claim_epoch bigint,requested_snapshot_hash text,
  requested_present_ids bigint[]
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pr_agent_harness AS $$
DECLARE calculated text; DECLARE changed integer; DECLARE syncrow pr_agent_harness.github_installation_sync_state%ROWTYPE;
BEGIN
  SELECT encode(public.digest(COALESCE(string_agg(id::text,',' ORDER BY id),''),'sha256'),'hex')
    INTO calculated FROM unnest(requested_present_ids) id;
  IF calculated<>requested_snapshot_hash THEN RAISE EXCEPTION 'GitHub snapshot hash mismatch' USING ERRCODE='22023'; END IF;
  SELECT * INTO syncrow FROM pr_agent_harness.github_installation_sync_state s
  WHERE s.github_app_id=requested_app_id AND s.installation_id=requested_installation_id
    AND s.status='applying' AND s.lease_owner=requested_owner AND s.lease_epoch=requested_lease_epoch
    AND s.claim_epoch=requested_claim_epoch AND s.requested_epoch=requested_claim_epoch
    AND s.snapshot_hash=requested_snapshot_hash AND s.lease_expires_at>clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'stale GitHub snapshot lease or epoch' USING ERRCODE='40001'; END IF;
  IF EXISTS (SELECT 1 FROM pr_agent_harness.integration_bindings b
    WHERE b.platform='github' AND b.origin='https://api.github.com'
      AND b.github_app_id=requested_app_id
      AND b.github_account_id=syncrow.github_account_id
      AND b.credential_ref='github-app:'||requested_installation_id::text
      AND NOT (b.provider_repository_id::bigint=ANY(requested_present_ids))
      AND b.provider_access_state<>'revoked') THEN
    RAISE EXCEPTION 'GitHub snapshot absence sweep is incomplete' USING ERRCODE='55000'; END IF;
  UPDATE pr_agent_harness.github_provider_access_restrictions SET resolved_epoch=requested_claim_epoch,
    resolved_by_snapshot_epoch=requested_claim_epoch,updated_at=clock_timestamp()
  WHERE github_app_id=requested_app_id AND installation_id=requested_installation_id
    AND repository_id=0 AND restricted_epoch<=requested_claim_epoch;
  UPDATE pr_agent_harness.github_installation_sync_state SET applied_epoch=requested_claim_epoch,
    status=CASE WHEN last_conflict_count>0 THEN 'conflict' ELSE 'idle' END,
    last_complete_snapshot_at=snapshot_completed_at,
    last_error_code=CASE WHEN last_conflict_count>0 THEN 'repository_conflict' ELSE NULL END,
    lease_owner=NULL,lease_expires_at=NULL,claim_epoch=NULL,snapshot_hash=NULL,
    snapshot_completed_at=NULL,updated_at=clock_timestamp()
  WHERE github_app_id=requested_app_id AND installation_id=requested_installation_id
    AND status='applying' AND lease_owner=requested_owner AND lease_epoch=requested_lease_epoch
    AND claim_epoch=requested_claim_epoch AND requested_epoch=requested_claim_epoch
    AND snapshot_hash=requested_snapshot_hash AND lease_expires_at>clock_timestamp();
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed<>1 THEN RAISE EXCEPTION 'stale GitHub snapshot lease or epoch' USING ERRCODE='40001'; END IF;
  RETURN true;
END $$;

CREATE FUNCTION pr_agent_harness.github_installation_snapshot_complete_restricted(
  requested_app_id bigint,requested_installation_id bigint,requested_owner text,
  requested_lease_epoch bigint,requested_claim_epoch bigint,requested_state text,requested_reason text,
  requested_completed_at timestamptz
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pr_agent_harness AS $$
DECLARE changed integer;
BEGIN
  IF requested_state NOT IN ('revoked','unknown')
     OR length(btrim(COALESCE(requested_reason,''))) NOT BETWEEN 1 AND 200
     OR requested_completed_at IS NULL THEN
    RAISE EXCEPTION 'invalid restricted GitHub snapshot' USING ERRCODE='22023'; END IF;
  PERFORM 1 FROM pr_agent_harness.github_installation_sync_state s
  WHERE s.github_app_id=requested_app_id AND s.installation_id=requested_installation_id
    AND s.status='applying' AND s.lease_owner=requested_owner AND s.lease_epoch=requested_lease_epoch
    AND s.claim_epoch=requested_claim_epoch AND s.requested_epoch=requested_claim_epoch
    AND s.lease_expires_at>clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'stale GitHub snapshot lease or epoch' USING ERRCODE='40001'; END IF;
  INSERT INTO pr_agent_harness.github_provider_access_restrictions
    (github_app_id,installation_id,repository_id,access_state,reason,delivery_id,restricted_epoch)
  VALUES (requested_app_id,requested_installation_id,0,requested_state,requested_reason,
    'snapshot:'||requested_claim_epoch::text,requested_claim_epoch)
  ON CONFLICT (github_app_id,installation_id,repository_id) DO UPDATE SET
    access_state=CASE WHEN pr_agent_harness.github_provider_access_restrictions.access_state='revoked'
      THEN 'revoked' ELSE EXCLUDED.access_state END,
    reason=EXCLUDED.reason,delivery_id=EXCLUDED.delivery_id,restricted_epoch=EXCLUDED.restricted_epoch,
    resolved_epoch=NULL,resolved_by_snapshot_epoch=NULL,
    version=pr_agent_harness.github_provider_access_restrictions.version+1,updated_at=clock_timestamp();
  WITH fenced AS (
    UPDATE pr_agent_harness.integration_bindings b SET
      provider_access_state=CASE WHEN b.provider_access_state='revoked' THEN 'revoked' ELSE requested_state END,
      provider_access_version=b.provider_access_version+1,provider_access_checked_at=clock_timestamp(),
      provider_access_reason=requested_reason,updated_at=clock_timestamp()
    WHERE b.platform='github' AND b.origin='https://api.github.com'
      AND b.credential_ref='github-app:'||requested_installation_id::text
      AND (b.github_app_id IS NULL OR b.github_app_id=requested_app_id)
    RETURNING b.tenant_id,b.id
  ), audited AS (
    INSERT INTO pr_agent_harness.audit_logs
      (tenant_id,actor_type,actor_id,action,decision,resource_type,resource_ref,details_json)
    SELECT tenant_id,'service','github-installation-sync:'||requested_app_id::text,
      'github.installation.snapshot_restricted','allowed','integration_binding',id::text,
      jsonb_build_object('snapshotEpoch',requested_claim_epoch,'state',requested_state,
        'reason',requested_reason,'completedAt',requested_completed_at)
    FROM fenced RETURNING 1
  ) SELECT count(*)::integer INTO changed FROM audited;
  UPDATE pr_agent_harness.github_installation_sync_state SET restrictive_epoch=requested_claim_epoch,
    applied_epoch=requested_claim_epoch,status='idle',last_complete_snapshot_at=requested_completed_at,
    last_error_code=NULL,lease_owner=NULL,lease_expires_at=NULL,claim_epoch=NULL,
    snapshot_hash=NULL,snapshot_completed_at=NULL,updated_at=clock_timestamp()
  WHERE github_app_id=requested_app_id AND installation_id=requested_installation_id;
  RETURN changed;
END $$;

CREATE FUNCTION pr_agent_harness.github_deferred_pull_request_admit(
  requested_app_id bigint,requested_installation_id bigint,requested_account_id bigint,
  requested_repository_id bigint,requested_repository text,requested_pull_number integer,
  requested_action text,requested_delivery_id text,requested_source_hash text
) RETURNS TABLE(outcome text,id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pr_agent_harness AS $$
DECLARE deferred_id uuid; DECLARE was_inserted boolean;
DECLARE existing pr_agent_harness.integration_bindings%ROWTYPE;
BEGIN
  IF requested_app_id<=0 OR requested_installation_id<=0 OR requested_account_id<=0
     OR requested_repository_id<=0 OR requested_repository !~ '^[a-z0-9_.-]+/[a-z0-9_.-]+$'
     OR requested_pull_number<=0 OR requested_action NOT IN ('opened','edited','synchronize','reopened','closed')
     OR length(requested_delivery_id) NOT BETWEEN 1 AND 200 OR requested_source_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid deferred GitHub pull request' USING ERRCODE='22023'; END IF;
  IF EXISTS (SELECT 1 FROM pr_agent_harness.github_installation_sync_state s
    WHERE s.github_app_id=requested_app_id AND s.installation_id=requested_installation_id
      AND s.github_account_id IS NOT NULL AND s.github_account_id<>requested_account_id) THEN
    RAISE EXCEPTION 'installation account identity conflict' USING ERRCODE='23505';
  END IF;
  SELECT b.* INTO existing FROM pr_agent_harness.integration_bindings b
  WHERE b.platform='github' AND b.origin='https://api.github.com'
    AND (b.provider_repository_id=requested_repository_id::text OR b.repository=requested_repository)
  ORDER BY (b.provider_repository_id=requested_repository_id::text) DESC LIMIT 1 FOR SHARE;
  IF FOUND THEN
    IF (existing.provider_repository_id IS NOT NULL AND existing.provider_repository_id<>requested_repository_id::text)
       OR (existing.github_app_id IS NOT NULL AND existing.github_app_id<>requested_app_id)
       OR (existing.github_account_id IS NOT NULL AND existing.github_account_id<>requested_account_id)
       OR (existing.credential_ref IS NOT NULL
         AND existing.credential_ref<>'github-app:'||requested_installation_id::text) THEN
      RAISE EXCEPTION 'deferred GitHub pull request conflicts with binding identity' USING ERRCODE='23505';
    END IF;
    IF NOT existing.active OR existing.publication_state<>'active'
       OR existing.review_execution_mode<>'harness_async'
       OR existing.review_execution_state<>'active' THEN
      RETURN QUERY SELECT 'suppressed'::text,NULL::uuid; RETURN;
    END IF;
  END IF;
  INSERT INTO pr_agent_harness.github_deferred_pull_requests
    (github_app_id,delivery_id,installation_id,github_account_id,repository_id,repository,
     pull_number,action,source_hash)
  VALUES (requested_app_id,requested_delivery_id,requested_installation_id,requested_account_id,
    requested_repository_id,requested_repository,requested_pull_number,requested_action,requested_source_hash)
  ON CONFLICT (github_app_id,delivery_id) DO NOTHING RETURNING github_deferred_pull_requests.id INTO deferred_id;
  was_inserted:=FOUND;
  IF NOT was_inserted THEN
    SELECT d.id INTO deferred_id FROM pr_agent_harness.github_deferred_pull_requests d
      WHERE d.github_app_id=requested_app_id AND d.delivery_id=requested_delivery_id
        AND d.source_hash=requested_source_hash;
    IF NOT FOUND THEN RAISE EXCEPTION 'GitHub delivery source hash conflict' USING ERRCODE='23505'; END IF;
  ELSE
    INSERT INTO pr_agent_harness.github_installation_sync_state
      (github_app_id,installation_id,github_account_id,requested_epoch,status)
    VALUES (requested_app_id,requested_installation_id,requested_account_id,1,'pending')
    ON CONFLICT (github_app_id,installation_id) DO UPDATE SET
      requested_epoch=pr_agent_harness.github_installation_sync_state.requested_epoch
        + CASE WHEN pr_agent_harness.github_installation_sync_state.status='idle' THEN 1 ELSE 0 END,
      github_account_id=COALESCE(pr_agent_harness.github_installation_sync_state.github_account_id,
        EXCLUDED.github_account_id),
      status=CASE WHEN pr_agent_harness.github_installation_sync_state.status IN ('applying','conflict')
        THEN pr_agent_harness.github_installation_sync_state.status ELSE 'pending' END,
      retry_at=CASE WHEN pr_agent_harness.github_installation_sync_state.status IN ('applying','conflict')
        THEN pr_agent_harness.github_installation_sync_state.retry_at ELSE NULL END,
      requested_at=CASE WHEN pr_agent_harness.github_installation_sync_state.status='idle'
        THEN clock_timestamp() ELSE pr_agent_harness.github_installation_sync_state.requested_at END,
      updated_at=clock_timestamp();
  END IF;
  RETURN QUERY SELECT CASE WHEN was_inserted THEN 'admitted' ELSE 'duplicate' END,deferred_id;
END $$;

CREATE FUNCTION pr_agent_harness.github_deferred_pull_request_claim(
  requested_app_id bigint,requested_owner text,requested_lease_seconds integer)
RETURNS SETOF pr_agent_harness.github_deferred_pull_requests
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pr_agent_harness AS $$
BEGIN
  IF requested_app_id IS NULL OR requested_app_id<=0
     OR length(btrim(COALESCE(requested_owner,''))) NOT BETWEEN 1 AND 200
     OR requested_lease_seconds NOT BETWEEN 5 AND 300 THEN
    RAISE EXCEPTION 'invalid deferred PR lease' USING ERRCODE='22023'; END IF;
  RETURN QUERY WITH candidate AS (
    SELECT d.id FROM pr_agent_harness.github_deferred_pull_requests d
    WHERE d.github_app_id=requested_app_id
      AND ((d.status IN ('pending','retry') AND (d.retry_at IS NULL OR d.retry_at<=clock_timestamp()))
      OR (d.status='leased' AND d.lease_expires_at<=clock_timestamp()))
      AND d.expires_at>clock_timestamp()
    ORDER BY d.received_at,d.id FOR UPDATE SKIP LOCKED LIMIT 1
  ), claimed AS (
    UPDATE pr_agent_harness.github_deferred_pull_requests d SET status='leased',lease_owner=requested_owner,
      lease_expires_at=clock_timestamp()+make_interval(secs=>requested_lease_seconds),
      lease_epoch=d.lease_epoch+1,attempt_count=d.attempt_count+1,updated_at=clock_timestamp()
    FROM candidate c WHERE d.id=c.id RETURNING d.*
  ) SELECT * FROM claimed;
END $$;

CREATE FUNCTION pr_agent_harness.github_deferred_pull_request_complete(
  requested_id uuid,requested_owner text,requested_lease_epoch bigint,requested_outcome text,
  requested_error_code text,requested_run_id uuid,requested_unused text,requested_retry_at timestamptz
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pr_agent_harness AS $$
DECLARE changed integer; DECLARE next_status text;
BEGIN
  IF requested_outcome NOT IN ('completed','skipped','retry','conflict','expired') THEN
    RAISE EXCEPTION 'invalid deferred PR outcome' USING ERRCODE='22023'; END IF;
  next_status:=requested_outcome;
  UPDATE pr_agent_harness.github_deferred_pull_requests SET status=next_status,
    run_id=COALESCE(requested_run_id,run_id),last_error_code=requested_error_code,
    retry_at=CASE WHEN next_status='retry' THEN requested_retry_at ELSE NULL END,
    completed_at=CASE WHEN next_status IN ('completed','skipped','conflict','expired')
      THEN clock_timestamp() ELSE NULL END,
    lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
  WHERE id=requested_id AND status='leased' AND lease_owner=requested_owner
    AND lease_epoch=requested_lease_epoch AND lease_expires_at>clock_timestamp();
  GET DIAGNOSTICS changed=ROW_COUNT; RETURN changed=1;
END $$;

CREATE FUNCTION pr_agent_harness.github_installation_sync_cleanup(requested_limit integer)
RETURNS TABLE(deleted integer,expired integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pr_agent_harness AS $$
DECLARE expired_count integer; DECLARE deleted_count integer;
BEGIN
  IF requested_limit NOT BETWEEN 1 AND 256 THEN RAISE EXCEPTION 'invalid cleanup limit' USING ERRCODE='22023'; END IF;
  WITH candidates AS (
    SELECT id FROM pr_agent_harness.github_deferred_pull_requests
    WHERE expires_at<=clock_timestamp() AND (
      status IN ('pending','retry')
      OR (status='leased' AND lease_expires_at<=clock_timestamp()))
    ORDER BY expires_at,id FOR UPDATE SKIP LOCKED LIMIT requested_limit
  ) UPDATE pr_agent_harness.github_deferred_pull_requests d SET status='expired',
    completed_at=clock_timestamp(),lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
  FROM candidates c WHERE d.id=c.id;
  GET DIAGNOSTICS expired_count=ROW_COUNT;
  WITH candidates AS (
    SELECT id FROM pr_agent_harness.github_deferred_pull_requests
    WHERE status IN ('completed','skipped','conflict','expired')
      AND completed_at<clock_timestamp()-interval '72 hours'
    ORDER BY completed_at,id FOR UPDATE SKIP LOCKED LIMIT requested_limit
  ) DELETE FROM pr_agent_harness.github_deferred_pull_requests d USING candidates c WHERE d.id=c.id;
  GET DIAGNOSTICS deleted_count=ROW_COUNT;
  RETURN QUERY SELECT deleted_count,expired_count;
END $$;

CREATE FUNCTION pr_agent_harness.github_installation_sync_status(requested_app_id bigint)
RETURNS TABLE(pending_sync_count bigint,oldest_sync_age_seconds bigint,
  pending_deferred_count bigint,oldest_deferred_age_seconds bigint,
  sync_conflict_count bigint,deferred_conflict_count bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pr_agent_harness AS $$
BEGIN
  IF requested_app_id IS NULL OR requested_app_id<=0 THEN
    RAISE EXCEPTION 'invalid GitHub App identity' USING ERRCODE='22023'; END IF;
  RETURN QUERY SELECT
    count(*) FILTER (WHERE s.status IN ('pending','retry','applying')),
    CASE WHEN count(*) FILTER (WHERE s.status IN ('pending','retry','applying'))=0 THEN NULL
      ELSE greatest(0,extract(epoch FROM clock_timestamp()-min(s.requested_at)
        FILTER (WHERE s.status IN ('pending','retry','applying')))::bigint) END,
    (SELECT count(*) FROM pr_agent_harness.github_deferred_pull_requests d
      WHERE d.github_app_id=requested_app_id AND d.status IN ('pending','retry','leased')),
    (SELECT CASE WHEN count(*)=0 THEN NULL ELSE greatest(0,
        extract(epoch FROM clock_timestamp()-min(d.received_at))::bigint) END
      FROM pr_agent_harness.github_deferred_pull_requests d
      WHERE d.github_app_id=requested_app_id AND d.status IN ('pending','retry','leased')),
    COALESCE(sum(s.last_conflict_count) FILTER (WHERE s.status='conflict'),0),
    (SELECT count(*) FROM pr_agent_harness.github_deferred_pull_requests d
      WHERE d.github_app_id=requested_app_id AND d.status='conflict')
  FROM pr_agent_harness.github_installation_sync_state s
  WHERE s.github_app_id=requested_app_id;
END $$;

CREATE FUNCTION pr_agent_harness.github_delivery_handoff_lock(
  requested_tenant_id uuid,requested_binding_id uuid,requested_source_key text,requested_source_hash text
) RETURNS TABLE(status text,run_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pr_agent_harness AS $$
DECLARE matched pr_agent_harness.agent_runs%ROWTYPE; DECLARE legacy_count integer;
BEGIN
  IF requested_tenant_id IS NULL OR nullif(current_setting('app.tenant_id',true),'') IS NULL
     OR requested_tenant_id<>nullif(current_setting('app.tenant_id',true),'')::uuid
     OR requested_source_key !~ '^github:delivery:.+' OR requested_source_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid GitHub delivery handoff scope' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'github-delivery:'||requested_tenant_id::text||':'||requested_source_key,0));
  SELECT r.* INTO matched FROM pr_agent_harness.agent_runs r
  WHERE r.tenant_id=requested_tenant_id AND r.source_kind='github_delivery'
    AND r.source_key=requested_source_key FOR UPDATE;
  IF FOUND THEN
    IF matched.integration_id=requested_binding_id AND matched.source_hash=requested_source_hash THEN
      RETURN QUERY SELECT 'matching'::text,matched.id; RETURN;
    END IF;
    INSERT INTO pr_agent_harness.audit_logs
      (tenant_id,actor_type,actor_id,action,decision,reason_code,resource_type,resource_ref,details_json)
    VALUES (requested_tenant_id,'service','github-delivery-handoff','github.delivery.integrity','denied',
      'source_identity_conflict','agent_run',matched.id::text,
      jsonb_build_object('sourceKey',requested_source_key,'bindingId',requested_binding_id));
    RETURN QUERY SELECT 'conflict'::text,matched.id; RETURN;
  END IF;
  SELECT count(*) INTO legacy_count FROM pr_agent_harness.agent_runs r
  WHERE r.tenant_id=requested_tenant_id AND r.create_key=requested_source_key
    AND r.integration_id=requested_binding_id AND r.run_type LIKE '%review%';
  IF legacy_count>1 THEN
    INSERT INTO pr_agent_harness.audit_logs
      (tenant_id,actor_type,actor_id,action,decision,reason_code,resource_type,resource_ref,details_json)
    VALUES (requested_tenant_id,'service','github-delivery-handoff','github.delivery.integrity','denied',
      'historical_duplicate_runs','github_delivery',requested_source_key,
      jsonb_build_object('runCount',legacy_count,'bindingId',requested_binding_id));
    RETURN QUERY SELECT 'conflict'::text,NULL::uuid; RETURN;
  END IF;
  IF legacy_count=1 THEN
    SELECT r.* INTO matched FROM pr_agent_harness.agent_runs r
    WHERE r.tenant_id=requested_tenant_id AND r.create_key=requested_source_key
      AND r.integration_id=requested_binding_id AND r.run_type LIKE '%review%' LIMIT 1 FOR UPDATE;
    IF matched.input_json#>>'{source,hash}' IS NULL OR matched.input_json#>>'{source,key}' IS NULL THEN
      INSERT INTO pr_agent_harness.audit_logs
        (tenant_id,actor_type,actor_id,action,decision,reason_code,resource_type,resource_ref,details_json)
      VALUES (requested_tenant_id,'service','github-delivery-handoff','github.delivery.integrity','denied',
        'legacy_source_hash_unavailable','agent_run',matched.id::text,
        jsonb_build_object('sourceKey',requested_source_key,'bindingId',requested_binding_id));
      RETURN QUERY SELECT 'legacy_hash_unavailable'::text,matched.id; RETURN;
    END IF;
    IF matched.integration_id=requested_binding_id
       AND matched.input_json#>>'{source,key}'=requested_source_key
       AND matched.input_json#>>'{source,hash}'=requested_source_hash THEN
      RETURN QUERY SELECT 'matching'::text,matched.id; RETURN;
    END IF;
    INSERT INTO pr_agent_harness.audit_logs
      (tenant_id,actor_type,actor_id,action,decision,reason_code,resource_type,resource_ref,details_json)
    VALUES (requested_tenant_id,'service','github-delivery-handoff','github.delivery.integrity','denied',
      'source_identity_conflict','agent_run',matched.id::text,
      jsonb_build_object('sourceKey',requested_source_key,'bindingId',requested_binding_id));
    RETURN QUERY SELECT 'conflict'::text,matched.id; RETURN;
  END IF;
  RETURN QUERY SELECT 'none'::text,NULL::uuid;
END $$;

CREATE FUNCTION pr_agent_harness.github_deferred_pull_request_lock_for_handoff(
  requested_tenant_id uuid,requested_source_key text,requested_owner text,
  requested_lease_epoch bigint,requested_binding_id uuid
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pr_agent_harness AS $$
DECLARE deferred_id uuid;
BEGIN
  IF requested_tenant_id IS NULL OR nullif(current_setting('app.tenant_id',true),'') IS NULL
     OR requested_tenant_id<>nullif(current_setting('app.tenant_id',true),'')::uuid THEN
    RAISE EXCEPTION 'GitHub handoff tenant scope mismatch' USING ERRCODE='42501'; END IF;
  SELECT d.id INTO deferred_id FROM pr_agent_harness.github_deferred_pull_requests d
  JOIN pr_agent_harness.integration_bindings b ON b.id=requested_binding_id AND b.tenant_id=requested_tenant_id
    AND b.platform='github' AND b.origin='https://api.github.com'
    AND b.provider_repository_id=d.repository_id::text
    AND b.github_app_id=d.github_app_id AND b.github_account_id=d.github_account_id
    AND b.credential_ref='github-app:'||d.installation_id::text
    AND b.active AND b.publication_state='active' AND b.review_execution_mode='harness_async'
    AND b.review_execution_state='active' AND b.provider_access_state='verified'
  WHERE d.delivery_id=substring(requested_source_key FROM '^github:delivery:(.+)$')
    AND d.status='leased' AND d.lease_owner=requested_owner AND d.lease_epoch=requested_lease_epoch
    AND d.lease_expires_at>clock_timestamp() FOR UPDATE OF d;
  RETURN deferred_id;
END $$;

CREATE FUNCTION pr_agent_harness.github_deferred_pull_request_finish_handoff(
  requested_tenant_id uuid,requested_source_key text,requested_owner text,
  requested_lease_epoch bigint,requested_binding_id uuid,requested_run_id uuid
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pr_agent_harness AS $$
DECLARE deferred_id uuid; DECLARE changed integer;
BEGIN
  IF requested_tenant_id IS NULL OR nullif(current_setting('app.tenant_id',true),'') IS NULL
     OR requested_tenant_id<>nullif(current_setting('app.tenant_id',true),'')::uuid THEN
    RAISE EXCEPTION 'GitHub handoff tenant scope mismatch' USING ERRCODE='42501'; END IF;
  deferred_id:=pr_agent_harness.github_deferred_pull_request_lock_for_handoff(
    requested_tenant_id,requested_source_key,requested_owner,requested_lease_epoch,requested_binding_id);
  IF deferred_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM pr_agent_harness.agent_runs r
    JOIN pr_agent_harness.github_deferred_pull_requests d ON d.id=deferred_id
    WHERE r.tenant_id=requested_tenant_id AND r.id=requested_run_id
      AND r.integration_id=requested_binding_id
      AND ((r.source_kind='github_delivery' AND r.source_key=requested_source_key
          AND r.source_hash=d.source_hash)
        OR (r.source_kind IS NULL AND r.create_key=requested_source_key
          AND r.run_type LIKE '%review%' AND r.input_json#>>'{source,key}'=requested_source_key
          AND r.input_json#>>'{source,hash}'=d.source_hash))
  ) THEN RETURN false; END IF;
  UPDATE pr_agent_harness.github_deferred_pull_requests SET status='completed',run_id=requested_run_id,
    completed_at=clock_timestamp(),lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
  WHERE id=deferred_id;
  GET DIAGNOSTICS changed=ROW_COUNT; RETURN changed=1;
END $$;

REVOKE ALL ON FUNCTION
  pr_agent_harness.github_installation_sync_request(bigint,bigint,bigint,text,text,text),
  pr_agent_harness.github_installation_restrict_and_request(bigint,bigint,bigint,bigint[],text,text,text),
  pr_agent_harness.github_installation_sync_claim(bigint,text,integer),
  pr_agent_harness.github_installation_sync_renew(bigint,bigint,text,bigint,bigint,integer),
  pr_agent_harness.github_installation_sync_known(bigint),
  pr_agent_harness.github_installation_sync_fail(bigint,bigint,text,bigint,bigint,text,timestamptz),
  pr_agent_harness.github_installation_snapshot_begin(bigint,bigint,text,bigint,bigint,bigint,bigint,text,timestamptz,bigint[]),
  pr_agent_harness.github_installation_snapshot_apply_present(bigint,bigint,text,bigint,bigint,text,jsonb),
  pr_agent_harness.github_installation_snapshot_absence_candidates(bigint,bigint,text,bigint,bigint,text,bigint[]),
  pr_agent_harness.github_installation_snapshot_apply_absent(bigint,bigint,text,bigint,bigint,text,bigint[],bigint[]),
  pr_agent_harness.github_installation_snapshot_complete(bigint,bigint,text,bigint,bigint,text,bigint[]),
  pr_agent_harness.github_installation_snapshot_complete_restricted(bigint,bigint,text,bigint,bigint,text,text,timestamptz),
  pr_agent_harness.github_deferred_pull_request_admit(bigint,bigint,bigint,bigint,text,integer,text,text,text),
  pr_agent_harness.github_deferred_pull_request_claim(bigint,text,integer),
  pr_agent_harness.github_deferred_pull_request_complete(uuid,text,bigint,text,text,uuid,text,timestamptz),
  pr_agent_harness.github_installation_sync_cleanup(integer),
  pr_agent_harness.github_installation_sync_status(bigint),
  pr_agent_harness.github_delivery_handoff_lock(uuid,uuid,text,text),
  pr_agent_harness.github_deferred_pull_request_lock_for_handoff(uuid,text,text,bigint,uuid),
  pr_agent_harness.github_deferred_pull_request_finish_handoff(uuid,text,text,bigint,uuid,uuid)
FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='pr_agent_onboarding') THEN
    GRANT USAGE ON SCHEMA pr_agent_harness TO pr_agent_onboarding;
    GRANT EXECUTE ON FUNCTION
      pr_agent_harness.github_installation_sync_request(bigint,bigint,bigint,text,text,text),
      pr_agent_harness.github_installation_restrict_and_request(bigint,bigint,bigint,bigint[],text,text,text),
      pr_agent_harness.github_installation_sync_claim(bigint,text,integer),
      pr_agent_harness.github_installation_sync_renew(bigint,bigint,text,bigint,bigint,integer),
      pr_agent_harness.github_installation_sync_known(bigint),
      pr_agent_harness.github_installation_sync_fail(bigint,bigint,text,bigint,bigint,text,timestamptz),
      pr_agent_harness.github_installation_snapshot_begin(bigint,bigint,text,bigint,bigint,bigint,bigint,text,timestamptz,bigint[]),
      pr_agent_harness.github_installation_snapshot_apply_present(bigint,bigint,text,bigint,bigint,text,jsonb),
      pr_agent_harness.github_installation_snapshot_absence_candidates(bigint,bigint,text,bigint,bigint,text,bigint[]),
      pr_agent_harness.github_installation_snapshot_apply_absent(bigint,bigint,text,bigint,bigint,text,bigint[],bigint[]),
      pr_agent_harness.github_installation_snapshot_complete(bigint,bigint,text,bigint,bigint,text,bigint[]),
      pr_agent_harness.github_installation_snapshot_complete_restricted(bigint,bigint,text,bigint,bigint,text,text,timestamptz),
      pr_agent_harness.github_deferred_pull_request_admit(bigint,bigint,bigint,bigint,text,integer,text,text,text),
      pr_agent_harness.github_deferred_pull_request_claim(bigint,text,integer),
      pr_agent_harness.github_deferred_pull_request_complete(uuid,text,bigint,text,text,uuid,text,timestamptz),
      pr_agent_harness.github_installation_sync_cleanup(integer),
      pr_agent_harness.github_installation_sync_status(bigint)
    TO pr_agent_onboarding;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='pr_agent_app') THEN
    GRANT EXECUTE ON FUNCTION
      pr_agent_harness.github_delivery_handoff_lock(uuid,uuid,text,text),
      pr_agent_harness.github_deferred_pull_request_lock_for_handoff(uuid,text,text,bigint,uuid),
      pr_agent_harness.github_deferred_pull_request_finish_handoff(uuid,text,text,bigint,uuid,uuid)
    TO pr_agent_app;
  END IF;
END $grants$;
