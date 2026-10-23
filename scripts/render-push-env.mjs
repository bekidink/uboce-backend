// Sets the secret environment variables from secrets/render.json on the Render
// services created by the Blueprint: pnpm deploy:push-env [--apply] [--deploy]
//
// Needs RENDER_API_KEY (Render dashboard → Account Settings → API Keys).
// Without --apply it only prints what it would change. --deploy also triggers a
// deploy of every service it changed. Empty values are skipped.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const apply = process.argv.includes('--apply');
const deploy = process.argv.includes('--deploy');
const key = process.env.RENDER_API_KEY;
if (!key) {
  console.error('Set RENDER_API_KEY (Render dashboard → Account Settings → API Keys).');
  process.exit(1);
}
const secrets = JSON.parse(readFileSync(`${root}secrets/render.json`, 'utf8'));

async function render(method, path, body) {
  const res = await fetch(`https://api.render.com/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.status === 204 ? null : res.json();
}

// Render service IDs by name.
const ids = new Map();
for (let cursor = ''; ; ) {
  const page = await render('GET', `/services?limit=100${cursor ? `&cursor=${cursor}` : ''}`);
  for (const item of page) ids.set(item.service.name, item.service.id);
  if (page.length < 100) break;
  cursor = page.at(-1).cursor;
}

let changed = 0;
for (const [name, values] of Object.entries(secrets)) {
  const id = ids.get(name);
  if (!id) {
    console.log(`skip ${name}: not on Render yet (create the Blueprint first)`);
    continue;
  }
  const set = Object.entries(values).filter(([, v]) => v);
  for (const [envKey, value] of set) {
    if (apply) await render('PUT', `/services/${id}/env-vars/${envKey}`, { value });
    console.log(`${apply ? 'set ' : 'would set'} ${name} ${envKey}`);
  }
  if (set.length) changed++;
  if (apply && deploy && set.length) {
    await render('POST', `/services/${id}/deploys`, {});
    console.log(`deploying ${name}`);
  }
}
console.log(apply ? `\nUpdated ${changed} services.` : '\nDry run. Add --apply to change Render (and --deploy to redeploy).');
