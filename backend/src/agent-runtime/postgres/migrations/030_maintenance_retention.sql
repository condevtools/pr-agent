CREATE TABLE pr_agent_harness.maintenance_receipts (
  cycle_id uuid PRIMARY KEY,
  action text NOT NULL CHECK (action IN ('preview','apply')),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  policy_json jsonb NOT NULL CHECK (jsonb_typeof(policy_json)='object'),
  result_json jsonb NOT NULL CHECK (jsonb_typeof(result_json)='object'),
  actor_role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX maintenance_receipts_retention
  ON pr_agent_harness.maintenance_receipts (created_at,cycle_id);

ALTER TABLE pr_agent_harness.dead_letter_jobs
  ADD COLUMN content_purged_at timestamptz;

ALTER TABLE pr_agent_harness.runtime_process_heartbeats
  DROP CONSTRAINT runtime_process_heartbeats_process_role_check,
  ADD CONSTRAINT runtime_process_heartbeats_process_role_check
    CHECK (process_role IN ('worker','recovery','verifier','maintenance'));

CREATE OR REPLACE FUNCTION pr_agent_harness.record_runtime_process_heartbeat(
  requested_role text, requested_instance_id uuid, requested_report jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pr_agent_harness AS $$
BEGIN
  IF requested_role NOT IN ('worker','recovery','verifier','maintenance')
     OR jsonb_typeof(requested_report)<>'object' THEN
    RAISE EXCEPTION 'invalid runtime process heartbeat';
  END IF;
  IF (requested_role='verifier' AND session_user<>'pr_agent_verifier')
     OR (requested_role='maintenance' AND session_user<>'pr_agent_maintenance')
     OR (requested_role IN ('worker','recovery') AND session_user<>'pr_agent_app') THEN
    RAISE EXCEPTION 'runtime process heartbeat role mismatch' USING ERRCODE='42501';
  END IF;
  INSERT INTO pr_agent_harness.runtime_process_heartbeats
    (process_role,instance_id,capability_report)
  VALUES (requested_role,requested_instance_id,requested_report)
  ON CONFLICT (process_role,instance_id) DO UPDATE
  SET heartbeat_at=clock_timestamp(),capability_report=EXCLUDED.capability_report;
END $$;

CREATE OR REPLACE FUNCTION pr_agent_harness.remove_runtime_process_heartbeat(
  requested_role text, requested_instance_id uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pr_agent_harness AS $$
BEGIN
  IF (requested_role='verifier' AND session_user<>'pr_agent_verifier')
     OR (requested_role='maintenance' AND session_user<>'pr_agent_maintenance')
     OR (requested_role IN ('worker','recovery') AND session_user<>'pr_agent_app')
     OR requested_role NOT IN ('worker','recovery','verifier','maintenance') THEN
    RAISE EXCEPTION 'runtime process heartbeat role mismatch' USING ERRCODE='42501';
  END IF;
  DELETE FROM pr_agent_harness.runtime_process_heartbeats
  WHERE process_role=requested_role AND instance_id=requested_instance_id;
END $$;

CREATE FUNCTION pr_agent_harness.assert_maintenance_session() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pr_agent_harness AS $$
BEGIN
  IF session_user<>'pr_agent_maintenance' THEN
    RAISE EXCEPTION 'maintenance role mismatch' USING ERRCODE='42501';
  END IF;
END $$;

CREATE FUNCTION pr_agent_harness.maintenance_request_hash(
  requested_action text,content_days integer,replay_days integer,trace_days integer,batch_limit integer
) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT encode(public.digest(requested_action||':'||content_days::text||':'||replay_days::text||':'
    ||trace_days::text||':'||batch_limit::text,'sha256'),'hex')
$$;

CREATE FUNCTION pr_agent_harness.validate_maintenance_request(
  requested_action text,content_days integer,replay_days integer,trace_days integer,batch_limit integer
) RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
BEGIN
  IF requested_action IS NULL OR content_days IS NULL OR replay_days IS NULL
     OR trace_days IS NULL OR batch_limit IS NULL
     OR requested_action NOT IN ('preview','apply') OR content_days<7 OR content_days>=replay_days
     OR replay_days>=trace_days OR trace_days>3650 OR batch_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'invalid maintenance retention policy';
  END IF;
END $$;

CREATE FUNCTION pr_agent_harness.maintenance_run_has_legacy_strong_reference(
  requested_tenant_id uuid,requested_run_id uuid
) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,pr_agent_harness AS $$
  SELECT EXISTS (SELECT 1 FROM pr_agent_harness.evolution_run_assignments row
      WHERE row.tenant_id=requested_tenant_id AND row.run_id=requested_run_id)
    OR EXISTS (SELECT 1 FROM pr_agent_harness.evolution_proposal_sources row
      WHERE row.tenant_id=requested_tenant_id AND row.proposal_run_id=requested_run_id)
    OR EXISTS (SELECT 1 FROM pr_agent_harness.eval_fixtures row
      WHERE row.tenant_id=requested_tenant_id AND row.run_id=requested_run_id)
    OR EXISTS (SELECT 1 FROM pr_agent_harness.eval_cases row
      WHERE row.tenant_id=requested_tenant_id AND row.source_run_id=requested_run_id)
    OR EXISTS (SELECT 1 FROM pr_agent_harness.eval_results row
      WHERE row.tenant_id=requested_tenant_id AND row.child_run_id=requested_run_id)
    OR EXISTS (SELECT 1 FROM pr_agent_harness.trusted_review_label_sets row
      WHERE row.tenant_id=requested_tenant_id AND row.source_run_id=requested_run_id)
    OR EXISTS (SELECT 1 FROM pr_agent_harness.fix_run_sources row
      WHERE row.tenant_id=requested_tenant_id
        AND (row.run_id=requested_run_id OR row.source_review_run_id=requested_run_id))
    OR EXISTS (SELECT 1 FROM pr_agent_harness.fix_proposals row
      WHERE row.tenant_id=requested_tenant_id AND row.run_id=requested_run_id)
    OR EXISTS (SELECT 1 FROM pr_agent_harness.verification_jobs row
      WHERE row.tenant_id=requested_tenant_id AND row.run_id=requested_run_id)
    OR EXISTS (SELECT 1 FROM pr_agent_harness.fix_approval_requests row
      WHERE row.tenant_id=requested_tenant_id
        AND (row.proposal_run_id=requested_run_id OR row.approved_publish_run_id=requested_run_id))
$$;

CREATE FUNCTION pr_agent_harness.fix_hold_releasable(
  requested_tenant_id uuid,requested_run_id uuid,content_days integer
)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,pr_agent_harness AS $$
  SELECT EXISTS (
    SELECT 1 FROM pr_agent_harness.agent_runs r
    WHERE r.tenant_id=requested_tenant_id AND r.id=requested_run_id
      AND r.status IN ('succeeded','failed','cancelled')
      AND r.finished_at<clock_timestamp()-make_interval(days=>content_days)
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.agent_runs child
        WHERE child.tenant_id=r.tenant_id AND child.parent_run_id=r.id
          AND child.status NOT IN ('succeeded','failed','cancelled'))
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.verification_jobs v
        WHERE v.tenant_id=r.tenant_id AND v.run_id=r.id AND v.status IN ('queued','leased'))
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.model_calls model
        WHERE model.tenant_id=r.tenant_id AND model.run_id=r.id
          AND model.status IN ('prepared','in_flight','unknown'))
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.model_budget_reservations reservation
        WHERE reservation.tenant_id=r.tenant_id AND reservation.run_id=r.id
          AND reservation.status IN ('reserved','pending'))
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.run_budget_envelopes budget
        WHERE budget.tenant_id=r.tenant_id AND budget.run_id=r.id AND budget.status<>'closed')
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.run_publication_batches rb
        JOIN pr_agent_harness.publication_batches batch
          ON batch.tenant_id=rb.tenant_id AND batch.id=rb.batch_id
        JOIN pr_agent_harness.publication_batch_operations link
          ON link.tenant_id=batch.tenant_id AND link.batch_id=batch.id
        JOIN pr_agent_harness.repository_operations operation
          ON operation.tenant_id=link.tenant_id
          AND operation.business_operation_id=link.business_operation_id
        WHERE rb.tenant_id=r.tenant_id AND rb.run_id=r.id
          AND (batch.status IN ('pending','waiting_reconciliation')
            OR operation.status IN ('prepared','in_flight','unknown','manual_review')))
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.fix_approval_requests a
        WHERE a.tenant_id=r.tenant_id AND a.proposal_run_id=r.id
          AND ((a.status IN ('open','approved') AND a.expires_at>clock_timestamp())
            OR EXISTS (SELECT 1 FROM pr_agent_harness.agent_runs publish
              WHERE publish.tenant_id=a.tenant_id AND publish.id=a.approved_publish_run_id
                AND publish.status NOT IN ('succeeded','failed','cancelled'))
            OR EXISTS (SELECT 1 FROM pr_agent_harness.run_publication_batches rb
              JOIN pr_agent_harness.publication_batches b
                ON b.tenant_id=rb.tenant_id AND b.id=rb.batch_id
              JOIN pr_agent_harness.publication_batch_operations bo
                ON bo.tenant_id=b.tenant_id AND bo.batch_id=b.id
              JOIN pr_agent_harness.repository_operations o
                ON o.tenant_id=bo.tenant_id AND o.business_operation_id=bo.business_operation_id
              WHERE rb.tenant_id=a.tenant_id AND rb.run_id=a.approved_publish_run_id
                AND (b.status IN ('pending','waiting_reconciliation')
                  OR o.status IN ('prepared','in_flight','unknown','manual_review')))))
  )
$$;

CREATE FUNCTION pr_agent_harness.maintenance_run_content_eligible(
  requested_tenant_id uuid,requested_run_id uuid,content_days integer
) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,pr_agent_harness AS $$
  SELECT EXISTS (
    SELECT 1 FROM pr_agent_harness.agent_runs r
    WHERE r.tenant_id=requested_tenant_id AND r.id=requested_run_id
      AND r.status IN ('succeeded','failed','cancelled') AND r.content_purged_at IS NULL
      AND r.finished_at<clock_timestamp()-make_interval(days=>content_days)
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.agent_runs child
        WHERE child.tenant_id=r.tenant_id AND child.parent_run_id=r.id
          AND child.status NOT IN ('succeeded','failed','cancelled'))
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.run_budget_envelopes budget
        WHERE budget.tenant_id=r.tenant_id AND budget.run_id=r.id
          AND budget.status<>'closed')
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.model_calls model
        WHERE model.tenant_id=r.tenant_id AND model.run_id=r.id
          AND model.status IN ('prepared','in_flight','unknown'))
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.run_artifact_holds hold
        LEFT JOIN pr_agent_harness.run_artifact_hold_releases release
          ON release.tenant_id=hold.tenant_id AND release.run_id=hold.run_id
          AND release.artifact_hash=hold.artifact_hash AND release.hold_key=hold.hold_key
        WHERE hold.tenant_id=r.tenant_id AND hold.run_id=r.id AND release.hold_key IS NULL)
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.fix_approval_requests approval
        WHERE approval.tenant_id=r.tenant_id AND approval.proposal_run_id=r.id
          AND ((approval.status IN ('open','approved') AND approval.expires_at>clock_timestamp())
            OR EXISTS (SELECT 1 FROM pr_agent_harness.agent_runs publish
              WHERE publish.tenant_id=approval.tenant_id
                AND publish.id=approval.approved_publish_run_id
                AND publish.status NOT IN ('succeeded','failed','cancelled'))))
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.run_publication_batches rb
        JOIN pr_agent_harness.publication_batches batch
          ON batch.tenant_id=rb.tenant_id AND batch.id=rb.batch_id
        JOIN pr_agent_harness.publication_batch_operations link
          ON link.tenant_id=batch.tenant_id AND link.batch_id=batch.id
        JOIN pr_agent_harness.repository_operations operation
          ON operation.tenant_id=link.tenant_id
          AND operation.business_operation_id=link.business_operation_id
        WHERE rb.tenant_id=r.tenant_id AND rb.run_id=r.id
          AND (batch.status IN ('pending','waiting_reconciliation')
            OR operation.status IN ('prepared','in_flight','unknown','manual_review')))
      AND NOT pr_agent_harness.maintenance_run_has_legacy_strong_reference(r.tenant_id,r.id)
  )
$$;

CREATE FUNCTION pr_agent_harness.maintenance_artifact_gc_eligible(
  requested_tenant_id uuid,requested_run_id uuid,requested_artifact_hash text
) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,pr_agent_harness AS $$
  SELECT EXISTS (
    SELECT 1 FROM pr_agent_harness.run_artifacts artifact
    JOIN pr_agent_harness.agent_runs run
      ON run.tenant_id=artifact.tenant_id AND run.id=artifact.run_id
    WHERE artifact.tenant_id=requested_tenant_id AND artifact.run_id=requested_run_id
      AND artifact.artifact_hash=requested_artifact_hash AND artifact.purged_at IS NULL
      AND artifact.retention_expires_at<=clock_timestamp()
      AND run.status IN ('succeeded','failed','cancelled')
      AND run.finished_at+interval '30 days'<=clock_timestamp()
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.run_publication_batches rb
        JOIN pr_agent_harness.publication_batch_operations link
          ON link.tenant_id=rb.tenant_id AND link.batch_id=rb.batch_id
        JOIN pr_agent_harness.repository_operations operation
          ON operation.tenant_id=link.tenant_id
          AND operation.business_operation_id=link.business_operation_id
        WHERE rb.tenant_id=artifact.tenant_id AND rb.run_id=artifact.run_id
          AND operation.status IN ('prepared','in_flight','unknown','manual_review'))
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.model_calls model
        WHERE model.tenant_id=artifact.tenant_id AND model.run_id=artifact.run_id
          AND model.status IN ('prepared','in_flight','unknown'))
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.model_budget_reservations reservation
        WHERE reservation.tenant_id=artifact.tenant_id AND reservation.run_id=artifact.run_id
          AND reservation.status IN ('reserved','pending'))
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.run_budget_envelopes budget
        WHERE budget.tenant_id=artifact.tenant_id AND budget.run_id=artifact.run_id
          AND budget.status<>'closed')
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.fix_approval_requests approval
        WHERE approval.tenant_id=artifact.tenant_id AND approval.proposal_run_id=artifact.run_id
          AND ((approval.status IN ('open','approved') AND approval.expires_at>clock_timestamp())
            OR EXISTS (SELECT 1 FROM pr_agent_harness.agent_runs publish
              WHERE publish.tenant_id=approval.tenant_id
                AND publish.id=approval.approved_publish_run_id
                AND publish.status NOT IN ('succeeded','failed','cancelled'))))
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.run_artifact_holds hold
        LEFT JOIN pr_agent_harness.run_artifact_hold_releases release
          ON release.tenant_id=hold.tenant_id AND release.run_id=hold.run_id
          AND release.artifact_hash=hold.artifact_hash AND release.hold_key=hold.hold_key
        WHERE hold.tenant_id=artifact.tenant_id AND hold.run_id=artifact.run_id
          AND hold.artifact_hash=artifact.artifact_hash AND release.hold_key IS NULL)
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.run_artifact_hold_releases release
        WHERE release.tenant_id=artifact.tenant_id AND release.run_id=artifact.run_id
          AND release.artifact_hash=artifact.artifact_hash
          AND release.released_at+interval '30 days'>clock_timestamp())
      AND (EXISTS (SELECT 1 FROM pr_agent_harness.run_artifact_holds hold
            WHERE hold.tenant_id=artifact.tenant_id AND hold.run_id=artifact.run_id
              AND hold.artifact_hash=artifact.artifact_hash)
        OR NOT pr_agent_harness.maintenance_run_has_legacy_strong_reference(
          artifact.tenant_id,artifact.run_id))
  )
$$;

CREATE OR REPLACE FUNCTION pr_agent_harness.guard_run_artifact_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pr_agent_harness AS $$
BEGIN
  IF NOT pr_agent_harness.is_harness_admin() THEN RAISE EXCEPTION 'run artifacts are immutable'; END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.content_compressed IS NULL AND OLD.purged_at IS NOT NULL
       AND OLD.purged_at+interval '30 days'<=clock_timestamp()
       AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.run_artifact_holds hold
         WHERE hold.tenant_id=OLD.tenant_id AND hold.run_id=OLD.run_id
           AND hold.artifact_hash=OLD.artifact_hash) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'run artifact metadata cannot be deleted';
  END IF;
  IF OLD.content_compressed IS NOT NULL AND NEW.content_compressed IS NULL AND OLD.purged_at IS NULL
      AND NEW.purged_at IS NOT NULL
      AND (to_jsonb(NEW)-'content_compressed'-'purged_at')=(to_jsonb(OLD)-'content_compressed'-'purged_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'run artifact metadata is immutable';
END $$;

CREATE FUNCTION pr_agent_harness.maintenance_trace_run_eligible(
  requested_tenant_id uuid,requested_run_id uuid,trace_days integer
) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,pr_agent_harness AS $$
  SELECT EXISTS (
    SELECT 1 FROM pr_agent_harness.agent_runs run
    WHERE run.tenant_id=requested_tenant_id AND run.id=requested_run_id
      AND run.status IN ('succeeded','failed','cancelled')
      AND run.finished_at<clock_timestamp()-make_interval(days=>trace_days)
      AND run.waiting_batch_id IS NULL AND run.next_outcome_scan_at IS NULL
      AND NOT pr_agent_harness.maintenance_run_has_legacy_strong_reference(run.tenant_id,run.id)
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.agent_runs child
        WHERE child.tenant_id=run.tenant_id AND child.parent_run_id=run.id)
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.run_artifact_holds hold
        WHERE hold.tenant_id=run.tenant_id AND hold.run_id=run.id)
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.run_artifact_hold_releases release
        WHERE release.tenant_id=run.tenant_id AND release.run_id=run.id)
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.run_artifacts artifact
        WHERE artifact.tenant_id=run.tenant_id AND artifact.run_id=run.id
          AND (artifact.purged_at IS NULL
            OR artifact.purged_at+interval '30 days'>clock_timestamp()))
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.model_calls model
        WHERE model.tenant_id=run.tenant_id AND model.run_id=run.id
          AND model.status NOT IN ('succeeded','failed_definite'))
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.model_budget_reservations reservation
        WHERE reservation.tenant_id=run.tenant_id AND reservation.run_id=run.id
          AND reservation.status NOT IN ('settled','released'))
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.run_budget_envelopes budget
        WHERE budget.tenant_id=run.tenant_id AND budget.run_id=run.id AND budget.status<>'closed')
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.dead_letter_jobs deadletter
        WHERE deadletter.tenant_id=run.tenant_id AND deadletter.run_id=run.id)
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.run_publication_batches publication
        JOIN pr_agent_harness.publication_batches batch
          ON batch.tenant_id=publication.tenant_id AND batch.id=publication.batch_id
        WHERE publication.tenant_id=run.tenant_id AND publication.run_id=run.id
          AND (batch.status NOT IN ('succeeded','failed_definite')
            OR batch.updated_at>=clock_timestamp()-make_interval(days=>trace_days)))
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.run_publication_batches publication
        JOIN pr_agent_harness.publication_batch_operations link
          ON link.tenant_id=publication.tenant_id AND link.batch_id=publication.batch_id
        JOIN pr_agent_harness.repository_operations operation
          ON operation.tenant_id=link.tenant_id
          AND operation.business_operation_id=link.business_operation_id
        WHERE publication.tenant_id=run.tenant_id AND publication.run_id=run.id
          AND (operation.status NOT IN ('succeeded','failed_definite','cancelled')
            OR operation.resolved_at IS NULL
            OR operation.resolved_at>=clock_timestamp()-make_interval(days=>trace_days)
            OR EXISTS (SELECT 1 FROM pr_agent_harness.publication_slots slot
              WHERE slot.tenant_id=operation.tenant_id
                AND slot.active_business_operation_id=operation.business_operation_id)
            OR EXISTS (SELECT 1 FROM pr_agent_harness.publication_batch_operations other_link
              JOIN pr_agent_harness.run_publication_batches other_publication
                ON other_publication.tenant_id=other_link.tenant_id
                AND other_publication.batch_id=other_link.batch_id
              WHERE other_link.tenant_id=operation.tenant_id
                AND other_link.business_operation_id=operation.business_operation_id
                AND other_publication.run_id<>run.id)
            OR EXISTS (SELECT 1 FROM pr_agent_harness.publication_command_receipts command
              WHERE command.tenant_id=operation.tenant_id
                AND command.business_operation_id=operation.business_operation_id
                AND command.created_at>=clock_timestamp()-make_interval(days=>trace_days))))
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.run_publication_batches publication
        JOIN pr_agent_harness.checkpoints checkpoint
          ON checkpoint.tenant_id=publication.tenant_id
          AND checkpoint.publication_batch_id=publication.batch_id
        WHERE publication.tenant_id=run.tenant_id AND publication.run_id=run.id
          AND checkpoint.run_id<>run.id)
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.run_publication_batches publication
        JOIN pr_agent_harness.fix_approval_consumptions consumption
          ON consumption.tenant_id=publication.tenant_id
          AND consumption.batch_id=publication.batch_id
        WHERE publication.tenant_id=run.tenant_id AND publication.run_id=run.id)
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.run_waits wait
        WHERE wait.tenant_id=run.tenant_id AND wait.run_id=run.id
          AND (wait.status='open'
            OR coalesce(wait.consumed_at,wait.created_at)>=
              clock_timestamp()-make_interval(days=>trace_days)))
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.run_command_receipts receipt
        WHERE receipt.tenant_id=run.tenant_id AND receipt.run_id=run.id
          AND (receipt.status='accepted'
            OR receipt.updated_at>=clock_timestamp()-make_interval(days=>trace_days)))
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.run_command_receipts receipt
        WHERE receipt.tenant_id=run.tenant_id AND receipt.new_run_id=run.id
          AND receipt.run_id<>run.id)
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.job_queue job
        WHERE job.tenant_id=run.tenant_id AND job.run_id=run.id
          AND (job.status NOT IN ('completed','cancelled') OR job.completed_at IS NULL
            OR job.completed_at>=clock_timestamp()-make_interval(days=>trace_days)))
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.evidence_records row
        WHERE row.tenant_id=run.tenant_id AND row.run_id=run.id)
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.finding_candidates row
        WHERE row.tenant_id=run.tenant_id AND row.run_id=run.id)
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.finding_decisions row
        WHERE row.tenant_id=run.tenant_id AND row.run_id=run.id)
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.review_artifacts row
        WHERE row.tenant_id=run.tenant_id AND row.run_id=run.id)
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.feedback_observations row
        WHERE row.tenant_id=run.tenant_id AND row.source_run_id=run.id)
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.review_annotations row
        WHERE row.tenant_id=run.tenant_id AND row.source_run_id=run.id)
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.review_annotation_arbitrations row
        WHERE row.tenant_id=run.tenant_id AND row.source_run_id=run.id)
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.fix_approval_decisions row
        WHERE row.tenant_id=run.tenant_id
          AND (row.proposal_run_id=run.id OR row.publish_run_id=run.id))
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.fix_approval_consumptions row
        WHERE row.tenant_id=run.tenant_id
          AND (row.proposal_run_id=run.id OR row.publish_run_id=run.id))
  )
$$;

CREATE FUNCTION pr_agent_harness.maintenance_deadletter_content_eligible(
  requested_tenant_id uuid,requested_deadletter_id uuid,trace_days integer
) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,pr_agent_harness AS $$
  SELECT EXISTS (
    SELECT 1 FROM pr_agent_harness.dead_letter_jobs deadletter
    JOIN pr_agent_harness.agent_runs run
      ON run.tenant_id=deadletter.tenant_id AND run.id=deadletter.run_id
    WHERE deadletter.tenant_id=requested_tenant_id AND deadletter.id=requested_deadletter_id
      AND deadletter.content_purged_at IS NULL
      AND deadletter.created_at<clock_timestamp()-make_interval(days=>trace_days)
      AND run.status IN ('succeeded','failed','cancelled')
      AND run.content_purged_at IS NOT NULL
      AND run.content_purged_at<transaction_timestamp()
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.run_artifact_holds hold
        LEFT JOIN pr_agent_harness.run_artifact_hold_releases release
          ON release.tenant_id=hold.tenant_id AND release.run_id=hold.run_id
          AND release.artifact_hash=hold.artifact_hash AND release.hold_key=hold.hold_key
        WHERE hold.tenant_id=run.tenant_id AND hold.run_id=run.id AND release.hold_key IS NULL)
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.model_calls model
        WHERE model.tenant_id=run.tenant_id AND model.run_id=run.id
          AND model.status IN ('prepared','in_flight','unknown'))
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.model_budget_reservations reservation
        WHERE reservation.tenant_id=run.tenant_id AND reservation.run_id=run.id
          AND reservation.status IN ('reserved','pending'))
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.run_budget_envelopes budget
        WHERE budget.tenant_id=run.tenant_id AND budget.run_id=run.id AND budget.status<>'closed')
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.run_publication_batches publication
        JOIN pr_agent_harness.publication_batch_operations link
          ON link.tenant_id=publication.tenant_id AND link.batch_id=publication.batch_id
        JOIN pr_agent_harness.repository_operations operation
          ON operation.tenant_id=link.tenant_id
          AND operation.business_operation_id=link.business_operation_id
        WHERE publication.tenant_id=run.tenant_id AND publication.run_id=run.id
          AND operation.status IN ('prepared','in_flight','unknown','manual_review'))
  )
$$;

CREATE FUNCTION pr_agent_harness.delete_maintenance_trace_run(
  requested_tenant_id uuid,requested_run_id uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pr_agent_harness AS $$
DECLARE batch_ids uuid[]; operation_ids text[];
BEGIN
  PERFORM 1 FROM pr_agent_harness.agent_runs
    WHERE tenant_id=requested_tenant_id AND id=requested_run_id FOR UPDATE;
  SELECT coalesce(array_agg(publication.batch_id),'{}'::uuid[]),
         coalesce(array_agg(DISTINCT link.business_operation_id)
           FILTER (WHERE link.business_operation_id IS NOT NULL),'{}'::text[])
    INTO batch_ids,operation_ids
  FROM pr_agent_harness.run_publication_batches publication
  LEFT JOIN pr_agent_harness.publication_batch_operations link
    ON link.tenant_id=publication.tenant_id AND link.batch_id=publication.batch_id
  WHERE publication.tenant_id=requested_tenant_id AND publication.run_id=requested_run_id;
  PERFORM 1 FROM pr_agent_harness.repository_operations operation
    WHERE operation.tenant_id=requested_tenant_id
      AND operation.business_operation_id=ANY(operation_ids)
    ORDER BY operation.business_operation_id FOR UPDATE;
  DELETE FROM pr_agent_harness.usage_records
    WHERE tenant_id=requested_tenant_id AND run_id=requested_run_id;
  DELETE FROM pr_agent_harness.model_budget_reservations
    WHERE tenant_id=requested_tenant_id AND run_id=requested_run_id;
  DELETE FROM pr_agent_harness.model_usage_adjustments
    WHERE tenant_id=requested_tenant_id AND run_id=requested_run_id;
  DELETE FROM pr_agent_harness.model_calls
    WHERE tenant_id=requested_tenant_id AND run_id=requested_run_id;
  UPDATE pr_agent_harness.run_command_receipts SET job_id=NULL
    WHERE tenant_id=requested_tenant_id AND run_id=requested_run_id AND job_id IS NOT NULL;
  UPDATE pr_agent_harness.job_queue SET command_receipt_id=NULL,wait_id=NULL
    WHERE tenant_id=requested_tenant_id AND run_id=requested_run_id
      AND (command_receipt_id IS NOT NULL OR wait_id IS NOT NULL);
  DELETE FROM pr_agent_harness.job_queue
    WHERE tenant_id=requested_tenant_id AND run_id=requested_run_id;
  DELETE FROM pr_agent_harness.run_wait_decisions
    WHERE tenant_id=requested_tenant_id AND run_id=requested_run_id;
  DELETE FROM pr_agent_harness.run_waits
    WHERE tenant_id=requested_tenant_id AND run_id=requested_run_id;
  DELETE FROM pr_agent_harness.run_command_receipts
    WHERE tenant_id=requested_tenant_id AND run_id=requested_run_id;
  DELETE FROM pr_agent_harness.publication_command_receipts
    WHERE tenant_id=requested_tenant_id AND business_operation_id=ANY(operation_ids);
  DELETE FROM pr_agent_harness.checkpoints
    WHERE tenant_id=requested_tenant_id AND run_id=requested_run_id;
  DELETE FROM pr_agent_harness.run_publication_batches
    WHERE tenant_id=requested_tenant_id AND run_id=requested_run_id;
  DELETE FROM pr_agent_harness.publication_batch_operations
    WHERE tenant_id=requested_tenant_id AND batch_id=ANY(batch_ids);
  DELETE FROM pr_agent_harness.publication_batches
    WHERE tenant_id=requested_tenant_id AND id=ANY(batch_ids);
  DELETE FROM pr_agent_harness.repository_operations
    WHERE tenant_id=requested_tenant_id AND business_operation_id=ANY(operation_ids);
  DELETE FROM pr_agent_harness.tool_calls
    WHERE tenant_id=requested_tenant_id AND run_id=requested_run_id;
  DELETE FROM pr_agent_harness.step_attempts
    WHERE tenant_id=requested_tenant_id AND run_id=requested_run_id;
  DELETE FROM pr_agent_harness.agent_steps
    WHERE tenant_id=requested_tenant_id AND run_id=requested_run_id;
  DELETE FROM pr_agent_harness.run_budget_envelopes
    WHERE tenant_id=requested_tenant_id AND run_id=requested_run_id;
  DELETE FROM pr_agent_harness.audit_logs
    WHERE tenant_id=requested_tenant_id AND run_id=requested_run_id;
  DELETE FROM pr_agent_harness.run_events
    WHERE tenant_id=requested_tenant_id AND run_id=requested_run_id;
  DELETE FROM pr_agent_harness.run_artifacts
    WHERE tenant_id=requested_tenant_id AND run_id=requested_run_id;
  DELETE FROM pr_agent_harness.agent_runs
    WHERE tenant_id=requested_tenant_id AND id=requested_run_id;
END $$;

CREATE FUNCTION pr_agent_harness.scrub_maintenance_run_content(
  requested_tenant_id uuid,requested_run_id uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pr_agent_harness AS $$
DECLARE event_sequence bigint;
BEGIN
  SELECT next_event_seq INTO STRICT event_sequence FROM pr_agent_harness.agent_runs
  WHERE tenant_id=requested_tenant_id AND id=requested_run_id FOR UPDATE;
  DELETE FROM pr_agent_harness.run_events
  WHERE tenant_id=requested_tenant_id AND run_id=requested_run_id;
  UPDATE pr_agent_harness.agent_steps SET output_json='{}'::jsonb,
    content_purged_at=clock_timestamp(),updated_at=clock_timestamp()
  WHERE tenant_id=requested_tenant_id AND run_id=requested_run_id AND content_purged_at IS NULL;
  UPDATE pr_agent_harness.checkpoints SET state_json='{}'::jsonb,content_purged_at=clock_timestamp()
  WHERE tenant_id=requested_tenant_id AND run_id=requested_run_id AND content_purged_at IS NULL;
  UPDATE pr_agent_harness.tool_calls SET result_ref=NULL,content_purged_at=clock_timestamp()
  WHERE tenant_id=requested_tenant_id AND run_id=requested_run_id AND content_purged_at IS NULL;
  UPDATE pr_agent_harness.model_calls SET request_metadata_json='{}'::jsonb,
    response_json=CASE WHEN response_json IS NULL THEN NULL ELSE '{}'::jsonb END,
    content_purged_at=clock_timestamp()
  WHERE tenant_id=requested_tenant_id AND run_id=requested_run_id AND content_purged_at IS NULL;
  UPDATE pr_agent_harness.usage_records SET original_usage_json='{}'::jsonb,
    content_purged_at=clock_timestamp()
  WHERE tenant_id=requested_tenant_id AND run_id=requested_run_id AND content_purged_at IS NULL;
  UPDATE pr_agent_harness.model_usage_adjustments SET evidence_reference='retained-ledger-only',
    content_purged_at=clock_timestamp()
  WHERE tenant_id=requested_tenant_id AND run_id=requested_run_id AND content_purged_at IS NULL;
  UPDATE pr_agent_harness.evidence_records SET summary='',result_json='{}'::jsonb,
    content_purged_at=clock_timestamp()
  WHERE tenant_id=requested_tenant_id AND run_id=requested_run_id AND content_purged_at IS NULL;
  UPDATE pr_agent_harness.finding_candidates SET record_json='{}'::jsonb,content_purged_at=clock_timestamp()
  WHERE tenant_id=requested_tenant_id AND run_id=requested_run_id AND content_purged_at IS NULL;
  UPDATE pr_agent_harness.finding_decisions SET record_json='{}'::jsonb,content_purged_at=clock_timestamp()
  WHERE tenant_id=requested_tenant_id AND run_id=requested_run_id AND content_purged_at IS NULL;
  UPDATE pr_agent_harness.review_artifacts SET artifact_json='{}'::jsonb,content_purged_at=clock_timestamp()
  WHERE tenant_id=requested_tenant_id AND run_id=requested_run_id AND content_purged_at IS NULL;
  UPDATE pr_agent_harness.fix_run_sources SET source_json='{}'::jsonb,allowed_paths_json='[]'::jsonb,
    content_purged_at=clock_timestamp()
  WHERE tenant_id=requested_tenant_id AND run_id=requested_run_id AND content_purged_at IS NULL;
  UPDATE pr_agent_harness.fix_proposals SET code_patch='',test_patch='',proposal_json='{}'::jsonb,
    content_purged_at=clock_timestamp()
  WHERE tenant_id=requested_tenant_id AND run_id=requested_run_id AND content_purged_at IS NULL;
  UPDATE pr_agent_harness.verification_jobs SET
    result_json=CASE WHEN result_json IS NULL THEN NULL ELSE '{}'::jsonb END,
    content_purged_at=clock_timestamp()
  WHERE tenant_id=requested_tenant_id AND run_id=requested_run_id AND content_purged_at IS NULL;
  UPDATE pr_agent_harness.fix_verifications SET result_json='{}'::jsonb,content_purged_at=clock_timestamp()
  WHERE tenant_id=requested_tenant_id AND run_id=requested_run_id AND content_purged_at IS NULL;
  UPDATE pr_agent_harness.fix_artifacts SET artifact_json='{}'::jsonb,content_purged_at=clock_timestamp()
  WHERE tenant_id=requested_tenant_id AND run_id=requested_run_id AND content_purged_at IS NULL;
  UPDATE pr_agent_harness.feedback_observations SET observation_json='{"purged":true}'::jsonb,
    content_purged_at=clock_timestamp()
  WHERE tenant_id=requested_tenant_id AND source_run_id=requested_run_id AND content_purged_at IS NULL;
  UPDATE pr_agent_harness.review_annotations SET label_set_json='{"purged":true}'::jsonb,
    provenance_json='{"purged":true}'::jsonb,content_purged_at=clock_timestamp()
  WHERE tenant_id=requested_tenant_id AND source_run_id=requested_run_id AND content_purged_at IS NULL;
  UPDATE pr_agent_harness.review_annotation_arbitrations SET reason='content purged by retention',
    content_purged_at=clock_timestamp()
  WHERE tenant_id=requested_tenant_id AND source_run_id=requested_run_id AND content_purged_at IS NULL;
  UPDATE pr_agent_harness.trusted_review_label_sets SET label_set_json='{"purged":true}'::jsonb,
    resolution_json='{"purged":true}'::jsonb,content_purged_at=clock_timestamp()
  WHERE tenant_id=requested_tenant_id AND source_run_id=requested_run_id AND content_purged_at IS NULL;
  UPDATE pr_agent_harness.agent_runs SET input_json='{}'::jsonb,content_purged_at=clock_timestamp(),
    event_retention_floor=event_sequence,next_event_seq=event_sequence+1,updated_at=clock_timestamp()
  WHERE tenant_id=requested_tenant_id AND id=requested_run_id AND content_purged_at IS NULL;
  INSERT INTO pr_agent_harness.run_events
    (tenant_id,run_id,sequence,event_type,event_key,visibility,actor_type,actor_id,payload_json)
  VALUES (requested_tenant_id,requested_run_id,event_sequence,'maintenance.retention_applied',
    'periodic-retention:'||event_sequence::text,'internal','system','pr_agent_maintenance',
    jsonb_build_object('reasonCode','retention_policy','eventRetentionFloor',event_sequence));
END $$;

CREATE FUNCTION pr_agent_harness.maintenance_candidate_counts(
  content_days integer,replay_days integer,trace_days integer,batch_limit integer
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pr_agent_harness AS $$
DECLARE run_content bigint; trace_runs bigint; fix_holds bigint; artifacts bigint;
  replay_content bigint; replay_rows bigint;
  audit_rows bigint; stale_heartbeats bigint; deadletter_content bigint; jobs bigint;
  attempts bigint; operations bigint; receipts bigint;
BEGIN
  SELECT count(*) INTO run_content FROM (SELECT 1 FROM pr_agent_harness.agent_runs r
    WHERE pr_agent_harness.maintenance_run_content_eligible(r.tenant_id,r.id,content_days)
    ORDER BY r.finished_at,r.tenant_id,r.id LIMIT batch_limit) bounded;
  SELECT count(*) INTO trace_runs FROM (SELECT 1 FROM pr_agent_harness.agent_runs r
    WHERE pr_agent_harness.maintenance_trace_run_eligible(r.tenant_id,r.id,trace_days)
    ORDER BY r.finished_at,r.tenant_id,r.id LIMIT batch_limit) bounded;
  SELECT count(*) INTO fix_holds FROM (SELECT 1 FROM pr_agent_harness.run_artifact_holds h
    JOIN pr_agent_harness.agent_runs r ON r.tenant_id=h.tenant_id AND r.id=h.run_id
    LEFT JOIN pr_agent_harness.run_artifact_hold_releases x
      ON x.tenant_id=h.tenant_id AND x.run_id=h.run_id AND x.artifact_hash=h.artifact_hash AND x.hold_key=h.hold_key
    WHERE h.hold_kind='fix' AND x.hold_key IS NULL
      AND pr_agent_harness.fix_hold_releasable(r.tenant_id,r.id,content_days)
    ORDER BY h.created_at,h.tenant_id,h.run_id,h.artifact_hash,h.hold_key LIMIT batch_limit) bounded;
  SELECT count(*) INTO artifacts FROM (SELECT 1 FROM pr_agent_harness.run_artifacts a
    WHERE pr_agent_harness.maintenance_artifact_gc_eligible(a.tenant_id,a.run_id,a.artifact_hash)
    ORDER BY a.retention_expires_at,a.tenant_id,a.run_id,a.artifact_hash LIMIT batch_limit) bounded;
  SELECT count(*) INTO replay_content FROM (SELECT 1 FROM pr_agent_harness.webhook_replay_events
    WHERE content_purged_at IS NULL AND received_at<clock_timestamp()-make_interval(days=>content_days)
    ORDER BY received_at,id LIMIT batch_limit) bounded;
  SELECT count(*) INTO replay_rows FROM (SELECT 1 FROM pr_agent_harness.webhook_replay_events
    WHERE received_at<clock_timestamp()-make_interval(days=>replay_days)
    ORDER BY received_at,id LIMIT batch_limit) bounded;
  SELECT count(*) INTO audit_rows FROM (SELECT 1 FROM pr_agent_harness.audit_logs a
    WHERE a.created_at<clock_timestamp()-make_interval(days=>trace_days)
      AND (a.run_id IS NULL OR EXISTS (SELECT 1 FROM pr_agent_harness.agent_runs r
        WHERE r.tenant_id=a.tenant_id AND r.id=a.run_id
          AND r.status IN ('succeeded','failed','cancelled')))
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.run_artifact_holds h
        LEFT JOIN pr_agent_harness.run_artifact_hold_releases x
          ON x.tenant_id=h.tenant_id AND x.run_id=h.run_id AND x.artifact_hash=h.artifact_hash AND x.hold_key=h.hold_key
        WHERE h.tenant_id=a.tenant_id AND h.run_id=a.run_id AND x.hold_key IS NULL)
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.run_budget_envelopes budget
        WHERE budget.tenant_id=a.tenant_id AND budget.run_id=a.run_id AND budget.status<>'closed')
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.run_publication_batches rb
        JOIN pr_agent_harness.publication_batch_operations link
          ON link.tenant_id=rb.tenant_id AND link.batch_id=rb.batch_id
        JOIN pr_agent_harness.repository_operations operation
          ON operation.tenant_id=link.tenant_id
          AND operation.business_operation_id=link.business_operation_id
        WHERE rb.tenant_id=a.tenant_id AND rb.run_id=a.run_id
          AND operation.status IN ('prepared','in_flight','unknown','manual_review'))
    ORDER BY a.created_at,a.id LIMIT batch_limit) bounded;
  SELECT count(*) INTO stale_heartbeats FROM (SELECT 1 FROM pr_agent_harness.runtime_process_heartbeats
    WHERE heartbeat_at<clock_timestamp()-interval '1 hour'
    ORDER BY heartbeat_at,process_role,instance_id LIMIT batch_limit) bounded;
  SELECT count(*) INTO deadletter_content FROM (SELECT 1 FROM pr_agent_harness.dead_letter_jobs d
    WHERE pr_agent_harness.maintenance_deadletter_content_eligible(d.tenant_id,d.id,trace_days)
    ORDER BY d.created_at,d.id LIMIT batch_limit) bounded;
  SELECT count(*) INTO jobs FROM (SELECT 1 FROM pr_agent_harness.job_queue j
    JOIN pr_agent_harness.agent_runs r ON r.tenant_id=j.tenant_id AND r.id=j.run_id
    WHERE j.status IN ('completed','cancelled') AND j.completed_at<clock_timestamp()-make_interval(days=>trace_days)
      AND r.content_purged_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.dead_letter_jobs d WHERE d.tenant_id=j.tenant_id AND d.job_id=j.id)
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.run_command_receipts c WHERE c.tenant_id=j.tenant_id AND c.job_id=j.id)
    ORDER BY j.completed_at,j.id LIMIT batch_limit) bounded;
  SELECT count(*) INTO attempts FROM (SELECT 1 FROM pr_agent_harness.step_attempts a
    JOIN pr_agent_harness.agent_runs r ON r.tenant_id=a.tenant_id AND r.id=a.run_id
    WHERE a.status<>'running' AND a.completed_at<clock_timestamp()-make_interval(days=>trace_days)
      AND r.content_purged_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.model_calls m WHERE m.tenant_id=a.tenant_id AND m.step_attempt_id=a.id)
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.tool_calls t WHERE t.tenant_id=a.tenant_id AND t.step_attempt_id=a.id)
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.checkpoints c WHERE c.tenant_id=a.tenant_id AND c.step_attempt_id=a.id)
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.evidence_records e WHERE e.tenant_id=a.tenant_id AND e.step_attempt_id=a.id)
    ORDER BY a.completed_at,a.id LIMIT batch_limit) bounded;
  SELECT count(*) INTO operations FROM (SELECT 1 FROM pr_agent_harness.repository_operations o
    WHERE o.status IN ('succeeded','failed_definite','cancelled')
      AND o.resolved_at<clock_timestamp()-make_interval(days=>trace_days)
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.publication_slots s
        WHERE s.tenant_id=o.tenant_id AND s.active_business_operation_id=o.business_operation_id)
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.publication_batch_operations b
        WHERE b.tenant_id=o.tenant_id AND b.business_operation_id=o.business_operation_id)
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.publication_command_receipts c
        WHERE c.tenant_id=o.tenant_id AND c.business_operation_id=o.business_operation_id)
      AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.run_waits w
        WHERE w.tenant_id=o.tenant_id AND w.business_operation_id=o.business_operation_id)
    ORDER BY o.resolved_at,o.tenant_id,o.business_operation_id LIMIT batch_limit) bounded;
  SELECT count(*) INTO receipts FROM (SELECT 1 FROM pr_agent_harness.maintenance_receipts receipt
    WHERE receipt.created_at<clock_timestamp()-make_interval(days=>trace_days)
    ORDER BY receipt.created_at,receipt.cycle_id LIMIT batch_limit) bounded;
  RETURN jsonb_build_object('runContent',run_content,'traceRuns',trace_runs,
    'fixHoldReleases',fix_holds,'artifacts',artifacts,
    'replayContent',replay_content,'replayRows',replay_rows,'auditRows',audit_rows,
    'staleHeartbeats',stale_heartbeats,'deadLetterContent',deadletter_content,'jobs',jobs,
    'stepAttempts',attempts,'repositoryOperations',operations,'maintenanceReceipts',receipts);
END $$;

CREATE FUNCTION pr_agent_harness.run_retention_maintenance(
  requested_cycle_id uuid,requested_action text,content_days integer,replay_days integer,
  trace_days integer,batch_limit integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pr_agent_harness AS $$
DECLARE computed_request_hash text; replayed record; result jsonb; counts jsonb;
  run_record record; trace_record record; deadletter_record record;
  run_content_scrubbed integer:=0; trace_runs_deleted integer:=0;
  fix_released integer:=0; artifacts_purged integer:=0; replay_scrubbed integer:=0;
  replay_deleted integer:=0; audit_deleted integer:=0; heartbeats_deleted integer:=0;
  deadletters_scrubbed integer:=0; jobs_deleted integer:=0; attempts_deleted integer:=0;
  operations_deleted integer:=0; receipts_deleted integer:=0;
BEGIN
  PERFORM pr_agent_harness.assert_maintenance_session();
  IF requested_cycle_id IS NULL THEN RAISE EXCEPTION 'invalid maintenance cycle id'; END IF;
  PERFORM pr_agent_harness.validate_maintenance_request(requested_action,content_days,replay_days,trace_days,batch_limit);
  PERFORM pg_advisory_xact_lock(hashtextextended(requested_cycle_id::text,3012));
  computed_request_hash:=pr_agent_harness.maintenance_request_hash(requested_action,content_days,replay_days,trace_days,batch_limit);
  SELECT receipt.action,receipt.request_hash,receipt.result_json INTO replayed
  FROM pr_agent_harness.maintenance_receipts receipt WHERE receipt.cycle_id=requested_cycle_id;
  IF FOUND THEN
    IF replayed.action<>requested_action OR replayed.request_hash<>computed_request_hash THEN
      RAISE EXCEPTION 'maintenance cycle id was reused' USING ERRCODE='23505';
    END IF;
    RETURN replayed.result_json;
  END IF;
  counts:=pr_agent_harness.maintenance_candidate_counts(content_days,replay_days,trace_days,batch_limit);
  IF requested_action='apply' THEN
    FOR run_record IN
      SELECT r.tenant_id,r.id FROM pr_agent_harness.agent_runs r
      WHERE pr_agent_harness.maintenance_run_content_eligible(r.tenant_id,r.id,content_days)
      ORDER BY r.finished_at,r.tenant_id,r.id
      FOR UPDATE OF r SKIP LOCKED LIMIT batch_limit
    LOOP
      PERFORM operation.business_operation_id
      FROM pr_agent_harness.run_publication_batches rb
      JOIN pr_agent_harness.publication_batch_operations link
        ON link.tenant_id=rb.tenant_id AND link.batch_id=rb.batch_id
      JOIN pr_agent_harness.repository_operations operation
        ON operation.tenant_id=link.tenant_id
        AND operation.business_operation_id=link.business_operation_id
      WHERE rb.tenant_id=run_record.tenant_id AND rb.run_id=run_record.id
      ORDER BY operation.business_operation_id FOR SHARE OF operation;
      IF pr_agent_harness.maintenance_run_content_eligible(
        run_record.tenant_id,run_record.id,content_days
      ) THEN
        PERFORM pr_agent_harness.scrub_maintenance_run_content(run_record.tenant_id,run_record.id);
        run_content_scrubbed:=run_content_scrubbed+1;
      END IF;
    END LOOP;

    WITH locked_runs AS (
      SELECT r.tenant_id,r.id FROM pr_agent_harness.agent_runs r
      WHERE pr_agent_harness.fix_hold_releasable(r.tenant_id,r.id,content_days)
        AND EXISTS (SELECT 1 FROM pr_agent_harness.run_artifact_holds h
          LEFT JOIN pr_agent_harness.run_artifact_hold_releases x
            ON x.tenant_id=h.tenant_id AND x.run_id=h.run_id AND x.artifact_hash=h.artifact_hash AND x.hold_key=h.hold_key
          WHERE h.tenant_id=r.tenant_id AND h.run_id=r.id AND h.hold_kind='fix' AND x.hold_key IS NULL)
      ORDER BY r.finished_at,r.tenant_id,r.id FOR UPDATE OF r SKIP LOCKED LIMIT batch_limit
    ), inserted AS (
      INSERT INTO pr_agent_harness.run_artifact_hold_releases
        (tenant_id,integration_id,run_id,artifact_hash,hold_key)
      SELECT h.tenant_id,h.integration_id,h.run_id,h.artifact_hash,h.hold_key
      FROM pr_agent_harness.run_artifact_holds h JOIN locked_runs r ON r.tenant_id=h.tenant_id AND r.id=h.run_id
      LEFT JOIN pr_agent_harness.run_artifact_hold_releases x
        ON x.tenant_id=h.tenant_id AND x.run_id=h.run_id AND x.artifact_hash=h.artifact_hash AND x.hold_key=h.hold_key
      WHERE h.hold_kind='fix' AND x.hold_key IS NULL
        AND pr_agent_harness.fix_hold_releasable(h.tenant_id,h.run_id,content_days)
      ORDER BY h.created_at,h.tenant_id,h.run_id,h.artifact_hash,h.hold_key
      LIMIT batch_limit
      ON CONFLICT DO NOTHING RETURNING 1
    ) SELECT count(*) INTO fix_released FROM inserted;

    WITH locked_runs AS (
      SELECT r.tenant_id,r.id FROM pr_agent_harness.agent_runs r
      WHERE r.status IN ('succeeded','failed','cancelled')
        AND EXISTS (SELECT 1 FROM pr_agent_harness.run_artifacts a
          WHERE a.tenant_id=r.tenant_id AND a.run_id=r.id
            AND pr_agent_harness.maintenance_artifact_gc_eligible(
              a.tenant_id,a.run_id,a.artifact_hash))
      ORDER BY r.finished_at,r.tenant_id,r.id FOR UPDATE OF r SKIP LOCKED LIMIT batch_limit
    ), candidates AS (
      SELECT a.tenant_id,a.run_id,a.artifact_hash FROM pr_agent_harness.run_artifacts a
      JOIN locked_runs r ON r.tenant_id=a.tenant_id AND r.id=a.run_id
      WHERE pr_agent_harness.maintenance_artifact_gc_eligible(
        a.tenant_id,a.run_id,a.artifact_hash)
      ORDER BY a.retention_expires_at,a.tenant_id,a.run_id,a.artifact_hash
      FOR UPDATE OF a SKIP LOCKED LIMIT batch_limit
    ), purged AS (
      UPDATE pr_agent_harness.run_artifacts a SET content_compressed=NULL,purged_at=clock_timestamp()
      FROM candidates c WHERE a.tenant_id=c.tenant_id AND a.run_id=c.run_id AND a.artifact_hash=c.artifact_hash RETURNING 1
    ) SELECT count(*) INTO artifacts_purged FROM purged;

    WITH candidates AS (SELECT id FROM pr_agent_harness.webhook_replay_events
      WHERE content_purged_at IS NULL AND received_at<clock_timestamp()-make_interval(days=>content_days)
      ORDER BY received_at,id FOR UPDATE SKIP LOCKED LIMIT batch_limit), changed AS (
      UPDATE pr_agent_harness.webhook_replay_events e SET headers_json='{}'::jsonb,payload_json='{}'::jsonb,
        content_purged_at=clock_timestamp() FROM candidates c WHERE e.id=c.id RETURNING 1)
    SELECT count(*) INTO replay_scrubbed FROM changed;
    WITH candidates AS (SELECT id FROM pr_agent_harness.webhook_replay_events
      WHERE received_at<clock_timestamp()-make_interval(days=>replay_days)
      ORDER BY received_at,id FOR UPDATE SKIP LOCKED LIMIT batch_limit), removed AS (
      DELETE FROM pr_agent_harness.webhook_replay_events e USING candidates c WHERE e.id=c.id RETURNING 1)
    SELECT count(*) INTO replay_deleted FROM removed;
    WITH candidates AS (SELECT process_role,instance_id FROM pr_agent_harness.runtime_process_heartbeats
      WHERE heartbeat_at<clock_timestamp()-interval '1 hour' ORDER BY heartbeat_at,process_role,instance_id
      FOR UPDATE SKIP LOCKED LIMIT batch_limit), removed AS (
      DELETE FROM pr_agent_harness.runtime_process_heartbeats h USING candidates c
      WHERE h.process_role=c.process_role AND h.instance_id=c.instance_id RETURNING 1)
    SELECT count(*) INTO heartbeats_deleted FROM removed;
    WITH candidates AS (SELECT a.id FROM pr_agent_harness.audit_logs a
      WHERE a.created_at<clock_timestamp()-make_interval(days=>trace_days)
        AND (a.run_id IS NULL OR EXISTS (SELECT 1 FROM pr_agent_harness.agent_runs r
          WHERE r.tenant_id=a.tenant_id AND r.id=a.run_id
            AND r.status IN ('succeeded','failed','cancelled')))
        AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.run_artifact_holds h
          LEFT JOIN pr_agent_harness.run_artifact_hold_releases x
            ON x.tenant_id=h.tenant_id AND x.run_id=h.run_id AND x.artifact_hash=h.artifact_hash AND x.hold_key=h.hold_key
          WHERE h.tenant_id=a.tenant_id AND h.run_id=a.run_id AND x.hold_key IS NULL)
        AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.run_budget_envelopes budget
          WHERE budget.tenant_id=a.tenant_id AND budget.run_id=a.run_id AND budget.status<>'closed')
        AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.run_publication_batches rb
          JOIN pr_agent_harness.publication_batch_operations link
            ON link.tenant_id=rb.tenant_id AND link.batch_id=rb.batch_id
          JOIN pr_agent_harness.repository_operations operation
            ON operation.tenant_id=link.tenant_id
            AND operation.business_operation_id=link.business_operation_id
          WHERE rb.tenant_id=a.tenant_id AND rb.run_id=a.run_id
            AND operation.status IN ('prepared','in_flight','unknown','manual_review'))
      ORDER BY a.created_at,a.id FOR UPDATE SKIP LOCKED LIMIT batch_limit), removed AS (
      DELETE FROM pr_agent_harness.audit_logs a USING candidates c WHERE a.id=c.id RETURNING 1)
    SELECT count(*) INTO audit_deleted FROM removed;
    FOR deadletter_record IN
      SELECT d.tenant_id,d.id FROM pr_agent_harness.dead_letter_jobs d
      JOIN pr_agent_harness.agent_runs r ON r.tenant_id=d.tenant_id AND r.id=d.run_id
      WHERE pr_agent_harness.maintenance_deadletter_content_eligible(d.tenant_id,d.id,trace_days)
      ORDER BY d.created_at,d.id FOR UPDATE OF r,d SKIP LOCKED LIMIT batch_limit
    LOOP
      IF pr_agent_harness.maintenance_deadletter_content_eligible(
        deadletter_record.tenant_id,deadletter_record.id,trace_days
      ) THEN
        UPDATE pr_agent_harness.dead_letter_jobs SET details_json='{}'::jsonb,
          content_purged_at=clock_timestamp()
        WHERE tenant_id=deadletter_record.tenant_id AND id=deadletter_record.id;
        deadletters_scrubbed:=deadletters_scrubbed+1;
      END IF;
    END LOOP;
    WITH candidates AS (SELECT j.id FROM pr_agent_harness.job_queue j
      JOIN pr_agent_harness.agent_runs r ON r.tenant_id=j.tenant_id AND r.id=j.run_id
      WHERE j.status IN ('completed','cancelled') AND j.completed_at<clock_timestamp()-make_interval(days=>trace_days)
        AND r.content_purged_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.dead_letter_jobs d WHERE d.tenant_id=j.tenant_id AND d.job_id=j.id)
        AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.run_command_receipts c WHERE c.tenant_id=j.tenant_id AND c.job_id=j.id)
      ORDER BY j.completed_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT batch_limit), removed AS (
      DELETE FROM pr_agent_harness.job_queue j USING candidates c WHERE j.id=c.id RETURNING 1)
    SELECT count(*) INTO jobs_deleted FROM removed;
    WITH candidates AS (SELECT a.id FROM pr_agent_harness.step_attempts a
      JOIN pr_agent_harness.agent_runs r ON r.tenant_id=a.tenant_id AND r.id=a.run_id
      WHERE a.status<>'running' AND a.completed_at<clock_timestamp()-make_interval(days=>trace_days)
        AND r.content_purged_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.model_calls m WHERE m.tenant_id=a.tenant_id AND m.step_attempt_id=a.id)
        AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.tool_calls t WHERE t.tenant_id=a.tenant_id AND t.step_attempt_id=a.id)
        AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.checkpoints c WHERE c.tenant_id=a.tenant_id AND c.step_attempt_id=a.id)
        AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.evidence_records e WHERE e.tenant_id=a.tenant_id AND e.step_attempt_id=a.id)
      ORDER BY a.completed_at,a.id FOR UPDATE OF a SKIP LOCKED LIMIT batch_limit), removed AS (
      DELETE FROM pr_agent_harness.step_attempts a USING candidates c WHERE a.id=c.id RETURNING 1)
    SELECT count(*) INTO attempts_deleted FROM removed;
    WITH candidates AS (SELECT o.tenant_id,o.business_operation_id FROM pr_agent_harness.repository_operations o
      WHERE o.status IN ('succeeded','failed_definite','cancelled')
        AND o.resolved_at<clock_timestamp()-make_interval(days=>trace_days)
        AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.publication_slots s
          WHERE s.tenant_id=o.tenant_id AND s.active_business_operation_id=o.business_operation_id)
        AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.publication_batch_operations b
          WHERE b.tenant_id=o.tenant_id AND b.business_operation_id=o.business_operation_id)
        AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.publication_command_receipts c
          WHERE c.tenant_id=o.tenant_id AND c.business_operation_id=o.business_operation_id)
        AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.run_waits w
          WHERE w.tenant_id=o.tenant_id AND w.business_operation_id=o.business_operation_id)
      ORDER BY o.resolved_at,o.tenant_id,o.business_operation_id FOR UPDATE OF o SKIP LOCKED LIMIT batch_limit), removed AS (
      DELETE FROM pr_agent_harness.repository_operations o USING candidates c
      WHERE o.tenant_id=c.tenant_id AND o.business_operation_id=c.business_operation_id RETURNING 1)
    SELECT count(*) INTO operations_deleted FROM removed;
    WITH candidates AS (SELECT receipt.cycle_id FROM pr_agent_harness.maintenance_receipts receipt
      WHERE receipt.created_at<clock_timestamp()-make_interval(days=>trace_days)
      ORDER BY receipt.created_at,receipt.cycle_id FOR UPDATE SKIP LOCKED LIMIT batch_limit), removed AS (
      DELETE FROM pr_agent_harness.maintenance_receipts receipt USING candidates candidate
      WHERE receipt.cycle_id=candidate.cycle_id RETURNING 1)
    SELECT count(*) INTO receipts_deleted FROM removed;
    FOR trace_record IN
      SELECT run.tenant_id,run.id FROM pr_agent_harness.agent_runs run
      WHERE pr_agent_harness.maintenance_trace_run_eligible(run.tenant_id,run.id,trace_days)
      ORDER BY run.finished_at,run.tenant_id,run.id
      FOR UPDATE OF run SKIP LOCKED LIMIT batch_limit
    LOOP
      PERFORM batch.id
      FROM pr_agent_harness.run_publication_batches publication
      JOIN pr_agent_harness.publication_batches batch
        ON batch.tenant_id=publication.tenant_id AND batch.id=publication.batch_id
      WHERE publication.tenant_id=trace_record.tenant_id
        AND publication.run_id=trace_record.id
      ORDER BY batch.id FOR UPDATE OF publication,batch;
      PERFORM operation.business_operation_id
      FROM pr_agent_harness.run_publication_batches publication
      JOIN pr_agent_harness.publication_batch_operations link
        ON link.tenant_id=publication.tenant_id AND link.batch_id=publication.batch_id
      JOIN pr_agent_harness.repository_operations operation
        ON operation.tenant_id=link.tenant_id
        AND operation.business_operation_id=link.business_operation_id
      WHERE publication.tenant_id=trace_record.tenant_id
        AND publication.run_id=trace_record.id
      ORDER BY operation.business_operation_id FOR UPDATE OF operation;
      IF pr_agent_harness.maintenance_trace_run_eligible(
        trace_record.tenant_id,trace_record.id,trace_days
      ) THEN
        PERFORM pr_agent_harness.delete_maintenance_trace_run(trace_record.tenant_id,trace_record.id);
        trace_runs_deleted:=trace_runs_deleted+1;
      END IF;
    END LOOP;
  END IF;
  result:=jsonb_build_object('schemaVersion',1,'action',requested_action,'candidates',counts,'applied',jsonb_build_object(
    'runContent',run_content_scrubbed,'traceRuns',trace_runs_deleted,
    'fixHoldReleases',fix_released,'artifacts',artifacts_purged,'replayContent',replay_scrubbed,
    'replayRows',replay_deleted,'auditRows',audit_deleted,'staleHeartbeats',heartbeats_deleted,
    'deadLetterContent',deadletters_scrubbed,'jobs',jobs_deleted,'stepAttempts',attempts_deleted,
    'repositoryOperations',operations_deleted,'maintenanceReceipts',receipts_deleted));
  INSERT INTO pr_agent_harness.maintenance_receipts
    (cycle_id,action,request_hash,policy_json,result_json,actor_role)
  VALUES (requested_cycle_id,requested_action,computed_request_hash,
    jsonb_build_object('contentDays',content_days,'replayDays',replay_days,'traceDays',trace_days,'batchLimit',batch_limit),
    result,session_user);
  RETURN result;
END $$;

REVOKE ALL ON TABLE pr_agent_harness.maintenance_receipts FROM PUBLIC;
REVOKE ALL ON FUNCTION pr_agent_harness.assert_maintenance_session(),
  pr_agent_harness.maintenance_request_hash(text,integer,integer,integer,integer),
  pr_agent_harness.validate_maintenance_request(text,integer,integer,integer,integer),
  pr_agent_harness.maintenance_run_has_legacy_strong_reference(uuid,uuid),
  pr_agent_harness.fix_hold_releasable(uuid,uuid,integer),
  pr_agent_harness.maintenance_run_content_eligible(uuid,uuid,integer),
  pr_agent_harness.maintenance_artifact_gc_eligible(uuid,uuid,text),
  pr_agent_harness.maintenance_trace_run_eligible(uuid,uuid,integer),
  pr_agent_harness.maintenance_deadletter_content_eligible(uuid,uuid,integer),
  pr_agent_harness.delete_maintenance_trace_run(uuid,uuid),
  pr_agent_harness.scrub_maintenance_run_content(uuid,uuid),
  pr_agent_harness.maintenance_candidate_counts(integer,integer,integer,integer),
  pr_agent_harness.run_retention_maintenance(uuid,text,integer,integer,integer,integer) FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='pr_agent_maintenance') THEN
    GRANT USAGE ON SCHEMA pr_agent_harness TO pr_agent_maintenance;
    GRANT EXECUTE ON FUNCTION pr_agent_harness.run_retention_maintenance(uuid,text,integer,integer,integer,integer),
      pr_agent_harness.record_runtime_process_heartbeat(text,uuid,jsonb),
      pr_agent_harness.remove_runtime_process_heartbeat(text,uuid) TO pr_agent_maintenance;
    REVOKE SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA pr_agent_harness FROM pr_agent_maintenance;
  END IF;
END $grants$;
