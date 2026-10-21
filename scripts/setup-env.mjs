// Prepares local .env files for every service and the gateway:
//  - creates .env from .env.example, or adds keys that are new in the example
//  - generates the RS256 signing key pair (private key only in Identity)
//  - generates the MFA encryption key (Identity only)
//  - generates a service-to-service secret per service; Identity gets only their SHA-256 hashes
// Safe to re-run: existing values are never overwritten.
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const targets = [
  ...readdirSync(join(root, 'services')).map((name) => ({ name, dir: join(root, 'services', name) })),
  { name: 'gateway', dir: join(root, 'apps', 'gateway') },
].filter((t) => existsSync(join(t.dir, '.env.example')));

const parse = (text) => {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) map.set(m[1], m[2]);
  }
  return map;
};

const setVar = (text, key, value) => {
  const re = new RegExp(`^${key}=.*$`, 'm');
  return re.test(text) ? text.replace(re, `${key}=${value}`) : `${text.replace(/\s*$/, '')}\n${key}=${value}\n`;
};

const envs = new Map();
for (const t of targets) {
  const path = join(t.dir, '.env');
  const example = readFileSync(join(t.dir, '.env.example'), 'utf8');
  if (!existsSync(path)) {
    writeFileSync(path, example);
    console.log(`created ${t.name}/.env`);
  } else {
    let text = readFileSync(path, 'utf8');
    const have = parse(text);
    const added = [...parse(example)].filter(([key]) => !have.has(key));
    for (const [key, value] of added) text = setVar(text, key, value);
    if (added.length) {
      writeFileSync(path, text);
      console.log(`added ${added.map(([k]) => k).join(', ')} to ${t.name}/.env`);
    }
  }
  envs.set(t.name, path);
}

const update = (name, changes) => {
  const path = envs.get(name);
  let text = readFileSync(path, 'utf8');
  const current = parse(text);
  let changed = false;
  for (const [key, value] of Object.entries(changes)) {
    if (current.get(key) !== value) {
      text = setVar(text, key, value);
      changed = true;
    }
  }
  if (changed) writeFileSync(path, text);
};

const identity = parse(readFileSync(envs.get('identity'), 'utf8'));

let publicKey = identity.get('JWT_PUBLIC_KEY');
if (!identity.get('JWT_PRIVATE_KEY') || !publicKey) {
  const keys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  publicKey = Buffer.from(keys.publicKey).toString('base64');
  update('identity', { JWT_PRIVATE_KEY: Buffer.from(keys.privateKey).toString('base64'), JWT_PUBLIC_KEY: publicKey });
  console.log('generated a JWT signing key pair');
}

if (!identity.get('MFA_ENCRYPTION_KEY')) {
  update('identity', { MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64') });
  console.log('generated an MFA encryption key');
}

const clients = [];
for (const [name, path] of envs) {
  const env = parse(readFileSync(path, 'utf8'));
  if (!env.has('SERVICE_CLIENT_ID')) continue;
  let secret = env.get('SERVICE_CLIENT_SECRET');
  if (!secret) {
    secret = randomBytes(32).toString('base64url');
    update(name, { SERVICE_CLIENT_SECRET: secret });
    console.log(`generated a service secret for ${name}`);
  }
  clients.push(`${env.get('SERVICE_CLIENT_ID')}:${createHash('sha256').update(secret).digest('hex')}`);
}
update('identity', { SERVICE_CLIENTS: clients.join(',') });

for (const [name, path] of envs) {
  if (parse(readFileSync(path, 'utf8')).has('JWT_PUBLIC_KEY')) update(name, { JWT_PUBLIC_KEY: publicKey });
}

// Every service (and the gateway) knows where its peers are, from one port map.
const ports = JSON.parse(readFileSync(join(root, 'infrastructure', 'services.json'), 'utf8'));
const peerUrls = Object.fromEntries(
  Object.entries(ports)
    .filter(([name]) => name !== 'gateway')
    .map(([name, port]) => [`${name.toUpperCase()}_URL`, `http://localhost:${port}`]),
);
for (const [name, path] of envs) {
  const current = parse(readFileSync(path, 'utf8'));
  const missing = Object.fromEntries(Object.entries(peerUrls).filter(([key]) => !current.get(key)));
  if (Object.keys(missing).length) update(name, missing);
}

// Local-only conveniences, never overwriting a value already set:
const integration = envs.get('integration');
if (integration && !parse(readFileSync(integration, 'utf8')).get('PROVIDERS')) {
  // Two signed test webhook providers, used by `pnpm smoke`.
  const providers = [`testpay:payment:${randomBytes(24).toString('base64url')}`, `testcarrier:carrier:${randomBytes(24).toString('base64url')}`];
  update('integration', { PROVIDERS: providers.join(',') });
  console.log('configured local test webhook providers (testpay, testcarrier)');
}
const administration = envs.get('administration');
if (administration && !parse(readFileSync(administration, 'utf8')).get('ADMIN_BOOTSTRAP_EMAILS')) {
  // The first platform administrator locally (still needs a verified email and MFA).
  update('administration', { ADMIN_BOOTSTRAP_EMAILS: 'admin@uboce.local' });
  console.log('local bootstrap admin: admin@uboce.local');
}
console.log(`ready: ${[...envs.keys()].join(', ')}`);
