// Mock media origin for the E2E harness (T2.8, NFR-TEST-001).
//
// A small Node HTTP server that answers like the recorded Jellyfin 12.1 server: every fixture in
// test-fixtures/providers/jellyfin is a recorded request/response pair, and a live request is
// matched to the closest recording on method, path and query. It stands in for a real origin so
// `wrangler dev` can register and talk to a server without any network or media files.
//
// Everything the sync and the adapter ask for is served from the recordings: sign-in, libraries,
// library item pages (with credits), box sets and their members. Where a recording is missing,
// a clearly named synthetic_* fixture stands in (see test-fixtures/providers/README.md).
//
// Playback (M3): the mock also plays the part of a Jellyfin origin for a viewing session. It mints
// a per-session token on `POST /Users/AuthenticateByName` when the DeviceId is `cinewren-ps-*`
// (the service account's own sign-in still comes from the recordings), answers PlaybackInfo with a
// token-gated HLS TranscodingUrl, serves a tiny real HLS stream (master, variant, init segment
// and three 4 s fMP4 segments of a 160x90 VP9 test pattern, apps/e2e/fixtures/hls), takes the
// session telemetry (`/Sessions/Playing*`) and revokes the token on `POST /Sessions/Logout`. A
// stream request without a live token is refused with 401, as a real origin does. CORS allows
// any origin, as Jellyfin does for HLS (fixtures cors_hls_*). VP9 in fMP4 is used because
// headless Chromium has no H.264 decoder; the stream is synthetic and says so in its own codecs.
//
// Extra endpoints for tests: GET /__requests returns the log of origin requests the Worker made
// (and, for the stream, the browser), and DELETE /__requests clears it. GET /__sessions returns
// the session tokens by state (never their values). No credential value is ever logged.
import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = join(here, '..', '..', 'test-fixtures', 'providers', 'jellyfin');
export const HLS_DIR = join(here, 'fixtures', 'hls');

// Paging and sorting differ between recordings, so they never decide a match.
const IGNORED = new Set(['startindex', 'limit', 'enabletotalrecordcount', 'sortby', 'sortorder']);

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

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
    // A recording of one library's (or box set's) children never answers another's.
    if (
      recorded.has('parentid') &&
      live.has('parentid') &&
      recorded.get('parentid') !== live.get('parentid')
    )
      continue;
    let score = 0;
    let mismatch = 0;
    for (const [k, v] of recorded) {
      if (live.get(k) === v) score += 1;
      else mismatch += 1;
    }
    for (const k of live.keys()) if (!recorded.has(k)) mismatch += 0.1;
    // The service account's sign-in is the one the Worker needs; it wins over the player's. A
    // synthetic_* fixture fills a gap in the recordings and wins over the recording it extends.
    const preferred = f.file === 'auth_svc.json' || f.file.startsWith('synthetic_') ? 0.5 : 0;
    const rank = score - mismatch + preferred;
    if (!best || rank > best.rank) best = { rank, f };
  }
  return best?.f ?? null;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
};
const SEGMENT_COUNT = 3;
const SEGMENT_SECONDS = 4;

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', () => {
      resolve('');
    });
  });
}

const headerParam = (header, name) =>
  new RegExp(`${name}="([^"]*)"`, 'i').exec(header ?? '')?.[1] ?? null;

function json(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(payload);
}

/** The stateful playback part of the mock: session tokens, PlaybackInfo, HLS, telemetry. */
function createPlayback(fixtures) {
  const tokens = new Map(); // token -> 'active' | 'revoked'
  let minted = 0;
  const fixture = (name) => fixtures.find((f) => f.file === name)?.fixture.response.body;
  const live = (token) => token !== null && tokens.get(token) === 'active';

  const assetBytes = (name) => readFileSync(join(HLS_DIR, name));

  /** The URL's own query, so each playlist hands the token on to what it references. */
  const carry = (url) => {
    const q = new URLSearchParams();
    for (const k of ['ApiKey', 'PlaySessionId', 'MediaSourceId']) {
      const v = url.searchParams.get(k);
      if (v !== null) q.set(k, v);
    }
    return q.toString();
  };

  return {
    sessions: () => ({
      active: [...tokens.values()].filter((s) => s === 'active').length,
      revoked: [...tokens.values()].filter((s) => s === 'revoked').length,
    }),

    /** Returns true when the request was a playback request and has been answered. */
    async handle(req, res, url, method, log) {
      const auth = req.headers.authorization;
      const bearer = headerParam(auth, 'Token');

      if (method === 'OPTIONS') {
        res.writeHead(204, CORS);
        res.end();
        return true;
      }

      if (method === 'POST' && /^\/Users\/AuthenticateByName$/i.test(url.pathname)) {
        const deviceId = headerParam(auth, 'DeviceId') ?? '';
        if (!deviceId.startsWith('cinewren-ps-')) return false; // the service account: recordings
        await readBody(req); // the password is neither read nor logged
        const base = fixture('auth_svc.json');
        const token = `e2e-session-token-${String(++minted)}-${deviceId.slice(-8)}`;
        tokens.set(token, 'active');
        log.push(`POST ${url.pathname} (session ${deviceId})`);
        json(res, 200, { ...base, AccessToken: token });
        return true;
      }

      if (method === 'POST' && /^\/Items\/[^/]+\/PlaybackInfo$/i.test(url.pathname)) {
        const body = JSON.parse((await readBody(req)) || '{}');
        log.push(`POST ${url.pathname}`);
        if (!live(bearer)) {
          json(res, 401, { error: 'invalid token' });
          return true;
        }
        const itemId = decodeURIComponent(url.pathname.split('/')[2] ?? '');
        const template = fixture('playbackinfo_h264_mkv.json');
        const source = structuredClone(template.MediaSources[0]);
        const mediaSourceId = body.MediaSourceId ?? itemId;
        const playSessionId = `e2e-play-${String(minted)}-${Date.now().toString(36)}`;
        source.Id = mediaSourceId;
        source.SupportsDirectPlay = false;
        source.SupportsDirectStream = false;
        source.SupportsTranscoding = true;
        source.TranscodingSubProtocol = 'hls';
        source.TranscodingContainer = 'mp4';
        // A remux of the file for token-gated HLS, the way Jellyfin answers; VideoCodec names what
        // the synthetic stream really contains.
        source.TranscodingUrl =
          `/videos/${itemId}/master.m3u8?DeviceId=${encodeURIComponent(headerParam(auth, 'DeviceId') ?? '')}` +
          `&MediaSourceId=${encodeURIComponent(mediaSourceId)}&VideoCodec=vp9&AudioCodec=copy` +
          `&SegmentContainer=mp4&PlaySessionId=${playSessionId}&ApiKey=${encodeURIComponent(bearer)}` +
          '&TranscodeReasons=ContainerNotSupported';
        json(res, 200, { MediaSources: [source], PlaySessionId: playSessionId });
        return true;
      }

      if (method === 'POST' && /^\/Sessions\/Playing(\/Progress|\/Stopped)?$/i.test(url.pathname)) {
        const body = JSON.parse((await readBody(req)) || '{}');
        const ticks = typeof body.PositionTicks === 'number' ? body.PositionTicks : 0;
        log.push(`POST ${url.pathname} (position ${String(Math.round(ticks / 10_000))} ms)`);
        res.writeHead(live(bearer) ? 204 : 401);
        res.end();
        return true;
      }

      if (method === 'POST' && /^\/Sessions\/Logout$/i.test(url.pathname)) {
        req.resume();
        log.push(`POST ${url.pathname}`);
        if (bearer !== null && tokens.has(bearer)) tokens.set(bearer, 'revoked');
        res.writeHead(bearer !== null && tokens.has(bearer) ? 204 : 401);
        res.end();
        return true;
      }

      // HLS: /videos/{id}/master.m3u8 -> /Videos/{id}/main.m3u8 -> init.mp4 and seg{n}.m4s.
      const hls = /^\/videos\/([^/]+)\/(master\.m3u8|main\.m3u8|init\.mp4|seg(\d+)\.m4s)$/i.exec(
        url.pathname,
      );
      if (method === 'GET' && hls) {
        const name = hls[2].toLowerCase();
        const logged = `GET ${url.pathname.replace(/[^/]+$/, name.startsWith('seg') ? 'seg{n}.m4s' : name)}`;
        // The credential is the session token in the URL, as with a real origin (ADR-0013).
        if (!live(url.searchParams.get('ApiKey'))) {
          log.push(`${logged} (401, no live token)`);
          res.writeHead(401, CORS);
          res.end();
          return true;
        }
        log.push(logged);
        const q = carry(url);
        if (name === 'master.m3u8') {
          res.writeHead(200, { ...CORS, 'content-type': 'application/vnd.apple.mpegurl' });
          res.end(
            '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=60000,CODECS="vp09.00.10.08",RESOLUTION=160x90,FRAME-RATE=10\n' +
              `main.m3u8?${q}\n`,
          );
        } else if (name === 'main.m3u8') {
          let out = `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:${String(SEGMENT_SECONDS)}\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI="init.mp4?${q}"\n`;
          for (let i = 0; i < SEGMENT_COUNT; i++) {
            out += `#EXTINF:${SEGMENT_SECONDS}.000000,\nseg${String(i)}.m4s?${q}\n`;
          }
          res.writeHead(200, { ...CORS, 'content-type': 'application/vnd.apple.mpegurl' });
          res.end(`${out}#EXT-X-ENDLIST\n`);
        } else {
          const file = name === 'init.mp4' ? 'init.mp4' : `seg${hls[3]}.m4s`;
          let bytes;
          try {
            bytes = assetBytes(file);
          } catch {
            res.writeHead(404, CORS);
            res.end();
            return true;
          }
          res.writeHead(200, {
            ...CORS,
            'content-type': name === 'init.mp4' ? 'video/mp4' : 'video/iso.segment',
            'content-length': bytes.length,
          });
          res.end(bytes);
        }
        return true;
      }
      return false;
    },
  };
}

export function createMockOrigin({ fixtureDir = FIXTURE_DIR } = {}) {
  const fixtures = loadFixtures(fixtureDir);
  const log = [];
  const playback = createPlayback(fixtures);

  const server = createServer((req, res) => {
    void route(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  async function route(req, res) {
    const url = new URL(req.url ?? '/', 'http://mock-origin.invalid');
    const method = (req.method ?? 'GET').toUpperCase();

    if (url.pathname === '/__sessions') {
      json(res, 200, playback.sessions());
      return;
    }
    if (await playback.handle(req, res, url, method, log)) return;

    if (url.pathname === '/__requests') {
      if (method === 'DELETE') log.length = 0;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(method === 'DELETE' ? [] : log));
      return;
    }

    // Artwork (`GET /Items/{id}/Images/{slot}`): the recordings keep no binary bodies, so every
    // image is the same synthetic 1x1 PNG. The artwork proxy only needs a well-formed image.
    if (method === 'GET' && /^\/Items\/[^/]+\/Images\/[^/]+$/i.test(url.pathname)) {
      req.resume();
      log.push(`${method} ${url.pathname} (synthetic image)`);
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG.length });
      res.end(PNG);
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
  }

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
