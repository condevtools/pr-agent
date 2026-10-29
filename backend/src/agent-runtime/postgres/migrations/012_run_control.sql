ALTER TABLE pr_agent_harness.agent_runs
  ADD COLUMN event_retention_floor bigint NOT NULL DEFAULT 1 CHECK (event_retention_floor > 0),
  ADD COLUMN publication_outcome_generation bigint NOT NULL DEFAULT 0 CHECK (publication_outcome_generation >= 0),
  ADD COLUMN next_outcome_scan_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN waiting_batch_id uuid,
  ADD COLUMN waiting_operation_set_hash text,
  ADD CONSTRAINT agent_runs_control_identity UNIQUE (tenant_id,integration_id,id),
  ADD CONSTRAINT agent_runs_waiting_batch_fk FOREIGN KEY (tenant_id,waiting_batch_id)
    REFERENCES pr_agent_harness.publication_batches (tenant_id,id),
  ADD CONSTRAINT agent_runs_waiting_batch_shape CHECK (
    (waiting_batch_id IS NULL AND waiting_operation_set_hash IS NULL)
    OR (waiting_batch_id IS NOT NULL AND waiting_operation_set_hash ~ '^[a-f0-9]{64}$'));

ALTER TABLE pr_agent_harness.run_events ADD COLUMN event_key text;
CREATE UNIQUE INDEX run_events_idempotent_fact
  ON pr_agent_harness.run_events (tenant_id,run_id,event_key) WHERE event_key IS NOT NULL;

CREATE INDEX agent_runs_outcome_scan ON pr_agent_harness.agent_runs (tenant_id,integration_id,next_outcome_scan_at)
  WHERE status IN ('waiting_for_reconciliation','succeeded','failed','cancelled');

CREATE TABLE pr_agent_harness.run_command_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  integration_id uuid NOT NULL,
  run_id uuid NOT NULL,
  command_kind text NOT NULL CHECK (command_kind IN ('cancel','resume','retry','recover','rerun')),
  command_key text NOT NULL CHECK (length(command_key) BETWEEN 1 AND 200),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  actor_type text NOT NULL CHECK (actor_type IN ('user','service')),
  actor_id text NOT NULL CHECK (length(actor_id)>0),
  request_json jsonb NOT NULL CHECK (jsonb_typeof(request_json)='object'),
  result_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(result_json)='object'),
  status text NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted','completed','rejected')),
  accepted_version bigint NOT NULL CHECK (accepted_version>=0),
  resulting_version bigint CHECK (resulting_version>=0),
  new_run_id uuid,
  job_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,run_id,id),
  UNIQUE (tenant_id,run_id,command_key),
  FOREIGN KEY (tenant_id,integration_id,run_id)
    REFERENCES pr_agent_harness.agent_runs (tenant_id,integration_id,id),
  FOREIGN KEY (tenant_id,integration_id,new_run_id)
    REFERENCES pr_agent_harness.agent_runs (tenant_id,integration_id,id),
  FOREIGN KEY (tenant_id,run_id,job_id)
    REFERENCES pr_agent_harness.job_queue (tenant_id,run_id,id)
);

CREATE TABLE pr_agent_harness.run_waits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  operation_set_hash text NOT NULL CHECK (operation_set_hash ~ '^[a-f0-9]{64}$'),
  business_operation_id text NOT NULL,
  operation_version bigint NOT NULL CHECK (operation_version>=0),
  intent_hash text NOT NULL CHECK (intent_hash ~ '^[a-f0-9]{64}$'),
  version bigint NOT NULL DEFAULT 1 CHECK (version>0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','consumed','superseded')),
  allowed_decisions jsonb NOT NULL CHECK (jsonb_typeof(allowed_decisions)='array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  UNIQUE (tenant_id,run_id,id),
  UNIQUE (tenant_id,run_id,business_operation_id,operation_version),
  FOREIGN KEY (tenant_id,run_id,batch_id)
    REFERENCES pr_agent_harness.run_publication_batches (tenant_id,run_id,batch_id),
  FOREIGN KEY (tenant_id,business_operation_id)
    REFERENCES pr_agent_harness.repository_operations (tenant_id,business_operation_id)
);
CREATE UNIQUE INDEX run_waits_one_open ON pr_agent_harness.run_waits (tenant_id,run_id) WHERE status='open';

CREATE TABLE pr_agent_harness.run_wait_decisions (
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  wait_id uuid NOT NULL,
  command_receipt_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('confirm_occurred','confirm_not_occurred','authorize_retry','abandon_publication')),
  evidence_json jsonb NOT NULL CHECK (jsonb_typeof(evidence_json)='object'),
  remote_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,run_id,wait_id),
  UNIQUE (tenant_id,run_id,command_receipt_id),
  FOREIGN KEY (tenant_id,run_id,wait_id) REFERENCES pr_agent_harness.run_waits (tenant_id,run_id,id),
  FOREIGN KEY (tenant_id,run_id,command_receipt_id) REFERENCES pr_agent_harness.run_command_receipts (tenant_id,run_id,id)
);

ALTER TABLE pr_agent_harness.job_queue
  ADD COLUMN expected_run_version bigint CHECK (expected_run_version>=0),
  ADD COLUMN expected_batch_id uuid,
  ADD COLUMN expected_operation_set_hash text CHECK (expected_operation_set_hash ~ '^[a-f0-9]{64}$'),
  ADD COLUMN outcome_generation bigint CHECK (outcome_generation>0),
  ADD COLUMN command_receipt_id uuid,
  ADD COLUMN wait_id uuid,
  ADD COLUMN wait_version bigint CHECK (wait_version>0),
  ADD COLUMN job_payload_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(job_payload_json)='object'),
  ADD FOREIGN KEY (tenant_id,run_id,expected_batch_id)
    REFERENCES pr_agent_harness.run_publication_batches (tenant_id,run_id,batch_id),
  ADD FOREIGN KEY (tenant_id,run_id,command_receipt_id)
    REFERENCES pr_agent_harness.run_command_receipts (tenant_id,run_id,id),
  ADD FOREIGN KEY (tenant_id,run_id,wait_id)
    REFERENCES pr_agent_harness.run_waits (tenant_id,run_id,id);

CREATE UNIQUE INDEX job_queue_publication_outcome_once
  ON pr_agent_harness.job_queue (tenant_id,run_id,outcome_generation,expected_operation_set_hash)
  WHERE job_kind='publication_outcome';
CREATE UNIQUE INDEX job_queue_manual_receipt_once
  ON pr_agent_harness.job_queue (tenant_id,run_id,command_receipt_id)
  WHERE job_kind='manual_resume';

ALTER TABLE pr_agent_harness.run_command_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.run_command_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.run_waits ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.run_waits FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.run_wait_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.run_wait_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY run_command_receipts_tenant ON pr_agent_harness.run_command_receipts
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY run_waits_tenant ON pr_agent_harness.run_waits
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY run_wait_decisions_tenant ON pr_agent_harness.run_wait_decisions
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

COMMENT ON TABLE pr_agent_harness.run_command_receipts IS 'Authorized idempotent Run control requests. A receipt does not grant a Run lease.';
COMMENT ON TABLE pr_agent_harness.run_waits IS 'Exact immutable publication intent awaiting a single authorized decision.';
