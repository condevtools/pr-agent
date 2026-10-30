-- Executed by psql during first initialization of the Docker data volume.
-- psql quotes the password as a SQL literal; no shell execution is needed.
\getenv app_password HARNESS_APP_PASSWORD
CREATE ROLE pr_agent_app LOGIN PASSWORD :'app_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

\getenv verifier_password HARNESS_VERIFIER_PASSWORD
CREATE ROLE pr_agent_verifier LOGIN PASSWORD :'verifier_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

\getenv maintenance_password HARNESS_MAINTENANCE_PASSWORD
CREATE ROLE pr_agent_maintenance LOGIN PASSWORD :'maintenance_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

-- Optional control-plane identity. Keeping the password unset preserves the
-- existing feature-off deployment and does not create an unused login.
\set onboarding_password ''
\getenv onboarding_password HARNESS_ONBOARDING_PASSWORD
SELECT format(
  'CREATE ROLE pr_agent_onboarding LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
  :'onboarding_password'
) WHERE length(:'onboarding_password') > 0 \gexec

-- The bootstrap superuser stays in PostgreSQL. Application migration containers
-- receive this schema owner credential, which has no cluster administration power.
\getenv migration_password HARNESS_MIGRATION_PASSWORD
CREATE ROLE pr_agent_migrator LOGIN PASSWORD :'migration_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
SELECT format('GRANT CREATE ON DATABASE %I TO pr_agent_migrator', current_database()) \gexec
