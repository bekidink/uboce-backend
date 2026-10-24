// Prints the local platform admin's current two-step code: pnpm admin:code
// (local development only; the login lives in the git-ignored .smoke-admin.json).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { totp } from './smoke-lib.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const all = JSON.parse(readFileSync(`${root}.smoke-admin.json`, 'utf8'));
// Same lookup as adminSession: the entry for the database the services use.
const url = readFileSync(`${root}services/identity/.env`, 'utf8').match(/^DATABASE_URL=(.*)$/m)?.[1] ?? '';
let key = 'localhost';
try {
  const u = new URL(url);
  key = decodeURIComponent(u.username).split('.')[1] ?? u.hostname;
} catch {
  // keep the local entry
}
const saved = typeof all.password === 'string' ? all : (all[key] ?? all.localhost);
if (!saved) {
  console.error(`No admin login saved for database "${key}".`);
  process.exit(1);
}
const left = 30 - (Math.floor(Date.now() / 1000) % 30);
console.log(`admin@uboce.local  password: ${saved.password}`);
console.log(`code: ${totp(saved.secret)}  (valid ${left}s; next: ${totp(saved.secret, 1)})`);
