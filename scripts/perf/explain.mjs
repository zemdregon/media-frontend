#!/usr/bin/env node
// Query plans for the catalog and play read paths against an already seeded perf database.
//
//   node scripts/perf/explain.mjs            analyse scripts/perf/.state (left behind by run.mjs)
//   node scripts/perf/explain.mjs --plans    also print every plan
//
// For each query the app issues (captured from the real builders, see queries.mjs) it reports the
// SQLite engine time on this machine, full table scans (`SCAN` without an index), and temp B-trees
// (sorts the index did not satisfy). Engine time is the query alone, without Worker or HTTP.
import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './seed.mjs';

const here = dirname(fileURLToPath(import.meta.url));

export function findSqlite(state) {
  const dir = join(state, 'v3', 'd1', 'miniflare-D1DatabaseObject');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sqlite') && !f.startsWith('metadata'));
  files.sort((a, b) => statSync(join(dir, b)).size - statSync(join(dir, a)).size);
  if (!files[0]) throw new Error(`no D1 sqlite file under ${dir}`);
  return join(dir, files[0]);
}

/** Plans, scans, sorts and engine time for each captured query. */
export function analyze(db, captured, inline, reps = 1) {
  return captured.map((c) => {
    const sql = inline(c);
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all()
      .map((r) => r.detail);
    const scans = plan.filter(
      (d) =>
        /^SCAN /.test(d) &&
        !/USING (COVERING )?INDEX/.test(d) &&
        !/VIRTUAL TABLE/.test(d) &&
        !/json_each|CONSTANT ROW|\(subquery/.test(d),
    );
    const sorts = plan.filter((d) => /TEMP B-TREE/.test(d));
    let best = Infinity;
    let rows = 0;
    for (let i = 0; i < reps; i++) {
      const t0 = performance.now();
      rows = db.prepare(sql).all().length;
      best = Math.min(best, performance.now() - t0);
    }
    return { name: c.name, ms: +best.toFixed(1), rows, scans, sorts, plan };
  });
}

export function sampleIds(db, cat, user) {
  const one = (sql, ...p) =>
    db
      .prepare(sql)
      .all(...p)
      .map((r) => r.id)[0];
  const op = user.role === 'operator' ? 1 : 0;
  const item = (type) =>
    one(
      `SELECT i.id FROM media_items i WHERE i.type = ?3 AND i.rowid IN
         (SELECT rowid FROM media_items WHERE type = ?3 ORDER BY random() LIMIT 1500)
         AND ${cat.visibleItem('i')} LIMIT 1`,
      op,
      user.userId,
      type,
    );
  const entity = (table, predicate) =>
    one(
      `SELECT i.id FROM ${table} i WHERE i.rowid IN
         (SELECT rowid FROM ${table} ORDER BY random() LIMIT 1500) AND ${predicate('i')} LIMIT 1`,
      op,
      user.userId,
    );
  return {
    item: item('movie'),
    series: item('series'),
    season: item('season'),
    person: entity('people', cat.visiblePerson),
    collection: entity('collections', cat.visibleCollection),
    viewer: user.userId,
  };
}

export function print(rows, withPlans) {
  const w = Math.max(...rows.map((r) => r.name.length));
  console.log(`${'query'.padEnd(w)}  engine ms  rows  scans  sorts`);
  for (const r of rows.sort((a, b) => b.ms - a.ms)) {
    console.log(
      `${r.name.padEnd(w)}  ${String(r.ms).padStart(9)}  ${String(r.rows).padStart(4)}  ${String(r.scans.length).padStart(5)}  ${String(r.sorts.length).padStart(5)}`,
    );
    if (withPlans) for (const d of r.plan) console.log(`      ${d}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const q = await import('./queries.mjs');
  const cat = await import(
    new URL(`file://${join(here, '..', '..', 'apps', 'worker', 'src', 'db', 'catalog.ts')}`).href
  );
  const db = openDb(findSqlite(join(here, '.state')));
  const viewer = db.prepare("SELECT id FROM users WHERE id = 'PU001'").get();
  const ids = sampleIds(db, cat, { role: 'viewer', userId: viewer.id });
  const rows = analyze(db, await q.captureQueries(ids), q.inline);
  print(rows, process.argv.includes('--plans'));
  db.close();
}
