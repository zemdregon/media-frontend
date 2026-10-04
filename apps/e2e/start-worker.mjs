// Starts the real Worker for E2E (T2.8): fresh local D1, migrations applied, then `wrangler dev`
// serving the built SPA and the API on E2E_WORKER_PORT. All configuration is passed as `--var`
// flags, so no secret file is needed and nothing real is touched.
//
// Test-only values (never used outside this harness):
//   SETUP_TOKEN          the first-operator bootstrap token the journey types into /setup
//   CREDENTIAL_KEYS      a throwaway AES key for the credential vault
//   ALLOW_INSECURE_ORIGINS  lets the Worker register the http:// mock origin (honoured only when
//                        ENVIRONMENT=local, FR-SRV-007)
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const worker = join(repo, 'apps', 'worker');
const state = join(here, '.state');
const port = process.env.E2E_WORKER_PORT ?? '8788';

// Keep in step with support/env.ts.
const SETUP_TOKEN =
  process.env.E2E_SETUP_TOKEN ?? 'e2e-setup-token-0123456789abcdef0123456789abcdef';
const CREDENTIAL_KEY = Buffer.alloc(32, 7).toString('base64');

if (!existsSync(join(repo, 'apps', 'web', 'dist', 'index.html'))) {
  console.log('apps/web/dist is missing; building the SPA first');
  const build = spawnSync('pnpm', ['--filter', '@cinewren/web', 'build'], {
    cwd: repo,
    stdio: 'inherit',
  });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

// A clean database every run: the journey creates the first operator through /setup.
rmSync(state, { recursive: true, force: true });
mkdirSync(state, { recursive: true });

const env = { ...process.env, CI: '1' };
const migrate = spawnSync(
  'pnpm',
  [
    'exec',
    'wrangler',
    'd1',
    'migrations',
    'apply',
    'cinewren-local',
    '--local',
    '--persist-to',
    state,
  ],
  { cwd: worker, stdio: 'inherit', env },
);
if (migrate.status !== 0) process.exit(migrate.status ?? 1);

const dev = spawn(
  'pnpm',
  [
    'exec',
    'wrangler',
    'dev',
    '--port',
    port,
    '--persist-to',
    state,
    '--var',
    `SETUP_TOKEN:${SETUP_TOKEN}`,
    `--var=CREDENTIAL_KEYS:${JSON.stringify({ 1: CREDENTIAL_KEY })}`,
    '--var',
    'ALLOW_INSECURE_ORIGINS:true',
    '--var',
    `APP_ORIGIN:http://localhost:${port}`,
  ],
  { cwd: worker, stdio: 'inherit', env },
);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    dev.kill(signal);
  });
}
dev.on('exit', (code) => process.exit(code ?? 0));
