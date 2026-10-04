/**
 * T2.8 journey: first-run setup and passkey sign-in through a virtual authenticator, register the
 * mock origin as a server through the UI, run a real full sync against it, then browse, open a
 * title, search, and check accessibility (axe) in both themes. One serial flow on one page,
 * because the journey owns the database.
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

const OPERATOR = 'E2E Operator';

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  page = await context.newPage();
  await addVirtualAuthenticator(page);
  page.on('request', (req) => {
    const url = req.url();
    if (!url.startsWith(BASE_URL) && !url.startsWith('data:') && !url.startsWith('blob:')) {
      thirdParty.push(url);
    }
  });
  page.on('console', (msg) => {
    if (/content security policy/i.test(msg.text())) cspMessages.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(err.message));
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

test('the app made no third-party requests and no CSP or script errors', () => {
  expect(thirdParty).toEqual([]);
  expect(cspMessages).toEqual([]);
  expect(pageErrors).toEqual([]);
});
