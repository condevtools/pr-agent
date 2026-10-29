ALTER TABLE pr_agent_harness.agent_runs
  ADD COLUMN content_purged_at timestamptz;
ALTER TABLE pr_agent_harness.agent_steps
  ADD COLUMN content_purged_at timestamptz;
ALTER TABLE pr_agent_harness.checkpoints
  ADD COLUMN content_purged_at timestamptz;
ALTER TABLE pr_agent_harness.tool_calls
  ADD COLUMN content_purged_at timestamptz;
ALTER TABLE pr_agent_harness.model_calls
  ADD COLUMN content_purged_at timestamptz;
ALTER TABLE pr_agent_harness.usage_records
  ADD COLUMN content_purged_at timestamptz;

CREATE INDEX agent_runs_retention_candidates
  ON pr_agent_harness.agent_runs (tenant_id,finished_at,id)
  WHERE status IN ('succeeded','failed','cancelled') AND content_purged_at IS NULL;

COMMENT ON COLUMN pr_agent_harness.agent_runs.content_purged_at IS
  'Administrative retention timestamp. input_json is replaced with an empty object; identity and hashes remain.';
COMMENT ON COLUMN pr_agent_harness.model_calls.content_purged_at IS
  'Administrative retention timestamp. Raw request metadata and response content are removed; hashes and usage remain.';
