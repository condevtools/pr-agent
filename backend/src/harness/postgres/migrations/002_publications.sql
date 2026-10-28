CREATE TABLE pr_agent_harness.repository_operations (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id              uuid NOT NULL,
    integration_id         uuid NOT NULL,
    business_operation_id  text NOT NULL CHECK (business_operation_id ~ '^[0-9a-f]{64}$'),
    platform               text NOT NULL CHECK (platform IN ('github', 'gitlab')),
    origin                 text NOT NULL CHECK (length(origin) > 0),
    repository             text NOT NULL CHECK (length(repository) > 0),
    target                 text NOT NULL CHECK (length(target) > 0),
    revision               text NOT NULL CHECK (length(revision) > 0),
    operation_type         text NOT NULL DEFAULT 'publication'
                           CHECK (operation_type = 'publication'),
    publication_slot       text NOT NULL CHECK (length(publication_slot) > 0),
    payload_hash           text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
    marker                 text NOT NULL CHECK (length(marker) > 0),
    status                 text NOT NULL DEFAULT 'prepared'
                           CHECK (status IN (
                             'prepared', 'in_flight', 'succeeded', 'unknown',
                             'manual_review', 'failed_definite', 'cancelled'
                           )),
    outcome_code           text CHECK (outcome_code IN (
                             'current', 'stale', 'not_occurred_confirmed',
                             'publication_abandoned'
                           )),
    remote_id              text,
    attempt_count          integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    version                bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
    last_error_code        text,
    prepared_at            timestamptz NOT NULL DEFAULT now(),
    dispatched_at          timestamptz,
    resolved_at            timestamptz,
    updated_at             timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT repository_operations_tenant_identity
      UNIQUE (tenant_id, business_operation_id),
    CONSTRAINT repository_operations_integration_fk
      FOREIGN KEY (tenant_id, integration_id)
      REFERENCES pr_agent_harness.integration_bindings (tenant_id, id)
      ON DELETE RESTRICT,
    CONSTRAINT repository_operations_resolution_shape CHECK (
      (status = 'succeeded' AND outcome_code IN ('current', 'stale') AND remote_id IS NOT NULL AND resolved_at IS NOT NULL)
      OR (status = 'failed_definite' AND outcome_code IN ('stale', 'publication_abandoned') AND remote_id IS NULL AND resolved_at IS NOT NULL)
      OR (status = 'cancelled' AND resolved_at IS NOT NULL)
      OR (status IN ('prepared', 'in_flight', 'unknown', 'manual_review') AND resolved_at IS NULL)
    )
);

CREATE INDEX repository_operations_reconcile
  ON pr_agent_harness.repository_operations
    (tenant_id, status, updated_at, business_operation_id)
  WHERE status IN ('in_flight', 'unknown', 'manual_review');

CREATE TABLE pr_agent_harness.publication_slots (
    tenant_id                    uuid NOT NULL,
    integration_id               uuid NOT NULL,
    target                       text NOT NULL CHECK (length(target) > 0),
    publication_slot             text NOT NULL CHECK (length(publication_slot) > 0),
    active_business_operation_id text NOT NULL CHECK (active_business_operation_id ~ '^[0-9a-f]{64}$'),
    generation                   bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
    updated_at                   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, integration_id, target, publication_slot),
    CONSTRAINT publication_slots_integration_fk
      FOREIGN KEY (tenant_id, integration_id)
      REFERENCES pr_agent_harness.integration_bindings (tenant_id, id)
      ON DELETE RESTRICT,
    CONSTRAINT publication_slots_operation_fk
      FOREIGN KEY (tenant_id, active_business_operation_id)
      REFERENCES pr_agent_harness.repository_operations (tenant_id, business_operation_id)
      ON DELETE RESTRICT
);

ALTER TABLE pr_agent_harness.repository_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.repository_operations FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.publication_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.publication_slots FORCE ROW LEVEL SECURITY;

CREATE POLICY repository_operations_tenant_policy
  ON pr_agent_harness.repository_operations
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY publication_slots_tenant_policy
  ON pr_agent_harness.publication_slots
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
