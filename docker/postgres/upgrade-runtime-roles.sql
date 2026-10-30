\set ON_ERROR_STOP on
\set QUIET on

-- Explicit one-time operator transition for volumes created with
-- POSTGRES_USER=pr_agent_migrator. Run only against the pr_agent database.
-- Passwords are read by psql from the process environment and are never
-- embedded in this file or emitted by its statements.
\set bootstrap_password ''
\set app_password ''
\set verifier_password ''
\set maintenance_password ''
\set migration_password ''
\getenv bootstrap_password HARNESS_BOOTSTRAP_PASSWORD
\getenv app_password HARNESS_APP_PASSWORD
\getenv verifier_password HARNESS_VERIFIER_PASSWORD
\getenv maintenance_password HARNESS_MAINTENANCE_PASSWORD
\getenv migration_password HARNESS_MIGRATION_PASSWORD

SELECT 1 / CASE WHEN length(:'bootstrap_password') > 0 THEN 1 ELSE 0 END;
SELECT 1 / CASE WHEN length(:'app_password') > 0 THEN 1 ELSE 0 END;
SELECT 1 / CASE WHEN length(:'verifier_password') > 0 THEN 1 ELSE 0 END;
SELECT 1 / CASE WHEN length(:'maintenance_password') > 0 THEN 1 ELSE 0 END;
SELECT 1 / CASE WHEN length(:'migration_password') > 0 THEN 1 ELSE 0 END;

BEGIN;

DO $$
DECLARE
  schema_owner text;
  unexpected_objects bigint;
BEGIN
  IF current_database() <> 'pr_agent' THEN
    RAISE EXCEPTION 'runtime role transition is restricted to database pr_agent';
  END IF;
  IF NOT COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname=current_user), false) THEN
    RAISE EXCEPTION 'runtime role transition requires an existing PostgreSQL administrator';
  END IF;
  SELECT pg_get_userbyid(nspowner) INTO schema_owner
  FROM pg_namespace WHERE nspname='pr_agent_harness';
  IF schema_owner IS DISTINCT FROM 'pr_agent_migrator' THEN
    RAISE EXCEPTION 'expected pr_agent_harness owner pr_agent_migrator, found %', COALESCE(schema_owner, '<missing>');
  END IF;

  SELECT count(*) INTO unexpected_objects
  FROM pg_depend namespace_dependency
  JOIN pg_shdepend owner_dependency
    ON owner_dependency.dbid=(SELECT oid FROM pg_database WHERE datname=current_database())
   AND owner_dependency.classid=namespace_dependency.classid
   AND owner_dependency.objid=namespace_dependency.objid
   AND owner_dependency.deptype='o'
  JOIN pg_roles owner_role ON owner_role.oid=owner_dependency.refobjid
  WHERE namespace_dependency.refclassid='pg_namespace'::regclass
    AND namespace_dependency.refobjid='pr_agent_harness'::regnamespace
    AND namespace_dependency.deptype='n'
    AND owner_role.rolname<>'pr_agent_migrator';
  IF unexpected_objects <> 0 THEN
    RAISE EXCEPTION 'pr_agent_harness contains % objects not owned by pr_agent_migrator; operator review required',
      unexpected_objects;
  END IF;
END $$;

SELECT format('CREATE ROLE postgres LOGIN SUPERUSER CREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'bootstrap_password') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='postgres') \gexec
SELECT format('ALTER ROLE postgres LOGIN SUPERUSER CREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'bootstrap_password') \gexec

SELECT format('CREATE ROLE pr_agent_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'app_password') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='pr_agent_app') \gexec
SELECT format('ALTER ROLE pr_agent_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'app_password') \gexec

SELECT format('CREATE ROLE pr_agent_verifier LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'verifier_password') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='pr_agent_verifier') \gexec
SELECT format('ALTER ROLE pr_agent_verifier LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'verifier_password') \gexec

SELECT format('CREATE ROLE pr_agent_maintenance LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'maintenance_password') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='pr_agent_maintenance') \gexec
SELECT format('ALTER ROLE pr_agent_maintenance LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'maintenance_password') \gexec

CREATE OR REPLACE FUNCTION pr_agent_harness.is_harness_admin() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,pr_agent_harness AS $$
  SELECT EXISTS (
    SELECT 1 FROM pg_namespace n
    WHERE n.nspname='pr_agent_harness'
      AND n.nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
  ) OR COALESCE(
    (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user), false
  )
$$;

DO $$
DECLARE
  relation record;
BEGIN
  FOR relation IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='pr_agent_harness' AND c.relkind IN ('r','p') AND c.relrowsecurity
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policy p
      WHERE p.polrelid=format('pr_agent_harness.%I',relation.relname)::regclass
        AND p.polname='schema_owner_maintenance'
    ) THEN
      EXECUTE format(
        'CREATE POLICY schema_owner_maintenance ON pr_agent_harness.%I TO pr_agent_migrator USING (true) WITH CHECK (true)',
        relation.relname
      );
    END IF;
  END LOOP;
END $$;

SET ROLE postgres;
SELECT format('ALTER ROLE pr_agent_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'migration_password') \gexec

COMMIT;
