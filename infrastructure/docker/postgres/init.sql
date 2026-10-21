-- One Postgres server, one database + login role per service (PRD 7.2):
-- each service can only connect to and migrate its own database.
-- Idempotent: runs on first container start, and again via `pnpm infra:db`
-- whenever a service is added. Local development credentials only.

SELECT format('CREATE ROLE %I LOGIN PASSWORD %L CREATEDB', s || '_svc', s || '_dev')
FROM unnest(ARRAY['identity', 'organization', 'notification', 'catalog', 'discovery', 'procurement', 'commerce']) AS s
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = s || '_svc')
\gexec

SELECT format('CREATE DATABASE %I OWNER %I', s, s || '_svc')
FROM unnest(ARRAY['identity', 'organization', 'notification', 'catalog', 'discovery', 'procurement', 'commerce']) AS s
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = s)
\gexec

SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', s)
FROM unnest(ARRAY['identity', 'organization', 'notification', 'catalog', 'discovery', 'procurement', 'commerce']) AS s
\gexec
