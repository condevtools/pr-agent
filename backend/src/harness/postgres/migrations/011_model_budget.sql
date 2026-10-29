CREATE TABLE pr_agent_harness.model_pricing_snapshots (
    tenant_id          uuid NOT NULL,
    pricing_hash       text NOT NULL CHECK (pricing_hash ~ '^[0-9a-f]{64}$'),
    pricing_version    text NOT NULL CHECK (length(pricing_version) > 0),
    provider           text NOT NULL CHECK (provider IN ('openai','openai-compatible','anthropic','gemini')),
    model              text NOT NULL CHECK (length(model) > 0),
    currency           text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    rates_json         jsonb NOT NULL CHECK (jsonb_typeof(rates_json) = 'object'),
    policy_json        jsonb NOT NULL CHECK (jsonb_typeof(policy_json) = 'object'),
    created_at         timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, pricing_hash)
);

CREATE TABLE pr_agent_harness.tenant_budget_accounts (
    tenant_id              uuid NOT NULL,
    period_key             text NOT NULL CHECK (length(period_key) > 0),
    currency               text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    input_token_limit      bigint NOT NULL CHECK (input_token_limit >= 0),
    output_token_limit     bigint NOT NULL CHECK (output_token_limit >= 0),
    cost_limit_micros      bigint NOT NULL CHECK (cost_limit_micros >= 0),
    reserved_input_tokens  bigint NOT NULL DEFAULT 0 CHECK (reserved_input_tokens >= 0),
    reserved_output_tokens bigint NOT NULL DEFAULT 0 CHECK (reserved_output_tokens >= 0),
    reserved_cost_micros   bigint NOT NULL DEFAULT 0 CHECK (reserved_cost_micros >= 0),
    spent_input_tokens     bigint NOT NULL DEFAULT 0 CHECK (spent_input_tokens >= 0),
    spent_output_tokens    bigint NOT NULL DEFAULT 0 CHECK (spent_output_tokens >= 0),
    spent_cost_micros      bigint NOT NULL DEFAULT 0 CHECK (spent_cost_micros >= 0),
    overdrawn              boolean NOT NULL DEFAULT false,
    updated_at             timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, period_key, currency)
);

CREATE TABLE pr_agent_harness.run_budget_envelopes (
    tenant_id                  uuid NOT NULL,
    run_id                     uuid NOT NULL,
    period_key                 text NOT NULL,
    currency                   text NOT NULL,
    pricing_hash               text NOT NULL,
    input_token_limit          bigint NOT NULL CHECK (input_token_limit >= 0),
    output_token_limit         bigint NOT NULL CHECK (output_token_limit >= 0),
    cost_limit_micros          bigint NOT NULL CHECK (cost_limit_micros >= 0),
    allocated_input_tokens     bigint NOT NULL DEFAULT 0 CHECK (allocated_input_tokens >= 0),
    allocated_output_tokens    bigint NOT NULL DEFAULT 0 CHECK (allocated_output_tokens >= 0),
    allocated_cost_micros      bigint NOT NULL DEFAULT 0 CHECK (allocated_cost_micros >= 0),
    actual_input_tokens        bigint NOT NULL DEFAULT 0 CHECK (actual_input_tokens >= 0),
    actual_output_tokens       bigint NOT NULL DEFAULT 0 CHECK (actual_output_tokens >= 0),
    actual_cost_micros         bigint NOT NULL DEFAULT 0 CHECK (actual_cost_micros >= 0),
    overdrawn                  boolean NOT NULL DEFAULT false,
    status                     text NOT NULL DEFAULT 'active'
                               CHECK (status IN ('active','pending_reconciliation','closed')),
    created_at                 timestamptz NOT NULL DEFAULT now(),
    updated_at                 timestamptz NOT NULL DEFAULT now(),
    closed_at                  timestamptz,
    PRIMARY KEY (tenant_id, run_id),
    CONSTRAINT run_budget_run_fk FOREIGN KEY (tenant_id, run_id)
      REFERENCES pr_agent_harness.agent_runs (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT run_budget_pricing_fk FOREIGN KEY (tenant_id, pricing_hash)
      REFERENCES pr_agent_harness.model_pricing_snapshots (tenant_id, pricing_hash) ON DELETE RESTRICT,
    CONSTRAINT run_budget_account_fk FOREIGN KEY (tenant_id, period_key, currency)
      REFERENCES pr_agent_harness.tenant_budget_accounts (tenant_id, period_key, currency) ON DELETE RESTRICT,
    CONSTRAINT run_budget_close_shape CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);

ALTER TABLE pr_agent_harness.step_attempts
  ADD CONSTRAINT step_attempts_step_identity
  UNIQUE (tenant_id, run_id, step_id, id);

CREATE TABLE pr_agent_harness.model_calls (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             uuid NOT NULL,
    run_id                uuid NOT NULL,
    step_id               uuid NOT NULL,
    step_attempt_id       uuid NOT NULL,
    physical_ordinal      integer NOT NULL CHECK (physical_ordinal > 0),
    provider              text NOT NULL CHECK (provider IN ('openai','openai-compatible','anthropic','gemini')),
    model                 text NOT NULL CHECK (length(model) > 0),
    request_kind          text NOT NULL CHECK (length(request_kind) > 0),
    request_hash          text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    request_metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(request_metadata_json) = 'object'),
    input_token_bound     bigint NOT NULL CHECK (input_token_bound >= 0),
    output_token_bound    bigint NOT NULL CHECK (output_token_bound >= 0),
    provider_request_id   text,
    provider_model_version text,
    response_json         jsonb,
    response_hash         text CHECK (response_hash IS NULL OR response_hash ~ '^[0-9a-f]{64}$'),
    status                text NOT NULL DEFAULT 'prepared'
                          CHECK (status IN ('prepared','in_flight','succeeded','failed_definite','unknown')),
    error_code            text,
    lease_epoch           bigint NOT NULL CHECK (lease_epoch > 0),
    created_at            timestamptz NOT NULL DEFAULT now(),
    sent_at               timestamptz,
    finished_at           timestamptz,
    CONSTRAINT model_calls_tenant_identity UNIQUE (tenant_id, run_id, id),
    CONSTRAINT model_calls_physical_attempt UNIQUE
      (tenant_id, run_id, step_attempt_id, physical_ordinal),
    CONSTRAINT model_calls_attempt_fk FOREIGN KEY (tenant_id, run_id, step_id, step_attempt_id)
      REFERENCES pr_agent_harness.step_attempts (tenant_id, run_id, step_id, id) ON DELETE RESTRICT,
    CONSTRAINT model_calls_step_fk FOREIGN KEY (tenant_id, run_id, step_id)
      REFERENCES pr_agent_harness.agent_steps (tenant_id, run_id, id) ON DELETE RESTRICT,
    CONSTRAINT model_calls_result_shape CHECK (
      (status IN ('prepared','in_flight','unknown') AND finished_at IS NULL)
      OR (status IN ('succeeded','failed_definite') AND finished_at IS NOT NULL)
    ),
    CONSTRAINT model_calls_success_response CHECK (
      status <> 'succeeded' OR (response_json IS NOT NULL AND response_hash IS NOT NULL)
    )
);

CREATE TABLE pr_agent_harness.model_budget_reservations (
    tenant_id              uuid NOT NULL,
    run_id                 uuid NOT NULL,
    model_call_id          uuid NOT NULL,
    reserved_input_tokens  bigint NOT NULL CHECK (reserved_input_tokens >= 0),
    reserved_output_tokens bigint NOT NULL CHECK (reserved_output_tokens >= 0),
    reserved_cost_micros   bigint NOT NULL CHECK (reserved_cost_micros >= 0),
    actual_input_tokens    bigint CHECK (actual_input_tokens >= 0),
    actual_output_tokens   bigint CHECK (actual_output_tokens >= 0),
    actual_cost_micros     bigint CHECK (actual_cost_micros >= 0),
    status                 text NOT NULL DEFAULT 'reserved'
                           CHECK (status IN ('reserved','settled','released','pending')),
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, model_call_id),
    CONSTRAINT model_budget_call_fk FOREIGN KEY (tenant_id, run_id, model_call_id)
      REFERENCES pr_agent_harness.model_calls (tenant_id, run_id, id) ON DELETE RESTRICT,
    CONSTRAINT model_budget_actual_shape CHECK (
      (status = 'settled' AND actual_input_tokens IS NOT NULL
       AND actual_output_tokens IS NOT NULL AND actual_cost_micros IS NOT NULL)
      OR (status <> 'settled' AND actual_input_tokens IS NULL
          AND actual_output_tokens IS NULL AND actual_cost_micros IS NULL)
    )
);

CREATE TABLE pr_agent_harness.usage_records (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                uuid NOT NULL,
    run_id                   uuid NOT NULL,
    model_call_id            uuid NOT NULL,
    measurement_status       text NOT NULL CHECK (measurement_status IN ('actual','unavailable')),
    input_tokens             bigint CHECK (input_tokens >= 0),
    cached_input_tokens      bigint CHECK (cached_input_tokens >= 0),
    cache_write_input_tokens bigint CHECK (cache_write_input_tokens >= 0),
    output_tokens            bigint CHECK (output_tokens >= 0),
    reasoning_tokens         bigint CHECK (reasoning_tokens >= 0),
    tool_input_tokens        bigint CHECK (tool_input_tokens >= 0),
    total_tokens             bigint CHECK (total_tokens >= 0),
    cost_micros              bigint CHECK (cost_micros >= 0),
    currency                 text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    pricing_hash             text NOT NULL,
    original_usage_json      jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(original_usage_json) = 'object'),
    measured_at              timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT usage_model_unique UNIQUE (tenant_id, model_call_id),
    CONSTRAINT usage_call_fk FOREIGN KEY (tenant_id, run_id, model_call_id)
      REFERENCES pr_agent_harness.model_calls (tenant_id, run_id, id) ON DELETE RESTRICT,
    CONSTRAINT usage_pricing_fk FOREIGN KEY (tenant_id, pricing_hash)
      REFERENCES pr_agent_harness.model_pricing_snapshots (tenant_id, pricing_hash) ON DELETE RESTRICT,
    CONSTRAINT usage_measurement_shape CHECK (
      (measurement_status = 'actual' AND input_tokens IS NOT NULL
       AND output_tokens IS NOT NULL AND cost_micros IS NOT NULL)
      OR (measurement_status = 'unavailable' AND input_tokens IS NULL
          AND cached_input_tokens IS NULL AND cache_write_input_tokens IS NULL
          AND output_tokens IS NULL AND reasoning_tokens IS NULL
          AND tool_input_tokens IS NULL AND total_tokens IS NULL AND cost_micros IS NULL)
    )
);

CREATE INDEX model_calls_recovery
  ON pr_agent_harness.model_calls (tenant_id, run_id, step_id, step_attempt_id, physical_ordinal)
  WHERE status IN ('prepared','in_flight','unknown');
CREATE INDEX run_budget_pending
  ON pr_agent_harness.run_budget_envelopes (tenant_id, status, updated_at)
  WHERE status = 'pending_reconciliation';

ALTER TABLE pr_agent_harness.model_pricing_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.model_pricing_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.tenant_budget_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.tenant_budget_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.run_budget_envelopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.run_budget_envelopes FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.model_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.model_calls FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.model_budget_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.model_budget_reservations FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.usage_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.usage_records FORCE ROW LEVEL SECURITY;

CREATE POLICY model_pricing_tenant_policy ON pr_agent_harness.model_pricing_snapshots
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_budget_tenant_policy ON pr_agent_harness.tenant_budget_accounts
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY run_budget_tenant_policy ON pr_agent_harness.run_budget_envelopes
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY model_calls_tenant_policy ON pr_agent_harness.model_calls
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY model_reservations_tenant_policy ON pr_agent_harness.model_budget_reservations
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY usage_records_tenant_policy ON pr_agent_harness.usage_records
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

COMMENT ON TABLE pr_agent_harness.run_budget_envelopes IS
  'A Run reserves its full envelope from the shared tenant account before intake commits.';
COMMENT ON TABLE pr_agent_harness.model_calls IS
  'One row per physical provider request. Ordinal is attempt-local; compatibility fallback is a new ordinal.';
COMMENT ON TABLE pr_agent_harness.model_budget_reservations IS
  'Unknown provider cost remains pending and consumes the Run envelope.';
