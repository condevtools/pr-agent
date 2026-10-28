CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS pr_agent_harness;

CREATE TABLE pr_agent_harness.integration_bindings (
    id          uuid PRIMARY KEY,
    tenant_id   uuid NOT NULL,
    platform    text NOT NULL CHECK (platform IN ('github', 'gitlab')),
    origin      text NOT NULL CHECK (length(origin) > 0),
    repository  text NOT NULL CHECK (length(repository) > 0),
    active      boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT integration_bindings_tenant_identity UNIQUE (tenant_id, id),
    CONSTRAINT integration_bindings_provider_target UNIQUE (platform, origin, repository)
);

COMMENT ON TABLE pr_agent_harness.integration_bindings IS
  'Trusted server-side platform-to-tenant registry. It is not exposed as a tenant-selected API resource.';

CREATE TABLE pr_agent_harness.agent_runs (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                uuid NOT NULL,
    integration_id           uuid NOT NULL,
    created_by_actor_type    text NOT NULL CHECK (created_by_actor_type IN ('user', 'service', 'system')),
    created_by_actor_id      text NOT NULL CHECK (length(created_by_actor_id) > 0),
    create_scope             text NOT NULL CHECK (length(create_scope) > 0),
    create_key               text NOT NULL CHECK (length(create_key) > 0),
    request_hash             text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    run_type                 text NOT NULL CHECK (length(run_type) > 0),
    base_sha                 text NOT NULL CHECK (length(base_sha) > 0),
    head_sha                 text NOT NULL CHECK (length(head_sha) > 0),
    workflow_version_hash    text NOT NULL CHECK (workflow_version_hash ~ '^[0-9a-f]{64}$'),
    prompt_version_hash      text NOT NULL CHECK (prompt_version_hash ~ '^[0-9a-f]{64}$'),
    model_version_hash       text NOT NULL CHECK (model_version_hash ~ '^[0-9a-f]{64}$'),
    tool_version_hash        text NOT NULL CHECK (tool_version_hash ~ '^[0-9a-f]{64}$'),
    policy_version_hash      text NOT NULL CHECK (policy_version_hash ~ '^[0-9a-f]{64}$'),
    runtime_version_hash     text NOT NULL CHECK (runtime_version_hash ~ '^[0-9a-f]{64}$'),
    input_json               jsonb NOT NULL CHECK (jsonb_typeof(input_json) = 'object'),
    status                   text NOT NULL DEFAULT 'queued'
                             CHECK (status IN ('queued', 'running', 'waiting_for_user', 'succeeded', 'failed', 'cancelled', 'retry_wait', 'waiting_for_reconciliation')),
    version                  bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
    lease_owner              text,
    lease_expires_at         timestamptz,
    lease_epoch              bigint NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
    next_event_seq           bigint NOT NULL DEFAULT 1 CHECK (next_event_seq > 0),
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    finished_at              timestamptz,
    CONSTRAINT agent_runs_tenant_identity UNIQUE (tenant_id, id),
    CONSTRAINT agent_runs_create_idempotency UNIQUE (tenant_id, create_scope, create_key),
    CONSTRAINT agent_runs_integration_fk FOREIGN KEY (tenant_id, integration_id)
      REFERENCES pr_agent_harness.integration_bindings (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT agent_runs_lease_pair CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
    CONSTRAINT agent_runs_running_has_lease CHECK ((status = 'running') = (lease_owner IS NOT NULL)),
    CONSTRAINT agent_runs_running_epoch CHECK (status <> 'running' OR lease_epoch > 0),
    CONSTRAINT agent_runs_terminal_time CHECK
      ((status IN ('succeeded', 'failed', 'cancelled')) = (finished_at IS NOT NULL))
);

CREATE INDEX agent_runs_status
  ON pr_agent_harness.agent_runs (tenant_id, status, updated_at, id);

CREATE TABLE pr_agent_harness.run_events (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL,
    run_id          uuid NOT NULL,
    sequence        bigint NOT NULL CHECK (sequence > 0),
    event_type      text NOT NULL CHECK (length(event_type) > 0),
    schema_version  integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
    visibility      text NOT NULL DEFAULT 'internal'
                    CHECK (visibility IN ('public', 'internal', 'sensitive')),
    actor_type      text NOT NULL CHECK (actor_type IN ('user', 'service', 'system', 'worker')),
    actor_id        text,
    payload_json    jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload_json) = 'object'),
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT run_events_sequence UNIQUE (tenant_id, run_id, sequence),
    CONSTRAINT run_events_run_fk FOREIGN KEY (tenant_id, run_id)
      REFERENCES pr_agent_harness.agent_runs (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX run_events_replay
  ON pr_agent_harness.run_events (tenant_id, run_id, sequence);

CREATE TABLE pr_agent_harness.job_queue (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            uuid NOT NULL,
    run_id               uuid NOT NULL,
    job_kind             text NOT NULL CHECK (job_kind IN ('start', 'resume', 'retry', 'recover', 'publication_outcome', 'manual_resume')),
    status               text NOT NULL DEFAULT 'ready'
                         CHECK (status IN ('ready', 'running', 'retry_wait', 'completed', 'cancelled', 'dead_letter')),
    dispatch_generation  bigint NOT NULL DEFAULT 1 CHECK (dispatch_generation > 0),
    priority             integer NOT NULL DEFAULT 0,
    available_at         timestamptz NOT NULL DEFAULT now(),
    attempt_count        integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    max_attempts         integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
    claimed_run_epoch    bigint CHECK (claimed_run_epoch > 0),
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    completed_at         timestamptz,
    CONSTRAINT job_queue_tenant_identity UNIQUE (tenant_id, run_id, id),
    CONSTRAINT job_queue_run_fk FOREIGN KEY (tenant_id, run_id)
      REFERENCES pr_agent_harness.agent_runs (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT job_queue_running_epoch CHECK (status <> 'running' OR claimed_run_epoch IS NOT NULL)
);

CREATE UNIQUE INDEX job_queue_one_active_per_run
  ON pr_agent_harness.job_queue (tenant_id, run_id)
  WHERE status IN ('ready', 'running', 'retry_wait');

CREATE INDEX job_queue_ready
  ON pr_agent_harness.job_queue (available_at, priority DESC, tenant_id, id)
  WHERE status IN ('ready', 'retry_wait');

CREATE TABLE pr_agent_harness.audit_logs (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL,
    run_id         uuid,
    actor_type     text NOT NULL,
    actor_id       text,
    action         text NOT NULL,
    decision       text NOT NULL CHECK (decision IN ('allowed', 'denied', 'error')),
    reason_code    text,
    resource_type  text,
    resource_ref   text,
    details_json   jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details_json) = 'object'),
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT audit_logs_run_fk FOREIGN KEY (tenant_id, run_id)
      REFERENCES pr_agent_harness.agent_runs (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX audit_logs_run_recent
  ON pr_agent_harness.audit_logs (tenant_id, run_id, created_at DESC);

ALTER TABLE pr_agent_harness.agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.agent_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.run_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.run_events FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.job_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.job_queue FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.audit_logs FORCE ROW LEVEL SECURITY;

CREATE POLICY agent_runs_tenant_policy ON pr_agent_harness.agent_runs
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY run_events_tenant_policy ON pr_agent_harness.run_events
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY job_queue_tenant_policy ON pr_agent_harness.job_queue
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY audit_logs_tenant_policy ON pr_agent_harness.audit_logs
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
