// Builds the UBOCE_CONFIG secret for the Hugging Face Space: pnpm hf:config
//
// Settings come from render.yaml (every service's configuration), secrets from
// secrets/render.json (`pnpm deploy:secrets`), and the Space's own details from
// deploy/huggingface/space.env. Everything runs in one container, so peers are
// http://127.0.0.1:<port>; files go to Supabase Storage's S3 API.
// Output: deploy/huggingface/UBOCE_CONFIG.txt (git-ignored) — paste it as the
// Space secret UBOCE_CONFIG, or let `pnpm hf:push -- --secrets` set it.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const yaml = require(require.resolve('js-yaml', { paths: [`${root}node_modules/.pnpm/node_modules`] }));
const ports = JSON.parse(readFileSync(`${root}infrastructure/services.json`, 'utf8'));
const blueprint = yaml.load(readFileSync(`${root}render.yaml`, 'utf8'));
const readEnv = (p) => Object.fromEntries([...readFileSync(p, 'utf8').matchAll(/^([A-Z0-9_]+)=(.*)$/gm)].map((m) => [m[1], m[2].trim()]));

for (const f of ['secrets/render.json', 'deploy/huggingface/space.env', '.env.supabase']) {
  if (!existsSync(`${root}${f}`)) {
    console.error(`Missing ${f}${f.startsWith('secrets') ? ' — run pnpm deploy:secrets' : ''}.`);
    process.exit(1);
  }
}
const secrets = JSON.parse(readFileSync(`${root}secrets/render.json`, 'utf8'));
const space = readEnv(`${root}deploy/huggingface/space.env`);
const supabase = readEnv(`${root}.env.supabase`);
if (!space.SPACE_ID || space.SPACE_ID.includes('your-')) {
  console.error('Set SPACE_ID (e.g. bekidink/uboce) in deploy/huggingface/space.env.');
  process.exit(1);
}
const [owner, spaceName] = space.SPACE_ID.split('/');
// A Space named owner/name is served at https://owner-name.hf.space (lowercase, _ and . become -).
const spaceUrl = space.SPACE_URL || `https://${`${owner}-${spaceName}`.toLowerCase().replace(/[_.]/g, '-')}.hf.space`;
const storageHost = `https://${supabase.SUPABASE_PROJECT_REF}.supabase.co`;

const local = (ref) => {
  if (ref.type === 'keyvalue') return 'redis://127.0.0.1:6379';
  const name = ref.name.replace(/^uboce-/, '');
  return `http://127.0.0.1:${ports[name]}`;
};

const ONE_CONTAINER = {
  APP_BASE_URL: spaceUrl,
  CORS_ORIGINS: spaceUrl,
  TRUST_PROXY_HOPS: '1',
  // Supabase Storage (S3 protocol): keys from Supabase dashboard → Storage → S3 connection.
  S3_ENDPOINT: `${storageHost}/storage/v1/s3`,
  S3_PUBLIC_ENDPOINT: `${storageHost}/storage/v1/s3`,
  S3_REGION: space.S3_REGION || 'eu-west-1',
  S3_ACCESS_KEY: space.S3_ACCESS_KEY,
  S3_SECRET_KEY: space.S3_SECRET_KEY,
  DATABASE_POOL_MAX: '3',
  INTERNAL_CALL_TIMEOUT_MS: '20000',
};
const GATEWAY = {
  WEB_ROOT: '/app/web',
  WEB_CONNECT_SRC: storageHost,
  FRAME_ANCESTORS: 'https://huggingface.co',
};

const perService = {};
for (const svc of blueprint.services) {
  if (svc.type === 'keyvalue' || svc.name === 'uboce-storage') continue;
  const name = svc.name.replace(/^uboce-/, '');
  const env = {};
  for (const e of svc.envVars ?? []) {
    if (['TARGET', 'FIREBASE_SERVICE_ACCOUNT_PATH', 'NODE_ENV'].includes(e.key)) continue;
    let value = e.fromService ? local(e.fromService) : e.sync === false ? secrets[svc.name]?.[e.key] : e.value;
    if (e.key in ONE_CONTAINER) value = ONE_CONTAINER[e.key];
    if (value !== undefined && value !== '') env[e.key] = String(value);
  }
  if (name === 'gateway') Object.assign(env, GATEWAY);
  perService[name] = env;
}
if (!ONE_CONTAINER.S3_ACCESS_KEY || !ONE_CONTAINER.S3_SECRET_KEY) {
  console.warn('warning: S3_ACCESS_KEY/S3_SECRET_KEY are empty in space.env — file uploads will fail until you set them.');
}

// Values identical in every process go into `shared` once, keeping the secret small.
const all = Object.values(perService);
const shared = {};
for (const [k, v] of Object.entries(all[0])) if (all.every((env) => env[k] === v)) shared[k] = v;
const strip = (env) => Object.fromEntries(Object.entries(env).filter(([k]) => !(k in shared)));
const { gateway, ...services } = perService;
const payload = { shared, gateway: strip(gateway), services: Object.fromEntries(Object.entries(services).map(([n, e]) => [n, strip(e)])) };

const encoded = gzipSync(JSON.stringify(payload), { level: 9 }).toString('base64');
writeFileSync(`${root}deploy/huggingface/UBOCE_CONFIG.txt`, encoded, { mode: 0o600 });
console.log(`deploy/huggingface/UBOCE_CONFIG.txt: ${Object.keys(services).length} services + gateway, ${(encoded.length / 1024).toFixed(1)} KB`);
console.log(`Space URL: ${spaceUrl}`);
