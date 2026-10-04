/**
 * T2.8 journey: first-run setup and passkey sign-in through a virtual authenticator, register the
 * mock origin as a server through the UI, browse, open a title, and check accessibility (axe) in
 * both themes. One serial flow on one page, because the journey owns the database.
 *
 * Real: Worker, D1, sessions, passkey ceremonies, server registration against the mock origin,
 * the catalog read API and PATCH /me/preferences.
 * Mocked (support/catalog-mocks.ts, until workstream A merges): the sync-runs API only.
 * Temporary: with no sync yet, catalog rows are seeded straight into local D1 (seed-catalog.sql).
 */
import { execFileSync } from 'node:child_process';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { addVirtualAuthenticator } from '../support/authenticator';
import { mockSyncApi } from '../support/catalog-mocks';
import { BASE_URL, ORIGIN_URL, SEED_SQL, SETUP_TOKEN, STATE_DIR, WORKER_DIR } from '../support/env';

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
  await mockSyncApi(page);
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

test('sync status page shows the last run and outcome', async () => {
  await page.getByRole('link', { name: 'Sync status' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Sync status' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Mock Jellyfin' })).toBeVisible();
  await expect(page.getByText('Last run')).toBeVisible();
  await expect(page.getByText('Next run')).toBeVisible();
  await expectAccessible('sync status');
});

test('TEMPORARY: seed catalog rows into local D1 until sync lands', () => {
  execFileSync(
    'pnpm',
    [
      'exec',
      'wrangler',
      'd1',
      'execute',
      'cinewren-local',
      '--local',
      '--persist-to',
      STATE_DIR,
      '--file',
      SEED_SQL,
    ],
    { cwd: WORKER_DIR, stdio: 'inherit', env: { ...process.env, CI: '1' } },
  );
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
  await expect(page.getByLabel('Versions: 4K HDR, 1080p')).toBeVisible();
  await expect(page.getByText('Available from 2 servers')).toBeVisible();
  await expect(page.getByRole('table')).toContainText('Seedbox');
  await expectAccessible('title detail');
});

test('series detail shows seasons and episodes', async () => {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Shows' }).click();
  await page.getByRole('link', { name: /Dragnet/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Dragnet' })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Season 1' })).toBeChecked();
  await expect(page.getByRole('link', { name: /Episode 2/ })).toBeVisible();
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
  await page.getByRole('link', { name: 'Classic Horror' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Classic Horror' })).toBeVisible();
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
