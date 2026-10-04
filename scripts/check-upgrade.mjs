#!/usr/bin/env node
// Upgrade rehearsal (ROADMAP T5.5, FR-OPS-008, NFR-MAINT-003): a database created by the previous
// release upgrades to this checkout by applying only the pending migrations, in order.
//
// Usage: node scripts/check-upgrade.mjs [--baseline <git-ref>]
//
// The baseline is the migration set of a released tag. Default: tag `v0.1.0` if it exists in this
// clone, else all migrations but the newest (so the script still rehearses a one-step upgrade
// before a second release exists). It uses wrangler's local D1 only; nothing touches Cloudflare.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(new URL(import.meta.url).pathname), '..');
const worker = join(root, 'apps/worker');
const migDir = join(worker, 'migrations');
const wrangler = join(worker, 'node_modules/.bin/wrangler');
const sqlFiles = (d) =>
  readdirSync(d)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();

const fail = (msg) => {
  console.error(`check-upgrade: FAIL: ${msg}`);
  process.exit(1);
};
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

const all = sqlFiles(migDir);
const refArg = process.argv.indexOf('--baseline');
let ref = refArg > -1 ? process.argv[refArg + 1] : undefined;
if (!ref) {
  try {
    git('rev-parse', '--verify', '--quiet', 'refs/tags/v0.1.0');
    ref = 'v0.1.0';
  } catch {
    ref = undefined;
  }
}
let baseline;
if (ref) {
  baseline = git('ls-tree', '--name-only', `${ref}:apps/worker/migrations`)
    .split('\n')
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();
} else {
  baseline = all.slice(0, -1);
}
const pending = all.filter((f) => !baseline.includes(f));
if (baseline.some((f, i) => all[i] !== f))
  fail('baseline is not a prefix of the current migrations');
console.log(`baseline ${ref ?? '(all but newest)'}: ${baseline.join(', ') || 'none'}`);
console.log(`pending: ${pending.join(', ') || 'none'}`);

const tmp = mkdtempSync(join(tmpdir(), 'cinewren-upgrade-'));
const state = join(tmp, 'state');
mkdirSync(state);
const project = (name, files) => {
  const dir = join(tmp, name);
  mkdirSync(join(dir, 'migrations'), { recursive: true });
  for (const f of files) cpSync(join(migDir, f), join(dir, 'migrations', f));
  writeFileSync(
    join(dir, 'wrangler.jsonc'),
    JSON.stringify({
      name: 'upgrade-check',
      main: 'index.js',
      compatibility_date: '2026-08-15',
      d1_databases: [
        {
          binding: 'DB',
          database_name: 'upgrade-check',
          database_id: '00000000-0000-0000-0000-000000000000',
          migrations_dir: 'migrations',
        },
      ],
    }),
  );
  writeFileSync(join(dir, 'index.js'), 'export default {};\n');
  return dir;
};
const run = (cwd, ...args) =>
  execFileSync(wrangler, ['d1', ...args, '--local', '--persist-to', state], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
  });
const applied = (cwd) =>
  JSON.parse(
    run(cwd, 'execute', 'DB', '--json', '--command', 'SELECT name FROM d1_migrations ORDER BY id'),
  )[0].results.map((r) => r.name);

try {
  // 1. A database as the baseline release left it.
  const old = project('old', baseline);
  if (baseline.length) run(old, 'migrations', 'apply', 'DB');
  if (baseline.length && applied(old).join() !== baseline.join()) fail('baseline did not apply');

  // 2. Upgrade with this checkout's migrations.
  const next = project('new', all);
  const listed = run(next, 'migrations', 'list', 'DB');
  for (const f of pending) if (!listed.includes(f)) fail(`${f} not listed as pending`);
  for (const f of baseline) if (listed.includes(f)) fail(`${f} wrongly listed as pending`);
  run(next, 'migrations', 'apply', 'DB');

  // 3. Same set, same order, nothing left, nothing re-run.
  if (applied(next).join() !== all.join()) fail(`applied ${applied(next).join()} != ${all.join()}`);
  if (!run(next, 'migrations', 'list', 'DB').includes('No migrations to apply')) {
    fail('migrations still pending after apply');
  }
  const tables = JSON.parse(
    run(
      next,
      'execute',
      'DB',
      '--json',
      '--command',
      "SELECT count(*) AS n FROM sqlite_master WHERE name='stream_device_leases'",
    ),
  )[0].results[0].n;
  if (all.includes('0003_stream_device_leases.sql') && tables !== 1) fail('0003 table missing');
  console.log(`check-upgrade: OK, ${pending.length} pending migration(s) applied in order`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
