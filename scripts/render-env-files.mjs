// Writes one .env file per Render service, for pasting into Render → Environment → "Add from .env":
// pnpm render:env-files
//
// Values come from render.yaml (plain settings; peers as their public https://<service>.onrender.com URLs,
// Redis left to the Blueprint's fromService link) and secrets/render.json (`pnpm deploy:secrets`).
// Output: secrets/render-env/<service>.env (git-ignored; contains secrets).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const yaml = require(require.resolve('js-yaml', { paths: [`${root}node_modules/.pnpm/node_modules`] }));
if (!existsSync(`${root}secrets/render.json`)) {
  console.error('Run `pnpm deploy:secrets` first.');
  process.exit(1);
}
const blueprint = yaml.load(readFileSync(`${root}render.yaml`, 'utf8'));
const secrets = JSON.parse(readFileSync(`${root}secrets/render.json`, 'utf8'));

const dir = `${root}secrets/render-env`;
mkdirSync(dir, { recursive: true });
const empty = [];
let files = 0;
for (const svc of blueprint.services) {
  if (svc.type === 'keyvalue') continue;
  const lines = [];
  for (const e of svc.envVars ?? []) {
    if (e.key === 'TARGET') continue; // build argument
    let value;
    if (e.fromService?.type === 'keyvalue') continue; // REDIS_URL: linked by the Blueprint
    if (e.fromService) value = `https://${e.fromService.name}.onrender.com`;
    else if (e.sync === false) value = secrets[svc.name]?.[e.key] ?? '';
    else value = String(e.value ?? '');
    if (value === '') {
      if (e.sync === false) empty.push(`${svc.name}.${e.key}`);
      continue;
    }
    lines.push(`${e.key}=${value}`);
  }
  writeFileSync(`${dir}/${svc.name}.env`, `${lines.join('\n')}\n`, { mode: 0o600 });
  files++;
}
console.log(`secrets/render-env: ${files} files — paste each into its Render service (Environment → Add from .env).`);
if (empty.length) console.log(`Empty, left out: ${empty.join(', ')}`);
