CREATE TABLE pr_agent_harness.publication_command_receipts (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id              uuid NOT NULL,
    business_operation_id  text NOT NULL CHECK (business_operation_id ~ '^[0-9a-f]{64}$'),
    command_key            text NOT NULL CHECK (length(command_key) > 0),
    request_hash           text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    decision               text NOT NULL CHECK (decision IN (
                             'confirm_occurred', 'confirm_not_occurred',
                             'authorize_retry', 'abandon_publication'
                           )),
    actor_type             text NOT NULL CHECK (actor_type IN ('user', 'service')),
    actor_id               text NOT NULL CHECK (length(actor_id) > 0),
    evidence_json          jsonb NOT NULL CHECK (jsonb_typeof(evidence_json) = 'object'),
    remote_id              text,
    previous_status        text NOT NULL,
    resulting_status       text NOT NULL,
    previous_version       bigint NOT NULL CHECK (previous_version >= 0),
    resulting_version      bigint NOT NULL CHECK (resulting_version > previous_version),
    created_at             timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT publication_command_receipts_tenant_identity UNIQUE (tenant_id, id),
    CONSTRAINT publication_command_receipts_command_identity UNIQUE (tenant_id, command_key),
    CONSTRAINT publication_command_receipts_operation_fk
      FOREIGN KEY (tenant_id, business_operation_id)
      REFERENCES pr_agent_harness.repository_operations (tenant_id, business_operation_id)
      ON DELETE RESTRICT
);

CREATE INDEX publication_command_receipts_operation_history
  ON pr_agent_harness.publication_command_receipts
    (tenant_id, business_operation_id, created_at, id);

ALTER TABLE pr_agent_harness.publication_command_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.publication_command_receipts FORCE ROW LEVEL SECURITY;

CREATE POLICY publication_command_receipts_tenant_policy
  ON pr_agent_harness.publication_command_receipts
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

COMMENT ON TABLE pr_agent_harness.publication_command_receipts IS
  'Idempotent administrator assertions and retry authorizations for unresolved publication operations.';

CREATE FUNCTION pr_agent_harness.lock_resolvable_publication_authority(
    requested_tenant_id uuid,
    requested_integration_id uuid,
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
    AND active
    AND publication_state IN ('active', 'draining')
    AND publication_generation = requested_generation
  FOR SHARE;
  RETURN COALESCE(matched, false);
END;
$$;

REVOKE ALL ON FUNCTION pr_agent_harness.lock_resolvable_publication_authority(
  uuid, uuid, bigint
) FROM PUBLIC;

COMMENT ON FUNCTION pr_agent_harness.lock_resolvable_publication_authority(uuid, uuid, bigint) IS
  'Locks matching active or draining authority while an administrator resolves a frozen operation.';
