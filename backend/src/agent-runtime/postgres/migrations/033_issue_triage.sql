ALTER TABLE pr_agent_harness.integration_bindings
  ADD COLUMN issue_triage_enabled boolean NOT NULL DEFAULT true;

CREATE OR REPLACE FUNCTION pr_agent_harness.lock_current_binding_capability(
  requested_tenant_id uuid, requested_integration_id uuid, requested_capability text
) RETURNS TABLE(authority_version bigint,capability_enabled boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pr_agent_harness AS $$
BEGIN
  IF requested_capability NOT IN ('review.single','review.deep','issue.triage','fix','evolution') THEN
    RAISE EXCEPTION 'invalid integration capability';
  END IF;
  RETURN QUERY
    SELECT b.authority_version,
      CASE requested_capability
        WHEN 'review.single' THEN true
        WHEN 'review.deep' THEN b.review_deep_enabled
        WHEN 'issue.triage' THEN b.platform='github' AND b.issue_triage_enabled
        WHEN 'fix' THEN b.fix_enabled
        ELSE b.evolution_enabled
      END
    FROM pr_agent_harness.integration_bindings b
    WHERE b.tenant_id=requested_tenant_id AND b.id=requested_integration_id AND b.active
    FOR SHARE OF b;
END $$;

CREATE OR REPLACE FUNCTION pr_agent_harness.reserve_runtime_bindings(
  requested_queue_class text,
  requested_runtime_hash text,
  requested_workflows text[],
  requested_limit integer,
  requested_per_binding_limit integer
) RETURNS TABLE(tenant_id uuid,integration_id uuid,job_kind text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pr_agent_harness AS $$
DECLARE
  cursor_tenant uuid;
  cursor_integration uuid;
  selected record;
BEGIN
  IF requested_queue_class IS NULL
     OR requested_limit IS NULL
     OR requested_per_binding_limit IS NULL
     OR requested_workflows IS NULL
     OR requested_queue_class NOT IN ('normal','publication_outcome','manual_resume','maintenance','recovery')
     OR requested_limit NOT BETWEEN 1 AND 64
     OR requested_per_binding_limit NOT BETWEEN 1 AND 16
     OR cardinality(requested_workflows)>32
     OR EXISTS (SELECT 1 FROM unnest(requested_workflows) workflow
       WHERE workflow IS NULL OR btrim(workflow)=''
         OR workflow NOT IN ('review','review.single.v1','review.deep.v1','issue.triage.v1','fix.propose.v1',
           'fix.publish.v1','evolution.propose.v1','eval.replay.v1'))
     OR (requested_queue_class IN ('normal','publication_outcome','manual_resume')
       AND (requested_runtime_hash IS NULL
         OR requested_runtime_hash !~ '^[a-f0-9]{64}$'
         OR cardinality(requested_workflows)=0)) THEN
    RAISE EXCEPTION 'invalid runtime scheduling request';
  END IF;

  INSERT INTO pr_agent_harness.runtime_scheduler_cursors(queue_class)
  VALUES (requested_queue_class) ON CONFLICT DO NOTHING;
  SELECT c.last_tenant_id,c.last_integration_id
    INTO cursor_tenant,cursor_integration
  FROM pr_agent_harness.runtime_scheduler_cursors c
  WHERE c.queue_class=requested_queue_class FOR UPDATE;

  FOR selected IN
    SELECT b.tenant_id,b.id AS integration_id,
      CASE WHEN requested_queue_class IN ('publication_outcome','manual_resume')
        THEN requested_queue_class ELSE NULL END AS job_kind
    FROM pr_agent_harness.integration_bindings b
    WHERE b.active AND b.review_execution_mode='harness_async'
      AND (
        (requested_queue_class='normal'
          AND b.publication_state='active' AND b.review_execution_state='active'
          AND (SELECT count(*) FROM pr_agent_harness.agent_runs active_run
            WHERE active_run.tenant_id=b.tenant_id AND active_run.integration_id=b.id
              AND active_run.status='running' AND active_run.lease_expires_at>clock_timestamp())
            < requested_per_binding_limit
          AND EXISTS (
            SELECT 1 FROM pr_agent_harness.job_queue j
            JOIN pr_agent_harness.agent_runs r
              ON r.tenant_id=j.tenant_id AND r.id=j.run_id
            WHERE j.tenant_id=b.tenant_id AND r.integration_id=b.id
              AND r.authority_generation=b.publication_generation
              AND r.execution_mode_generation=b.execution_mode_generation
              AND r.runtime_version_hash=requested_runtime_hash
              AND r.run_type=ANY(requested_workflows)
              AND (r.run_type IN ('review','review.single.v1')
                OR (r.run_type='issue.triage.v1' AND b.platform='github' AND b.issue_triage_enabled)
                OR (r.run_type='review.deep.v1' AND b.review_deep_enabled)
                OR (r.run_type IN ('fix.propose.v1','fix.publish.v1') AND b.fix_enabled)
                OR (r.run_type IN ('evolution.propose.v1','eval.replay.v1') AND b.evolution_enabled))
              AND j.job_kind IN ('start','retry','recover')
              AND j.status IN ('ready','retry_wait') AND j.available_at<=clock_timestamp()
              AND r.status IN ('queued','retry_wait') AND r.cancel_requested_at IS NULL
              AND r.deadline_at>clock_timestamp()))
        OR (requested_queue_class IN ('publication_outcome','manual_resume')
          AND b.publication_state IN ('active','draining')
          AND b.review_execution_state IN ('active','draining')
          AND (SELECT count(*) FROM pr_agent_harness.agent_runs active_run
            WHERE active_run.tenant_id=b.tenant_id AND active_run.integration_id=b.id
              AND active_run.status='running' AND active_run.lease_expires_at>clock_timestamp())
            < requested_per_binding_limit
          AND EXISTS (
            SELECT 1 FROM pr_agent_harness.job_queue j
            JOIN pr_agent_harness.agent_runs r
              ON r.tenant_id=j.tenant_id AND r.id=j.run_id
            WHERE j.tenant_id=b.tenant_id AND r.integration_id=b.id
              AND r.authority_generation=b.publication_generation
              AND r.execution_mode_generation=b.execution_mode_generation
              AND r.runtime_version_hash=requested_runtime_hash
              AND j.job_kind=requested_queue_class
              AND j.status IN ('ready','retry_wait') AND j.available_at<=clock_timestamp()
              AND r.status=CASE requested_queue_class
                WHEN 'publication_outcome' THEN 'waiting_for_reconciliation'
                ELSE 'waiting_for_user' END
              AND r.cancel_requested_at IS NULL AND r.deadline_at>clock_timestamp()))
        OR (requested_queue_class='maintenance'
          AND b.publication_state IN ('active','draining')
          AND (
            EXISTS (
              SELECT 1 FROM pr_agent_harness.agent_runs maintenance_run
              WHERE maintenance_run.tenant_id=b.tenant_id
                AND maintenance_run.integration_id=b.id
                AND maintenance_run.authority_generation=b.publication_generation
                AND maintenance_run.execution_mode_generation=b.execution_mode_generation
                AND (
                  (maintenance_run.status IN ('waiting_for_reconciliation','waiting_for_user')
                    AND (maintenance_run.cancel_requested_at IS NOT NULL
                      OR maintenance_run.deadline_at<=clock_timestamp()))
                  OR EXISTS (
                    SELECT 1 FROM pr_agent_harness.job_queue maintenance_job
                    WHERE maintenance_job.tenant_id=maintenance_run.tenant_id
                      AND maintenance_job.run_id=maintenance_run.id
                      AND ((maintenance_run.status='running' AND maintenance_job.status='running')
                        OR (maintenance_run.status IN ('queued','retry_wait')
                          AND maintenance_job.status IN ('ready','retry_wait')))
                      AND (maintenance_run.cancel_requested_at IS NOT NULL
                        OR maintenance_run.deadline_at<=clock_timestamp()
                        OR (maintenance_run.status='running'
                          AND maintenance_run.lease_expires_at<=clock_timestamp()))))
                )
            OR EXISTS (
              SELECT 1 FROM pr_agent_harness.agent_runs outcome_run
              WHERE outcome_run.tenant_id=b.tenant_id AND outcome_run.integration_id=b.id
                AND outcome_run.authority_generation=b.publication_generation
                AND outcome_run.execution_mode_generation=b.execution_mode_generation
                AND outcome_run.status IN ('waiting_for_reconciliation','succeeded','failed','cancelled')
                AND outcome_run.next_outcome_scan_at IS NOT NULL
                AND outcome_run.next_outcome_scan_at<=clock_timestamp()
                AND (outcome_run.waiting_batch_id IS NOT NULL OR EXISTS (
                  SELECT 1 FROM pr_agent_harness.run_publication_batches outcome_link
                  WHERE outcome_link.tenant_id=outcome_run.tenant_id
                    AND outcome_link.run_id=outcome_run.id))
            )
            OR EXISTS (
              SELECT 1 FROM pr_agent_harness.eval_runs expired_evaluation
              JOIN pr_agent_harness.evolution_candidates expired_candidate
                ON expired_candidate.tenant_id=expired_evaluation.tenant_id
                AND expired_candidate.id=expired_evaluation.candidate_id
              JOIN pr_agent_harness.agent_runs expired_proposal
                ON expired_proposal.tenant_id=expired_candidate.tenant_id
                AND expired_proposal.id=expired_candidate.proposal_run_id
              WHERE expired_evaluation.tenant_id=b.tenant_id
                AND expired_proposal.integration_id=b.id
                AND expired_evaluation.status IN ('queued','running')
                AND expired_evaluation.deadline_at<=clock_timestamp()
            )
            OR (b.evolution_enabled AND EXISTS (
              SELECT 1 FROM pr_agent_harness.eval_runs evaluation
              WHERE evaluation.tenant_id=b.tenant_id
                AND evaluation.status IN ('queued','running')
                AND evaluation.deadline_at>clock_timestamp()
                AND evaluation.available_at<=clock_timestamp()
                AND (evaluation.lease_expires_at IS NULL
                  OR evaluation.lease_expires_at<=clock_timestamp())
                AND EXISTS (
                  SELECT 1 FROM pr_agent_harness.eval_results evaluation_result
                  WHERE evaluation_result.tenant_id=evaluation.tenant_id
                    AND evaluation_result.eval_run_id=evaluation.id
                    AND evaluation_result.integration_id=b.id
                    AND evaluation_result.status IN ('pending','queued','running'))
            ))
          ))
        OR (requested_queue_class='recovery'
          AND b.publication_state IN ('active','draining')
          AND (EXISTS (
            SELECT 1 FROM pr_agent_harness.publication_batches pb
            WHERE pb.tenant_id=b.tenant_id AND pb.integration_id=b.id
              AND pb.status IN ('pending','waiting_reconciliation'))
            OR EXISTS (
              SELECT 1 FROM pr_agent_harness.repository_operations ro
              WHERE ro.tenant_id=b.tenant_id AND ro.integration_id=b.id
                AND ro.authority_generation=b.publication_generation
                AND ro.status IN ('in_flight','unknown')
                AND (ro.next_reconcile_at IS NULL OR ro.next_reconcile_at<=clock_timestamp())
                AND (ro.reconcile_claim_expires_at IS NULL
                  OR ro.reconcile_claim_expires_at<=clock_timestamp()))))
      )
    ORDER BY CASE WHEN cursor_tenant IS NULL
                    OR ROW(b.tenant_id,b.id)>ROW(cursor_tenant,cursor_integration)
                  THEN 0 ELSE 1 END,
             b.tenant_id,b.id
    LIMIT requested_limit
  LOOP
    tenant_id := selected.tenant_id;
    integration_id := selected.integration_id;
    job_kind := selected.job_kind;
    cursor_tenant := selected.tenant_id;
    cursor_integration := selected.integration_id;
    RETURN NEXT;
  END LOOP;

  IF cursor_tenant IS NOT NULL THEN
    UPDATE pr_agent_harness.runtime_scheduler_cursors
    SET last_tenant_id=cursor_tenant,last_integration_id=cursor_integration,
        version=version+1,updated_at=clock_timestamp()
    WHERE queue_class=requested_queue_class;
  END IF;
END $$;


REVOKE ALL ON FUNCTION pr_agent_harness.lock_current_binding_capability(uuid,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION pr_agent_harness.reserve_runtime_bindings(text,text,text[],integer,integer) FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='pr_agent_app') THEN
    GRANT EXECUTE ON FUNCTION pr_agent_harness.lock_current_binding_capability(uuid,uuid,text) TO pr_agent_app;
    GRANT EXECUTE ON FUNCTION pr_agent_harness.reserve_runtime_bindings(text,text,text[],integer,integer) TO pr_agent_app;
  END IF;
END $grants$;
