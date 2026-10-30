-- The schema owner is a dedicated DDL/maintenance identity. Runtime roles retain
-- FORCE RLS and never inherit this policy. SECURITY DEFINER queue functions run
-- as this owner through fixed, bounded queries without SUPERUSER/BYPASSRLS.
CREATE OR REPLACE FUNCTION pr_agent_harness.is_harness_admin() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,pr_agent_harness AS $$
  SELECT EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname='pr_agent_harness' AND n.nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user))
    OR COALESCE((SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user),false)
$$;

DO $$
DECLARE relation record; owner_name text;
BEGIN
  SELECT pg_get_userbyid(nspowner) INTO STRICT owner_name FROM pg_namespace WHERE nspname='pr_agent_harness';
  FOR relation IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='pr_agent_harness' AND c.relkind IN ('r','p') AND c.relrowsecurity
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS schema_owner_maintenance ON pr_agent_harness.%I', relation.relname);
    EXECUTE format('CREATE POLICY schema_owner_maintenance ON pr_agent_harness.%I TO %I USING (true) WITH CHECK (true)',
      relation.relname,owner_name);
  END LOOP;
END $$;

-- Versioned runtime grants. Bootstrap creates login roles; migrations only own
-- schema objects and must never require CREATEROLE or a superuser credential.
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='pr_agent_app') THEN
        GRANT USAGE ON SCHEMA pr_agent_harness TO pr_agent_app;
        GRANT SELECT ON pr_agent_harness.integration_bindings TO pr_agent_app;
        GRANT SELECT, INSERT, UPDATE, DELETE ON pr_agent_harness.command_rate_limits,
          pr_agent_harness.review_incremental_cursors,
          pr_agent_harness.review_feedback_signals TO pr_agent_app;
        GRANT SELECT, INSERT, UPDATE ON pr_agent_harness.webhook_replay_events TO pr_agent_app;
        GRANT SELECT, INSERT, UPDATE ON pr_agent_harness.agent_runs,
          pr_agent_harness.job_queue, pr_agent_harness.repository_operations,
          pr_agent_harness.publication_slots, pr_agent_harness.publication_batches TO pr_agent_app;
        GRANT SELECT, INSERT ON pr_agent_harness.publication_batch_operations TO pr_agent_app;
        REVOKE UPDATE, DELETE ON pr_agent_harness.publication_batch_operations FROM pr_agent_app;
        GRANT SELECT, INSERT ON pr_agent_harness.run_events,
          pr_agent_harness.audit_logs TO pr_agent_app;
        GRANT SELECT, INSERT ON pr_agent_harness.publication_command_receipts TO pr_agent_app;
        GRANT EXECUTE ON FUNCTION pr_agent_harness.lock_active_publication_authority(
          uuid, uuid, text, text, text, bigint) TO pr_agent_app;
        GRANT EXECUTE ON FUNCTION pr_agent_harness.skip_failed_batch_successors(uuid, uuid) TO pr_agent_app;
        GRANT EXECUTE ON FUNCTION pr_agent_harness.list_due_model_budget_tenants(integer) TO pr_agent_app;
        GRANT EXECUTE ON FUNCTION pr_agent_harness.lock_active_review_execution_authority(uuid,uuid,bigint,bigint),
          pr_agent_harness.lock_resumable_review_execution_authority(uuid,uuid,bigint,bigint) TO pr_agent_app;
        GRANT SELECT, INSERT, UPDATE ON pr_agent_harness.agent_steps,
          pr_agent_harness.step_attempts, pr_agent_harness.tool_calls,
          pr_agent_harness.model_calls, pr_agent_harness.tenant_budget_accounts,
          pr_agent_harness.run_budget_envelopes, pr_agent_harness.model_budget_reservations TO pr_agent_app;
        GRANT SELECT, INSERT ON pr_agent_harness.checkpoints,
          pr_agent_harness.run_publication_batches, pr_agent_harness.dead_letter_jobs,
          pr_agent_harness.usage_records, pr_agent_harness.model_usage_adjustments,
          pr_agent_harness.model_pricing_snapshots TO pr_agent_app;
        GRANT UPDATE (measurement_status,input_tokens,cached_input_tokens,cache_write_input_tokens,
          output_tokens,reasoning_tokens,tool_input_tokens,total_tokens,cost_micros,
          original_usage_json,updated_at) ON pr_agent_harness.usage_records TO pr_agent_app;
        GRANT SELECT, INSERT, UPDATE ON pr_agent_harness.run_command_receipts,
          pr_agent_harness.run_waits TO pr_agent_app;
        GRANT SELECT, INSERT ON pr_agent_harness.run_wait_decisions TO pr_agent_app;
        GRANT SELECT, INSERT ON pr_agent_harness.evidence_records,
          pr_agent_harness.finding_candidates, pr_agent_harness.finding_decisions,
          pr_agent_harness.review_artifacts TO pr_agent_app;
        REVOKE UPDATE, DELETE ON pr_agent_harness.evidence_records,
          pr_agent_harness.finding_candidates, pr_agent_harness.finding_decisions,
          pr_agent_harness.review_artifacts FROM pr_agent_app;
        GRANT SELECT, INSERT ON pr_agent_harness.fix_run_sources,
          pr_agent_harness.fix_run_findings, pr_agent_harness.fix_proposals,
          pr_agent_harness.fix_verifications, pr_agent_harness.fix_artifacts,
          pr_agent_harness.fix_relevance_attestations,
          pr_agent_harness.fix_approval_decisions, pr_agent_harness.fix_approval_consumptions,
          pr_agent_harness.verification_jobs TO pr_agent_app;
        GRANT SELECT, INSERT ON pr_agent_harness.fix_approval_requests TO pr_agent_app;
        GRANT UPDATE (status,version,approved_publish_run_id,approved_at,revoked_at,consumed_at)
          ON pr_agent_harness.fix_approval_requests TO pr_agent_app;
        REVOKE UPDATE, DELETE ON pr_agent_harness.fix_run_sources,
          pr_agent_harness.fix_run_findings, pr_agent_harness.fix_proposals,
          pr_agent_harness.fix_verifications, pr_agent_harness.fix_artifacts,
          pr_agent_harness.fix_relevance_attestations,
          pr_agent_harness.fix_approval_decisions, pr_agent_harness.fix_approval_consumptions,
          pr_agent_harness.verification_jobs FROM pr_agent_app;
        GRANT EXECUTE ON FUNCTION pr_agent_harness.lock_resolvable_publication_authority(uuid,uuid,bigint),
          pr_agent_harness.skip_cancelled_run_publications(uuid,uuid) TO pr_agent_app;
        REVOKE INSERT, UPDATE, DELETE ON pr_agent_harness.feedback_observations,
          pr_agent_harness.review_annotations,
          pr_agent_harness.review_annotation_arbitrations,
          pr_agent_harness.trusted_review_label_sets,
          pr_agent_harness.eval_datasets,
          pr_agent_harness.eval_cases,
          pr_agent_harness.eval_fixtures,
          pr_agent_harness.eval_fixture_files FROM pr_agent_app;
        GRANT SELECT ON pr_agent_harness.feedback_observations,
          pr_agent_harness.review_annotations,
          pr_agent_harness.review_annotation_arbitrations,
          pr_agent_harness.trusted_review_label_sets,
          pr_agent_harness.eval_datasets,
          pr_agent_harness.eval_cases,
          pr_agent_harness.eval_fixtures,
          pr_agent_harness.eval_fixture_files TO pr_agent_app;
        GRANT INSERT (tenant_id,integration_id,source_run_id,artifact_hash,command_key,request_hash,actor_type,actor_id,
          observation_json)
          ON pr_agent_harness.feedback_observations TO pr_agent_app;
        GRANT INSERT (id,tenant_id,integration_id,source_run_id,artifact_hash,rubric_version,label_set_hash,label_set_json,
          provenance_json,actor_type,actor_id,command_key,request_hash,supersedes_annotation_id)
          ON pr_agent_harness.review_annotations TO pr_agent_app;
        GRANT INSERT (id,tenant_id,integration_id,source_run_id,artifact_hash,rubric_version,left_annotation_id,
          left_label_set_hash,right_annotation_id,right_label_set_hash,chosen_label_set_hash,actor_type,
          actor_id,command_key,request_hash,reason)
          ON pr_agent_harness.review_annotation_arbitrations TO pr_agent_app;
        GRANT INSERT (id,tenant_id,integration_id,source_run_id,artifact_hash,rubric_version,label_set_hash,label_set_json,
          version,active,supersedes_label_set_id,resolution_kind,resolution_json,arbitration_id)
          ON pr_agent_harness.trusted_review_label_sets TO pr_agent_app;
        GRANT INSERT (tenant_id,name,curator_actor_type,curator_actor_id,split_policy_json,split_policy_hash)
          ON pr_agent_harness.eval_datasets TO pr_agent_app;
        GRANT INSERT (tenant_id,integration_id,dataset_id,source_run_id,fixture_id,label_set_id,source_artifact_hash,
          fixture_hash,label_set_hash,label_set_json,lineage_hash,shingle_hash,shingle_hashes_json,
          source_created_at,repository,pull_number)
          ON pr_agent_harness.eval_cases TO pr_agent_app;
        GRANT INSERT (id,tenant_id,integration_id,run_id,repository,base_sha,head_sha,input_hash,source_step_id,
          source_step_output_hash,artifact_hash,fixture_hash,input_json,files_manifest_json,coverage_json,
          ci_json,total_bytes)
          ON pr_agent_harness.eval_fixtures TO pr_agent_app;
        GRANT INSERT (tenant_id,fixture_id,path,kind,content_text,content_hash,size_bytes) ON pr_agent_harness.eval_fixture_files TO pr_agent_app;
        GRANT UPDATE (superseded_by_annotation_id) ON pr_agent_harness.review_annotations TO pr_agent_app;
        GRANT UPDATE (active) ON pr_agent_harness.trusted_review_label_sets TO pr_agent_app;
        GRANT UPDATE (status,version,manifest_hash,case_count,dev_count,validation_count,holdout_count,frozen_at,updated_at)
          ON pr_agent_harness.eval_datasets TO pr_agent_app;
        GRANT UPDATE (split,ordinal) ON pr_agent_harness.eval_cases TO pr_agent_app;
        REVOKE INSERT, UPDATE, DELETE ON pr_agent_harness.evolution_proposal_sources,
          pr_agent_harness.evolution_candidates,
          pr_agent_harness.eval_runs,
          pr_agent_harness.eval_results FROM pr_agent_app;
        GRANT SELECT ON pr_agent_harness.evolution_proposal_sources,
          pr_agent_harness.evolution_candidates,
          pr_agent_harness.eval_runs,
          pr_agent_harness.eval_results TO pr_agent_app;
        GRANT INSERT (tenant_id,proposal_run_id,dataset_id,dataset_version,dataset_manifest_hash,baseline_prompt_hash,baseline_tool_hash,source_hash,source_json,created_by_actor_type,created_by_actor_id)
          ON pr_agent_harness.evolution_proposal_sources TO pr_agent_app;
        GRANT INSERT (id,tenant_id,proposal_run_id,dataset_id,dataset_version,dataset_manifest_hash,candidate_json,candidate_hash,baseline_prompt_hash,baseline_tool_hash,model_config_hash,source_hash,provenance_json,created_by_actor_type,created_by_actor_id)
          ON pr_agent_harness.evolution_candidates TO pr_agent_app;
        GRANT INSERT (id,tenant_id,dataset_id,candidate_id,curator_actor_type,curator_actor_id,split,command_key,request_hash,repetitions,manifest_hash,baseline_component_hash,candidate_component_hash,model_version_hash,runtime_version_hash,total_result_count,planned_result_count,deadline_at,scheduling_policy_json,scheduling_policy_hash)
          ON pr_agent_harness.eval_runs TO pr_agent_app;
        GRANT INSERT (tenant_id,eval_run_id,dataset_id,case_id,integration_id,variant,repetition,seed_hash,fixture_hash,label_set_id,label_set_hash,component_hash,expected_model_hash,expected_runtime_hash,expected_workflow_hash,expected_prompt_hash,expected_tool_hash,expected_policy_hash,expected_verifier_hash)
          ON pr_agent_harness.eval_results TO pr_agent_app;
        GRANT UPDATE (status,version,completed_result_count,failed_result_count,lease_owner,lease_epoch,
          lease_expires_at,heartbeat_at,available_at,error_code,metrics_json,metrics_hash,updated_at,completed_at)
          ON pr_agent_harness.eval_runs TO pr_agent_app;
        GRANT UPDATE (child_run_id,status,artifact_hash,score_json,score_hash,usage_json,latency_ms,error_code,updated_at,completed_at)
          ON pr_agent_harness.eval_results TO pr_agent_app;
        REVOKE INSERT, UPDATE, DELETE ON pr_agent_harness.evolution_release_qualifications,
          pr_agent_harness.evolution_release_assignments, pr_agent_harness.evolution_release_requests,
          pr_agent_harness.evolution_release_decisions, pr_agent_harness.evolution_release_receipts,
          pr_agent_harness.evolution_run_assignments FROM pr_agent_app;
        GRANT SELECT ON pr_agent_harness.evolution_release_qualifications,
          pr_agent_harness.evolution_release_assignments, pr_agent_harness.evolution_release_requests,
          pr_agent_harness.evolution_release_decisions, pr_agent_harness.evolution_release_receipts,
          pr_agent_harness.evolution_run_assignments TO pr_agent_app;
        GRANT INSERT (id,tenant_id,integration_id,candidate_id,dataset_id,dataset_version,validation_evaluation_id,
          holdout_evaluation_id,policy_json,policy_hash,evidence_json,evidence_hash,created_by_actor_type,created_by_actor_id,command_key,request_hash)
          ON pr_agent_harness.evolution_release_qualifications TO pr_agent_app;
        GRANT INSERT (tenant_id,integration_id,state,routing,candidate_id,qualification_id,version,fraction_bps,salt,activated_at,promoted_at)
          ON pr_agent_harness.evolution_release_assignments TO pr_agent_app;
        GRANT UPDATE (state,routing,candidate_id,qualification_id,version,fraction_bps,activated_at,promoted_at,updated_at)
          ON pr_agent_harness.evolution_release_assignments TO pr_agent_app;
        GRANT INSERT (id,tenant_id,integration_id,target,candidate_id,qualification_id,expected_assignment_version,candidate_bps,
          maker_actor_type,maker_actor_id,command_key,request_hash,expires_at)
          ON pr_agent_harness.evolution_release_requests TO pr_agent_app;
        GRANT UPDATE (status,consumed_at,updated_at,revoke_command_key,revoke_request_hash)
          ON pr_agent_harness.evolution_release_requests TO pr_agent_app;
        GRANT INSERT (tenant_id,integration_id,request_id,decision,checker_actor_type,checker_actor_id,command_key,request_hash)
          ON pr_agent_harness.evolution_release_decisions TO pr_agent_app;
        GRANT INSERT (tenant_id,integration_id,request_id,kind,assignment_version,before_json,after_json,evidence_json,evidence_hash,actor_type,actor_id,command_key,request_hash)
          ON pr_agent_harness.evolution_release_receipts TO pr_agent_app;
        GRANT INSERT (tenant_id,integration_id,run_id,assignment_version,routing,selection,bucket,candidate_id,qualification_id,
          release_receipt_id,review_text_json,review_text_hash,prompt_hash,tool_hash,selection_hash)
          ON pr_agent_harness.evolution_run_assignments TO pr_agent_app;
    GRANT SELECT ON pr_agent_harness.schema_migrations TO pr_agent_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='pr_agent_verifier') THEN
      GRANT USAGE ON SCHEMA pr_agent_harness TO pr_agent_verifier;
      GRANT EXECUTE ON FUNCTION pr_agent_harness.claim_verification_job(text,integer,text),
        pr_agent_harness.heartbeat_verification_job(uuid,uuid,text,bigint,integer),
        pr_agent_harness.complete_verification_job(uuid,uuid,text,bigint,jsonb,text,text,text,text),
        pr_agent_harness.relinquish_verification_job(uuid,uuid,text,bigint),
        pr_agent_harness.fail_verification_job(uuid,uuid,text,bigint,text,integer) TO pr_agent_verifier;
      REVOKE ALL ON pr_agent_harness.verification_jobs,pr_agent_harness.agent_runs,
        pr_agent_harness.fix_verifications FROM pr_agent_verifier;
  END IF;
END $grants$;
