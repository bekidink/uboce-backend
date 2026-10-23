// Generates render.yaml (a Render Blueprint) from infrastructure/services.json and
// each deployable's .env.example: pnpm render:generate
//
//   uboce-gateway   public web service (the only public API entry point)
//   uboce-<name>    21 private services, reachable only on Render's private network
//   uboce-storage   SeaweedFS (S3) with a disk; public, because browsers PUT/GET
//                   files with signed URLs
//   uboce-redis     Render Key Value (event streams, rate limits, revocations)
//   Postgres        Supabase, one schema per service (see `pnpm db:supabase`)
//
// Secrets are `sync: false`: Render never stores them in the Blueprint. Generate
// them with `pnpm deploy:secrets` and push them with `pnpm deploy:push-env`.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const ports = JSON.parse(readFileSync(`${root}infrastructure/services.json`, 'utf8'));
const names = Object.keys(ports);

const REGION = 'frankfurt'; // closest Render region to Supabase eu-west-1
const PLAN = 'starter';
const APP_URL = 'https://app.example.com'; // the web app; also CORS origin and email link base
const STORAGE_URL = 'https://uboce-storage.onrender.com'; // uboce-storage's public URL (Render shows it after the first deploy)

/** Values each deployment must supply (see `pnpm deploy:secrets`). */
const SECRET = new Set([
  'DATABASE_URL',
  'MIGRATE_DATABASE_URL',
  'SERVICE_CLIENT_SECRET',
  'JWT_PUBLIC_KEY',
  'JWT_PRIVATE_KEY',
  'MFA_ENCRYPTION_KEY',
  'SERVICE_CLIENTS',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
  'PROVIDERS',
  'SMTP_URL',
  'ADMIN_BOOTSTRAP_EMAILS',
]);

/** Production values that differ from local development. */
const OVERRIDE = {
  NODE_ENV: 'production',
  LOG_LEVEL: 'info',
  APP_BASE_URL: APP_URL,
  CORS_ORIGINS: APP_URL,
  S3_PUBLIC_ENDPOINT: STORAGE_URL,
  TRUST_PROXY_HOPS: '1', // Render's load balancer
  DOCS_ENABLED: 'false',
  REQUIRE_STAFF_MFA: 'true',
  EMAIL_FROM: 'UBOCE <no-reply@example.com>',
  FIREBASE_SERVICE_ACCOUNT_PATH: '/etc/secrets/firebase-service-account.json', // a Render secret file
  DATABASE_POOL_MAX: '5',
  INTERNAL_CALL_TIMEOUT_MS: '10000',
};

/** Local-only tuning: production keeps the code defaults (e.g. strict auth rate limits). */
const DROP = new Set(['AUTH_RATE_LIMIT_PER_MINUTE', 'RATE_LIMIT_PER_MINUTE']);

const service = (name) => (name === 'gateway' ? 'uboce-gateway' : `uboce-${name}`);
const urlKey = (name) => `${name.toUpperCase()}_URL`;
const peerKeys = new Map(names.map((n) => [urlKey(n), n]));

function envExample(name) {
  const dir = name === 'gateway' ? 'apps/gateway' : `services/${name}`;
  const text = readFileSync(`${root}${dir}/.env.example`, 'utf8');
  return [...text.matchAll(/^([A-Z0-9_]+)=(.*)$/gm)].map((m) => [m[1], m[2]]);
}

const q = (v) => (/^[\w./:@+-]*$/.test(v) && v !== '' && !/^(true|false|yes|no|null|\d+)$/i.test(v) ? v : JSON.stringify(v));

function envVars(name) {
  const lines = [];
  const add = (key, body) => lines.push(`      - key: ${key}\n${body}`);
  const dir = name === 'gateway' ? 'apps/gateway' : `services/${name}`;
  add('TARGET', `        value: ${dir}`); // Docker build arg: which deployable to build
  const keys = new Map(envExample(name));
  keys.set('NODE_ENV', 'production');
  if (name !== 'gateway') {
    keys.set('MIGRATE_DATABASE_URL', '');
    keys.set('DATABASE_POOL_MAX', '');
    keys.set('INTERNAL_CALL_TIMEOUT_MS', '');
  }
  for (const [key, local] of keys) {
    if (DROP.has(key)) continue;
    if (key === 'PORT') add(key, `        value: ${q(String(ports[name]))}`);
    else if (key === 'REDIS_URL') add(key, '        fromService:\n          type: keyvalue\n          name: uboce-redis\n          property: connectionString');
    else if (key === 'S3_ENDPOINT') add(key, '        fromService:\n          type: web\n          name: uboce-storage\n          property: hostport');
    else if (peerKeys.has(key) && peerKeys.get(key) !== name) {
      add(key, `        fromService:\n          type: pserv\n          name: ${service(peerKeys.get(key))}\n          property: hostport`);
    } else if (peerKeys.has(key)) continue; // a service never calls itself
    else if (SECRET.has(key)) add(key, '        sync: false');
    else if (key in OVERRIDE) add(key, `        value: ${q(OVERRIDE[key])}`);
    else add(key, `        value: ${q(local)}`);
  }
  return lines.join('\n');
}

const blocks = [];
blocks.push(`  - type: web
    name: uboce-gateway
    runtime: docker
    region: ${REGION}
    plan: ${PLAN}
    dockerfilePath: ./Dockerfile
    dockerContext: .
    healthCheckPath: /health/live
    autoDeploy: true
    envVars:
${envVars('gateway')}`);

for (const name of names.filter((n) => n !== 'gateway')) {
  blocks.push(`  - type: pserv
    name: ${service(name)}
    runtime: docker
    region: ${REGION}
    plan: ${PLAN}
    dockerfilePath: ./Dockerfile
    dockerContext: .
    preDeployCommand: npx --no-install prisma migrate deploy
    autoDeploy: true
    envVars:
${envVars(name)}`);
}

blocks.push(`  - type: web
    name: uboce-storage
    runtime: docker
    region: ${REGION}
    plan: ${PLAN}
    dockerfilePath: ./infrastructure/docker/seaweedfs/Dockerfile
    dockerContext: ./infrastructure/docker/seaweedfs
    disk:
      name: data
      mountPath: /data
      sizeGB: 10
    autoDeploy: false
    envVars:
      - key: PORT
        value: "8333"
      - key: S3_ACCESS_KEY
        sync: false
      - key: S3_SECRET_KEY
        sync: false`);

blocks.push(`  - type: keyvalue
    name: uboce-redis
    region: ${REGION}
    plan: ${PLAN}
    # Event streams must never be evicted.
    maxmemoryPolicy: noeviction
    # Private network only.
    ipAllowList: []`);

const yaml = `# Generated by scripts/generate-render.mjs — edit that script, then \`pnpm render:generate\`.
# Render Blueprint for the UBOCE backend. See docs/DEPLOY.md.
services:
${blocks.join('\n\n')}
`;
writeFileSync(`${root}render.yaml`, yaml);
console.log(`render.yaml: ${blocks.length} resources (${names.length - 1} private services, gateway, storage, redis)`);
