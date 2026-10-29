ALTER TABLE pr_agent_harness.integration_bindings
  ADD COLUMN review_execution_mode text NOT NULL DEFAULT 'legacy_sync'
    CHECK (review_execution_mode IN ('legacy_sync','harness_async')),
  ADD COLUMN execution_mode_generation bigint NOT NULL DEFAULT 0
    CHECK (execution_mode_generation >= 0),
  ADD CONSTRAINT integration_bindings_async_execution_shape CHECK (
    review_execution_mode = 'legacy_sync'
    OR (publication_state IN ('active','draining') AND publication_generation > 0
        AND execution_mode_generation > 0)
  );

ALTER TABLE pr_agent_harness.agent_runs
  ADD COLUMN authority_generation bigint NOT NULL DEFAULT 0
    CHECK (authority_generation >= 0),
  ADD COLUMN runtime_config_json jsonb NOT NULL DEFAULT
    '{"pollMs":1000,"leaseTtlMs":60000,"heartbeatMs":15000,"sweeperMs":5000}'::jsonb
    CHECK (jsonb_typeof(runtime_config_json) = 'object'),
  ADD COLUMN limits_json jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(limits_json) = 'object'),
  ADD COLUMN deadline_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
  ADD COLUMN cancel_requested_at timestamptz,
  ADD COLUMN outcome_code text,
  ADD COLUMN error_code text,
  ADD COLUMN execution_attempt_count integer NOT NULL DEFAULT 0
    CHECK (execution_attempt_count >= 0),
  ADD COLUMN execution_mode_generation bigint NOT NULL DEFAULT 0
    CHECK (execution_mode_generation >= 0),
  ADD COLUMN checkpoint_version bigint NOT NULL DEFAULT 0
    CHECK (checkpoint_version >= 0),
  ADD COLUMN parent_run_id uuid,
  ADD CONSTRAINT agent_runs_parent_fk
    FOREIGN KEY (tenant_id, parent_run_id)
    REFERENCES pr_agent_harness.agent_runs (tenant_id, id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT agent_runs_not_own_parent
    CHECK (parent_run_id IS NULL OR parent_run_id <> id),
  ADD CONSTRAINT agent_runs_deadline_after_create
    CHECK (deadline_at > created_at);

ALTER TABLE pr_agent_harness.job_queue
  ADD COLUMN last_error_code text;

CREATE TABLE pr_agent_harness.agent_steps (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid NOT NULL,
    run_id             uuid NOT NULL,
    step_key           text NOT NULL CHECK (length(step_key) > 0),
    step_kind          text NOT NULL
                       CHECK (step_kind IN ('tool','model','publication','coordination','verification')),
    input_hash         text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
    status             text NOT NULL DEFAULT 'running'
                       CHECK (status IN ('running', 'succeeded', 'failed')),
    output_hash        text CHECK (output_hash IS NULL OR output_hash ~ '^[0-9a-f]{64}$'),
    output_json        jsonb CHECK (output_json IS NULL OR jsonb_typeof(output_json) = 'object'),
    last_lease_epoch   bigint NOT NULL CHECK (last_lease_epoch > 0),
    attempt_count      integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    completed_at       timestamptz,
    CONSTRAINT agent_steps_tenant_identity UNIQUE (tenant_id, run_id, id),
    CONSTRAINT agent_steps_logical_identity UNIQUE (tenant_id, run_id, step_key),
    CONSTRAINT agent_steps_run_fk FOREIGN KEY (tenant_id, run_id)
      REFERENCES pr_agent_harness.agent_runs (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT agent_steps_completion_shape CHECK (
      (status = 'running' AND output_hash IS NULL AND output_json IS NULL AND completed_at IS NULL)
      OR
      (status IN ('succeeded', 'failed') AND output_hash IS NOT NULL
       AND output_json IS NOT NULL AND completed_at IS NOT NULL)
    )
);

CREATE TABLE pr_agent_harness.step_attempts (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL,
    run_id          uuid NOT NULL,
    step_id         uuid NOT NULL,
    attempt_number  integer NOT NULL CHECK (attempt_number > 0),
    lease_owner     text NOT NULL CHECK (length(lease_owner) > 0),
    lease_epoch     bigint NOT NULL CHECK (lease_epoch > 0),
    status          text NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running', 'succeeded', 'failed', 'abandoned')),
    error_code      text,
    started_at      timestamptz NOT NULL DEFAULT now(),
    completed_at    timestamptz,
    CONSTRAINT step_attempts_tenant_identity UNIQUE (tenant_id, run_id, id),
    CONSTRAINT step_attempts_number UNIQUE (tenant_id, step_id, attempt_number),
    CONSTRAINT step_attempts_step_fk FOREIGN KEY (tenant_id, run_id, step_id)
      REFERENCES pr_agent_harness.agent_steps (tenant_id, run_id, id) ON DELETE RESTRICT,
    CONSTRAINT step_attempts_completion_shape CHECK (
      (status = 'running' AND completed_at IS NULL)
      OR (status <> 'running' AND completed_at IS NOT NULL)
    )
);

CREATE TABLE pr_agent_harness.checkpoints (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             uuid NOT NULL,
    run_id                uuid NOT NULL,
    sequence              bigint NOT NULL CHECK (sequence > 0),
    checkpoint_kind       text NOT NULL DEFAULT 'step_completed'
                          CHECK (checkpoint_kind IN ('step_completed','publication_frozen')),
    publication_batch_id  uuid,
    step_id               uuid,
    step_attempt_id       uuid,
    schema_version        integer NOT NULL CHECK (schema_version > 0),
    runtime_version_hash  text NOT NULL CHECK (runtime_version_hash ~ '^[0-9a-f]{64}$'),
    state_hash            text NOT NULL CHECK (state_hash ~ '^[0-9a-f]{64}$'),
    state_json            jsonb NOT NULL CHECK (jsonb_typeof(state_json) = 'object'),
    lease_epoch           bigint NOT NULL CHECK (lease_epoch > 0),
    created_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT checkpoints_tenant_identity UNIQUE (tenant_id, run_id, id),
    CONSTRAINT checkpoints_sequence UNIQUE (tenant_id, run_id, sequence),
    CONSTRAINT checkpoints_step UNIQUE (tenant_id, run_id, step_id),
    CONSTRAINT checkpoints_publication_batch UNIQUE (tenant_id, run_id, publication_batch_id),
    CONSTRAINT checkpoints_attempt_fk FOREIGN KEY (tenant_id, run_id, step_attempt_id)
      REFERENCES pr_agent_harness.step_attempts (tenant_id, run_id, id) ON DELETE RESTRICT,
    CONSTRAINT checkpoints_step_fk FOREIGN KEY (tenant_id, run_id, step_id)
      REFERENCES pr_agent_harness.agent_steps (tenant_id, run_id, id) ON DELETE RESTRICT,
    CONSTRAINT checkpoints_publication_batch_fk FOREIGN KEY (tenant_id, publication_batch_id)
      REFERENCES pr_agent_harness.publication_batches (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT checkpoints_step_shape CHECK (
      (checkpoint_kind = 'step_completed' AND step_id IS NOT NULL
       AND step_attempt_id IS NOT NULL AND publication_batch_id IS NULL)
      OR (checkpoint_kind = 'publication_frozen' AND step_id IS NULL
          AND step_attempt_id IS NULL AND publication_batch_id IS NOT NULL)
    )
);

CREATE TABLE pr_agent_harness.tool_calls (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid NOT NULL,
    run_id             uuid NOT NULL,
    step_id            uuid NOT NULL,
    step_attempt_id    uuid NOT NULL,
    tool_kind          text NOT NULL
                       CHECK (tool_kind IN ('provider_read','repository_read','sandbox_read','mcp_read')),
    tool_name          text NOT NULL CHECK (length(tool_name) > 0),
    request_hash       text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    status             text NOT NULL DEFAULT 'in_flight'
                       CHECK (status IN ('prepared','in_flight','succeeded','failed_definite','unknown')),
    side_effect        text NOT NULL DEFAULT 'read_only' CHECK (side_effect = 'read_only'),
    result_hash        text CHECK (result_hash IS NULL OR result_hash ~ '^[0-9a-f]{64}$'),
    result_ref         text,
    error_code         text,
    started_at         timestamptz NOT NULL DEFAULT now(),
    completed_at       timestamptz,
    CONSTRAINT tool_calls_tenant_identity UNIQUE (tenant_id, run_id, id),
    CONSTRAINT tool_calls_physical_attempt UNIQUE (tenant_id, run_id, step_attempt_id),
    CONSTRAINT tool_calls_attempt_fk FOREIGN KEY (tenant_id, run_id, step_attempt_id)
      REFERENCES pr_agent_harness.step_attempts (tenant_id, run_id, id) ON DELETE RESTRICT,
    CONSTRAINT tool_calls_step_fk FOREIGN KEY (tenant_id, run_id, step_id)
      REFERENCES pr_agent_harness.agent_steps (tenant_id, run_id, id) ON DELETE RESTRICT,
    CONSTRAINT tool_calls_completion_shape CHECK (
      (status IN ('prepared','in_flight') AND completed_at IS NULL)
      OR (status IN ('succeeded','failed_definite','unknown') AND completed_at IS NOT NULL)
    )
);

CREATE TABLE pr_agent_harness.dead_letter_jobs (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             uuid NOT NULL,
    run_id                uuid NOT NULL,
    job_id                uuid NOT NULL,
    final_run_epoch       bigint NOT NULL CHECK (final_run_epoch >= 0),
    attempt_count         integer NOT NULL CHECK (attempt_count >= 0),
    reason_code           text NOT NULL CHECK (length(reason_code) > 0),
    details_json          jsonb NOT NULL DEFAULT '{}'::jsonb
                          CHECK (jsonb_typeof(details_json) = 'object'),
    created_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT dead_letter_jobs_identity UNIQUE (tenant_id, job_id),
    CONSTRAINT dead_letter_jobs_run_fk FOREIGN KEY (tenant_id, run_id)
      REFERENCES pr_agent_harness.agent_runs (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT dead_letter_jobs_job_fk FOREIGN KEY (tenant_id, run_id, job_id)
      REFERENCES pr_agent_harness.job_queue (tenant_id, run_id, id) ON DELETE RESTRICT
);

CREATE TABLE pr_agent_harness.run_publication_batches (
    tenant_id          uuid NOT NULL,
    run_id             uuid NOT NULL,
    batch_id           uuid NOT NULL,
    step_id            uuid,
    lease_epoch        bigint NOT NULL CHECK (lease_epoch > 0),
    operation_set_hash text NOT NULL CHECK (operation_set_hash ~ '^[0-9a-f]{64}$'),
    created_at         timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, run_id, batch_id),
    CONSTRAINT run_publication_batches_batch_unique UNIQUE (tenant_id, batch_id),
    CONSTRAINT run_publication_batches_run_fk FOREIGN KEY (tenant_id, run_id)
      REFERENCES pr_agent_harness.agent_runs (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT run_publication_batches_batch_fk FOREIGN KEY (tenant_id, batch_id)
      REFERENCES pr_agent_harness.publication_batches (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT run_publication_batches_step_fk FOREIGN KEY (tenant_id, run_id, step_id)
      REFERENCES pr_agent_harness.agent_steps (tenant_id, run_id, id) ON DELETE RESTRICT
);

CREATE INDEX agent_steps_run_order
  ON pr_agent_harness.agent_steps (tenant_id, run_id, created_at, id);
CREATE INDEX checkpoints_run_latest
  ON pr_agent_harness.checkpoints (tenant_id, run_id, sequence DESC);
CREATE INDEX job_queue_claimable
  ON pr_agent_harness.job_queue (available_at, priority DESC, tenant_id, id)
  WHERE status IN ('ready', 'retry_wait');

ALTER TABLE pr_agent_harness.agent_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.agent_steps FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.step_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.step_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.checkpoints FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.tool_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.tool_calls FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.dead_letter_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.dead_letter_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.run_publication_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.run_publication_batches FORCE ROW LEVEL SECURITY;

CREATE POLICY agent_steps_tenant_policy ON pr_agent_harness.agent_steps
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY step_attempts_tenant_policy ON pr_agent_harness.step_attempts
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY checkpoints_tenant_policy ON pr_agent_harness.checkpoints
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tool_calls_tenant_policy ON pr_agent_harness.tool_calls
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY dead_letter_jobs_tenant_policy ON pr_agent_harness.dead_letter_jobs
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY run_publication_batches_tenant_policy
  ON pr_agent_harness.run_publication_batches
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

COMMENT ON TABLE pr_agent_harness.agent_steps IS
  'Logical action steps. Retries create attempts without changing the stable step identity.';
COMMENT ON TABLE pr_agent_harness.checkpoints IS
  'Fenced, versioned recovery state accepted atomically with a completed logical step.';
COMMENT ON TABLE pr_agent_harness.dead_letter_jobs IS
  'Terminal scheduling failures. A dead-letter record never grants Run execution authority.';

CREATE FUNCTION pr_agent_harness.lock_active_review_execution_authority(
    requested_tenant_id uuid,
    requested_integration_id uuid,
    requested_publication_generation bigint,
    requested_execution_generation bigint
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
    AND publication_state = 'active'
    AND publication_generation = requested_publication_generation
    AND review_execution_mode = 'harness_async'
    AND execution_mode_generation = requested_execution_generation
  FOR SHARE;
  RETURN COALESCE(matched, false);
END;
$$;

REVOKE ALL ON FUNCTION pr_agent_harness.lock_active_review_execution_authority(
  uuid, uuid, bigint, bigint
) FROM PUBLIC;

CREATE FUNCTION pr_agent_harness.lock_resumable_review_execution_authority(
    requested_tenant_id uuid,
    requested_integration_id uuid,
    requested_publication_generation bigint,
    requested_execution_generation bigint
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
    AND publication_state IN ('active','draining')
    AND publication_generation = requested_publication_generation
    AND review_execution_mode = 'harness_async'
    AND execution_mode_generation = requested_execution_generation
  FOR SHARE;
  RETURN COALESCE(matched, false);
END;
$$;

REVOKE ALL ON FUNCTION pr_agent_harness.lock_resumable_review_execution_authority(
  uuid, uuid, bigint, bigint
) FROM PUBLIC;
