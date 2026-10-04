// Component tests for the M2 catalog UI (T2.7): home, browse, search, detail, series, person,
// collections, sync status. The API is a stubbed `fetch`; contracts follow LLD-API.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { card, detail, operator, page, renderApp, viewer } from '../test-utils';

const url = (fetchMock: ReturnType<typeof renderApp>, includes: string) =>
  fetchMock.mock.calls.some(([u]) => u.includes(includes));

it('home shows recently added with copies chips, and a continue-watching placeholder', async () => {
  renderApp('/', viewer, (_m, p) =>
    p === '/home'
      ? [
          200,
          {
            recentlyAdded: [
              card({ id: 'm1', title: 'Night of the Living Dead', copyCount: 2 }),
              card({ id: 'm2', title: 'His Girl Friday', year: 1940 }),
            ],
            continueWatching: [],
          },
        ]
      : undefined,
  );
  expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeInTheDocument();
  const link = await screen.findByRole('link', {
    name: 'Night of the Living Dead, 1968, 2 copies',
  });
  expect(link).toHaveAttribute('href', '/items/m1');
  expect(screen.getByRole('link', { name: 'His Girl Friday, 1940, 1 copy' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Continue watching' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: /Recently added/ })).toBeInTheDocument();
});

it('home marks a poster whose best copy is offline', async () => {
  renderApp('/', viewer, () => [
    200,
    {
      recentlyAdded: [
        card({
          id: 'm1',
          title: 'Detour',
          bestCopy: { serverName: 'Seedbox', serverStatus: 'unreachable', label: '1080p' },
        }),
      ],
      continueWatching: [],
    },
  ]);
  expect(await screen.findByText(/Seedbox · offline/)).toBeInTheDocument();
});

it('hides operator navigation from viewers and shows it to operators', async () => {
  renderApp('/', viewer, () => [200, { recentlyAdded: [], continueWatching: [] }]);
  const nav = await screen.findByRole('navigation', { name: 'Main' });
  expect(within(nav).getByRole('link', { name: 'Movies' })).toBeInTheDocument();
  expect(within(nav).getByRole('link', { name: 'Collections' })).toBeInTheDocument();
  expect(within(nav).queryByRole('link', { name: 'Servers' })).toBeNull();
  expect(within(nav).getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
});

it('shows Servers to operators', async () => {
  renderApp('/', operator, () => [200, { recentlyAdded: [], continueWatching: [] }]);
  const nav = await screen.findByRole('navigation', { name: 'Main' });
  expect(within(nav).getByRole('link', { name: 'Servers' })).toBeInTheDocument();
});

it('browse sends filters to the API and offers load more', async () => {
  const fetchMock = renderApp(
    '/movies?genre=Horror&yearFrom=1950&minHeight=1080',
    viewer,
    (_m, p) => {
      if (p.includes('cursor=c1')) return [200, page([card({ id: 'm3', title: 'Plan 9' })])];
      if (p.startsWith('/items'))
        return [200, page([card({ id: 'm1', title: 'Night of the Living Dead' })], 'c1')];
      return undefined;
    },
  );
  expect(await screen.findByRole('link', { name: /Night of the Living Dead/ })).toBeInTheDocument();
  const call = fetchMock.mock.calls.map(([u]) => u).find((u) => u.startsWith('/api/v1/items'));
  expect(call).toContain('type=movie');
  expect(call).toContain('genre=Horror');
  expect(call).toContain('yearFrom=1950');
  expect(call).toContain('minHeight=1080');
  expect(screen.getByRole('button', { name: 'Remove filter Genre: Horror' })).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
  expect(await screen.findByRole('link', { name: /Plan 9/ })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
});

it('browse applies a filter through the form and shows the empty state with Clear filters', async () => {
  const fetchMock = renderApp('/shows', viewer, (_m, p) =>
    p.includes('genre=Western')
      ? [200, page([])]
      : [200, page([card({ id: 's1', title: 'Dragnet', kind: 'series' })])],
  );
  await screen.findByRole('link', { name: /Dragnet/ });
  fireEvent.change(screen.getByLabelText('Genre'), { target: { value: 'Western' } });
  await userEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
  expect(await screen.findByText('No titles match these filters.')).toBeInTheDocument();
  expect(url(fetchMock, 'type=series')).toBe(true);
  await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
  expect(await screen.findByRole('link', { name: /Dragnet/ })).toBeInTheDocument();
});

it('browse reports an error with a retry', async () => {
  let fail = true;
  renderApp('/movies', viewer, () =>
    fail
      ? [500, { error: { code: 'INTERNAL', message: 'Something broke.', requestId: 'r' } }]
      : [200, page([card({ id: 'm1', title: 'Detour' })])],
  );
  expect(await screen.findByRole('alert')).toHaveTextContent('Something broke.');
  fail = false;
  await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByRole('link', { name: /Detour/ })).toBeInTheDocument();
});

it('search submits from the header and groups titles, people and collections', async () => {
  renderApp('/', viewer, (_m, p) => {
    if (p === '/home') return [200, { recentlyAdded: [], continueWatching: [] }];
    if (p.startsWith('/search')) {
      return [
        200,
        {
          titles: page([card({ id: 'm1', title: 'Night of the Living Dead' })]),
          people: page([{ id: 'p1', name: 'Duane Jones', artworkUrl: null }]),
          collections: page([{ id: 'c1', name: 'Classic Horror', artworkUrl: null }]),
        },
      ];
    }
    return undefined;
  });
  await userEvent.type(
    await screen.findByRole('searchbox', { name: 'Search every server' }),
    'night{Enter}',
  );
  expect(
    await screen.findByRole('heading', { level: 1, name: 'Results for “night”' }),
  ).toBeInTheDocument();
  expect(window.location.pathname + window.location.search).toBe('/search?q=night');
  expect(await screen.findByRole('heading', { level: 2, name: /Titles/ })).toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 2, name: /People/ })).toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 2, name: /Collections/ })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Duane Jones' })).toHaveAttribute('href', '/people/p1');
  expect(screen.getByRole('link', { name: 'Classic Horror' })).toHaveAttribute(
    'href',
    '/collections/c1',
  );
  expect(screen.getByRole('status')).toHaveTextContent('3 results');
});

it('search with no hits says so', async () => {
  renderApp('/search?q=zzz', viewer, () => [
    200,
    { titles: page([]), people: page([]), collections: page([]) },
  ]);
  expect(await screen.findByText('Nothing matches “zzz”.')).toBeInTheDocument();
});

it('title detail shows the versions badge, server count, copies table and cast', async () => {
  renderApp('/items/m1', viewer, (_m, p) =>
    p === '/items/m1'
      ? [
          200,
          detail({
            id: 'm1',
            title: 'Night of the Living Dead',
            copyCount: 2,
            serverCount: 2,
            runtimeMinutes: 96,
            cast: [
              {
                person: { id: 'p1', name: 'Duane Jones', artworkUrl: null },
                role: 'Actor',
                character: 'Ben',
              },
            ],
            collections: [{ id: 'c1', name: 'Classic Horror' }],
            copies: [
              {
                sourceId: 's1',
                versionId: 'v1',
                serverName: 'Basement NAS',
                serverStatus: 'active',
                resolution: { width: 3840, height: 2160, label: '4K' },
                hdr: 'hdr10',
                videoCodec: 'hevc',
                container: 'mkv',
                audio: [{ codec: 'aac', channels: 6, language: 'en' }],
                sizeBytes: 6_400_000_000,
                expectedPlayability: 'direct_play',
                reasons: ['direct_play'],
                selected: true,
              },
              {
                sourceId: 's2',
                versionId: 'v2',
                serverName: 'Seedbox',
                serverStatus: 'unreachable',
                resolution: { width: 1920, height: 1080, label: '1080p' },
                hdr: 'none',
                videoCodec: 'h264',
                container: 'mp4',
                audio: [],
                sizeBytes: null,
                expectedPlayability: 'unavailable',
                reasons: ['server_unreachable'],
                selected: false,
              },
            ],
          }),
        ]
      : undefined,
  );
  expect(
    await screen.findByRole('heading', { level: 1, name: 'Night of the Living Dead' }),
  ).toBeInTheDocument();
  expect(screen.getByLabelText('Versions: 4K HDR, 1080p')).toBeInTheDocument();
  expect(screen.getByText('Available from 2 servers')).toBeInTheDocument();
  expect(screen.getByText('1968 · 1 h 36 min · Horror')).toBeInTheDocument();
  const table = screen.getByRole('table');
  expect(within(table).getByText('BEST')).toBeInTheDocument();
  expect(within(table).getByText('Plays as-is in this browser')).toBeInTheDocument();
  expect(within(table).getByText('Offline')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /Duane Jones/ })).toHaveAttribute('href', '/people/p1');
  expect(screen.getByRole('link', { name: 'Classic Horror' })).toHaveAttribute(
    'href',
    '/collections/c1',
  );
});

it('title detail uses the singular for one server', async () => {
  renderApp('/items/m1', viewer, () => [
    200,
    detail({ id: 'm1', title: 'Detour', serverCount: 1 }),
  ]);
  expect(await screen.findByText('Available from 1 server')).toBeInTheDocument();
});

it('an unknown title shows a not-found state, not a crash', async () => {
  renderApp('/items/nope', viewer, () => undefined);
  expect(await screen.findByRole('heading', { name: 'Title not found' })).toBeInTheDocument();
});

it('series detail lists seasons as a radio group and loads the chosen season', async () => {
  renderApp('/items/sr1', viewer, (_m, p) => {
    if (p === '/items/sr1')
      return [200, detail({ id: 'sr1', title: 'Dragnet', kind: 'series', copies: [] })];
    if (p.startsWith('/items/sr1/children'))
      return [
        200,
        page([
          card({ id: 'se1', title: 'Season 1', kind: 'season', seasonNumber: 1 }),
          card({ id: 'se2', title: 'Season 2', kind: 'season', seasonNumber: 2 }),
        ]),
      ];
    if (p.startsWith('/items/se1/children'))
      return [
        200,
        page([
          card({
            id: 'e1',
            title: 'The Big Casing',
            kind: 'episode',
            episodeNumber: 1,
            runtimeMinutes: 30,
          }),
        ]),
      ];
    if (p.startsWith('/items/se2/children'))
      return [
        200,
        page([
          card({
            id: 'e9',
            title: 'The Big Bounce',
            kind: 'episode',
            episodeNumber: 1,
            bestCopy: { serverName: 'Seedbox', serverStatus: 'unreachable', label: '720p' },
          }),
        ]),
      ];
    return undefined;
  });
  expect(await screen.findByRole('link', { name: /The Big Casing/ })).toBeInTheDocument();
  const group = screen.getByRole('group', { name: 'Season' });
  expect(within(group).getByRole('radio', { name: 'Season 1' })).toBeChecked();
  await userEvent.click(within(group).getByRole('radio', { name: 'Season 2' }));
  const ep = await screen.findByRole('link', { name: /The Big Bounce/ });
  expect(ep).toHaveTextContent('Offline');
  expect(ep).toHaveAttribute('href', '/items/e9');
});

it('season selector moves with the arrow keys', async () => {
  renderApp('/items/sr1', viewer, (_m, p) => {
    if (p === '/items/sr1') return [200, detail({ id: 'sr1', title: 'Dragnet', kind: 'series' })];
    if (p.startsWith('/items/sr1/children'))
      return [
        200,
        page([
          card({ id: 'se1', title: 'S1', kind: 'season', seasonNumber: 1 }),
          card({ id: 'se2', title: 'S2', kind: 'season', seasonNumber: 2 }),
        ]),
      ];
    return [200, page([])];
  });
  const first = await screen.findByRole('radio', { name: 'Season 1' });
  first.focus();
  await userEvent.keyboard('{ArrowRight}');
  expect(screen.getByRole('radio', { name: 'Season 2' })).toBeChecked();
});

it('person page lists visible titles with the role', async () => {
  renderApp('/people/p1', viewer, () => [
    200,
    {
      id: 'p1',
      name: 'Duane Jones',
      artworkUrl: null,
      credits: page([
        {
          item: card({ id: 'm1', title: 'Night of the Living Dead' }),
          role: 'Actor',
          character: 'Ben',
        },
      ]),
    },
  ]);
  expect(await screen.findByRole('heading', { level: 1, name: 'Duane Jones' })).toBeInTheDocument();
  expect(screen.getByText('as Ben')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /Night of the Living Dead/ })).toBeInTheDocument();
});

it('collections browse shows tiles, and the empty state when none', async () => {
  renderApp('/collections', viewer, () => [
    200,
    page([{ id: 'c1', name: 'Classic Horror', artworkUrl: null }]),
  ]);
  expect(await screen.findByRole('link', { name: 'Classic Horror' })).toHaveAttribute(
    'href',
    '/collections/c1',
  );
});

it('collections browse empty state', async () => {
  renderApp('/collections', viewer, () => [200, page([])]);
  expect(await screen.findByText('No collections yet.')).toBeInTheDocument();
});

it('collection page shows the member count and titles', async () => {
  renderApp('/collections/c1', viewer, () => [
    200,
    {
      id: 'c1',
      name: 'Classic Horror',
      overview: null,
      artworkUrl: null,
      members: page([
        card({ id: 'm1', title: 'Night of the Living Dead' }),
        card({
          id: 'm2',
          title: 'Plan 9',
          bestCopy: { serverName: 'Seedbox', serverStatus: 'active', label: '720p' },
        }),
      ]),
    },
  ]);
  expect(
    await screen.findByRole('heading', { level: 1, name: 'Classic Horror' }),
  ).toBeInTheDocument();
  expect(screen.getByText('2 titles on 2 servers')).toBeInTheDocument();
});

it('sync status shows last run, outcome, next run and recent errors per server', async () => {
  const server = {
    id: 's1',
    type: 'jellyfin',
    name: 'Basement NAS',
    baseUrl: 'https://x.example',
    priority: 0,
    status: 'active',
    version: '12.1.0',
    lastValidatedAt: 1,
    keyVersion: 1,
    createdAt: 1,
    updatedAt: 1,
    libraryCount: 2,
    enabledLibraryCount: 2,
  };
  const fetchMock = renderApp('/servers/sync', operator, (m, p) => {
    if (p === '/admin/servers') return [200, [server]];
    if (m === 'POST' && p === '/admin/servers/s1/sync') return [202, { runId: 'r2' }];
    if (p.startsWith('/admin/servers/s1/sync-runs'))
      return [
        200,
        {
          items: [
            {
              id: 'r1',
              type: 'incremental',
              trigger: 'schedule',
              status: 'partial',
              added: 3,
              updated: 1,
              missing: 0,
              errors: 2,
              errorSummary: 'Library Shows: origin returned 503',
              queuedAt: 1_000,
              startedAt: 1_000,
              endedAt: 2_000,
            },
          ],
          nextCursor: null,
          nextScheduled: 9_000_000_000_000,
        },
      ];
    return undefined;
  });
  expect(await screen.findByRole('heading', { level: 1, name: 'Sync status' })).toBeInTheDocument();
  expect(await screen.findByText('Finished with some libraries failing')).toBeInTheDocument();
  expect(screen.getByText('Library Shows: origin returned 503')).toBeInTheDocument();
  expect(screen.getByText('Next run')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Full re-index of Basement NAS' }));
  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/admin/servers/s1/sync',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ type: 'full' }) }),
    );
  });
});

it('sync status is not available to viewers', async () => {
  renderApp('/servers/sync', viewer, () => [200, []]);
  expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
});

it('sync status tells the operator when a sync is already running', async () => {
  const server = {
    id: 's1',
    type: 'jellyfin',
    name: 'NAS',
    baseUrl: 'https://x.example',
    priority: 0,
    status: 'active',
    version: null,
    lastValidatedAt: 1,
    keyVersion: 1,
    createdAt: 1,
    updatedAt: 1,
    libraryCount: 1,
    enabledLibraryCount: 1,
  };
  renderApp('/servers/sync', operator, (m, p) => {
    if (p === '/admin/servers') return [200, [server]];
    if (m === 'POST')
      return [409, { error: { code: 'SYNC_IN_PROGRESS', message: 'x', requestId: 'r' } }];
    return [200, { items: [], nextCursor: null, nextScheduled: null }];
  });
  expect(await screen.findByText('Never run')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Sync NAS now' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('A sync is already running');
});
