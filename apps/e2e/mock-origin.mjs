// Mock media origin for the E2E harness (T2.8, NFR-TEST-001).
//
// A small Node HTTP server that answers like the recorded Jellyfin 12.1 server: every fixture in
// test-fixtures/providers/jellyfin is a recorded request/response pair, and a live request is
// matched to the closest recording on method, path and query. It stands in for a real origin so
// `wrangler dev` can register and talk to a server without any network or media files.
//
// Extra endpoints for tests: GET /__requests returns the log of origin requests the Worker made,
// and DELETE /__requests clears it. No credential value is ever logged.
import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = join(here, '..', '..', 'test-fixtures', 'providers', 'jellyfin');

// Paging and sorting differ between recordings, so they never decide a match.
const IGNORED = new Set(['startindex', 'limit', 'enabletotalrecordcount', 'sortby', 'sortorder']);

function loadFixtures(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => {
      const fixture = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      const url = new URL(fixture.request.path, 'http://fixture.invalid');
      return { file, fixture, method: fixture.request.method.toUpperCase(), url };
    });
}

function queryMap(url) {
  const map = new Map();
  for (const [k, v] of url.searchParams) {
    if (!IGNORED.has(k.toLowerCase())) map.set(k.toLowerCase(), v);
  }
  return map;
}

/** Best recording for a request: same method and path, then the most matching query values. */
function pick(fixtures, method, url) {
  const live = queryMap(url);
  let best = null;
  for (const f of fixtures) {
    if (f.method !== method || f.url.pathname.toLowerCase() !== url.pathname.toLowerCase())
      continue;
    const recorded = queryMap(f.url);
    let score = 0;
    let mismatch = 0;
    for (const [k, v] of recorded) {
      if (live.get(k) === v) score += 1;
      else mismatch += 1;
    }
    for (const k of live.keys()) if (!recorded.has(k)) mismatch += 0.1;
    // The service account's sign-in is the one the Worker needs; it wins over the player's.
    const preferred = f.file === 'auth_svc.json' ? 0.5 : 0;
    const rank = score - mismatch + preferred;
    if (!best || rank > best.rank) best = { rank, f };
  }
  return best?.f ?? null;
}

export function createMockOrigin({ fixtureDir = FIXTURE_DIR } = {}) {
  const fixtures = loadFixtures(fixtureDir);
  const log = [];

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock-origin.invalid');
    const method = (req.method ?? 'GET').toUpperCase();

    if (url.pathname === '/__requests') {
      if (method === 'DELETE') log.length = 0;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(method === 'DELETE' ? [] : log));
      return;
    }

    req.resume(); // request bodies (sign-in credentials) are neither read nor logged
    const match = pick(fixtures, method, url);
    log.push(`${method} ${url.pathname}${match ? '' : ' (no recording)'}`);
    if (!match) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'no recording', method, path: url.pathname }));
      return;
    }
    const { status, headers, body } = match.fixture.response;
    const outHeaders = {};
    for (const [k, v] of Object.entries(headers ?? {})) {
      // Keep type and CORS headers; length is recomputed from the body below.
      if (k.toLowerCase() !== 'content-length') outHeaders[k] = v;
    }
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    if (!Object.keys(outHeaders).some((k) => k.toLowerCase() === 'content-type')) {
      outHeaders['content-type'] = typeof body === 'string' ? 'text/plain' : 'application/json';
    }
    res.writeHead(status, outHeaders);
    res.end(payload);
  });

  return {
    server,
    requests: log,
    listen: (port, host = '127.0.0.1') =>
      new Promise((resolve) => {
        server.listen(port, host, () => {
          resolve(server.address());
        });
      }),
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

// CLI: `node e2e/mock-origin.mjs` (used by playwright.config.ts as a webServer).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.MOCK_ORIGIN_PORT ?? 8790);
  const origin = createMockOrigin();
  await origin.listen(port);
  console.log(`mock origin listening on http://127.0.0.1:${String(port)}`);
}
