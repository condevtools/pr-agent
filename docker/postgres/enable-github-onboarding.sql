\set ON_ERROR_STOP on
\set QUIET on

-- Idempotent deployment bootstrap for fresh and existing PostgreSQL volumes.
-- Compose runs this as the bootstrap PostgreSQL administrator after migrations.
-- The password comes from the process environment and is never printed.
\set onboarding_password ''
\getenv onboarding_password HARNESS_ONBOARDING_PASSWORD
SELECT 1 / CASE WHEN length(:'onboarding_password') > 0 THEN 1 ELSE 0 END;

BEGIN;

DO $$
DECLARE
  onboarding_oid oid;
BEGIN
  IF current_database() <> 'pr_agent' THEN
    RAISE EXCEPTION 'GitHub onboarding role enablement is restricted to database pr_agent';
  END IF;
  IF NOT COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname=session_user),false) THEN
    RAISE EXCEPTION 'GitHub onboarding role enablement requires the bootstrap PostgreSQL administrator';
  END IF;
  IF to_regprocedure('pr_agent_harness.github_onboarding_list(uuid,bigint[])') IS NULL
     OR to_regprocedure('pr_agent_harness.github_onboarding_enroll(uuid,text,text,text,text,bigint,bigint,bigint,bigint,bigint,text)') IS NULL
     OR to_regprocedure('pr_agent_harness.github_onboarding_revalidate(uuid,text,text,text,text,bigint,bigint,bigint,bigint,bigint,text,bigint)') IS NULL
     OR to_regprocedure('pr_agent_harness.github_onboarding_invalidate(bigint,bigint,bigint[],text,text,text)') IS NULL
     OR to_regprocedure('pr_agent_harness.github_installation_sync_request(bigint,bigint,bigint,text,text,text)') IS NULL
     OR to_regprocedure('pr_agent_harness.github_installation_restrict_and_request(bigint,bigint,bigint,bigint[],text,text,text)') IS NULL
     OR to_regprocedure('pr_agent_harness.github_installation_sync_claim(bigint,text,integer)') IS NULL
     OR to_regprocedure('pr_agent_harness.github_installation_sync_renew(bigint,bigint,text,bigint,bigint,integer)') IS NULL
     OR to_regprocedure('pr_agent_harness.github_installation_sync_known(bigint)') IS NULL
     OR to_regprocedure('pr_agent_harness.github_installation_sync_fail(bigint,bigint,text,bigint,bigint,text,timestamptz)') IS NULL
     OR to_regprocedure('pr_agent_harness.github_installation_snapshot_begin(bigint,bigint,text,bigint,bigint,bigint,bigint,text,timestamptz,bigint[])') IS NULL
     OR to_regprocedure('pr_agent_harness.github_installation_snapshot_apply_present(bigint,bigint,text,bigint,bigint,text,jsonb)') IS NULL
     OR to_regprocedure('pr_agent_harness.github_installation_snapshot_absence_candidates(bigint,bigint,text,bigint,bigint,text,bigint[])') IS NULL
     OR to_regprocedure('pr_agent_harness.github_installation_snapshot_apply_absent(bigint,bigint,text,bigint,bigint,text,bigint[],bigint[])') IS NULL
     OR to_regprocedure('pr_agent_harness.github_installation_snapshot_complete(bigint,bigint,text,bigint,bigint,text,bigint[])') IS NULL
     OR to_regprocedure('pr_agent_harness.github_installation_snapshot_complete_restricted(bigint,bigint,text,bigint,bigint,text,text,timestamptz)') IS NULL
     OR to_regprocedure('pr_agent_harness.github_deferred_pull_request_admit(bigint,bigint,bigint,bigint,text,integer,text,text,text)') IS NULL
     OR to_regprocedure('pr_agent_harness.github_deferred_pull_request_claim(bigint,text,integer)') IS NULL
     OR to_regprocedure('pr_agent_harness.github_deferred_pull_request_complete(uuid,text,bigint,text,text,uuid,text,timestamptz)') IS NULL
     OR to_regprocedure('pr_agent_harness.github_installation_sync_cleanup(integer)') IS NULL
     OR to_regprocedure('pr_agent_harness.github_installation_sync_status(bigint)') IS NULL THEN
    RAISE EXCEPTION 'migration 032 GitHub installation sync functions are not installed';
  END IF;
  SELECT oid INTO onboarding_oid FROM pg_roles WHERE rolname='pr_agent_onboarding';
  IF onboarding_oid IS NOT NULL AND (
    EXISTS (SELECT 1 FROM pg_auth_members
      WHERE member=onboarding_oid OR roleid=onboarding_oid)
    OR EXISTS (SELECT 1 FROM pg_shdepend WHERE refclassid='pg_authid'::regclass
      AND refobjid=onboarding_oid AND deptype='o')
  ) THEN
    RAISE EXCEPTION 'existing pr_agent_onboarding role owns objects or participates in role membership; operator review required';
  END IF;
END $$;

SELECT format(
  'CREATE ROLE pr_agent_onboarding LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
  :'onboarding_password'
) WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='pr_agent_onboarding') \gexec
SELECT format(
  'ALTER ROLE pr_agent_onboarding LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
  :'onboarding_password'
) \gexec

REVOKE ALL ON SCHEMA pr_agent_harness FROM pr_agent_onboarding;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA pr_agent_harness FROM pr_agent_onboarding;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA pr_agent_harness FROM pr_agent_onboarding;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA pr_agent_harness FROM pr_agent_onboarding;
GRANT USAGE ON SCHEMA pr_agent_harness TO pr_agent_onboarding;
GRANT EXECUTE ON FUNCTION
  pr_agent_harness.github_onboarding_list(uuid,bigint[]),
  pr_agent_harness.github_onboarding_enroll(uuid,text,text,text,text,bigint,bigint,bigint,bigint,bigint,text),
  pr_agent_harness.github_onboarding_revalidate(uuid,text,text,text,text,bigint,bigint,bigint,bigint,bigint,text,bigint),
  pr_agent_harness.github_onboarding_invalidate(bigint,bigint,bigint[],text,text,text),
  pr_agent_harness.github_installation_sync_request(bigint,bigint,bigint,text,text,text),
  pr_agent_harness.github_installation_restrict_and_request(bigint,bigint,bigint,bigint[],text,text,text),
  pr_agent_harness.github_installation_sync_claim(bigint,text,integer),
  pr_agent_harness.github_installation_sync_renew(bigint,bigint,text,bigint,bigint,integer),
  pr_agent_harness.github_installation_sync_known(bigint),
  pr_agent_harness.github_installation_sync_fail(bigint,bigint,text,bigint,bigint,text,timestamptz),
  pr_agent_harness.github_installation_snapshot_begin(bigint,bigint,text,bigint,bigint,bigint,bigint,text,timestamptz,bigint[]),
  pr_agent_harness.github_installation_snapshot_apply_present(bigint,bigint,text,bigint,bigint,text,jsonb),
  pr_agent_harness.github_installation_snapshot_absence_candidates(bigint,bigint,text,bigint,bigint,text,bigint[]),
  pr_agent_harness.github_installation_snapshot_apply_absent(bigint,bigint,text,bigint,bigint,text,bigint[],bigint[]),
  pr_agent_harness.github_installation_snapshot_complete(bigint,bigint,text,bigint,bigint,text,bigint[]),
  pr_agent_harness.github_installation_snapshot_complete_restricted(bigint,bigint,text,bigint,bigint,text,text,timestamptz),
  pr_agent_harness.github_deferred_pull_request_admit(bigint,bigint,bigint,bigint,text,integer,text,text,text),
  pr_agent_harness.github_deferred_pull_request_claim(bigint,text,integer),
  pr_agent_harness.github_deferred_pull_request_complete(uuid,text,bigint,text,text,uuid,text,timestamptz),
  pr_agent_harness.github_installation_sync_cleanup(integer),
  pr_agent_harness.github_installation_sync_status(bigint)
TO pr_agent_onboarding;

COMMIT;
