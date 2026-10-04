#!/usr/bin/env node
// Builds GitHub Release notes for a tag (FR-OPS-008, TDD §9.1): the CHANGELOG.md section for the
// version, the migration list, and the upgrade steps.
// Usage: node scripts/release-notes.mjs vX.Y.Z > notes.md   (exit 1 if the version has no section)
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(new URL(import.meta.url).pathname), '..');
const tag = process.argv[2];
if (!tag || !/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(tag)) {
  console.error('usage: release-notes.mjs vX.Y.Z');
  process.exit(1);
}
const version = tag.slice(1);

const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
const lines = changelog.split('\n');
const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
if (start < 0) {
  console.error(`CHANGELOG.md has no "## [${version}]" section`);
  process.exit(1);
}
let end = lines.findIndex((l, i) => i > start && /^(## |\[[^\]]+\]: )/.test(l));
if (end < 0) end = lines.length;
const section = lines
  .slice(start + 1, end)
  .join('\n')
  .trim();

const migrations = readdirSync(join(root, 'apps/worker/migrations'))
  .filter((f) => /^\d{4}_.+\.sql$/.test(f))
  .sort();

console.log(`${section}\n`);
console.log('## Migrations\n');
console.log(
  `Highest migration number: ${migrations.length > 0 ? migrations.at(-1).slice(0, 4) : 'none'}.\n`,
);
for (const m of migrations) console.log(`- \`${m}\``);
console.log(`
## Upgrading

Record a D1 Time Travel bookmark first, then bring this tag into your deployment and let it run
\`pnpm run deploy\` (migrations, then the Worker). If you deploy by hand, apply migrations before
the Worker: \`pnpm run migrate\`. Until they are applied, the API answers 503 \`MIGRATIONS_PENDING\`.
Full steps and rollback: [docs/operations/self-host.md](docs/operations/self-host.md#7-upgrading-to-a-new-release).`);
