-- One Postgres server, one database + login role per service (PRD 7.2):
-- each service can only connect to and migrate its own database.
-- Idempotent: runs on first container start, and again via `pnpm infra:db`
-- whenever a service is added. Local development credentials only.

CREATE TEMP TABLE uboce_services (name text);
INSERT INTO uboce_services VALUES
  ('identity'), ('organization'), ('notification'), ('catalog'), ('discovery'), ('procurement'), ('commerce'),
  ('inventory'), ('warehouse'), ('logistics'), ('quality'), ('agriculture'), ('manufacturing'),
  ('kyc'), ('kyb'), ('finance'), ('document'), ('dispute'), ('integration'), ('analytics'), ('administration');

SELECT format('CREATE ROLE %I LOGIN PASSWORD %L CREATEDB', name || '_svc', name || '_dev')
FROM uboce_services WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = name || '_svc')
\gexec

SELECT format('CREATE DATABASE %I OWNER %I', name, name || '_svc')
FROM uboce_services WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = name)
\gexec

SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', name) FROM uboce_services
\gexec
