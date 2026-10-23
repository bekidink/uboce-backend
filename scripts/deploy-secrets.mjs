// Generates production secrets for every Render service: pnpm deploy:secrets
//
// Writes secrets/render.json (git-ignored): { "<render service>": { KEY: value } }
// for every `sync: false` key in render.yaml. Nothing is shared with local
// development: new signing keys, MFA key, service credentials and S3 keys.
// Database URLs come from .env.supabase (one schema per service).
//
// Re-running keeps existing values (so a redeploy never logs everyone out or
// breaks service auth). `--rotate` regenerates everything except the database URLs.
//
// Optional, from the environment:
//   DEPLOY_ADMIN_EMAILS   first platform admin(s), comma-separated
//   DEPLOY_SMTP_URL       e.g. smtps://user:pass@smtp.example.com:465
//   DEPLOY_PROVIDERS      name:kind:secret,… for signed payment/carrier webhooks
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = `${root}secrets/render.json`;
const rotate = process.argv.includes('--rotate');

// Which secret keys each Render service needs, straight from render.yaml.
const yaml = readFileSync(`${root}render.yaml`, 'utf8');
const needs = {};
for (const block of yaml.split(/\n(?=  - type: )/)) {
  const name = block.match(/^\s*- type: \w+\n\s+name: ([\w-]+)/m)?.[1];
  if (!name) continue;
  needs[name] = [...block.matchAll(/- key: ([A-Z0-9_]+)\n\s+sync: false/g)].map((m) => m[1]);
}

const previous = existsSync(out) && !rotate ? JSON.parse(readFileSync(out, 'utf8')) : {};
const keep = (service, key, make) => previous[service]?.[key] ?? make();
const secret = (bytes = 32) => randomBytes(bytes).toString('base64url');

// Signing keys: only Identity holds the private key; every service verifies with the public one.
let publicKey = previous['uboce-identity']?.JWT_PUBLIC_KEY;
let privateKey = previous['uboce-identity']?.JWT_PRIVATE_KEY;
if (!publicKey || !privateKey) {
  const keys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  publicKey = Buffer.from(keys.publicKey).toString('base64');
  privateKey = Buffer.from(keys.privateKey).toString('base64');
}

// Database: Supabase via the pooler, one schema per service.
if (!existsSync(`${root}.env.supabase`)) {
  console.error('Missing .env.supabase — the production database settings come from there (see README).');
  process.exit(1);
}
const db = Object.fromEntries([...readFileSync(`${root}.env.supabase`, 'utf8').matchAll(/^([A-Z0-9_]+)=(.*)$/gm)].map((m) => [m[1], m[2]]));
const dbUser = encodeURIComponent(`postgres.${db.SUPABASE_PROJECT_REF}`);
const dbPassword = encodeURIComponent(db.SUPABASE_DB_PASSWORD);
const ssl = db.SUPABASE_CA_FILE ? 'sslmode=verify-full' : 'sslmode=no-verify';

const s3Access = keep('uboce-storage', 'S3_ACCESS_KEY', () => `uboce_${secret(9)}`);
const s3Secret = keep('uboce-storage', 'S3_SECRET_KEY', () => secret(30));
const result = {};
const clientHashes = [];

for (const [service, keys] of Object.entries(needs)) {
  const name = service.replace(/^uboce-/, '');
  const values = {};
  for (const key of keys) {
    switch (key) {
      case 'DATABASE_URL':
        values[key] = `postgresql://${dbUser}:${dbPassword}@${db.SUPABASE_POOLER_HOST}:6543/postgres?schema=${name}&${ssl}`;
        break;
      case 'MIGRATE_DATABASE_URL':
        values[key] = `postgresql://${dbUser}:${dbPassword}@${db.SUPABASE_POOLER_HOST}:5432/postgres?schema=${name}&sslmode=require&connect_timeout=30`;
        break;
      case 'JWT_PUBLIC_KEY':
        values[key] = publicKey;
        break;
      case 'JWT_PRIVATE_KEY':
        values[key] = privateKey;
        break;
      case 'MFA_ENCRYPTION_KEY':
        values[key] = keep(service, key, () => randomBytes(32).toString('base64'));
        break;
      case 'SERVICE_CLIENT_SECRET':
        values[key] = keep(service, key, () => secret());
        clientHashes.push(`${name}:${createHash('sha256').update(values[key]).digest('hex')}`);
        break;
      case 'S3_ACCESS_KEY':
        values[key] = s3Access;
        break;
      case 'S3_SECRET_KEY':
        values[key] = s3Secret;
        break;
      case 'ADMIN_BOOTSTRAP_EMAILS':
        values[key] = process.env.DEPLOY_ADMIN_EMAILS ?? previous[service]?.[key] ?? '';
        break;
      case 'SMTP_URL':
        values[key] = process.env.DEPLOY_SMTP_URL ?? previous[service]?.[key] ?? '';
        break;
      case 'PROVIDERS':
        values[key] = process.env.DEPLOY_PROVIDERS ?? previous[service]?.[key] ?? '';
        break;
      case 'SERVICE_CLIENTS':
        break; // filled in once every service's secret exists
      default:
        console.error(`No rule for secret ${key} (${service}) — add one to scripts/deploy-secrets.mjs`);
        process.exit(1);
    }
  }
  result[service] = values;
}
result['uboce-identity'].SERVICE_CLIENTS = clientHashes.sort().join(',');

mkdirSync(`${root}secrets`, { recursive: true });
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });

const empty = Object.entries(result).flatMap(([s, v]) => Object.entries(v).filter(([, x]) => !x).map(([k]) => `${s}.${k}`));
console.log(`secrets/render.json: ${Object.keys(result).length} services, ${clientHashes.length} service credentials${rotate ? ' (rotated)' : ''}`);
if (empty.length) console.log(`Still empty (set them before going live): ${empty.join(', ')}`);
