// Publishes the backend (and the web app) to the Hugging Face Space: pnpm hf:push [-- --secrets]
//
// Builds a clean bundle — this repo's committed + new files (never ignored ones
// like .env*, secrets/), deploy/huggingface/Dockerfile at its root, the Space's
// README front matter, and uboce-web's production build in web/ — and force-pushes
// it to the Space's git repository. Hugging Face then builds and starts it.
// --secrets also sets the UBOCE_CONFIG secret through the Hugging Face API.
// --bundle=<dir> only writes the bundle there (no push, no token): for a local `docker build`.
//
// Needs HF_TOKEN (huggingface.co → Settings → Access Tokens, "write").
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const bundleArg = process.argv.find((a) => a.startsWith('--bundle='))?.slice('--bundle='.length);
const token = process.env.HF_TOKEN;
if (!token && !bundleArg) {
  console.error('Set HF_TOKEN (huggingface.co → Settings → Access Tokens, with write access).');
  process.exit(1);
}
const space = Object.fromEntries([...readFileSync(`${root}deploy/huggingface/space.env`, 'utf8').matchAll(/^([A-Z0-9_]+)=(.*)$/gm)].map((m) => [m[1], m[2].trim()]));
const spaceId = space.SPACE_ID;
const webDir = space.WEB_REPO || join(root, '..', 'uboce-web');
const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString();

const bundle = bundleArg ?? mkdtempSync(join(tmpdir(), 'uboce-space-'));
if (bundleArg) {
  rmSync(bundle, { recursive: true, force: true });
  mkdirSync(bundle, { recursive: true });
}
try {
  // 1. Source: tracked and new files only; ignored files (env, secrets, builds) never leave the machine.
  const files = sh('git', ['ls-files', '-co', '--exclude-standard', '-z'], root).split('\0').filter(Boolean);
  const forbidden = files.filter((f) => /(^|\/)\.env(\.|$)(?!example)|^secrets\/|\.smoke-admin\.json$|UBOCE_CONFIG/.test(f));
  if (forbidden.length) throw new Error(`Refusing to publish secrets: ${forbidden.join(', ')}`);
  for (const f of files) {
    if (!existsSync(join(root, f))) continue; // deleted in the working tree
    mkdirSync(dirname(join(bundle, f)), { recursive: true });
    cpSync(join(root, f), join(bundle, f));
  }
  cpSync(join(root, 'deploy/huggingface/Dockerfile'), join(bundle, 'Dockerfile'));
  writeFileSync(
    join(bundle, 'README.md'),
    `---\ntitle: UBOCE\nemoji: 🌱\ncolorFrom: green\ncolorTo: yellow\nsdk: docker\napp_port: 7860\npinned: false\n---\n\nUBOCE — the backend and web app in one container. Built from the uboce repo by scripts/hf-push.mjs.\n`,
  );

  // 2. Web app, served by the gateway from the same origin (so it calls /api directly).
  if (!existsSync(join(webDir, 'package.json'))) throw new Error(`Web app not found at ${webDir} (set WEB_REPO in space.env)`);
  console.log('Building the web app…');
  execFileSync('pnpm', ['exec', 'vite', 'build'], { cwd: webDir, stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, VITE_API_URL: '' } });
  cpSync(join(webDir, 'dist'), join(bundle, 'web'), { recursive: true });

  if (bundleArg) {
    console.log(`Bundle written to ${bundle}`);
    process.exit(0);
  }

  // 3. Push. Hugging Face only accepts binary files through LFS/Xet.
  sh('git', ['init', '-q', '-b', 'main'], bundle);
  sh('git', ['lfs', 'install', '--local'], bundle);
  sh('git', ['lfs', 'track', '*.woff2', '*.woff', '*.ttf', '*.png', '*.jpg', '*.jpeg', '*.ico', '*.pdf', '*.webp'], bundle);
  sh('git', ['add', '-A'], bundle);
  sh('git', ['-c', 'user.name=uboce-deploy', '-c', 'user.email=deploy@uboce.local', 'commit', '-q', '-m', 'Deploy UBOCE'], bundle);
  const remote = `https://user:${token}@huggingface.co/spaces/${spaceId}`;
  console.log(`Pushing to huggingface.co/spaces/${spaceId}…`);
  execFileSync('git', ['push', '--force', remote, 'main'], { cwd: bundle, stdio: ['ignore', 'inherit', 'pipe'] });

  // 4. Optional: the configuration secret.
  if (process.argv.includes('--secrets')) {
    const value = readFileSync(join(root, 'deploy/huggingface/UBOCE_CONFIG.txt'), 'utf8').trim();
    const res = await fetch(`https://huggingface.co/api/spaces/${spaceId}/secrets`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'UBOCE_CONFIG', value }),
    });
    if (!res.ok) throw new Error(`Setting UBOCE_CONFIG failed: ${res.status} ${await res.text()}`);
    console.log('Set the UBOCE_CONFIG secret.');
  }
  console.log(`\nDone. Build logs: https://huggingface.co/spaces/${spaceId} (Logs tab).`);
} finally {
  if (!bundleArg) rmSync(bundle, { recursive: true, force: true });
}
