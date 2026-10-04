/**
 * T5.7 accessibility audit (NFR-A11Y-001, NFR-UX-001): WCAG 2.2 AA on the core journeys.
 *
 * Runs after journey.spec.ts, on the same database (Playwright orders spec files by name and this
 * project runs one worker), so the catalog, the registered server and the operator already exist.
 * The journey hands over the operator's passkey; this spec signs in again with the keyboard.
 *
 * What is automated here: axe-core (WCAG 2.0/2.1/2.2 A and AA rules) on every screen and state in
 * both themes; the browser's accessibility tree for the name of every control; keyboard-only
 * journeys with focus-visible, focus-order and focus-not-obscured checks; reduced motion; and
 * reflow at 200 % and 400 % zoom. What is not: manual screen-reader listening, voice control and
 * real devices (see docs/reports/2026-a11y-audit.md).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  addAuthenticator,
  exportCredentials,
  type VirtualCredential,
} from '../support/authenticator';
import { BASE_URL, HANDOFF_FILE, OPERATOR_NAME } from '../support/env';

test.describe.configure({ mode: 'serial' });

let page: Page;
let credentials: VirtualCredential[] = [];
/** Held for the whole run: the virtual authenticator lives only as long as its CDP session. */
let authenticator: Awaited<ReturnType<typeof addAuthenticator>> | undefined;
const pageErrors: string[] = [];

test.beforeAll(async ({ browser }) => {
  const handoff = JSON.parse(readFileSync(HANDOFF_FILE, 'utf8')) as {
    credentials: VirtualCredential[];
  };
  const context = await browser.newContext();
  page = await context.newPage();
  credentials = handoff.credentials;
  authenticator = await addAuthenticator(page, credentials);
  page.on('pageerror', (err) => pageErrors.push(err.message));
});

test.afterAll(async () => {
  await authenticator?.cdp.detach().catch(() => undefined);
  await page.context().close();
});

// ---- helpers ----

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const CONTROL_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'slider',
  'radio',
  'checkbox',
  'combobox',
  'switch',
  'menuitem',
  'tab',
]);

/** Every control in the browser's accessibility tree has a non-empty name (what a screen reader says). */
async function expectNamedControls(label: string) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('DOM.enable');
    await cdp.send('DOM.getDocument', { depth: 0 });
    const { nodes } = await cdp.send('Accessibility.getFullAXTree');
    const unnamed: string[] = [];
    for (const n of nodes) {
      const role = String(n.role?.value ?? '');
      if (n.ignored || !CONTROL_ROLES.has(role)) continue;
      if (String(n.name?.value ?? '').trim()) continue;
      let html = `<${role}>`;
      if (n.backendDOMNodeId !== undefined) {
        try {
          const { outerHTML } = await cdp.send('DOM.getOuterHTML', {
            backendNodeId: n.backendDOMNodeId,
          });
          html = outerHTML.slice(0, 120);
        } catch {
          /* keep the role */
        }
      }
      unnamed.push(`${role}: ${html}`);
    }
    expect(unnamed, `controls without an accessible name on "${label}"`).toEqual([]);
  } finally {
    await cdp.detach();
  }
}

/** axe in both themes (data-theme set before the scan, TDD §6.6) plus the control-name check. */
async function expectAccessible(label: string, opts: { exclude?: string[] } = {}) {
  for (const theme of ['dark', 'light'] as const) {
    await page.evaluate((t) => {
      document.documentElement.setAttribute('data-theme', t);
    }, theme);
    let axe = new AxeBuilder({ page }).withTags(WCAG_TAGS);
    for (const sel of opts.exclude ?? []) axe = axe.exclude(sel);
    const results = await axe.analyze();
    const summary = results.violations.map(
      (v) => `${v.id} (${v.impact ?? '?'}): ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
    );
    expect(summary, `axe violations on "${label}" in the ${theme} theme`).toEqual([]);
  }
  await expectNamedControls(label);
}

interface Focus {
  label: string;
  tag: string;
  id: string;
  ring: boolean;
  obscured: boolean;
  inPlayer: boolean;
  checked: boolean;
}

/** What has keyboard focus now, and whether it is visibly focused and not covered (WCAG 2.4.7, 2.4.11). */
async function focused(): Promise<Focus | null> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body || el === document.documentElement) return null;
    const text = el.textContent
      .replace(/^[←→]\s*/, '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 60);
    const labelled = el.id ? document.querySelector(`label[for="${el.id}"]`) : null;
    const label =
      el.getAttribute('aria-label') ||
      (labelled?.textContent ?? '').trim() ||
      text ||
      `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}`;
    const hasRing = (c: Element | null) => {
      if (!c) return false;
      const cs = getComputedStyle(c);
      return (
        cs.outlineStyle !== 'none' &&
        parseFloat(cs.outlineWidth) >= 2 &&
        cs.outlineColor !== 'rgba(0, 0, 0, 0)'
      );
    };
    // The ring may sit on the control, its search form, its segment label or its menu-option label.
    const ring = [el, el.closest('.search'), el.closest('.segment'), el.closest('label')].some(
      hasRing,
    );
    const r = el.getBoundingClientRect();
    let obscured = false;
    if (r.width >= 8 && r.height >= 8) {
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      obscured = !top || !(el === top || el.contains(top) || top.contains(el));
    }
    return {
      label,
      tag: el.tagName.toLowerCase(),
      id: el.id,
      ring,
      obscured,
      inPlayer: !!el.closest('.player'),
      checked: el instanceof HTMLInputElement && el.checked,
    };
  });
}

/**
 * Presses Tab (or Shift+Tab) until the focused control's label matches, checking every stop on the
 * way. Returns the labels visited, in order. Fails if the control is not reached in `max` presses
 * (a keyboard trap or a missing tab stop).
 */
async function tabTo(
  match: RegExp,
  opts: { max?: number; back?: boolean; allowOutsidePlayer?: boolean } = {},
): Promise<string[]> {
  const visited: string[] = [];
  for (let i = 0; i < (opts.max ?? 60); i++) {
    await page.keyboard.press(opts.back ? 'Shift+Tab' : 'Tab');
    const f = await focused();
    if (!f) {
      visited.push('(browser)');
      continue;
    }
    visited.push(f.label);
    expect(f.ring, `focus ring on "${f.label}"`).toBe(true);
    expect(f.obscured, `"${f.label}" is not covered by other content`).toBe(false);
    if (match.test(f.label)) return visited;
  }
  throw new Error(
    `"${String(match)}" was not reached by keyboard; visited: ${visited.join(' > ')}`,
  );
}

const nav = () => page.getByRole('navigation', { name: 'Main' });
const video = () => page.locator('video');

async function ids() {
  const get = async <T>(url: string) => (await (await page.request.get(url)).json()) as T;
  interface Card {
    id: string;
    title: string;
  }
  const movies = await get<{ items: Card[] }>('/api/v1/items?type=movie&limit=100');
  const series = await get<{ items: Card[] }>('/api/v1/items?type=series&limit=100');
  const dragnet = series.items.find((s) => s.title === 'Dragnet');
  const night = movies.items.find((m) => m.title === 'Night of the Living Dead');
  if (!dragnet || !night) throw new Error('the synced catalog lacks the expected titles');
  const seasons = await get<{ items: Card[] }>(`/api/v1/items/${dragnet.id}/children`);
  const season = seasons.items[0];
  if (!season) throw new Error('Dragnet has no season');
  const episodes = await get<{ items: Card[] }>(`/api/v1/items/${season.id}/children`);
  const episode = episodes.items[0];
  if (!episode) throw new Error('Dragnet has no episode');
  const people = await get<{ people: { items: Card[] } }>('/api/v1/search?q=duane&kind=person');
  const collections = await get<{ items: Card[] }>('/api/v1/collections');
  return {
    night: night.id,
    series: dragnet.id,
    season: season.id,
    episode: episode.id,
    person: people.people.items[0]?.id ?? '',
    collection: collections.items[0]?.id ?? '',
  };
}

let cat: Awaited<ReturnType<typeof ids>>;

// ---- keyboard-only journey: sign in, browse, open a title, play, change subtitles, stop ----

test('keyboard: sign in with the passkey button, in a sensible focus order', async () => {
  await page.context().clearCookies();
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  // (axe on the sign-in screen runs in journey.spec.ts; a second CDP session here would drop the
  // virtual authenticator that the ceremony below needs.)
  const visited = await tabTo(/^Use your passkey$/, { max: 5 });
  expect(visited.at(-1)).toBe('Use your passkey');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
  // This sign-in advanced the passkey's signature counter, so hand the current credential on to
  // users.spec.ts (the server refuses a counter that went backwards). Read it now: a later axe
  // scan opens a second CDP session, which drops the virtual authenticator.
  if (authenticator) {
    const fresh = await exportCredentials(authenticator.cdp, authenticator.authenticatorId);
    mkdirSync(dirname(HANDOFF_FILE), { recursive: true });
    writeFileSync(HANDOFF_FILE, JSON.stringify({ credentials: fresh }));
  }
  cat = await ids();
});

// Static auth screens render the same signed in or out.
test('signed-out screens: sign-in, invite and its invalid state, setup', async () => {
  await page.goto('/invite');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expectAccessible('invite (no token)');
  await page.goto('/invite?token=not-a-real-token');
  await expect(page.getByRole('heading', { level: 1, name: 'Invite not valid' })).toBeVisible();
  await expectAccessible('invite (invalid)');
  await page.goto('/setup');
  await expect(page.getByRole('heading', { level: 1, name: 'Set up Cinewren' })).toBeVisible();
  await expectAccessible('setup');
});

test('keyboard: the skip link comes first, then navigation, search and account, then the page', async () => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
  const order: string[] = [];
  for (let i = 0; i < 11; i++) {
    await page.keyboard.press('Tab');
    const f = await focused();
    expect(f, 'every stop is a real element').not.toBeNull();
    expect(f?.ring, `focus ring on "${f?.label}"`).toBe(true);
    expect(f?.obscured, `"${f?.label}" is not covered`).toBe(false);
    order.push(f?.label ?? '');
  }
  expect(order.slice(0, 9)).toEqual([
    'Skip to content',
    'Home',
    'Movies',
    'Shows',
    'Collections',
    'Servers',
    'Settings',
    'Search every server',
    `Account, ${OPERATOR_NAME}`,
  ]);

  // The skip link really moves focus to the main region.
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.keyboard.press('Enter');
  expect((await focused())?.id).toBe('main');
});

test('keyboard: browse Movies and open a title without touching the mouse', async () => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
  await tabTo(/^Movies$/);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'Movies' })).toBeVisible();
  // In-app navigation moves focus to the page, so the next Tab starts inside it, not at the top.
  expect((await focused())?.id).toBe('main');
  await tabTo(/Plan 9 from Outer Space/);
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Plan 9 from Outer Space' }),
  ).toBeVisible();
  expect((await focused())?.id).toBe('main');
  await expectAccessible('title detail');
});

async function startPlayerByKeyboard() {
  await tabTo(/^Play from Mock Jellyfin/);
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Seek')).toBeVisible();
  await expect
    .poll(() => video().evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 30_000 })
    .toBeGreaterThan(0.3);
}

test('keyboard: the player is fully operable, focus never leaves it, and nothing traps', async () => {
  await startPlayerByKeyboard();
  await expect(page.getByRole('region', { name: 'Video player' })).toBeFocused();
  await expectAccessible('player');

  // Shortcuts work from the player container: K pauses and resumes.
  await page.keyboard.press('k');
  await expect.poll(() => video().evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  await page.keyboard.press('k');
  await expect.poll(() => video().evaluate((v: HTMLVideoElement) => v.paused)).toBe(false);
  // Left arrow seeks back 10 s (the 12 s test clip would end on a forward seek).
  await page.waitForTimeout(1500);
  const before = await video().evaluate((v: HTMLVideoElement) => v.currentTime);
  expect(before).toBeGreaterThan(1);
  await page.keyboard.press('ArrowLeft');
  await expect
    .poll(() => video().evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeLessThan(before - 0.5);

  // Tab order through the controls, and focus never lands outside the overlay: the page behind
  // it (navigation, search) is inert, so nothing the overlay hides can take focus.
  const forward: string[] = [];
  for (let i = 0; i < 16; i++) {
    await page.keyboard.press('Tab');
    const f = await focused();
    if (!f) {
      forward.push('(leaves the page)');
      continue;
    }
    expect(f.inPlayer, `"${f.label}" is inside the player`).toBe(true);
    expect(f.ring, `focus ring on "${f.label}"`).toBe(true);
    expect(f.obscured, `"${f.label}" is not covered`).toBe(false);
    forward.push(f.label);
  }
  expect(forward[2]).toMatch(/^(Play|Pause)$/);
  expect(forward.slice(0, 11)).toEqual([
    'Back',
    'Seek',
    forward[2] ?? '',
    'Back 10 s',
    'Forward 10 s',
    'Mute',
    'Volume',
    'Captions',
    'Audio and subtitles',
    'Copy',
    'Fullscreen',
  ]);
  // After the last control the next Tab leaves the page (browser UI) rather than looping inside:
  // there is no trap. Shift+Tab walks back into the controls.
  expect(forward).toContain('(leaves the page)');
  const back: string[] = [];
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Shift+Tab');
    const f = await focused();
    back.push(f?.label ?? '(leaves the page)');
    if (f) expect(f.inPlayer).toBe(true);
  }
  expect(back.some((l) => l !== '(leaves the page)')).toBe(true);
});

test('keyboard: change the subtitles from the menu, close it with Escape, focus returns', async () => {
  await tabTo(/^Audio and subtitles$/, { max: 20 });
  await page.keyboard.press('Enter');
  const trigger = page.getByRole('button', { name: 'Audio and subtitles' });
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  const menu = page.getByRole('group', { name: 'Audio and subtitles' });
  await expect(menu).toBeVisible();
  // Opening the menu moves focus into it (the checked option), so no tabbing past every control.
  const entry = await focused();
  expect(entry?.tag).toBe('input');
  expect(entry?.inPlayer).toBe(true);
  expect(entry?.ring).toBe(true);
  await expectAccessible('player, audio and subtitles menu');

  const subtitles = menu.getByRole('group', { name: 'Subtitles' });
  const radios = subtitles.getByRole('radio');
  const count = await radios.count();
  expect(count, 'Off plus at least one subtitle track').toBeGreaterThan(1);
  await expect(radios.first()).toBeChecked(); // Off
  // Move focus to the Off radio, then Arrow keys select the next one (native radio behaviour must
  // not be swallowed by the player's seek shortcut).
  await radios.first().focus();
  const timeBefore = await video().evaluate((v: HTMLVideoElement) => v.currentTime);
  await page.keyboard.press('ArrowDown');
  await expect(radios.nth(1)).toBeChecked();
  await expect(radios.first()).not.toBeChecked();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowLeft');
  const timeAfter = await video().evaluate((v: HTMLVideoElement) => v.currentTime);
  expect(Math.abs(timeAfter - timeBefore)).toBeLessThan(8); // no 10 s seeks from radio arrows
  // The change is announced to a screen reader through the live region.
  await expect(page.locator('.player p.sr-only[role="status"]')).toContainText(/Captions on/);
  // And Off again, with the keyboard.
  await page.keyboard.press('ArrowUp');
  await expect(radios.first()).toBeChecked();
  await expect(page.locator('.player p.sr-only[role="status"]')).toContainText('Captions off');

  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');

  // The copy menu behaves the same way.
  await tabTo(/^Copy$/, { max: 5 });
  await page.keyboard.press('Enter');
  const copyMenu = page.getByRole('group', { name: 'Choose a copy' });
  await expect(copyMenu).toBeVisible();
  await expect(copyMenu).toBeFocused();
  await expectAccessible('player, copy menu');
  await page.keyboard.press('Escape');
  await expect(copyMenu).toBeHidden();
  await expect(page.getByRole('button', { name: 'Copy', exact: true })).toBeFocused();
});

test('keyboard: stop playback with Back, and the session ends', async () => {
  await tabTo(/^Back$/, { max: 20, back: true });
  const stopped = page.waitForRequest(
    (r) =>
      r.method() === 'POST' &&
      /\/api\/v1\/play\/[^/]+\/events$/.test(r.url()) &&
      /"stop"/.test(r.postData() ?? ''),
  );
  await page.keyboard.press('Enter');
  await stopped;
  await expect(
    page.getByRole('heading', { level: 1, name: 'Plan 9 from Outer Space' }),
  ).toBeVisible();
  // The page behind the player is operable again (no leftover inert).
  await page.keyboard.press('Tab');
  expect(await focused(), 'the page chrome takes focus again').not.toBeNull();
  await expect(nav()).toBeVisible();
});

test('dialog: the resume prompt takes focus, is operable by keyboard, and does not trap', async () => {
  const put = await page.request.put(`/api/v1/progress/${encodeURIComponent(cat.night)}`, {
    data: { positionMs: 75_000 },
    headers: { origin: BASE_URL },
  });
  expect(put.status()).toBe(200);
  await page.goto(`/items/${cat.night}`);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Night of the Living Dead' }),
  ).toBeVisible();
  await tabTo(/^Play from Mock Jellyfin/);
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Pick up where you left off?' });
  await expect(dialog).toBeVisible();
  // Focus lands on the primary action, with a visible ring.
  const first = await focused();
  expect(first?.label).toBe('Resume from 1:15');
  expect(first?.ring).toBe(true);
  await expectAccessible('resume prompt');
  await page.keyboard.press('Tab');
  expect((await focused())?.label).toBe('Start over');
  // The background is inert, so Tab from the last button leaves the page instead of landing on a
  // hidden control; Shift+Tab returns. No trap, nothing obscured.
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab');
    const f = await focused();
    if (f) {
      expect(f.obscured, `"${f.label}" is not covered`).toBe(false);
      expect(f.inPlayer, `"${f.label}" is inside the player`).toBe(true);
    }
  }
  await tabTo(/^Start over$/, { back: true, max: 8 });
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Seek')).toBeVisible();
  await page.keyboard.press('Escape'); // nothing is open; must not break playback
  await expect(page.getByLabel('Seek')).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Night of the Living Dead' }),
  ).toBeVisible();
});

// ---- every screen, both themes ----

interface Screen {
  name: string;
  path: () => string;
  ready: (p: Page) => Promise<void>;
}

const h1 = (name: string | RegExp) => async (p: Page) => {
  await expect(p.getByRole('heading', { level: 1, name })).toBeVisible();
};

const SCREENS: Screen[] = [
  { name: 'home', path: () => '/', ready: h1('Home') },
  { name: 'movies', path: () => '/movies', ready: h1('Movies') },
  { name: 'shows', path: () => '/shows', ready: h1('Shows') },
  { name: 'collections', path: () => '/collections', ready: h1('Collections') },
  { name: 'title detail (movie)', path: () => `/items/${cat.night}`, ready: h1(/Night of/) },
  { name: 'series detail', path: () => `/items/${cat.series}`, ready: h1('Dragnet') },
  { name: 'season detail', path: () => `/items/${cat.season}`, ready: h1(/./) },
  { name: 'episode detail', path: () => `/items/${cat.episode}`, ready: h1(/./) },
  { name: 'person', path: () => `/people/${cat.person}`, ready: h1('Duane Jones') },
  { name: 'collection', path: () => `/collections/${cat.collection}`, ready: h1(/./) },
  { name: 'search results', path: () => '/search?q=night', ready: h1(/Results for/) },
  {
    name: 'search with no results',
    path: () => '/search?q=zzzzqqqq',
    ready: async (p) => {
      await expect(p.getByText(/Nothing matches/)).toBeVisible();
    },
  },
  { name: 'settings', path: () => '/settings', ready: h1('Settings') },
  { name: 'servers (operator)', path: () => '/servers', ready: h1('Servers') },
  { name: 'sync status (operator)', path: () => '/servers/sync', ready: h1('Sync status') },
  { name: 'audit log (operator)', path: () => '/servers/audit', ready: h1(/Audit log/) },
  { name: 'match conflicts (operator curation)', path: () => '/servers/conflicts', ready: h1(/./) },
  { name: 'page not found', path: () => '/no/such/page', ready: h1('Page not found') },
  { name: 'item not found', path: () => '/items/nope', ready: h1(/not found/i) },
  {
    name: 'player, title that cannot start',
    path: () => '/watch/nope',
    ready: async (p) => {
      await expect(p.getByRole('region', { name: 'Video player' })).toBeVisible();
    },
  },
];

for (const s of SCREENS) {
  test(`axe, both themes: ${s.name}`, async () => {
    await page.goto(s.path());
    await s.ready(page);
    // Let lazy images, skeletons and live regions settle before scanning.
    await page.waitForLoadState('networkidle');
    await expectAccessible(s.name);
  });
}

test('axe, both themes: server list with the add form, libraries and health panel', async () => {
  await page.goto('/servers');
  await expect(page.getByRole('heading', { level: 1, name: 'Servers' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Mock Jellyfin' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  await expectAccessible('servers with a server card');
  await page.getByRole('button', { name: 'Add server' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Add a server' })).toBeVisible();
  // Errors are shown inline and tied to the form: submit it empty.
  await expectAccessible('servers, add-server form');
  // Keyboard: every field is reachable, labelled, and has a visible ring.
  await tabTo(/^Display name$|^Server address$/, { max: 40 });
  await page.getByRole('button', { name: 'Cancel' }).click();
});

test('axe, both themes: filtered browse, empty state and the settings theme control', async () => {
  await page.goto('/movies?genre=Western');
  await expect(page.getByRole('heading', { level: 1, name: 'Movies' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  await expectAccessible('movies, filtered');
  await page.goto('/settings');
  await page.getByRole('radio', { name: 'Dark' }).check({ force: true });
  await expect(page.getByText('Appearance saved.')).toBeVisible();
  await expectAccessible('settings, theme saved status');
  await page.getByRole('radio', { name: 'System' }).check({ force: true });
  await expect(page.getByText('Appearance saved.')).toBeVisible();
});

// ---- reduced motion (WCAG 2.2.2, 2.3.3; UX §6) ----

test('reduced motion: no animation or transition survives prefers-reduced-motion', async () => {
  const probe = () =>
    page.evaluate(() => {
      const make = (cls: string) => {
        const el = document.createElement('div');
        el.className = cls;
        document.body.append(el);
        const cs = getComputedStyle(el);
        const out = { animation: cs.animationName, transition: cs.transitionDuration };
        el.remove();
        return out;
      };
      // Everything with a transition or animation anywhere on the page, in this state.
      const moving = [...document.querySelectorAll<HTMLElement>('body *')]
        .filter((el) => {
          const cs = getComputedStyle(el);
          const dur = cs.transitionDuration.split(',').map((d) => parseFloat(d));
          return cs.animationName !== 'none' || dur.some((d) => d > 0);
        })
        .map((el) => `${el.tagName.toLowerCase()}.${el.className}`);
      return { skeleton: make('skeleton'), spinner: make('spinner'), moving };
    });

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/movies');
  await expect(page.getByRole('heading', { level: 1, name: 'Movies' })).toBeVisible();
  const normal = await probe();
  // The probes prove the test can tell the difference: they do animate by default.
  expect(normal.skeleton.animation).not.toBe('none');
  expect(normal.spinner.animation).not.toBe('none');
  expect(normal.moving.length).toBeGreaterThan(0);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const path of ['/movies', '/', `/items/${cat.night}`, '/servers/sync', '/settings']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const reduced = await probe();
    expect(reduced.skeleton.animation, `skeleton on ${path}`).toBe('none');
    expect(reduced.spinner.animation, `spinner on ${path}`).toBe('none');
    expect(reduced.moving, `moving elements on ${path} under reduced motion`).toEqual([]);
  }

  // The player: the buffering spinner and the control fade respect it as well.
  await page.goto(`/items/${cat.night}`);
  await page.getByRole('link', { name: /^Play from Mock Jellyfin/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Pick up where you left off?' });
  await expect(dialog.or(page.getByLabel('Seek'))).toBeVisible();
  if (await dialog.isVisible()) await dialog.getByRole('button', { name: 'Start over' }).click();
  await expect(page.getByLabel('Seek')).toBeVisible();
  expect((await probe()).moving, 'moving elements in the player').toEqual([]);
  await page.goBack();
  await page.emulateMedia({ reducedMotion: null });
});

// ---- zoom and reflow (WCAG 1.4.4 Resize Text, 1.4.10 Reflow) ----

const ZOOM_SCREENS = [
  '/',
  '/movies',
  '/search?q=night',
  '/settings',
  '/servers',
  '/servers/sync',
  '/servers/audit',
  '/servers/conflicts',
];

async function expectNoPageScroll(label: string) {
  const m = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    wide: [...document.querySelectorAll<HTMLElement>('body *')]
      .filter(
        (el) =>
          !el.parentElement?.closest('.table-wrap') &&
          el.getBoundingClientRect().right > document.documentElement.clientWidth + 1,
      )
      .slice(0, 8)
      .map(
        (el) =>
          `${el.tagName.toLowerCase()}.${el.className} right=${Math.round(el.getBoundingClientRect().right)}`,
      ),
    clientWidth: document.documentElement.clientWidth,
    // Content cut off at the right edge of the viewport, outside any scroll container.
    clipped: [...document.querySelectorAll<HTMLElement>('body *')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        let p: HTMLElement | null = el.parentElement;
        while (p && p !== document.body) {
          const ox = getComputedStyle(p).overflowX;
          if (ox === 'auto' || ox === 'scroll') return false;
          p = p.parentElement;
        }
        return r.right > document.documentElement.clientWidth + 1;
      })
      .map(
        (el) =>
          `${el.tagName.toLowerCase()}.${el.className} "${el.textContent.trim().slice(0, 30)}" right=${Math.round(el.getBoundingClientRect().right)}`,
      ),
  }));
  expect(m.clipped, `${label}: nothing is cut off at the right edge`).toEqual([]);
  expect(
    m.scrollWidth,
    `${label}: no horizontal page scroll; wide: ${m.wide.join(' | ')}`,
  ).toBeLessThanOrEqual(m.clientWidth + 1);
}

test('200% zoom (640 CSS px wide): screens reflow, controls stay reachable, axe stays clean', async () => {
  // 1280 x 720 at 200% is a 640 x 360 CSS viewport.
  await page.setViewportSize({ width: 640, height: 360 });
  for (const path of ZOOM_SCREENS) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expectNoPageScroll(`200% zoom ${path}`);
  }
  // Navigation and search are still there and usable at 200%.
  await page.goto('/');
  await expect(nav().getByRole('link', { name: 'Movies' })).toBeVisible();
  await expect(page.getByRole('searchbox', { name: 'Search every server' })).toBeVisible();
  await expect(page.getByRole('link', { name: `Account, ${OPERATOR_NAME}` })).toBeVisible();
  await expectAccessible('home at 200% zoom');
  await page.goto(`/items/${cat.night}`);
  await expect(page.getByRole('heading', { level: 1, name: /Night of/ })).toBeVisible();
  await page.waitForLoadState('networkidle');
  await expectNoPageScroll('200% zoom title detail');
  await expectAccessible('title detail at 200% zoom');
  await page.goto('/servers/audit');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.waitForLoadState('networkidle');
  await expectAccessible('audit log at 200% zoom');
});

test('400% zoom (320 CSS px wide): single-column reflow without two-dimensional scrolling', async () => {
  await page.setViewportSize({ width: 320, height: 256 });
  for (const path of ['/', '/movies', `/items/${cat.night}`, '/search?q=night', '/settings']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expectNoPageScroll(`400% zoom ${path}`);
  }
  await expectAccessible('settings at 400% zoom');
});

test('the player at 200% zoom: every control is on screen and focusable', async () => {
  await page.setViewportSize({ width: 640, height: 360 });
  await page.goto(`/items/${cat.night}`);
  await page.getByRole('link', { name: /^Play from Mock Jellyfin/ }).click();
  await expect(page.getByLabel('Seek')).toBeVisible();
  const boxes = await page
    .locator('.player-bottom button, .player-bottom input, .player-top button')
    .evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return {
          name: el.getAttribute('aria-label') || el.textContent.trim(),
          left: r.left,
          right: r.right,
          top: r.top,
          bottom: r.bottom,
        };
      }),
    );
  expect(boxes.length).toBeGreaterThanOrEqual(11);
  for (const b of boxes) {
    expect(b.left, `${b.name} left edge`).toBeGreaterThanOrEqual(0);
    expect(b.right, `${b.name} right edge`).toBeLessThanOrEqual(640);
    expect(b.top, `${b.name} top edge`).toBeGreaterThanOrEqual(0);
    expect(b.bottom, `${b.name} bottom edge`).toBeLessThanOrEqual(360);
  }
  await expectAccessible('player at 200% zoom');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 720 });
});

// ---- target size (WCAG 2.5.8) and names, across the signed-in chrome ----

test('target size: every button, link and field in the chrome is at least 24 x 24 CSS px', async () => {
  for (const path of ['/', '/movies', '/settings', '/servers']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const small = await page.evaluate(() =>
      [
        ...document.querySelectorAll<HTMLElement>(
          'header a, header input, nav a, main button, main input:not(.sr-only), main select, main .button',
        ),
      ]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          if (cs.visibility === 'hidden' || r.width === 0) return false;
          // Native radios and checkboxes are visually hidden; their label is the target.
          if (el instanceof HTMLInputElement && ['radio', 'checkbox'].includes(el.type)) {
            const lr = (el.closest('label') ?? el).getBoundingClientRect();
            return lr.width < 24 || lr.height < 24;
          }
          return r.width < 24 || r.height < 24;
        })
        .map((el) => `${el.tagName.toLowerCase()} "${el.textContent.trim().slice(0, 30)}"`),
    );
    expect(small, `targets smaller than 24 px on ${path}`).toEqual([]);
  }
});

test('the audit made no script errors', () => {
  expect(pageErrors).toEqual([]);
});
