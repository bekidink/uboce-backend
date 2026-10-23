// Points every service at one Supabase Postgres database: pnpm db:supabase
//
// Supabase gives one database, so each service gets its own schema in it
// (identity, catalog, …), named by `?schema=` in its DATABASE_URL. Prisma
// qualifies its queries with it, and raw SQL uses `qualified()` from
// @uboce/common, so nothing depends on search_path.
//
// All services sign in as the project's postgres user through Supabase's pooler:
// the transaction pooler (6543) at runtime, so the 21 services share one small
// pool of server connections, and the session pooler (5432) for migrations,
// which take session locks. (Separate login roles per service would each get
// their own server pool, which exhausts a small instance's connection limit.)
//
// Reads .env.supabase (git-ignored). Idempotent. `pnpm db:local` switches back.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(`${root}services/identity/package.json`);
const pg = require(require.resolve('pg', { paths: [require.resolve('@prisma/adapter-pg')] }));

const mode = process.argv[2] === 'local' ? 'local' : 'supabase';
const services = Object.keys(JSON.parse(readFileSync(`${root}infrastructure/services.json`, 'utf8'))).filter((n) => existsSync(`${root}services/${n}`));

const readEnv = (path) => Object.fromEntries([...readFileSync(path, 'utf8').matchAll(/^([A-Z0-9_]+)=(.*)$/gm)].map((m) => [m[1], m[2]]));

/** Sets (or adds, or with null removes) KEY=value lines in a .env file, keeping everything else. */
function setEnv(path, values) {
  let text = readFileSync(path, 'utf8');
  for (const [key, value] of Object.entries(values)) {
    const re = new RegExp(`^${key}=.*$\\n?`, 'm');
    if (value === null) text = text.replace(re, '');
    else if (re.test(text)) text = text.replace(re, `${key}=${value}\n`);
    else text = `${text.replace(/\n*$/, '\n')}${key}=${value}\n`;
  }
  writeFileSync(path, text);
}

if (mode === 'local') {
  for (const name of services) {
    setEnv(`${root}services/${name}/.env`, {
      DATABASE_URL: `postgresql://${name}_svc:${name}_dev@localhost:5433/${name}`,
      MIGRATE_DATABASE_URL: null,
      DATABASE_POOL_MAX: null,
      INTERNAL_CALL_TIMEOUT_MS: null,
    });
  }
  console.log(`All ${services.length} services point at the local Postgres again (pnpm infra:up).`);
  process.exit(0);
}

if (!existsSync(`${root}.env.supabase`)) {
  console.error('Missing .env.supabase (SUPABASE_PROJECT_REF, SUPABASE_POOLER_HOST, SUPABASE_DB_PASSWORD).');
  process.exit(1);
}
const cfg = readEnv(`${root}.env.supabase`);
const { SUPABASE_PROJECT_REF: ref, SUPABASE_POOLER_HOST: host, SUPABASE_DB_PASSWORD: password } = cfg;
if (!ref || !host || !password) {
  console.error('.env.supabase needs SUPABASE_PROJECT_REF, SUPABASE_POOLER_HOST and SUPABASE_DB_PASSWORD.');
  process.exit(1);
}
const poolMax = cfg.DATABASE_POOL_MAX ?? '5';
// Every query is a round trip to the Supabase region, so service-to-service calls get longer.
const callTimeout = cfg.INTERNAL_CALL_TIMEOUT_MS ?? '15000';

// The pooler's certificate is issued by Supabase's own CA. Set SUPABASE_CA_FILE
// (dashboard → Database → SSL) to verify it; otherwise TLS isn't verified.
const ssl = cfg.SUPABASE_CA_FILE ? { ca: readFileSync(cfg.SUPABASE_CA_FILE, 'utf8') } : { rejectUnauthorized: false };
const sslParam = cfg.SUPABASE_CA_FILE ? `sslmode=verify-full&sslrootcert=${encodeURIComponent(cfg.SUPABASE_CA_FILE)}` : 'sslmode=no-verify';

const admin = new pg.Client({ host, port: 5432, user: `postgres.${ref}`, password, database: 'postgres', ssl });
await admin.connect();
const ident = (s) => `"${s.replace(/"/g, '""')}"`;

for (const name of services) {
  await admin.query(`create schema if not exists ${ident(name)}`);
  // Earlier versions of this script used one login role per service; fold them back into postgres.
  const legacy = `${name}_svc`;
  if ((await admin.query('select 1 from pg_roles where rolname = $1', [legacy])).rowCount) {
    await admin.query(`reassign owned by ${ident(legacy)} to current_user`);
    await admin.query(`drop owned by ${ident(legacy)}`);
    await admin.query(`drop role ${ident(legacy)}`);
  }
  await admin.query(`alter schema ${ident(name)} owner to current_user`);
  await admin.query(`revoke all on schema ${ident(name)} from public`);

  const user = encodeURIComponent(`postgres.${ref}`);
  const pw = encodeURIComponent(password);
  setEnv(`${root}services/${name}/.env`, {
    DATABASE_URL: `postgresql://${user}:${pw}@${host}:6543/postgres?schema=${name}&${sslParam}`,
    MIGRATE_DATABASE_URL: `postgresql://${user}:${pw}@${host}:5432/postgres?schema=${name}&sslmode=require&connect_timeout=30`,
    DATABASE_POOL_MAX: poolMax,
    INTERNAL_CALL_TIMEOUT_MS: callTimeout,
  });
  console.log(`schema ${name} ready`);
}
await admin.end();
console.log(`\nAll ${services.length} services now use Supabase. Next: pnpm migrate, then start the services.`);
