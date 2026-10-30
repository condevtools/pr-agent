\set ON_ERROR_STOP on
\set QUIET on

-- Explicit one-time operator action for an existing PostgreSQL volume. Run as
-- the bootstrap PostgreSQL administrator after migration 031 has been applied.
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
     OR to_regprocedure('pr_agent_harness.github_onboarding_invalidate(bigint,bigint,bigint[],text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'migration 031 GitHub onboarding functions are not installed';
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
  pr_agent_harness.github_onboarding_invalidate(bigint,bigint,bigint[],text,text,text)
TO pr_agent_onboarding;

COMMIT;
