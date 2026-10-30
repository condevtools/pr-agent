ALTER TABLE pr_agent_harness.model_budget_reservations
  ADD COLUMN reconciliation_grace_ms integer NOT NULL DEFAULT 300000
    CHECK (reconciliation_grace_ms > 0),
  ADD COLUMN reconcile_max_attempts integer NOT NULL DEFAULT 5
    CHECK (reconcile_max_attempts > 0),
  ADD COLUMN reconcile_initial_backoff_ms integer NOT NULL DEFAULT 1000
    CHECK (reconcile_initial_backoff_ms > 0),
  ADD COLUMN reconcile_max_backoff_ms integer NOT NULL DEFAULT 60000
    CHECK (reconcile_max_backoff_ms >= reconcile_initial_backoff_ms),
  ADD COLUMN reconciliation_due_at timestamptz,
  ADD COLUMN next_reconcile_at timestamptz,
  ADD COLUMN reconcile_attempt_count integer NOT NULL DEFAULT 0
    CHECK (reconcile_attempt_count >= 0),
  ADD COLUMN last_reconcile_error text,
  ADD COLUMN current_provider_usage_revision text
    CHECK (current_provider_usage_revision IS NULL OR length(current_provider_usage_revision) BETWEEN 1 AND 128),
  ADD COLUMN settlement_kind text
    CHECK (settlement_kind IN ('actual','estimated_upper_bound'));

UPDATE pr_agent_harness.model_budget_reservations
SET settlement_kind='actual'
WHERE status='settled';

UPDATE pr_agent_harness.model_budget_reservations
SET reconciliation_due_at=updated_at + interval '5 minutes',
    next_reconcile_at=updated_at + interval '5 minutes'
WHERE status='pending';

ALTER TABLE pr_agent_harness.model_budget_reservations
  DROP CONSTRAINT model_budget_actual_shape,
  ADD CONSTRAINT model_budget_actual_shape CHECK (
    (status = 'settled' AND actual_input_tokens IS NOT NULL
     AND actual_output_tokens IS NOT NULL AND actual_cost_micros IS NOT NULL
     AND settlement_kind IS NOT NULL)
    OR (status <> 'settled' AND actual_input_tokens IS NULL
        AND actual_output_tokens IS NULL AND actual_cost_micros IS NULL
        AND settlement_kind IS NULL)
  ),
  ADD CONSTRAINT model_budget_reconcile_shape CHECK (
    (status = 'pending' AND reconciliation_due_at IS NOT NULL AND next_reconcile_at IS NOT NULL)
    OR status <> 'pending'
  );

ALTER TABLE pr_agent_harness.usage_records
  DROP CONSTRAINT usage_records_measurement_status_check,
  DROP CONSTRAINT usage_measurement_shape,
  ADD CONSTRAINT usage_records_measurement_status_check
    CHECK (measurement_status IN ('actual','unavailable','estimated_upper_bound')),
  ADD CONSTRAINT usage_measurement_shape CHECK (
    (measurement_status IN ('actual','estimated_upper_bound') AND input_tokens IS NOT NULL
     AND output_tokens IS NOT NULL AND cost_micros IS NOT NULL)
    OR (measurement_status = 'unavailable' AND input_tokens IS NULL
        AND cached_input_tokens IS NULL AND cache_write_input_tokens IS NULL
        AND output_tokens IS NULL AND reasoning_tokens IS NULL
        AND tool_input_tokens IS NULL AND total_tokens IS NULL AND cost_micros IS NULL)
  );

CREATE TABLE pr_agent_harness.model_usage_adjustments (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                uuid NOT NULL,
    run_id                   uuid NOT NULL,
    model_call_id            uuid NOT NULL,
    provider_usage_revision  text NOT NULL CHECK (length(provider_usage_revision) BETWEEN 1 AND 128),
    supersedes_provider_usage_revision text
                               CHECK (supersedes_provider_usage_revision IS NULL
                                 OR length(supersedes_provider_usage_revision) BETWEEN 1 AND 128),
    payload_hash              text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
    evidence_reference        text NOT NULL CHECK (length(evidence_reference) BETWEEN 1 AND 2048),
    actual_input_tokens       bigint NOT NULL CHECK (actual_input_tokens >= 0),
    actual_output_tokens      bigint NOT NULL CHECK (actual_output_tokens >= 0),
    actual_cost_micros        bigint NOT NULL CHECK (actual_cost_micros >= 0),
    delta_input_tokens        bigint NOT NULL,
    delta_output_tokens       bigint NOT NULL,
    delta_cost_micros         bigint NOT NULL,
    actor_type                text NOT NULL CHECK (actor_type IN ('user','service','system')),
    actor_id                  text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 200),
    content_purged_at         timestamptz,
    created_at                timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT model_usage_adjustment_unique
      UNIQUE (tenant_id,model_call_id,provider_usage_revision),
    CONSTRAINT model_usage_adjustment_call_fk
      FOREIGN KEY (tenant_id,run_id,model_call_id)
      REFERENCES pr_agent_harness.model_calls (tenant_id,run_id,id) ON DELETE RESTRICT
);

ALTER TABLE pr_agent_harness.model_usage_adjustments
  ADD CONSTRAINT model_usage_adjustment_supersedes_fk
  FOREIGN KEY (tenant_id,model_call_id,supersedes_provider_usage_revision)
  REFERENCES pr_agent_harness.model_usage_adjustments
    (tenant_id,model_call_id,provider_usage_revision) ON DELETE RESTRICT;

ALTER TABLE pr_agent_harness.model_budget_reservations
  ADD CONSTRAINT model_budget_current_usage_revision_fk
  FOREIGN KEY (tenant_id,model_call_id,current_provider_usage_revision)
  REFERENCES pr_agent_harness.model_usage_adjustments
    (tenant_id,model_call_id,provider_usage_revision) ON DELETE RESTRICT;

CREATE INDEX model_budget_reconcile_due
  ON pr_agent_harness.model_budget_reservations
  (tenant_id,next_reconcile_at,model_call_id)
  WHERE status='pending';

ALTER TABLE pr_agent_harness.model_usage_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.model_usage_adjustments FORCE ROW LEVEL SECURITY;
CREATE POLICY model_usage_adjustment_tenant_policy
  ON pr_agent_harness.model_usage_adjustments
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE FUNCTION pr_agent_harness.list_due_model_budget_tenants(max_rows integer)
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pr_agent_harness
AS $$
  SELECT due.tenant_id
  FROM (
    SELECT br.tenant_id,min(br.next_reconcile_at) AS due_at
    FROM model_budget_reservations br
    WHERE br.status='pending' AND br.reconciliation_due_at<=clock_timestamp()
      AND br.next_reconcile_at<=clock_timestamp()
    GROUP BY br.tenant_id
    UNION ALL
    SELECT e.tenant_id,min(e.updated_at) AS due_at
    FROM run_budget_envelopes e
    JOIN agent_runs r ON r.tenant_id=e.tenant_id AND r.id=e.run_id
    WHERE e.status<>'closed' AND r.status IN ('succeeded','failed','cancelled')
    GROUP BY e.tenant_id
  ) due
  GROUP BY due.tenant_id
  ORDER BY min(due.due_at),due.tenant_id
  LIMIT LEAST(GREATEST(COALESCE(max_rows,1),1),1000)
$$;

REVOKE ALL ON FUNCTION pr_agent_harness.list_due_model_budget_tenants(integer) FROM PUBLIC;
