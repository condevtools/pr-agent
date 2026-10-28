ALTER TABLE pr_agent_harness.integration_bindings
  ADD COLUMN provider_repository_id text,
  ADD COLUMN provider_actor_id text,
  ADD COLUMN credential_ref text,
  ADD COLUMN publication_state text NOT NULL DEFAULT 'blocked'
    CHECK (publication_state IN ('blocked', 'active', 'draining')),
  ADD COLUMN publication_generation bigint NOT NULL DEFAULT 0 CHECK (publication_generation >= 0),
  ADD COLUMN authority_version bigint NOT NULL DEFAULT 0 CHECK (authority_version >= 0),
  ADD COLUMN quiescence_receipt jsonb,
  ADD CONSTRAINT integration_provider_repository_id CHECK
    (provider_repository_id IS NULL OR provider_repository_id ~ '^[1-9][0-9]*$'),
  ADD CONSTRAINT integration_provider_actor_id CHECK
    (provider_actor_id IS NULL OR provider_actor_id ~ '^[1-9][0-9]*$'),
  ADD CONSTRAINT integration_active_authority CHECK
    (publication_state = 'blocked' OR
      (provider_repository_id IS NOT NULL AND provider_actor_id IS NOT NULL
       AND credential_ref IS NOT NULL AND publication_generation > 0
       AND quiescence_receipt IS NOT NULL));

CREATE UNIQUE INDEX integration_bindings_immutable_target
  ON pr_agent_harness.integration_bindings(platform, origin, provider_repository_id)
  WHERE provider_repository_id IS NOT NULL;

COMMENT ON COLUMN pr_agent_harness.integration_bindings.quiescence_receipt IS
  'Operator evidence of stopped/drained pre-ledger publishers; PG cannot fence an old binary that does not consult this registry.';
