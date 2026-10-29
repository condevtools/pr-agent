CREATE TABLE pr_agent_harness.evidence_records (
    id                 text NOT NULL CHECK (id ~ '^[0-9a-f]{64}$'),
    tenant_id          uuid NOT NULL,
    integration_id     uuid NOT NULL,
    run_id             uuid NOT NULL,
    step_id            uuid NOT NULL,
    step_attempt_id    uuid NOT NULL,
    tool_call_id       uuid NOT NULL,
    repository         text NOT NULL CHECK (length(repository) BETWEEN 1 AND 512),
    head_sha           text NOT NULL CHECK (length(head_sha) BETWEEN 1 AND 128),
    evidence_kind      text NOT NULL CHECK (evidence_kind IN
                         ('file_range','changed_files_search','symbol_references','manifest','ci_status')),
    tool_name          text NOT NULL CHECK (tool_name IN
                         ('read_file_range','search_changed_files','find_symbol_references','read_manifest','read_ci_status')),
    request_hash       text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    content_hash       text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    path               text,
    start_line         integer CHECK (start_line IS NULL OR start_line > 0),
    end_line           integer CHECK (end_line IS NULL OR end_line > 0),
    summary            text NOT NULL CHECK (length(summary) <= 4096),
    truncated          boolean NOT NULL DEFAULT false,
    result_json        jsonb NOT NULL CHECK (jsonb_typeof(result_json) = 'object'),
    content_purged_at  timestamptz,
    created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, id),
    CONSTRAINT evidence_records_run_fk FOREIGN KEY (tenant_id, integration_id, run_id)
      REFERENCES pr_agent_harness.agent_runs (tenant_id, integration_id, id) ON DELETE RESTRICT,
    CONSTRAINT evidence_records_step_fk FOREIGN KEY (tenant_id, run_id, step_id)
      REFERENCES pr_agent_harness.agent_steps (tenant_id, run_id, id) ON DELETE RESTRICT,
    CONSTRAINT evidence_records_attempt_fk FOREIGN KEY (tenant_id, run_id, step_attempt_id)
      REFERENCES pr_agent_harness.step_attempts (tenant_id, run_id, id) ON DELETE RESTRICT,
    CONSTRAINT evidence_records_tool_fk FOREIGN KEY (tenant_id, run_id, tool_call_id)
      REFERENCES pr_agent_harness.tool_calls (tenant_id, run_id, id) ON DELETE RESTRICT,
    CONSTRAINT evidence_records_location_shape CHECK (
      (start_line IS NULL AND end_line IS NULL) OR
      (path IS NOT NULL AND start_line IS NOT NULL AND end_line IS NOT NULL AND end_line >= start_line)
    )
);

CREATE TABLE pr_agent_harness.finding_candidates (
    id                 text NOT NULL CHECK (id ~ '^[0-9a-f]{64}$'),
    tenant_id          uuid NOT NULL,
    integration_id     uuid NOT NULL,
    run_id             uuid NOT NULL,
    step_id            uuid NOT NULL,
    source_role        text NOT NULL CHECK (source_role IN ('security','correctness')),
    head_sha           text NOT NULL CHECK (length(head_sha) BETWEEN 1 AND 128),
    content_hash       text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    record_json        jsonb NOT NULL CHECK (jsonb_typeof(record_json) = 'object'),
    content_purged_at  timestamptz,
    created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, run_id, id),
    CONSTRAINT finding_candidates_run_fk FOREIGN KEY (tenant_id, integration_id, run_id)
      REFERENCES pr_agent_harness.agent_runs (tenant_id, integration_id, id) ON DELETE RESTRICT,
    CONSTRAINT finding_candidates_step_fk FOREIGN KEY (tenant_id, run_id, step_id)
      REFERENCES pr_agent_harness.agent_steps (tenant_id, run_id, id) ON DELETE RESTRICT
);

CREATE TABLE pr_agent_harness.finding_decisions (
    id                 text NOT NULL CHECK (id ~ '^[0-9a-f]{64}$'),
    tenant_id          uuid NOT NULL,
    integration_id     uuid NOT NULL,
    run_id             uuid NOT NULL,
    step_id            uuid NOT NULL,
    candidate_id       text NOT NULL CHECK (candidate_id ~ '^[0-9a-f]{64}$'),
    stage              text NOT NULL CHECK (stage IN ('critic','gate')),
    head_sha           text NOT NULL CHECK (length(head_sha) BETWEEN 1 AND 128),
    content_hash       text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    record_json        jsonb NOT NULL CHECK (jsonb_typeof(record_json) = 'object'),
    content_purged_at  timestamptz,
    created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, id),
    CONSTRAINT finding_decisions_run_fk FOREIGN KEY (tenant_id, integration_id, run_id)
      REFERENCES pr_agent_harness.agent_runs (tenant_id, integration_id, id) ON DELETE RESTRICT,
    CONSTRAINT finding_decisions_step_fk FOREIGN KEY (tenant_id, run_id, step_id)
      REFERENCES pr_agent_harness.agent_steps (tenant_id, run_id, id) ON DELETE RESTRICT,
    CONSTRAINT finding_decisions_candidate_fk FOREIGN KEY (tenant_id, run_id, candidate_id)
      REFERENCES pr_agent_harness.finding_candidates (tenant_id, run_id, id) ON DELETE RESTRICT,
    CONSTRAINT finding_decisions_stage_unique UNIQUE (tenant_id, run_id, stage, candidate_id)
);

CREATE TABLE pr_agent_harness.review_artifacts (
    id                 text NOT NULL CHECK (id ~ '^[0-9a-f]{64}$'),
    tenant_id          uuid NOT NULL,
    integration_id     uuid NOT NULL,
    run_id             uuid NOT NULL,
    workflow_id        text NOT NULL CHECK (workflow_id = 'review.deep.v1'),
    publication_mode   text NOT NULL CHECK (publication_mode = 'shadow'),
    head_sha           text NOT NULL CHECK (length(head_sha) BETWEEN 1 AND 128),
    content_hash       text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    artifact_json      jsonb NOT NULL CHECK (jsonb_typeof(artifact_json) = 'object'),
    content_purged_at  timestamptz,
    created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, id),
    CONSTRAINT review_artifacts_run_unique UNIQUE (tenant_id, run_id),
    CONSTRAINT review_artifacts_run_fk FOREIGN KEY (tenant_id, integration_id, run_id)
      REFERENCES pr_agent_harness.agent_runs (tenant_id, integration_id, id) ON DELETE RESTRICT
);

CREATE INDEX evidence_records_run ON pr_agent_harness.evidence_records (tenant_id,run_id,created_at,id);
CREATE INDEX finding_candidates_run ON pr_agent_harness.finding_candidates (tenant_id,run_id,created_at,id);
CREATE INDEX finding_decisions_run ON pr_agent_harness.finding_decisions (tenant_id,run_id,stage,created_at,id);

ALTER TABLE pr_agent_harness.evidence_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.evidence_records FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.finding_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.finding_candidates FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.finding_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.finding_decisions FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.review_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_agent_harness.review_artifacts FORCE ROW LEVEL SECURITY;

CREATE POLICY evidence_records_tenant_policy ON pr_agent_harness.evidence_records
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY finding_candidates_tenant_policy ON pr_agent_harness.finding_candidates
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY finding_decisions_tenant_policy ON pr_agent_harness.finding_decisions
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY review_artifacts_tenant_policy ON pr_agent_harness.review_artifacts
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

COMMENT ON TABLE pr_agent_harness.evidence_records IS
  'Immutable, fixed-revision evidence derived only from successful durable read-only tool steps.';
COMMENT ON TABLE pr_agent_harness.review_artifacts IS
  'Immutable deep-review shadow artifact; raw content is removable by the administrative retention protocol.';
