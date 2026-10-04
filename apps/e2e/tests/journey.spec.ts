/**
 * T2.8 journey: first-run setup and passkey sign-in through a virtual authenticator, register the
 * mock origin as a server through the UI, run a real full sync against it, then browse, open a
 * title, search, and check accessibility (axe) in both themes. M3 adds playback: press Play on a
 * title, play a real (tiny, synthetic) HLS stream from the mock origin under the dynamic CSP,
 * stop, and get the resume prompt on the next play. One serial flow on one page, because the
 * journey owns the database.
 *
 * Everything is real: Worker, D1, the sync queue consumer (wrangler dev runs it locally), sessions,
 * passkey ceremonies, server registration and the sync itself against the mock origin (recorded
 * Jellyfin responses, plus synthetic_* fixtures where the recordings have gaps). Nothing is mocked
 * or seeded in the Worker; the catalog the pages show is the synced one.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { addVirtualAuthenticator } from '../support/authenticator';
import { BASE_URL, ORIGIN_URL, SETUP_TOKEN } from '../support/env';

test.describe.configure({ mode: 'serial' });

let page: Page;
const thirdParty: string[] = [];
const cspMessages: string[] = [];
const pageErrors: string[] = [];
/** Every browser request to the mock origin: the only host besides the app that may be used. */
const originRequests: { url: string; type: string }[] = [];
/** Every browser request to the app that could carry media: none may. */
const appMediaRequests: string[] = [];
/** The session events the browser posted, in order. */
const sentEvents: { type: string; positionMs: number; seq: number }[] = [];

const OPERATOR = 'E2E Operator';

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  page = await context.newPage();
  await addVirtualAuthenticator(page);
  page.on('request', (req) => {
    const url = req.url();
    if (url.startsWith(ORIGIN_URL)) {
      originRequests.push({ url, type: req.resourceType() });
    } else if (!url.startsWith(BASE_URL) && !url.startsWith('data:') && !url.startsWith('blob:')) {
      thirdParty.push(url);
    }
    if (url.startsWith(BASE_URL) && /\.(m3u8|m4s|mp4|ts|webm|mkv)(\?|$)/i.test(url)) {
      appMediaRequests.push(url);
    }
    if (req.method() === 'POST' && /\/api\/v1\/play\/[^/]+\/events$/.test(url)) {
      sentEvents.push(JSON.parse(req.postData() ?? '{}') as (typeof sentEvents)[number]);
    }
  });
  page.on('console', (msg) => {
    if (/content security policy/i.test(msg.text())) cspMessages.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(err.message));
  // Violations as the browser reports them, on every page load (console text is the second net).
  await page.exposeFunction('__reportCsp', (v: string) => cspMessages.push(v));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      void (window as unknown as { __reportCsp: (v: string) => Promise<void> }).__reportCsp(
        `${e.violatedDirective} blocked ${e.blockedURI}`,
      );
    });
  });
});

test.afterAll(async () => {
  await page.context().close();
});

/** axe, once per theme, by setting data-theme before the scan (TDD §6.6). Any violation fails. */
async function expectAccessible(name: string) {
  for (const theme of ['dark', 'light'] as const) {
    await page.evaluate((t) => {
      document.documentElement.setAttribute('data-theme', t);
    }, theme);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    const summary = results.violations.map(
      (v) => `${v.id} (${v.impact ?? '?'}): ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
    );
    expect(summary, `axe violations on "${name}" in the ${theme} theme`).toEqual([]);
  }
}

test('first operator is created through /setup with a passkey', async () => {
  await page.goto('/setup');
  await expect(page.getByRole('heading', { level: 1, name: 'Set up Cinewren' })).toBeVisible();
  await page.getByLabel('Your name').fill(OPERATOR);
  await page.getByLabel('Setup token').fill(SETUP_TOKEN);
  await page.getByRole('button', { name: 'Create passkey' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
  await expect(page.getByRole('link', { name: `Account, ${OPERATOR}` })).toBeVisible();
});

test('the operator registers the mock origin as a server', async () => {
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Servers' })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Servers' })).toBeVisible();
  await page.getByRole('button', { name: 'Add server' }).click();
  await page.getByLabel('Display name').fill('Mock Jellyfin');
  await page.getByLabel('Server address').fill(ORIGIN_URL);
  await page.getByLabel('Service account username').fill('cinewren-svc');
  await page.getByLabel('Password').fill('not-a-real-password');
  await page.getByRole('button', { name: 'Add server' }).last().click();
  await expect(page.getByText('Mock Jellyfin is connected')).toBeVisible();
  // Choose the libraries to index; the Collections view is not offered (movies and TV only).
  await page.getByRole('checkbox', { name: /Movies/ }).click();
  await page.getByRole('checkbox', { name: /Shows/ }).click();
  await expect(page.getByRole('checkbox', { name: /Movies/ })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: /Shows/ })).toBeChecked();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(
    page.getByRole('article').getByRole('heading', { name: 'Mock Jellyfin' }),
  ).toBeVisible();
  await expect(page.getByText('Online')).toBeVisible();

  // The Worker really talked to the mock origin (recorded Jellyfin responses).
  const log = await page.request.get(`${ORIGIN_URL}/__requests`);
  const calls = (await log.json()) as string[];
  expect(calls).toContain('GET /System/Info/Public');
  expect(calls).toContain('POST /Users/AuthenticateByName');
  expect(calls.some((c) => c.startsWith('GET /UserViews'))).toBe(true);
  await expectAccessible('servers');
});

interface RunsPage {
  items: { id: string; status: string; type: string; trigger: string; added: number }[];
  nextScheduled: number | null;
}

async function serverId(): Promise<string> {
  const res = await page.request.get('/api/v1/admin/servers');
  const servers = (await res.json()) as { id: string; name: string }[];
  const found = servers.find((s) => s.name === 'Mock Jellyfin');
  if (!found) throw new Error('Mock Jellyfin is not registered');
  return found.id;
}

const runs = async (id: string) =>
  (await (await page.request.get(`/api/v1/admin/servers/${id}/sync-runs`)).json()) as RunsPage;

test('registration queued the first sync; a real full sync of the mock origin then succeeds', async () => {
  const id = await serverId();
  // WF-1: activation queued the first full sync (it ran before any library was enabled).
  await expect
    .poll(async () => (await runs(id)).items.at(-1)?.trigger, { timeout: 30_000 })
    .toBe('schedule');
  await expect
    .poll(async () => (await runs(id)).items.every((r) => r.status === 'succeeded'), {
      timeout: 60_000,
    })
    .toBe(true);

  await page.getByRole('link', { name: 'Sync status' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Sync status' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Mock Jellyfin' })).toBeVisible();
  await expect(page.getByText('Next run')).toBeVisible();

  // The operator triggers a full sync now, with the libraries enabled.
  await page.getByRole('button', { name: 'Full re-index of Mock Jellyfin' }).click();
  await expect
    .poll(
      async () => {
        const first = (await runs(id)).items[0];
        return first?.type === 'full' && first.trigger === 'manual' ? first.status : 'waiting';
      },
      { timeout: 90_000, intervals: [500, 1000, 2000] },
    )
    .toBe('succeeded');
  const latest = (await runs(id)).items[0];
  expect(latest?.added).toBeGreaterThan(0);
  // A second trigger after completion is accepted; while active it would be refused (409).
  await page.reload();
  await expect(page.getByText('Succeeded')).toBeVisible();
  await expect(page.getByText('Last run')).toBeVisible();
  await expectAccessible('sync status');

  // The Worker really listed the origin: sign-in, libraries, item pages and box sets.
  const log = await page.request.get(`${ORIGIN_URL}/__requests`);
  const calls = (await log.json()) as string[];
  expect(calls.some((c) => c.startsWith('GET /Items'))).toBe(true);
  expect(calls.some((c) => c.includes('(no recording)'))).toBe(false);
});

test('two simultaneous sync triggers: one is queued, the other refused with 409 SYNC_IN_PROGRESS', async () => {
  const id = await serverId();
  const post = () =>
    page.request.post(`/api/v1/admin/servers/${id}/sync`, {
      data: { type: 'full' },
      headers: { origin: BASE_URL },
    });
  const results = await Promise.all([post(), post()]);
  expect(results.map((r) => r.status()).sort()).toEqual([202, 409]);
  const refused = results.find((r) => r.status() === 409);
  expect(((await refused?.json()) as { error: { code: string } }).error.code).toBe(
    'SYNC_IN_PROGRESS',
  );
  // Let the accepted run finish so the catalog is stable for the pages below.
  await expect
    .poll(async () => (await runs(id)).items.every((r) => r.status === 'succeeded'), {
      timeout: 90_000,
    })
    .toBe(true);
});

test('sign out, then sign in again with the passkey', async () => {
  await page.getByRole('link', { name: `Account, ${OPERATOR}` }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await expectAccessible('settings');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  await expectAccessible('sign-in');
  await page.getByRole('button', { name: 'Use your passkey' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
});

test('home lists recently added titles', async () => {
  await expect(page.getByRole('heading', { level: 2, name: /Recently added/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Night of the Living Dead, 1968/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Plan 9 from Outer Space/ })).toBeVisible();
  await expectAccessible('home');
});

test('browse Movies with a filter, then open a title', async () => {
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Movies' })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Movies' })).toBeVisible();
  await expect(page.getByRole('link', { name: /His Girl Friday/ })).toBeVisible();
  await expectAccessible('movies');

  await page.getByLabel('Genre').fill('Western');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(page.getByText('No titles match these filters.')).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();

  await page.getByRole('link', { name: /Night of the Living Dead/ }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Night of the Living Dead' }),
  ).toBeVisible();
  await expect(page.getByLabel(/^Versions: /)).toBeVisible();
  await expect(page.getByText('Available from 1 server', { exact: true })).toBeVisible();
  await expect(page.getByRole('radiogroup')).toContainText('Mock Jellyfin');
  await expectAccessible('title detail');
});

test('series detail shows seasons and episodes', async () => {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Shows' }).click();
  await page.getByRole('link', { name: /Dragnet/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Dragnet' })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Season 1' })).toBeChecked();
  await expect(page.getByRole('link', { name: /Spike Episode 2/ })).toBeVisible();
  await expectAccessible('series detail');
});

test('search groups titles, people and collections, and opens a person', async () => {
  await page.getByRole('searchbox', { name: 'Search every server' }).fill('night');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'Results for “night”' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: /Titles/ })).toBeVisible();
  await expectAccessible('search results');

  await page.getByRole('searchbox', { name: 'Search every server' }).fill('duane');
  await page.keyboard.press('Enter');
  await page.getByRole('link', { name: 'Duane Jones' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Duane Jones' })).toBeVisible();
  await expectAccessible('person page');
});

test('collections browse and a collection page', async () => {
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Collections' })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Collections' })).toBeVisible();
  await expectAccessible('collections');
  await page.getByRole('link', { name: 'Cinewren Spike Horror Collection' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Cinewren Spike Horror Collection' }),
  ).toBeVisible();
  await expectAccessible('collection page');
});

test('the theme follows prefers-color-scheme, and the per-user override wins and persists', async () => {
  await page.goto('/settings');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.removeAttribute('data-theme');
  });
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  await page.emulateMedia({ colorScheme: 'light' });
  expect(await bg()).toBe('rgb(250, 246, 238)');
  await page.emulateMedia({ colorScheme: 'dark' });
  expect(await bg()).toBe('rgb(14, 13, 11)');

  // Override: Light wins over a dark system preference.
  await page.getByRole('radio', { name: 'Light' }).check({ force: true });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await bg()).toBe('rgb(250, 246, 238)');
  await expect(page.getByText('Appearance saved.')).toBeVisible();
  // The preference is stored per user by PATCH /me/preferences and survives a reload.
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await bg()).toBe('rgb(250, 246, 238)');
  await expect(page.getByRole('radio', { name: 'Light' })).toBeChecked();
  const me = await page.request.get('/api/v1/me');
  expect(((await me.json()) as { preferences: { theme: string } }).preferences.theme).toBe('light');

  await page.getByRole('radio', { name: 'System' }).check({ force: true });
  await expect(page.getByText('Appearance saved.')).toBeVisible();
  await page.reload();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
  await page.emulateMedia({ colorScheme: null });
});

// ---- M3 playback (FR-PLAY-001, FR-PLAY-007, FR-PLAY-008, FR-PLAY-009, FR-PROG-001, NFR-SEC-003) ----
//
// What is real: the Worker (selection, session credential minted at the origin, PlaybackInfo,
// descriptor, events, progress), the browser (capability detection, hls.js over MSE, the CSP) and
// the mock origin's HLS stream. The stream is a 12 s synthetic VP9 test pattern in fMP4 because
// headless Chromium has no H.264 decoder; the codec in the mock's PlaybackInfo says so. The
// player's state is asserted against the real <video> element (frames decoded), with the network
// flow asserted alongside.

interface Descriptor {
  sessionId: string;
  item: { id: string; title: string };
  source: { serverName: string };
  mode: string;
  streamUrl: string;
  streamType: string;
  reasons: string[];
  resume: { positionMs: number } | null;
}

const originHost = new URL(ORIGIN_URL).host;
let playedItemId = '';
let firstSessionId = '';
let firstStreamUrl = '';

const originLog = async () =>
  (await (await page.request.get(`${ORIGIN_URL}/__requests`)).json()) as string[];
const originSessions = async () =>
  (await (await page.request.get(`${ORIGIN_URL}/__sessions`)).json()) as {
    active: number;
    revoked: number;
  };
const video = () => page.locator('video');

async function openNightOfTheLivingDead() {
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Movies' })
    .click();
  await page.getByRole('link', { name: /Night of the Living Dead/ }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Night of the Living Dead' }),
  ).toBeVisible();
}

test('Play requests a descriptor, and the stream plays from the mock origin under the CSP', async () => {
  await openNightOfTheLivingDead();
  const playRequest = page.waitForRequest(
    (r) => r.method() === 'POST' && r.url() === `${BASE_URL}/api/v1/play`,
  );
  const playResponse = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url() === `${BASE_URL}/api/v1/play`,
  );
  await page.getByRole('link', { name: /^Play from Mock Jellyfin/ }).click();

  // A descriptor is requested: an Idempotency-Key, the item, and this browser's capabilities.
  const req = await playRequest;
  expect(req.headers()['idempotency-key']).toBeTruthy();
  const body = req.postDataJSON() as {
    itemId: string;
    capabilities: { containers: string[]; mse: boolean };
  };
  expect(body.itemId).toBeTruthy();
  expect(body.capabilities.mse).toBe(true);
  expect(body.capabilities.containers).toContain('hls');
  const res = await playResponse;
  expect(res.status()).toBe(201);
  const d = (await res.json()) as Descriptor;
  playedItemId = d.item.id;
  firstSessionId = d.sessionId;
  firstStreamUrl = d.streamUrl;
  expect(d.source.serverName).toBe('Mock Jellyfin');
  expect(d.streamType).toBe('hls');
  expect(['direct_stream', 'transcode']).toContain(d.mode);
  expect(d.reasons.length).toBeGreaterThan(0);
  expect(d.resume).toBeNull();
  // FR-PLAY-008: the stream URL is on the origin's own host, not the app's.
  expect(new URL(d.streamUrl).host).toBe(originHost);
  expect(new URL(d.streamUrl).host).not.toBe(new URL(BASE_URL).host);

  // The player is up and really playing: frames decoded from the origin's HLS.
  await expect(page.getByLabel('Seek')).toBeVisible();
  await expect
    .poll(
      () =>
        video().evaluate((v: HTMLVideoElement) => ({
          width: v.videoWidth,
          ready: v.readyState,
          time: v.currentTime,
          error: v.error?.code ?? null,
        })),
      { timeout: 30_000, message: 'the <video> decodes the HLS stream' },
    )
    .toMatchObject({ width: 160, error: null });
  await expect
    .poll(() => video().evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 20_000 })
    .toBeGreaterThan(0.5);
  await expect(page.getByRole('region', { name: 'Video player' }).first()).toBeVisible();

  // The session was announced to the Worker (start), and on to the origin.
  await expect.poll(() => sentEvents.map((e) => e.type)).toContain('start');
  await expect
    .poll(async () => (await originLog()).some((c) => c.startsWith('POST /Sessions/Playing ')))
    .toBe(true);

  // The origin saw a minted session token, the PlaybackInfo call, and the HLS requests.
  const log = await originLog();
  expect(
    log.some((c) => c.startsWith('POST /Users/AuthenticateByName (session cinewren-ps-')),
  ).toBe(true);
  expect(log.some((c) => /^POST \/Items\/[^/]+\/PlaybackInfo/.test(c))).toBe(true);
  expect(log.some((c) => /^GET \/videos\/[^/]+\/master\.m3u8$/.test(c))).toBe(true);
  expect(log.some((c) => c.endsWith('/main.m3u8'))).toBe(true);
  expect(log.some((c) => c.endsWith('/init.mp4'))).toBe(true);
  expect(log.some((c) => c.endsWith('/seg{n}.m4s'))).toBe(true);
  expect(log.some((c) => c.includes('(401'))).toBe(false);
  expect(log.some((c) => c.includes('(no recording)'))).toBe(false);
});

test('media requests go only to the mock origin, never through the app (FR-PLAY-008)', async () => {
  const media = originRequests.filter((r) => /\.(m3u8|m4s|mp4)(\?|$)/.test(r.url));
  expect(media.length).toBeGreaterThanOrEqual(4); // master, variant, init, at least one segment
  for (const r of originRequests) expect(new URL(r.url).host).toBe(originHost);
  // The Worker never served a byte of media (ADR-0002): nothing on the app's host looked like it.
  expect(appMediaRequests).toEqual([]);
  // NFR-SEC-003: the CSP is generated from the registered server: its origin, and no other host,
  // is allowed for media and connections; scripts stay on 'self'.
  const csp = (await page.request.get('/')).headers()['content-security-policy'] ?? '';
  const directive = (name: string) =>
    (csp.split('; ').find((d) => d.startsWith(`${name} `)) ?? '').split(' ').slice(1);
  expect(directive('media-src')).toEqual(["'self'", 'blob:', ORIGIN_URL]);
  expect(directive('connect-src')).toEqual(["'self'", ORIGIN_URL]);
  expect(directive('script-src')).toEqual(["'self'"]);
  // The session credential rides in the stream URL only, never in a request to the app.
  expect(thirdParty).toEqual([]);
});

test('pressing Back stops the session: stop event, origin telemetry, credential revoked', async () => {
  const before = await originSessions();
  expect(before.active).toBeGreaterThanOrEqual(1);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Night of the Living Dead' }),
  ).toBeVisible();
  await expect.poll(() => sentEvents.at(-1)?.type).toBe('stop');
  await expect
    .poll(async () =>
      (await originLog()).some((c) => c.startsWith('POST /Sessions/Playing/Stopped')),
    )
    .toBe(true);
  // BR-9: the session's credential is revoked at the origin once it ends.
  await expect.poll(async () => (await originSessions()).active).toBe(0);
  expect((await originSessions()).revoked).toBeGreaterThanOrEqual(1);
  expect(sentEvents.filter((e) => e.type === 'stop')).toHaveLength(1);
  // The stream credential no longer works: the origin refuses a replay of the first stream URL.
  const replay = await page.request.get(firstStreamUrl);
  expect(replay.status()).toBe(401);
});

test('the next Play offers to resume once there is a stored position', async () => {
  // The test clip is 12 s long, so a position above BR-7's 60 s floor cannot come from real
  // playback; it is set through the progress API, which leaves the watched flag alone.
  const put = await page.request.put(`/api/v1/progress/${encodeURIComponent(playedItemId)}`, {
    data: { positionMs: 75_000 },
    headers: { origin: BASE_URL },
  });
  expect(put.status()).toBe(200);
  expect(await put.json()).toEqual({ positionMs: 75_000, watched: false });

  const playResponse = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url() === `${BASE_URL}/api/v1/play`,
  );
  await page.getByRole('link', { name: /^Play from Mock Jellyfin/ }).click();
  const d = (await (await playResponse).json()) as Descriptor;
  expect(d.sessionId).not.toBe(firstSessionId);
  expect(d.resume).toEqual({ positionMs: 75_000 });
  const dialog = page.getByRole('dialog', { name: 'Pick up where you left off?' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Resume from 1:15' })).toBeVisible();
  await expectAccessible('resume prompt');

  // Start over: plays again from the origin, then leaving the page by browser navigation also
  // ends the session with a stop event.
  const stopsBefore = sentEvents.filter((e) => e.type === 'stop').length;
  await dialog.getByRole('button', { name: 'Start over' }).click();
  await expect(page.getByLabel('Seek')).toBeVisible();
  await expect
    .poll(() => video().evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 30_000 })
    .toBeGreaterThan(0.5);
  await expectAccessible('player');
  await page.goBack();
  await expect.poll(() => sentEvents.filter((e) => e.type === 'stop').length).toBe(stopsBefore + 1);
  await expect.poll(async () => (await originSessions()).active).toBe(0);
});

test('the app made no third-party requests and no CSP or script errors', () => {
  expect(thirdParty).toEqual([]);
  // Playback used the mock origin and only it, and the CSP allowed that without a violation.
  expect(originRequests.length).toBeGreaterThan(0);
  expect(cspMessages).toEqual([]);
  expect(pageErrors).toEqual([]);
});
