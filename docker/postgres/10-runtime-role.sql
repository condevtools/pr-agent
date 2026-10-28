-- Executed by psql during first initialization of the Docker data volume.
-- psql quotes the password as a SQL literal; no shell execution is needed.
\getenv app_password HARNESS_APP_PASSWORD
CREATE ROLE pr_agent_app LOGIN PASSWORD :'app_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
