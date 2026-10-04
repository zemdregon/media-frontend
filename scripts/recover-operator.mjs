#!/usr/bin/env node
// Last-operator recovery (FR-USR-007, ADR-0014 decision 4). Issues a single-use, 24 h
// re-enrollment link for an active operator who lost every passkey, by writing straight to D1
// through `wrangler d1 execute`. Access to the Cloudflare account is the root of trust.
//
//   pnpm recover:operator -- --config wrangler.jsonc --remote --origin https://cinewren.example.workers.dev [--user <name|id>] [--env staging]
//
// The token and its hash come from packages/shared (the same code the Worker uses). Only the
// link is printed; the database receives only the token's hash.
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACTIVE_OPERATORS_SQL,
  findOperatorSql,
  planRecovery,
} from '../packages/shared/src/recovery.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE =
  'Usage: pnpm recover:operator -- --config <wrangler config> (--remote | --local) --origin <APP_ORIGIN> [--user <displayName or id>] [--env <name>]';

function fail(msg) {
  console.error(`recover-operator: ${msg}\n${USAGE}`);
  process.exit(1);
}

/** Runs SQL on the DB binding and returns the first result set's rows. */
function d1(opts, sql) {
  const args = [
    '--filter',
    '@cinewren/worker',
    'exec',
    'wrangler',
    'd1',
    'execute',
    'DB',
    '--config',
    opts.config,
    opts.remote ? '--remote' : '--local',
    '--json',
    '--command',
    sql,
  ];
  if (opts.env) args.push('--env', opts.env);
  const out = execFileSync('pnpm', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const parsed = JSON.parse(out.slice(out.indexOf('[')));
  return parsed[0]?.results ?? [];
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--') argv.shift(); // pnpm forwards the separator
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string' },
      env: { type: 'string' },
      remote: { type: 'boolean', default: false },
      local: { type: 'boolean', default: false },
      user: { type: 'string' },
      origin: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!values.config) fail('--config is required.');
  if (values.remote === values.local) fail('Pass exactly one of --remote or --local.');
  if (!values.origin || !/^https?:\/\/[^/]+$/.test(values.origin.replace(/\/+$/, ''))) {
    fail('--origin must be the APP_ORIGIN, for example https://cinewren.example.workers.dev.');
  }
  const opts = {
    config: path.resolve(process.env.INIT_CWD ?? process.cwd(), values.config),
    env: values.env,
    remote: values.remote,
  };

  let operator;
  if (values.user) {
    operator = d1(opts, findOperatorSql(values.user))[0];
    if (!operator) fail(`No active operator matches "${values.user}".`);
  } else {
    const operators = d1(opts, ACTIVE_OPERATORS_SQL);
    if (operators.length === 0) fail('There is no active operator in this database.');
    if (operators.length > 1) {
      const list = operators.map((o) => `  ${o.display_name} (${o.id})`).join('\n');
      fail(`Several active operators exist; choose one with --user:\n${list}`);
    }
    operator = operators[0];
  }

  const plan = await planRecovery({ userId: operator.id, appOrigin: values.origin });
  d1(opts, plan.sql.join(';\n'));

  console.log(`Recovery link for operator "${operator.display_name}" (single use):`);
  console.log(plan.link);
  console.log(
    `Expires ${new Date(plan.expiresAt).toISOString()}. Open it in a browser to add a passkey.`,
  );
}

main().catch((err) => {
  console.error(`recover-operator: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
