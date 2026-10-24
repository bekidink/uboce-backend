// Starts the whole backend inside one container (Hugging Face Space):
//   Redis → pending migrations → 21 services → gateway on $PORT (7860).
//
// Configuration arrives as one secret, UBOCE_CONFIG: base64 of gzipped JSON
// { shared: {KEY: value}, services: {name: {KEY: value}}, gateway: {KEY: value} },
// made by `pnpm hf:config`. Each process gets only its own settings.
// Crashed processes are restarted with backoff; SIGTERM stops everything.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import net from 'node:net';
import { gunzipSync } from 'node:zlib';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const PORT = process.env.PORT ?? '7860';

if (!process.env.UBOCE_CONFIG) {
  console.error('UBOCE_CONFIG is not set. Add it as a Space secret (pnpm hf:config prints it).');
  process.exit(1);
}
const config = JSON.parse(gunzipSync(Buffer.from(process.env.UBOCE_CONFIG, 'base64')).toString('utf8'));

// Only what a Node process needs from the container; never the whole config blob.
const base = {
  PATH: process.env.PATH,
  HOME: process.env.HOME ?? '/tmp',
  NODE_ENV: 'production',
  NODE_OPTIONS: '--max-old-space-size=384',
};
const envFor = (name) => ({ ...base, ...config.shared, ...(name === 'gateway' ? config.gateway : config.services[name]) });

const children = new Set();
let stopping = false;
const log = (name, line) => process.stdout.write(`[${name}] ${line}\n`);

function pipe(name, stream) {
  let rest = '';
  stream.on('data', (chunk) => {
    const lines = (rest + chunk).split('\n');
    rest = lines.pop();
    for (const l of lines) if (l) log(name, l);
  });
}

/** Runs a long-lived process, restarting it if it exits. */
function supervise(name, command, args, options) {
  let delay = 1000;
  const start = () => {
    if (stopping) return;
    const started = Date.now();
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    pipe(name, child.stdout);
    pipe(name, child.stderr);
    child.on('exit', (code, signal) => {
      children.delete(child);
      if (stopping) return;
      if (Date.now() - started > 60_000) delay = 1000; // it ran fine for a while: reset backoff
      log('launcher', `${name} exited (${signal ?? code}); restarting in ${delay / 1000}s`);
      setTimeout(start, delay);
      delay = Math.min(delay * 2, 30_000);
    });
  };
  start();
}

/** Runs a command to completion. */
const run = (name, command, args, options) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    pipe(name, child.stdout);
    pipe(name, child.stderr);
    child.on('exit', (code) => resolve(code ?? 1));
  });

const waitForPort = (port, timeoutMs) =>
  new Promise((resolve) => {
    const end = Date.now() + timeoutMs;
    const attempt = () => {
      const socket = net.connect({ host: '127.0.0.1', port }, () => {
        socket.end();
        resolve(true);
      });
      socket.on('error', () => (Date.now() > end ? resolve(false) : setTimeout(attempt, 500)));
    };
    attempt();
  });

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    stopping = true;
    log('launcher', `${signal}: stopping ${children.size} processes`);
    for (const c of children) c.kill('SIGTERM');
    setTimeout(() => process.exit(0), 8000).unref();
  });
}

// 1. Redis (event streams; data lives only as long as the container).
mkdirSync('/tmp/redis', { recursive: true });
supervise('redis', 'redis-server', ['--port', '6379', '--bind', '127.0.0.1', '--dir', '/tmp/redis', '--appendonly', 'yes', '--maxmemory-policy', 'noeviction', '--save', ''], {});
if (!(await waitForPort(6379, 30_000))) log('launcher', 'Redis did not start in 30s; continuing');

const services = Object.keys(config.services);

// 2. Migrations, one service at a time (the session pooler allows few connections).
if (process.env.UBOCE_SKIP_MIGRATIONS !== 'true') {
  for (const name of services) {
    const env = envFor(name);
    if (!env.MIGRATE_DATABASE_URL && !env.DATABASE_URL) continue;
    const code = await run(`migrate:${name}`, process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], { cwd: `${ROOT}services/${name}`, env });
    if (code !== 0) log('launcher', `migrations for ${name} failed (exit ${code}); starting anyway`);
  }
}

// 3. Services.
for (const name of services) supervise(name, process.execPath, ['dist/main.js'], { cwd: `${ROOT}services/${name}`, env: envFor(name) });
const ready = await Promise.all(services.map((name) => waitForPort(Number(config.services[name].PORT), 180_000)));
log('launcher', `${ready.filter(Boolean).length}/${services.length} services listening`);

// 4. Gateway: the Space's public port; also serves the web app.
supervise('gateway', process.execPath, ['dist/main.js'], { cwd: `${ROOT}apps/gateway`, env: { ...envFor('gateway'), PORT } });
