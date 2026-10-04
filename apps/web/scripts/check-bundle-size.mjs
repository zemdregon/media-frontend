// NFR-PERF-003 / T2.7: the initial route's JavaScript must stay at or under 250 KB gzipped.
// "Initial route" = every script the built index.html loads on first paint: the entry module and
// its modulepreload links. Lazy route chunks (loaded by dynamic import) are not part of it.
// Fonts and CSS are excluded by the TDD (§6.6). Run after `vite build`; exits 1 when over budget.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const BUDGET_BYTES = 250 * 1024;
const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const html = readFileSync(join(dist, 'index.html'), 'utf8');

const files = new Set();
for (const m of html.matchAll(/<script[^>]+src="([^"]+)"/g)) files.add(m[1]);
for (const m of html.matchAll(/<link[^>]+rel="modulepreload"[^>]*href="([^"]+)"/g)) files.add(m[1]);
for (const m of html.matchAll(/<link[^>]+href="([^"]+)"[^>]*rel="modulepreload"/g)) files.add(m[1]);

let total = 0;
for (const f of files) {
  if (!f.endsWith('.js')) continue;
  const size = gzipSync(readFileSync(join(dist, f))).length;
  total += size;
  console.log(`  ${f}  ${(size / 1024).toFixed(1)} KB gzip`);
}

const kb = (total / 1024).toFixed(1);
if (total > BUDGET_BYTES) {
  console.error(`Initial route JS is ${kb} KB gzipped; the budget is 250 KB (NFR-PERF-003).`);
  process.exit(1);
}
console.log(`Initial route JS: ${kb} KB gzipped (budget 250 KB).`);
