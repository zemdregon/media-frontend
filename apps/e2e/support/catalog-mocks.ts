/**
 * MOCKED BACKEND PARTS (remove when the endpoints are merged and run with E2E_REAL_CATALOG=1).
 *
 * The catalog read API (LLD-API: /home, /items, /search, /people, /collections), the operator
 * sync-runs API and `PATCH /me/preferences` are built by other workstreams. Until they are in the
 * Worker, these Playwright route mocks answer them with data shaped like the recorded Jellyfin
 * library (test-fixtures/providers/jellyfin: three movies and the series Dragnet). Everything
 * else (setup, sign-in, sessions, server registration through the mock origin) hits the real
 * Worker.
 */
import type { Page, Route } from '@playwright/test';
import type {
  CollectionDetail,
  ItemCard,
  ItemCopy,
  ItemDetail,
  Page as CursorPage,
  PersonDetail,
  SyncRunsPage,
} from '@cinewren/shared';

const card = (over: Partial<ItemCard> & Pick<ItemCard, 'id' | 'title' | 'kind'>): ItemCard => ({
  year: null,
  artworkUrl: null,
  copyCount: 1,
  serverCount: 1,
  bestCopy: { serverName: 'Basement NAS', serverStatus: 'active', label: '1080p' },
  ...over,
});

export const NIGHT = card({
  id: 'm-night',
  kind: 'movie',
  title: 'Night of the Living Dead',
  year: 1968,
  copyCount: 2,
  serverCount: 2,
});
export const FRIDAY = card({ id: 'm-friday', kind: 'movie', title: 'His Girl Friday', year: 1940 });
export const PLAN9 = card({
  id: 'm-plan9',
  kind: 'movie',
  title: 'Plan 9 from Outer Space',
  year: 1957,
  bestCopy: { serverName: 'Basement NAS', serverStatus: 'active', label: '720p' },
});
export const DRAGNET = card({ id: 's-dragnet', kind: 'series', title: 'Dragnet', year: 1951 });

const page = <T>(items: T[], nextCursor: string | null = null): CursorPage<T> => ({
  items,
  nextCursor,
});

const copies: ItemCopy[] = [
  {
    sourceId: 'src1',
    versionId: 'v1',
    serverName: 'Basement NAS',
    serverStatus: 'active',
    resolution: { width: 1920, height: 1080, label: '1080p' },
    hdr: 'none',
    videoCodec: 'h264',
    container: 'mkv',
    audio: [{ codec: 'aac', channels: 2, language: 'en' }],
    sizeBytes: 1_400_000_000,
    expectedPlayability: 'direct_play',
    reasons: ['direct_play'],
    selected: true,
  },
  {
    sourceId: 'src2',
    versionId: 'v2',
    serverName: 'Seedbox',
    serverStatus: 'unreachable',
    resolution: { width: 3840, height: 2160, label: '4K' },
    hdr: 'hdr10',
    videoCodec: 'hevc',
    container: 'mkv',
    audio: [{ codec: 'eac3', channels: 6, language: 'en' }],
    sizeBytes: 9_800_000_000,
    expectedPlayability: 'unavailable',
    reasons: ['server_unreachable'],
    selected: false,
  },
];

const person = { id: 'p-jones', name: 'Duane Jones', artworkUrl: null };

const detail = (c: ItemCard, over: Partial<ItemDetail> = {}): ItemDetail => ({
  ...c,
  overview: 'A group of strangers barricade themselves in a farmhouse against the dead.',
  genres: ['Horror', 'Thriller'],
  runtimeMinutes: 96,
  versionsSummary: ['4K HDR', '1080p'],
  cast: [{ person, role: 'Actor', character: 'Ben' }],
  collections: [{ id: 'c-horror', name: 'Classic Horror' }],
  copies,
  ...over,
});

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

const notFound = (route: Route) =>
  json(route, { error: { code: 'NOT_FOUND', message: 'Not found.', requestId: 'e2e' } }, 404);

const MOVIES = [NIGHT, FRIDAY, PLAN9];

/** The recorded preference calls, so a spec can assert what the page sent. */
export interface MockState {
  preferenceCalls: unknown[];
  syncCalls: unknown[];
}

export async function mockCatalog(page_: Page): Promise<MockState> {
  const state: MockState = { preferenceCalls: [], syncCalls: [] };

  await page_.route(/\/api\/v1\/(home|items|search|people|collections)(\/|\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace('/api/v1', '');
    if (path === '/home') {
      return json(route, { recentlyAdded: [NIGHT, FRIDAY, PLAN9, DRAGNET], continueWatching: [] });
    }
    if (path === '/items') {
      const type = url.searchParams.get('type');
      const genre = url.searchParams.get('genre');
      let list = type === 'series' ? [DRAGNET] : MOVIES;
      if (genre && genre !== 'Horror') list = [];
      return json(route, page(list));
    }
    if (path === '/items/s-dragnet') {
      return json(
        route,
        detail(DRAGNET, { copies: [], versionsSummary: ['1080p'], cast: [], collections: [] }),
      );
    }
    if (path === '/items/s-dragnet/children') {
      return json(
        route,
        page([card({ id: 'se-1', kind: 'season', title: 'Season 1', seasonNumber: 1 })]),
      );
    }
    if (path === '/items/se-1/children') {
      return json(
        route,
        page(
          [1, 2, 3].map((n) =>
            card({
              id: `e-${String(n)}`,
              kind: 'episode',
              title: `Episode ${String(n)}`,
              episodeNumber: n,
              runtimeMinutes: 30,
              year: 1951,
            }),
          ),
        ),
      );
    }
    const item = /^\/items\/([^/]+)$/.exec(path)?.[1];
    if (item) {
      const found = MOVIES.find((m) => m.id === item);
      return found ? json(route, detail(found)) : notFound(route);
    }
    if (path === '/search') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      const titles = MOVIES.filter((m) => m.title.toLowerCase().includes(q));
      const people = person.name.toLowerCase().includes(q) ? [person] : [];
      const collections = 'classic horror'.includes(q)
        ? [{ id: 'c-horror', name: 'Classic Horror', artworkUrl: null }]
        : [];
      return json(route, {
        titles: page(titles),
        people: page(people),
        collections: page(collections),
      });
    }
    if (path === '/people/p-jones') {
      const body: PersonDetail = {
        ...person,
        credits: page([{ item: NIGHT, role: 'Actor', character: 'Ben' }]),
      };
      return json(route, body);
    }
    if (path === '/collections') {
      return json(route, page([{ id: 'c-horror', name: 'Classic Horror', artworkUrl: null }]));
    }
    if (path === '/collections/c-horror') {
      const body: CollectionDetail = {
        id: 'c-horror',
        name: 'Classic Horror',
        overview: null,
        artworkUrl: null,
        members: page([NIGHT, PLAN9]),
      };
      return json(route, body);
    }
    return notFound(route);
  });

  await page_.route(/\/api\/v1\/me\/preferences$/, (route) => {
    const body = route.request().postDataJSON() as unknown;
    state.preferenceCalls.push(body);
    return json(route, body);
  });

  await page_.route(/\/api\/v1\/admin\/servers\/[^/]+\/sync(-runs)?(\?.*)?$/, (route) => {
    if (route.request().method() === 'POST') {
      state.syncCalls.push(route.request().postDataJSON() as unknown);
      return json(route, { runId: 'run-2' }, 202);
    }
    const body: SyncRunsPage = {
      items: [
        {
          id: 'run-1',
          type: 'full',
          trigger: 'manual',
          status: 'succeeded',
          added: 4,
          updated: 0,
          missing: 0,
          errors: 0,
          errorSummary: null,
          queuedAt: Date.now() - 120_000,
          startedAt: Date.now() - 110_000,
          endedAt: Date.now() - 60_000,
        },
      ],
      nextCursor: null,
      nextScheduled: Date.now() + 300_000,
    };
    return json(route, body);
  });

  return state;
}
