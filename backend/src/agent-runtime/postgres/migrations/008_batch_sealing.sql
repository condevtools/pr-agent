ALTER TABLE pr_agent_harness.publication_batches
  ADD COLUMN seal_state text NOT NULL DEFAULT 'building'
    CHECK (seal_state IN ('building', 'sealed')),
  ADD COLUMN sealed_at timestamptz,
  ADD COLUMN operation_count integer CHECK (operation_count >= 0),
  ADD COLUMN operation_set_hash text CHECK (
    operation_set_hash IS NULL OR operation_set_hash ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT publication_batches_seal_shape CHECK (
    (seal_state = 'building' AND sealed_at IS NULL
      AND operation_count IS NULL AND operation_set_hash IS NULL)
    OR
    (seal_state = 'sealed' AND sealed_at IS NOT NULL
      AND operation_count IS NOT NULL AND operation_set_hash IS NOT NULL)
  );

WITH frozen_sets AS (
  SELECT pb.tenant_id, pb.id,
         count(pbo.business_operation_id)::integer AS operation_count,
         encode(
           public.digest(
             COALESCE(
               string_agg(
                 pbo.ordinal::text || ':' || pbo.business_operation_id,
                 E'\n' ORDER BY pbo.ordinal
               ),
               ''
             ),
             'sha256'
           ),
           'hex'
         ) AS operation_set_hash
  FROM pr_agent_harness.publication_batches pb
  LEFT JOIN pr_agent_harness.publication_batch_operations pbo
    ON pbo.tenant_id = pb.tenant_id AND pbo.batch_id = pb.id
  GROUP BY pb.tenant_id, pb.id
)
UPDATE pr_agent_harness.publication_batches pb
SET seal_state = 'sealed', sealed_at = now(),
    operation_count = frozen_sets.operation_count,
    operation_set_hash = frozen_sets.operation_set_hash
FROM frozen_sets
WHERE pb.tenant_id = frozen_sets.tenant_id AND pb.id = frozen_sets.id;

UPDATE pr_agent_harness.repository_operations ro
SET status = 'manual_review', outcome_code = NULL, remote_id = NULL,
    last_error_code = 'sealed_batch_payload_unavailable', resolved_at = NULL,
    version = version + 1, updated_at = now()
WHERE ro.payload_json IS NULL
  AND ro.status IN ('prepared', 'in_flight', 'unknown')
  AND EXISTS (
    SELECT 1
    FROM pr_agent_harness.publication_batch_operations pbo
    WHERE pbo.tenant_id = ro.tenant_id
      AND pbo.business_operation_id = ro.business_operation_id
  );

UPDATE pr_agent_harness.publication_batches pb
SET status = 'waiting_reconciliation', updated_at = now()
WHERE EXISTS (
  SELECT 1
  FROM pr_agent_harness.publication_batch_operations pbo
  JOIN pr_agent_harness.repository_operations ro
    ON ro.tenant_id = pbo.tenant_id
   AND ro.business_operation_id = pbo.business_operation_id
  WHERE pbo.tenant_id = pb.tenant_id AND pbo.batch_id = pb.id
    AND ro.payload_json IS NULL
);

CREATE FUNCTION pr_agent_harness.guard_publication_batch_seal()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pr_agent_harness
AS $$
DECLARE
  actual_count integer;
  actual_hash text;
  has_missing_payload boolean;
BEGIN
  IF OLD.seal_state = 'sealed' THEN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.integration_id IS DISTINCT FROM OLD.integration_id
      OR NEW.platform IS DISTINCT FROM OLD.platform
      OR NEW.origin IS DISTINCT FROM OLD.origin
      OR NEW.repository IS DISTINCT FROM OLD.repository
      OR NEW.target IS DISTINCT FROM OLD.target
      OR NEW.revision IS DISTINCT FROM OLD.revision
      OR NEW.authority_generation IS DISTINCT FROM OLD.authority_generation
      OR NEW.source_key IS DISTINCT FROM OLD.source_key
      OR NEW.source_hash IS DISTINCT FROM OLD.source_hash
      OR NEW.seal_state IS DISTINCT FROM OLD.seal_state
      OR NEW.sealed_at IS DISTINCT FROM OLD.sealed_at
      OR NEW.operation_count IS DISTINCT FROM OLD.operation_count
      OR NEW.operation_set_hash IS DISTINCT FROM OLD.operation_set_hash THEN
      RAISE EXCEPTION 'sealed publication batch identity is immutable';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.seal_state = 'sealed' THEN
    SELECT count(*)::integer,
           encode(
             public.digest(
               COALESCE(
                 string_agg(
                   pbo.ordinal::text || ':' || pbo.business_operation_id,
                   E'\n' ORDER BY pbo.ordinal
                 ),
                 ''
               ),
               'sha256'
             ),
             'hex'
           ),
           COALESCE(bool_or(ro.payload_json IS NULL), false)
    INTO actual_count, actual_hash, has_missing_payload
    FROM pr_agent_harness.publication_batch_operations pbo
    JOIN pr_agent_harness.repository_operations ro
      ON ro.tenant_id = pbo.tenant_id
     AND ro.business_operation_id = pbo.business_operation_id
    WHERE pbo.tenant_id = OLD.tenant_id AND pbo.batch_id = OLD.id;

    IF actual_count = 0 OR has_missing_payload
      OR NEW.operation_count IS DISTINCT FROM actual_count
      OR NEW.operation_set_hash IS DISTINCT FROM actual_hash
      OR NEW.sealed_at IS NULL THEN
      RAISE EXCEPTION 'publication batch seal does not match its complete frozen operation set';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER publication_batches_guard_seal
BEFORE UPDATE ON pr_agent_harness.publication_batches
FOR EACH ROW EXECUTE FUNCTION pr_agent_harness.guard_publication_batch_seal();

CREATE FUNCTION pr_agent_harness.guard_sealed_batch_links()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pr_agent_harness
AS $$
BEGIN
  IF (
    TG_OP <> 'INSERT' AND EXISTS (
      SELECT 1
      FROM pr_agent_harness.publication_batches pb
      WHERE pb.tenant_id = OLD.tenant_id AND pb.id = OLD.batch_id
        AND pb.seal_state = 'sealed'
    )
  ) OR (
    TG_OP <> 'DELETE' AND EXISTS (
      SELECT 1
      FROM pr_agent_harness.publication_batches pb
      WHERE pb.tenant_id = NEW.tenant_id AND pb.id = NEW.batch_id
        AND pb.seal_state = 'sealed'
    )
  ) THEN
    RAISE EXCEPTION 'sealed publication batch membership is immutable';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER publication_batch_operations_guard_sealed
BEFORE INSERT OR UPDATE OR DELETE ON pr_agent_harness.publication_batch_operations
FOR EACH ROW EXECUTE FUNCTION pr_agent_harness.guard_sealed_batch_links();

CREATE FUNCTION pr_agent_harness.guard_sealed_operation_identity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pr_agent_harness
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pr_agent_harness.publication_batch_operations pbo
    JOIN pr_agent_harness.publication_batches pb
      ON pb.tenant_id = pbo.tenant_id AND pb.id = pbo.batch_id
    WHERE pbo.tenant_id = OLD.tenant_id
      AND pbo.business_operation_id = OLD.business_operation_id
      AND pb.seal_state = 'sealed'
  ) AND (
    NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.integration_id IS DISTINCT FROM OLD.integration_id
    OR NEW.business_operation_id IS DISTINCT FROM OLD.business_operation_id
    OR NEW.platform IS DISTINCT FROM OLD.platform
    OR NEW.origin IS DISTINCT FROM OLD.origin
    OR NEW.repository IS DISTINCT FROM OLD.repository
    OR NEW.target IS DISTINCT FROM OLD.target
    OR NEW.revision IS DISTINCT FROM OLD.revision
    OR NEW.operation_type IS DISTINCT FROM OLD.operation_type
    OR NEW.authority_generation IS DISTINCT FROM OLD.authority_generation
    OR NEW.publication_slot IS DISTINCT FROM OLD.publication_slot
    OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
    OR NEW.payload_json IS DISTINCT FROM OLD.payload_json
    OR NEW.marker IS DISTINCT FROM OLD.marker
  ) THEN
    RAISE EXCEPTION 'sealed publication operation identity and payload are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER repository_operations_guard_sealed_identity
BEFORE UPDATE ON pr_agent_harness.repository_operations
FOR EACH ROW EXECUTE FUNCTION pr_agent_harness.guard_sealed_operation_identity();
