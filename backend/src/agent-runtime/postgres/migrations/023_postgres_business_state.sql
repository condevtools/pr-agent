CREATE TABLE pr_agent_harness.command_rate_limits (
  tenant_id uuid NOT NULL,
  integration_id uuid NOT NULL,
  scope_key text NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 512),
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count BETWEEN 1 AND 1000000),
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,integration_id,scope_key),
  FOREIGN KEY (tenant_id,integration_id)
    REFERENCES pr_agent_harness.integration_bindings (tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX command_rate_limits_expiry ON pr_agent_harness.command_rate_limits (expires_at);

CREATE TABLE pr_agent_harness.review_incremental_cursors (
  tenant_id uuid NOT NULL,
  integration_id uuid NOT NULL,
  platform text NOT NULL CHECK (platform IN ('github','gitlab')),
  origin text NOT NULL CHECK (length(origin) BETWEEN 1 AND 2048),
  repository text NOT NULL CHECK (length(repository) BETWEEN 1 AND 512),
  target text NOT NULL CHECK (length(target) BETWEEN 1 AND 128),
  head_sha text NOT NULL CHECK (length(head_sha) BETWEEN 1 AND 128),
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,integration_id,platform,origin,repository,target),
  FOREIGN KEY (tenant_id,integration_id)
    REFERENCES pr_agent_harness.integration_bindings (tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX review_incremental_cursors_expiry ON pr_agent_harness.review_incremental_cursors (expires_at);

CREATE TABLE pr_agent_harness.review_feedback_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  integration_id uuid NOT NULL,
  platform text NOT NULL CHECK (platform IN ('github','gitlab')),
  origin text NOT NULL CHECK (length(origin) BETWEEN 1 AND 2048),
  repository text NOT NULL CHECK (length(repository) BETWEEN 1 AND 512),
  target text NOT NULL CHECK (length(target) BETWEEN 1 AND 128),
  signal text NOT NULL CHECK (length(signal) BETWEEN 1 AND 4000),
  signal_hash text NOT NULL CHECK (signal_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,integration_id,platform,origin,repository,target,signal_hash),
  FOREIGN KEY (tenant_id,integration_id)
    REFERENCES pr_agent_harness.integration_bindings (tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX review_feedback_signals_lookup ON pr_agent_harness.review_feedback_signals
  (tenant_id,integration_id,platform,origin,repository,target,created_at DESC) WHERE expires_at>created_at;

CREATE TABLE pr_agent_harness.webhook_replay_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  integration_id uuid NOT NULL,
  platform text NOT NULL CHECK (platform IN ('github','gitlab')),
  delivery_id text NOT NULL CHECK (length(delivery_id) BETWEEN 1 AND 256),
  event_name text NOT NULL CHECK (length(event_name) BETWEEN 1 AND 128),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  outcome text NOT NULL CHECK (outcome IN ('succeeded','failed')),
  outcome_code text NOT NULL CHECK (length(outcome_code) BETWEEN 1 AND 128),
  headers_json jsonb NOT NULL CHECK (jsonb_typeof(headers_json)='object'),
  payload_json jsonb NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  raw_body_hash text NOT NULL CHECK (raw_body_hash ~ '^[0-9a-f]{64}$'),
  replay_count integer NOT NULL DEFAULT 0 CHECK (replay_count>=0),
  last_replayed_at timestamptz,
  content_purged_at timestamptz,
  UNIQUE (tenant_id,integration_id,platform,delivery_id,payload_hash,outcome,outcome_code),
  FOREIGN KEY (tenant_id,integration_id)
    REFERENCES pr_agent_harness.integration_bindings (tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX webhook_replay_events_lookup ON pr_agent_harness.webhook_replay_events
  (tenant_id,integration_id,platform,received_at DESC,id);

ALTER TABLE pr_agent_harness.command_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.command_rate_limits FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.review_incremental_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.review_incremental_cursors FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.review_feedback_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.review_feedback_signals FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.webhook_replay_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.webhook_replay_events FORCE ROW LEVEL SECURITY;

CREATE POLICY command_rate_limits_tenant ON pr_agent_harness.command_rate_limits
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY review_incremental_cursors_tenant ON pr_agent_harness.review_incremental_cursors
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY review_feedback_signals_tenant ON pr_agent_harness.review_feedback_signals
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY webhook_replay_events_tenant ON pr_agent_harness.webhook_replay_events
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
