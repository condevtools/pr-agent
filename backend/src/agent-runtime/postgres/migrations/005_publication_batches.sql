CREATE TABLE pr_agent_harness.publication_batches (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             uuid NOT NULL,
    integration_id        uuid NOT NULL,
    platform              text NOT NULL CHECK (platform IN ('github', 'gitlab')),
    origin                text NOT NULL CHECK (length(origin) > 0),
    repository            text NOT NULL CHECK (length(repository) > 0),
    target                text NOT NULL CHECK (length(target) > 0),
    revision              text NOT NULL CHECK (length(revision) > 0),
    authority_generation  bigint NOT NULL CHECK (authority_generation >= 0),
    source_key            text NOT NULL CHECK (length(source_key) > 0),
    source_hash           text NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
    status                text NOT NULL DEFAULT 'pending'
                          CHECK (status IN (
                            'pending', 'waiting_reconciliation',
                            'succeeded', 'failed_definite'
                          )),
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT publication_batches_tenant_identity UNIQUE (tenant_id, id),
    CONSTRAINT publication_batches_source_identity
      UNIQUE (tenant_id, integration_id, source_key),
    CONSTRAINT publication_batches_integration_fk
      FOREIGN KEY (tenant_id, integration_id)
      REFERENCES pr_agent_harness.integration_bindings (tenant_id, id)
      ON DELETE RESTRICT
);

CREATE INDEX publication_batches_recoverable
  ON pr_agent_harness.publication_batches
    (tenant_id, integration_id, updated_at, id)
  WHERE status IN ('pending', 'waiting_reconciliation');

CREATE TABLE pr_agent_harness.publication_batch_operations (
    tenant_id                 uuid NOT NULL,
    batch_id                  uuid NOT NULL,
    ordinal                   integer NOT NULL CHECK (ordinal >= 0),
    business_operation_id     text NOT NULL CHECK (business_operation_id ~ '^[0-9a-f]{64}$'),
    PRIMARY KEY (tenant_id, batch_id, ordinal),
    CONSTRAINT publication_batch_operations_unique_operation
      UNIQUE (tenant_id, batch_id, business_operation_id),
    CONSTRAINT publication_batch_operations_batch_fk
      FOREIGN KEY (tenant_id, batch_id)
      REFERENCES pr_agent_harness.publication_batches (tenant_id, id)
      ON DELETE RESTRICT,
    CONSTRAINT publication_batch_operations_operation_fk
      FOREIGN KEY (tenant_id, business_operation_id)
      REFERENCES pr_agent_harness.repository_operations (tenant_id, business_operation_id)
      ON DELETE RESTRICT
);

ALTER TABLE pr_agent_harness.publication_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.publication_batches FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.publication_batch_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.publication_batch_operations FORCE ROW LEVEL SECURITY;

CREATE POLICY publication_batches_tenant_policy
  ON pr_agent_harness.publication_batches
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY publication_batch_operations_tenant_policy
  ON pr_agent_harness.publication_batch_operations
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

COMMENT ON TABLE pr_agent_harness.publication_batches IS
  'Immutable, ordered publication decisions keyed by their upstream source event.';
COMMENT ON TABLE pr_agent_harness.publication_batch_operations IS
  'Complete ordered operation set frozen before any external publication call.';

CREATE FUNCTION pr_agent_harness.lock_active_publication_authority(
    requested_tenant_id uuid,
    requested_integration_id uuid,
    requested_platform text,
    requested_origin text,
    requested_repository text,
    requested_generation bigint
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pr_agent_harness
AS $$
DECLARE
  matched boolean;
BEGIN
  SELECT true INTO matched
  FROM pr_agent_harness.integration_bindings
  WHERE tenant_id = requested_tenant_id
    AND id = requested_integration_id
    AND platform = requested_platform
    AND origin = requested_origin
    AND repository = requested_repository
    AND active
    AND publication_state = 'active'
    AND publication_generation = requested_generation
  FOR SHARE;
  RETURN COALESCE(matched, false);
END;
$$;

REVOKE ALL ON FUNCTION pr_agent_harness.lock_active_publication_authority(
  uuid, uuid, text, text, text, bigint
) FROM PUBLIC;

COMMENT ON FUNCTION pr_agent_harness.lock_active_publication_authority(
  uuid, uuid, text, text, text, bigint
) IS 'Narrow authority assertion and row lock; application roles receive EXECUTE, never registry UPDATE.';
