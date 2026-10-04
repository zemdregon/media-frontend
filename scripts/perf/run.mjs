#!/usr/bin/env node
// T5.7 performance run at the NFR-SCALE-001 envelope (docs/reports/2026-perf-cost.md).
//
//   node scripts/perf/run.mjs [--quick] [--keep] [--worker-port 8789] [--origin-port 8791]
//
// What it does, all local (wrangler dev + Miniflare's SQLite-backed D1, nothing deployed):
//   1. applies the migrations to a fresh local D1 under scripts/perf/.state
//   2. seeds 50 users with session cookies, starts the Worker and the mock origin, and registers
//      the mock origin through the real admin API (so play has a server with a real vault entry)
//   3. seeds 20 servers, 200,000 sources over 120,000 canonical items, people, collections, FTS
//   4. EXPLAIN QUERY PLAN for every catalog and play query (full scans, temp B-trees) and its engine time
//   5. restarts the Worker and measures browse, search, detail, home and POST /play latency
//
// The numbers are LOCAL measurements: wall-clock time of an HTTP request from this process to a
// local `wrangler dev` (workerd + Miniflare D1). They are not production D1 latency.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from './explain.mjs';
import { ENVELOPE, counts, openDb, seedCatalog, seedUsers } from './seed.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const worker = join(repo, 'apps', 'worker');
const state = join(here, '.state');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const QUICK = flag('--quick');
const PORT = Number(opt('--worker-port', '8789'));
const ORIGIN_PORT = Number(opt('--origin-port', '8791'));
const BASE = `http://localhost:${String(PORT)}`;
const ORIGIN = `http://127.0.0.1:${String(ORIGIN_PORT)}`;
const REPS = QUICK ? 60 : 300;
const WARMUP = QUICK ? 10 : 30;
const CREDENTIAL_KEY = Buffer.alloc(32, 7).toString('base64');
const SETUP_TOKEN = 'perf-setup-token-0123456789abcdef0123456789abcdef';

const log = (...a) => {
  console.log(`[perf ${new Date().toISOString().slice(11, 19)}]`, ...a);
};

// ---------------------------------------------------------------- processes

const children = [];
function start(cmd, args, opts) {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', ...opts });
  children.push(child);
  return child;
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
  await new Promise((r) => {
    child.once('exit', r);
    setTimeout(r, 8000);
  });
}
process.on('exit', () => {
  for (const c of children) {
    try {
      process.kill(-c.pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
});

async function waitFor(url, what, ms = 120_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${what} did not come up at ${url}`);
}

function startWorker() {
  return start(
    'pnpm',
    [
      'exec',
      'wrangler',
      'dev',
      '--port',
      String(PORT),
      '--persist-to',
      state,
      '--var',
      `SETUP_TOKEN:${SETUP_TOKEN}`,
      `--var=CREDENTIAL_KEYS:${JSON.stringify({ 1: CREDENTIAL_KEY })}`,
      '--var',
      'ALLOW_INSECURE_ORIGINS:true',
      '--var',
      `APP_ORIGIN:${BASE}`,
    ],
    { cwd: worker, env: { ...process.env, CI: '1' } },
  );
}

function findSqlite() {
  const dir = join(state, 'v3', 'd1', 'miniflare-D1DatabaseObject');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sqlite') && !f.startsWith('metadata'));
  // The database file is the biggest one (the other holds Miniflare bookkeeping).
  files.sort((a, b) => statSync(join(dir, b)).size - statSync(join(dir, a)).size);
  if (!files[0]) throw new Error('no D1 sqlite file under the persist dir');
  return join(dir, files[0]);
}

// ---------------------------------------------------------------- statistics

const pct = (sorted, p) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
function summarize(ms) {
  const s = [...ms].sort((a, b) => a - b);
  return {
    n: s.length,
    p50: +pct(s, 50).toFixed(1),
    p95: +pct(s, 95).toFixed(1),
    p99: +pct(s, 99).toFixed(1),
    max: +s.at(-1).toFixed(1),
    mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(1),
  };
}

function rng(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- HTTP

async function call(user, method, path, body, extra = {}) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      cookie: `__Host-cw_session=${user.cookie}`,
      ...(body ? { 'content-type': 'application/json', origin: BASE } : {}),
      ...extra,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const ms = performance.now() - t0;
  return { status: res.status, ms, text };
}

async function adminJson(user, method, path, body) {
  const r = await call(user, method, path, body);
  if (r.status >= 300)
    throw new Error(`${method} ${path} -> ${String(r.status)} ${r.text.slice(0, 200)}`);
  return JSON.parse(r.text);
}

/** Runs `makeRequest(i)` REPS times at the given concurrency; returns timings and status counts. */
async function measure(name, makeRequest, { reps = REPS, concurrency = 1, warmup = WARMUP } = {}) {
  for (let i = 0; i < warmup; i++) await makeRequest(-1 - i);
  const times = [];
  const statuses = {};
  let next = 0;
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < reps) {
        const i = next++;
        const r = await makeRequest(i);
        times.push(r.ms);
        statuses[r.status] = (statuses[r.status] ?? 0) + 1;
      }
    }),
  );
  const wall = performance.now() - t0;
  const row = {
    name,
    concurrency,
    ...summarize(times),
    rps: +((reps / wall) * 1000).toFixed(1),
    statuses,
  };
  log(
    `${name.padEnd(46)} c=${String(concurrency).padEnd(2)} p50=${String(row.p50).padStart(6)} ms  p95=${String(row.p95).padStart(6)} ms  max=${String(row.max).padStart(6)}  ${JSON.stringify(statuses)}`,
  );
  return row;
}

// ---------------------------------------------------------------- main

async function main() {
  const t0 = Date.now();
  rmSync(state, { recursive: true, force: true });
  mkdirSync(state, { recursive: true });
  const env = { ...process.env, CI: '1' };

  log('applying migrations to a fresh local D1');
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
    { cwd: worker, stdio: 'ignore', env },
  );
  if (migrate.status !== 0) throw new Error('migrations failed');
  const dbFile = findSqlite();

  log('seeding users and sessions');
  let db = openDb(dbFile);
  const users = seedUsers(db);
  db.close();
  const operator = users[0];
  const viewers = users.slice(1);

  log('starting the mock origin and the Worker; registering the origin as a server');
  start('node', [join(repo, 'apps', 'e2e', 'mock-origin.mjs')], {
    env: { ...process.env, MOCK_ORIGIN_PORT: String(ORIGIN_PORT) },
  });
  await waitFor(`${ORIGIN}/__requests`, 'mock origin', 30_000);
  let w = startWorker();
  await waitFor(`${BASE}/api/v1/health`, 'worker');
  const server = await adminJson(operator, 'POST', '/api/v1/admin/servers', {
    type: 'jellyfin',
    name: 'Perf Origin',
    baseUrl: ORIGIN,
    credentials: { username: 'cinewren-svc', password: 'not-a-real-password' },
  });
  const moviesLib = server.libraries.find((l) => l.kind === 'movies');
  const tvLib = server.libraries.find((l) => l.kind === 'tv');
  if (!moviesLib || !tvLib) throw new Error('the mock origin lacks a movies or TV library');
  // Let the first sync finish so nothing is mid-flight when the database is replaced.
  for (let i = 0; i < 120; i++) {
    const runs = await adminJson(operator, 'GET', `/api/v1/admin/servers/${server.id}/sync-runs`);
    if (runs.items.every((r) => r.status !== 'queued' && r.status !== 'running')) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  await stop(w);

  log(`seeding the envelope: ${JSON.stringify(ENVELOPE)}`);
  db = openDb(dbFile);
  const seedStart = Date.now();
  seedCatalog(db, { serverId: server.id, moviesLib: moviesLib.id, tvLib: tvLib.id });
  db.exec(`UPDATE libraries SET enabled = 1 WHERE server_id = '${server.id}'`);
  db.exec(
    `INSERT OR IGNORE INTO library_grants (user_id, library_id, granted_at)
     SELECT u.id, l.id, ${Date.now()} FROM users u, libraries l
      WHERE u.role = 'viewer' AND l.server_id = '${server.id}' AND CAST(substr(u.id, 3) AS INTEGER) % 2 = 0`,
  );
  const rows = counts(db);
  log(`seeded in ${((Date.now() - seedStart) / 1000).toFixed(1)} s: ${JSON.stringify(rows)}`);

  // ---- samples of ids each user can really see, and play targets on the real server ----
  const q = await import('./queries.mjs');
  const cat = await import(pathUrl('apps/worker/src/db/catalog.ts'));
  const sample = (user, type) =>
    db
      .prepare(
        `SELECT i.id FROM media_items i WHERE i.type = ?3 AND i.rowid IN
           (SELECT rowid FROM media_items WHERE type = ?3 ORDER BY random() LIMIT 1500)
           AND ${cat.visibleItem('i')} LIMIT 200`,
      )
      .all(user.role === 'operator' ? 1 : 0, user.userId, type)
      .map((r) => r.id);
  const entitySample = (user, table, predicate) =>
    db
      .prepare(
        `SELECT i.id FROM ${table} i WHERE i.rowid IN
           (SELECT rowid FROM ${table} ORDER BY random() LIMIT 1500) AND ${predicate('i')} LIMIT 100`,
      )
      .all(user.role === 'operator' ? 1 : 0, user.userId)
      .map((r) => r.id);
  const visible = new Map();
  for (const u of users) {
    visible.set(u.userId, {
      movies: sample(u, 'movie'),
      series: sample(u, 'series'),
      seasons: sample(u, 'season'),
      people: entitySample(u, 'people', cat.visiblePerson),
      collections: entitySample(u, 'collections', cat.visibleCollection),
    });
  }
  // Movies whose only copy is on the real (mock) server, and the users who may see them.
  const playItems = db
    .prepare(
      `SELECT s.media_item_id AS id FROM sources s WHERE s.server_id = ? AND s.item_type = 'movie'
         AND (SELECT count(*) FROM sources o WHERE o.media_item_id = s.media_item_id) = 1 LIMIT 600`,
    )
    .all(server.id)
    .map((r) => r.id);
  const playUsers = users.filter((u) =>
    u.role === 'operator'
      ? true
      : db
          .prepare('SELECT 1 FROM library_grants WHERE user_id = ? AND library_id = ?')
          .get(u.userId, moviesLib.id) !== undefined,
  );
  log(
    `play targets: ${String(playItems.length)} movies on the mock origin, ${String(playUsers.length)} users who may play them`,
  );

  // ---- query plans and rows read ----
  const mid = visible.get(viewers[0].userId);
  const captured = await q.captureQueries({
    item: mid.movies[0],
    series: mid.series[0],
    season: mid.seasons[0] ?? mid.series[0],
    person: mid.people[0],
    collection: mid.collections[0],
    viewer: viewers[0].userId,
  });
  const plans = analyze(db, captured, q.inline);
  db.close();

  // ---- latency ----
  log('starting the Worker for measurement');
  w = startWorker();
  await waitFor(`${BASE}/api/v1/health`, 'worker');
  const rand = rng(42);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const viewerAt = (i) => viewers[((i % viewers.length) + viewers.length) % viewers.length];
  const userFor = (i, who) => (who === 'operator' ? operator : viewerAt(i));

  const results = [];
  const families = (who) => {
    const v = (i) => visible.get(userFor(i, who).userId);
    const get = (name, path) => ({
      name: `${name} [${who}]`,
      fn: (i) => call(userFor(i, who), 'GET', path(i, v(i))),
    });
    return [
      get('home', () => '/api/v1/home'),
      get('browse: movies by title', () => '/api/v1/items?type=movie&sort=title&limit=50'),
      get('browse: series by title', () => '/api/v1/items?type=series&sort=title&limit=50'),
      get(
        'browse: movies newest first',
        () => '/api/v1/items?type=movie&sort=added&order=desc&limit=50',
      ),
      get('browse: movies by year', () => '/api/v1/items?type=movie&sort=year&limit=50'),
      get('browse: genre filter', () => '/api/v1/items?type=movie&genre=Western&limit=50'),
      get(
        'browse: year range filter',
        () => '/api/v1/items?type=movie&yearFrom=1950&yearTo=1959&limit=50',
      ),
      get('browse: min height filter', () => '/api/v1/items?type=movie&minHeight=2160&limit=50'),
      get('search: 2-letter prefix', () => '/api/v1/search?q=ni'),
      get(
        'search: word',
        () => `/api/v1/search?q=${pick(['night', 'river', 'storm', 'golden', 'shadow'])}`,
      ),
      get('search: two words', () => '/api/v1/search?q=silent+harbor'),
      get('search: no hits', () => '/api/v1/search?q=qqzzxx'),
      get('detail: movie', (i, vis) => `/api/v1/items/${pick(vis.movies)}`),
      get('detail: series', (i, vis) => `/api/v1/items/${pick(vis.series)}`),
      get('detail: series seasons', (i, vis) => `/api/v1/items/${pick(vis.series)}/children`),
      get('detail: movie versions', (i, vis) => `/api/v1/items/${pick(vis.movies)}/versions`),
      get('detail: person', (i, vis) => `/api/v1/people/${pick(vis.people)}`),
      get('detail: collection', (i, vis) => `/api/v1/collections/${pick(vis.collections)}`),
      get('collections: browse', () => '/api/v1/collections'),
    ];
  };

  for (const who of ['viewer', 'operator']) {
    for (const f of families(who))
      results.push({ group: 'sequential', who, ...(await measure(f.name, f.fn)) });
  }
  // Ten clients at once (50 users, so 10 simultaneous is a busy moment).
  for (const who of ['viewer']) {
    for (const f of families(who).filter((x) =>
      /home|movies by title|word|detail: movie\b|detail: series\b/.test(x.name),
    )) {
      results.push({
        group: 'concurrent',
        who,
        ...(await measure(f.name, f.fn, { concurrency: 10, reps: REPS })),
      });
    }
  }
  // Keyset pagination depth: walk 80 pages (4,000 titles) of the title-sorted movie list.
  const walkTimes = [];
  for (const u of [operator, viewers[0], viewers[1]]) {
    let cursor = null;
    for (let page = 0; page < 80; page++) {
      const r = await call(
        u,
        'GET',
        `/api/v1/items?type=movie&sort=title&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      walkTimes.push(r.ms);
      cursor = JSON.parse(r.text).nextCursor;
      if (!cursor) break;
    }
  }
  const walk = {
    name: 'browse: 80-page keyset walk',
    concurrency: 1,
    ...summarize(walkTimes),
    rps: 0,
    statuses: {},
  };
  log(
    `${walk.name.padEnd(46)} c=1  p50=${String(walk.p50).padStart(6)} ms  p95=${String(walk.p95).padStart(6)} ms  max=${String(walk.max).padStart(6)}`,
  );
  results.push({ group: 'sequential', who: 'mixed', ...walk });

  // ---- play descriptor against the mock origin ----
  const caps = {
    containers: ['hls', 'mp4'],
    video: [{ codec: 'h264' }, { codec: 'vp9' }],
    audio: ['aac', 'opus'],
    hdr: [],
    textSubtitles: ['vtt'],
    nativeHls: false,
    mse: true,
  };
  let seq = 0;
  const open = [];
  const play = async (i) => {
    const u = playUsers[((i % playUsers.length) + playUsers.length) % playUsers.length];
    const r = await call(
      u,
      'POST',
      '/api/v1/play',
      {
        itemId: playItems[((i % playItems.length) + playItems.length) % playItems.length],
        capabilities: caps,
      },
      { 'idempotency-key': `perf-${String(++seq)}-${Date.now().toString(36)}` },
    );
    if (r.status === 201 && i >= 0) open.push({ u, id: JSON.parse(r.text).sessionId });
    else if (r.status === 201) open.push({ u, id: JSON.parse(r.text).sessionId, warm: true });
    return r;
  };
  const stopAll = async () => {
    await Promise.all(
      open
        .splice(0)
        .map(({ u, id }) =>
          call(u, 'POST', `/api/v1/play/${id}/events`, { seq: 1, type: 'stop', positionMs: 0 }),
        ),
    );
  };
  // The play limiter allows 60 a minute per user; stay under it by spreading over users and
  // stopping sessions as we go.
  const playReps = Math.min(REPS, playUsers.length * 25);
  const playRow = await measure(
    'play: descriptor (mock origin), sequential',
    async (i) => {
      const r = await play(i);
      if (open.length >= 5) await stopAll();
      return r;
    },
    { reps: playReps, warmup: 5 },
  );
  await stopAll();
  const concRow = await measure('play: descriptor, 20 concurrent sessions', play, {
    reps: Math.min(100, playUsers.length * 2),
    concurrency: 20,
    warmup: 0,
  });
  await stopAll();
  results.push(
    { group: 'play', who: 'mixed', ...playRow },
    { group: 'play', who: 'mixed', ...concRow },
  );

  // Mock-origin view of what play cost the origin side.
  const originLog = await (await fetch(`${ORIGIN}/__requests`)).json();
  const originCalls = {
    authenticate: originLog.filter((l) => l.startsWith('POST /Users/AuthenticateByName')).length,
    playbackInfo: originLog.filter((l) => /PlaybackInfo/.test(l)).length,
  };

  await stop(w);
  const out = {
    when: new Date().toISOString(),
    node: process.version,
    quick: QUICK,
    reps: REPS,
    envelope: ENVELOPE,
    rows,
    plans: plans.map(({ name, ms, rows, scans, sorts }) => ({ name, ms, rows, scans, sorts })),
    results,
    originCalls,
    seconds: Math.round((Date.now() - t0) / 1000),
  };
  writeFileSync(join(here, '.state', 'results.json'), JSON.stringify(out, null, 2));
  writeFileSync(join(here, '.state', 'plans.json'), JSON.stringify(plans, null, 2));
  log(`done in ${String(out.seconds)} s; results in scripts/perf/.state/results.json`);
  printSummary(out);
}

function pathUrl(rel) {
  return new URL(`file://${join(repo, rel)}`).href;
}

function printSummary(out) {
  console.log('\n== query engine time (SQLite, one run each, no HTTP) and plan flags ==');
  for (const p of [...out.plans].sort((x, y) => y.ms - x.ms).slice(0, 12)) {
    console.log(
      `${String(p.ms).padStart(8)} ms  scans=${String(p.scans.length)} sorts=${String(p.sorts.length)}  ${p.name}`,
    );
  }
  const scans = out.plans.filter((p) => p.scans.length);
  console.log(
    scans.length
      ? `\nFULL SCANS in: ${scans.map((p) => p.name).join(', ')}`
      : '\nNo full table scans in any catalog or play query.',
  );
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
