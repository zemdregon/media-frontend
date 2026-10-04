#!/usr/bin/env node
// Documentation consistency check for Cinewren (ROADMAP T0.3, NFR-MAINT-002).
// Usage: node scripts/check-docs.mjs   (exit code 1 on any error)
//
// Checks:
//  1. Relative Markdown links resolve to existing files, and #anchors to existing headings.
//  2. Every stable ID referenced anywhere is defined in its canonical document.
//  3. LLD section IDs exist as `## LLD-XXX — ...` headings.
//  4. SRS: every row has priority, milestone and verification; every Must appears in §8.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';

const root = resolve(dirname(new URL(import.meta.url).pathname), '..');
const errors = [];
const err = (file, msg) => errors.push(`${relative(root, file)}: ${msg}`);

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.md') ? [p] : [];
  });
}

const files = [
  ...['AGENTS.md', 'CLAUDE.md', 'README.md'].map((f) => join(root, f)).filter(existsSync),
  ...walk(join(root, 'docs')),
];
const text = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));
const isSource = (f) => f.includes(`${join('docs', 'sources')}`);

// GitHub-style heading slug.
const slug = (h) =>
  h.trim().toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
const anchorsOf = (md) => {
  const seen = new Map();
  const out = new Set();
  for (const m of stripCode(md).matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = slug(m[1]);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  return out;
};
function stripCode(md) {
  return md.replace(/^```[\s\S]*?^```/gm, '');
}

// 1. Links
for (const [file, md] of text) {
  if (isSource(file)) continue;
  for (const m of stripCode(md).matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = m[1];
    if (/^(https?:|mailto:)/.test(target)) continue;
    const [pathPart, anchor] = target.split('#');
    const dest = pathPart ? resolve(dirname(file), pathPart) : file;
    if (!existsSync(dest)) { err(file, `broken link -> ${target}`); continue; }
    if (anchor && dest.endsWith('.md')) {
      const md2 = text.get(dest) ?? readFileSync(dest, 'utf8');
      if (!anchorsOf(md2).has(anchor)) err(file, `missing anchor -> ${target}`);
    }
  }
}

// 2. ID definitions
const doc = (p) => text.get(join(root, p)) ?? '';
const SRS = doc('docs/requirements/SRS.md');
const LLD = doc('docs/design/LLD.md');
const adrFiles = existsSync(join(root, 'docs/adr')) ? readdirSync(join(root, 'docs/adr')) : [];

const srsRowIds = new Set([...SRS.matchAll(/^\|\s*((?:FR|IR|DR|NFR)-[A-Z0-9-]+)\s*\|/gm)].map((m) => m[1]));
const lldIds = new Set([...LLD.matchAll(/^##\s+(LLD-[A-Z]+)\s+—/gm)].map((m) => m[1]));
const definedIn = (canon) => {
  const t = doc(canon);
  return (id) => new RegExp(`(^|[^A-Za-z0-9-])${id.replace(/[.]/g, '\\.')}(?![0-9])`).test(t);
};
const rules = [
  { re: /\b(?:FR|IR|DR|NFR)-[A-Z]*-?\d{3}\b/g, ok: (id) => srsRowIds.has(id), canon: 'SRS row' },
  { re: /\bBR-\d+\b/g, ok: definedIn('docs/requirements/FRD.md'), canon: 'FRD' },
  { re: /\bWF-\d+\b/g, ok: definedIn('docs/requirements/FRD.md'), canon: 'FRD' },
  { re: /\b(?:CAP|DEF)-\d+\b/g, ok: definedIn('docs/requirements/PRD.md'), canon: 'PRD' },
  { re: /\bJ-\d+\b/g, ok: definedIn('docs/requirements/PRD.md'), canon: 'PRD' },
  { re: /\bP-\d\b/g, ok: definedIn('docs/requirements/PRD.md'), canon: 'PRD' },
  { re: /\bBO-\d+\b/g, ok: definedIn('docs/requirements/BRD.md'), canon: 'BRD' },
  { re: /\bC-[A-Z]{2,}\b/g, ok: definedIn('docs/design/HLD.md'), canon: 'HLD' },
  { re: /\b(?:TB|DF)-\d+\b/g, ok: definedIn('docs/design/HLD.md'), canon: 'HLD' },
  { re: /\b(?:A|Q|R|B)-\d+\b/g, ok: definedIn('docs/ROADMAP.md'), canon: 'ROADMAP' },
  { re: /\bC-\d+\b/g, ok: definedIn('docs/ROADMAP.md'), canon: 'ROADMAP' },
  { re: /\bT\d\.\d+\b/g, ok: definedIn('docs/ROADMAP.md'), canon: 'ROADMAP' },
  { re: /\bLLD-[A-Z]+\b/g, ok: (id) => lldIds.has(id), canon: 'LLD heading' },
  { re: /\bADR-\d{4}\b/g, ok: (id) => adrFiles.some((f) => f.startsWith(id.slice(4) + '-')), canon: 'docs/adr file' },
];
for (const [file, md] of text) {
  if (isSource(file)) continue;
  const seen = new Set();
  for (const { re, ok, canon } of rules) {
    for (const m of md.matchAll(re)) {
      const id = m[0];
      if (seen.has(id)) continue;
      seen.add(id);
      if (!ok(id)) err(file, `${id} is not defined in ${canon}`);
    }
  }
}

// 3. Expected LLD sections
for (const id of ['LLD-SCHEMA', 'LLD-API', 'LLD-PROV', 'LLD-SYNC', 'LLD-MATCH', 'LLD-SEL', 'LLD-TOKEN', 'LLD-ERR']) {
  if (LLD && !lldIds.has(id)) err(join(root, 'docs/design/LLD.md'), `missing section ${id}`);
}

// 4. SRS row completeness and Must coverage in §8
const srsFile = join(root, 'docs/requirements/SRS.md');
const sec8 = SRS.split(/^## 8\./m)[1] ?? '';
const expand = (s) =>
  s.replace(/((?:FR|IR|DR|NFR)-[A-Z]+-)(\d{3}) to \1(\d{3})/g, (_, p, a, b) =>
    Array.from({ length: +b - +a + 1 }, (_, i) => p + String(+a + i).padStart(3, '0')).join(', '));
const covered = new Set(expand(sec8).match(/\b(?:FR|IR|DR|NFR)-[A-Z]*-?\d{3}\b/g) ?? []);
for (const m of SRS.matchAll(/^\|\s*((?:FR|IR|DR|NFR)-[A-Z0-9-]+)\s*\|(.*)$/gm)) {
  const id = m[1];
  const cells = m[2].split('|').map((c) => c.trim());
  const pri = cells.find((c) => /^(Must|Should|Could|Withdrawn)$/.test(c));
  if (!pri) err(srsFile, `${id} has no priority`);
  if (!cells.some((c) => /^M\d|^M\d, M\d/.test(c))) err(srsFile, `${id} has no milestone`);
  if (!/^[TIDA](, [TIDA])*$/.test(cells.at(-2) ?? '')) err(srsFile, `${id} has no verification method`);
  if (pri === 'Must' && !covered.has(id)) err(srsFile, `Must ${id} missing from §8 coverage table`);
}

if (errors.length) {
  console.error(`check-docs: ${errors.length} problem(s)\n` + errors.map((e) => `  - ${e}`).join('\n'));
  process.exit(1);
}
console.log(`check-docs: OK (${files.length} files, ${srsRowIds.size} SRS requirements)`);
