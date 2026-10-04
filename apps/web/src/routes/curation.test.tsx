import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { CurationEntity, MatchConflict } from '@cinewren/shared';
import { card, detail, operator, page, renderApp, viewer } from '../test-utils';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const conflict: MatchConflict = {
  id: 'c1',
  entityKind: 'item',
  status: 'open',
  reason: 'conflicting_ids',
  detectedAt: 1,
  source: {
    id: 's2',
    title: 'Blade Runner (cut)',
    year: 1982,
    serverName: 'Attic Plex',
    serverType: 'plex',
    externalIds: { tmdb: '78', imdb: 'tt9999999' },
    currentId: 'i2',
  },
  candidates: [
    {
      id: 'i1',
      title: 'Blade Runner',
      year: 1982,
      externalIds: { tmdb: ['78'], imdb: ['tt0083658'] },
      sharedIds: ['tmdb:78'],
      conflictingIds: ['imdb:tt9999999!=tt0083658'],
    },
  ],
};

it('lists conflicts with their candidates, resolves one by merge, and the list refreshes (FR-CAT-010)', async () => {
  let open: MatchConflict[] = [conflict];
  const posted: unknown[] = [];
  renderApp('/servers/conflicts', operator, (method, path, body) => {
    if (method === 'POST' && path === '/admin/curation/conflicts/c1/resolve') {
      posted.push(body);
      open = [];
      return [200, { id: 'i1', itemId: 'i1' }];
    }
    if (path.startsWith('/admin/curation/conflicts')) return [200, page(open)];
    return undefined;
  });
  expect(await screen.findByRole('heading', { name: 'Match conflicts' })).toBeTruthy();
  const cardEl = await screen.findByRole('article', { name: /Blade Runner \(cut\)/ });
  expect(within(cardEl).getByText('Looks like the same one, but the IDs disagree')).toBeTruthy();
  expect(within(cardEl).getByText(/Different: imdb:tt9999999/)).toBeTruthy();
  expect(within(cardEl).getByText('Flagged on Attic Plex')).toBeTruthy();

  await userEvent.click(
    within(cardEl).getByRole('button', {
      name: 'Merge Blade Runner (cut) (1982) into Blade Runner (1982)',
    }),
  );
  expect(await screen.findByText('No conflicts to review')).toBeTruthy();
  expect(posted).toEqual([{ action: 'merge', intoId: 'i1' }]);
  expect(screen.getByRole('status').textContent).toMatch(/Merged Blade Runner \(cut\)/);
});

it('keeps separate and dismisses through the same endpoint, shows a stale conflict as an error, and filters by kind', async () => {
  const seen: string[] = [];
  const bodies: unknown[] = [];
  renderApp('/servers/conflicts', operator, (method, path, body) => {
    if (method === 'POST') {
      bodies.push(body);
      return bodies.length === 1
        ? [404, { error: { code: 'NOT_FOUND', message: 'Not found.', requestId: 'r' } }]
        : [200, { id: 'i2', itemId: 'i2' }];
    }
    seen.push(path);
    return [200, page(path.includes('entityKind=person') ? [] : [conflict])];
  });
  const cardEl = await screen.findByRole('article', { name: /Blade Runner \(cut\)/ });
  await userEvent.click(within(cardEl).getByRole('button', { name: /Keep Blade Runner \(cut\)/ }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/Not found/);
  await userEvent.click(within(cardEl).getByRole('button', { name: /Dismiss the flag/ }));
  await waitFor(() => {
    expect(bodies).toEqual([{ action: 'keep_separate' }, { action: 'dismiss' }]);
  });
  await userEvent.selectOptions(screen.getByLabelText('Show'), 'person');
  expect(await screen.findByText('No conflicts to review')).toBeTruthy();
  expect(seen.some((p) => p.includes('entityKind=person'))).toBe(true);
});

it('keeps the conflicts page out of reach of viewers', async () => {
  renderApp('/servers/conflicts', viewer, () => undefined);
  expect(await screen.findByText(/not found/i)).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Match conflicts' })).toBeNull();
});

const entity: CurationEntity = {
  entityKind: 'item',
  id: 'i1',
  name: 'Nosferatu',
  records: [
    {
      id: 'src-a',
      serverName: 'Basement NAS',
      serverType: 'jellyfin',
      name: 'Nosferatu',
      year: 1922,
      status: 'present',
      manual: false,
    },
    {
      id: 'src-b',
      serverName: 'Attic Plex',
      serverType: 'plex',
      name: 'Nosferatu (1922)',
      year: 1922,
      status: 'present',
      manual: false,
    },
  ],
};

it('offers split and merge on a title page to operators only (FR-CAT-007)', async () => {
  const calls: [string, string, unknown][] = [];
  const handler = (method: string, path: string, body: unknown): [number, unknown] | undefined => {
    calls.push([method, path, body]);
    if (path === '/items/i1') return [200, detail({ id: 'i1', title: 'Nosferatu' })];
    if (path === '/admin/curation/entities/item/i1') return [200, entity];
    if (path.startsWith('/search')) {
      return [
        200,
        {
          titles: page([
            card({ id: 'i1', title: 'Nosferatu' }),
            card({ id: 'i9', title: 'Nosferatu', year: 2024 }),
          ]),
          people: page([]),
          collections: page([]),
        },
      ];
    }
    if (method === 'POST' && path === '/admin/curation/merge') return [200, { id: 'i1' }];
    if (method === 'POST' && path === '/admin/curation/split') return [200, { newId: 'i7' }];
    return undefined;
  };
  renderApp('/items/i1', operator, handler);
  const panel = await screen.findByRole('region', { name: 'Curation' });
  expect(within(panel).getByText('This choice is kept across future indexing.')).toBeTruthy();

  // Merge: search, pick, preview, confirm. The page's own title is never offered as a candidate.
  await userEvent.type(
    await within(panel).findByLabelText(/Merge another title into this one/),
    'nosf',
  );
  await userEvent.click(within(panel).getByRole('button', { name: 'Find' }));
  const results = await within(panel).findByRole('list', { name: 'Search results' });
  expect(within(results).getAllByRole('button')).toHaveLength(1);
  await userEvent.click(within(results).getByRole('button', { name: 'Nosferatu (2024)' }));
  expect(within(panel).getByRole('group', { name: 'Merge preview' }).textContent).toMatch(
    /Nosferatu \(2024\).*merged into.*Nosferatu/,
  );
  await userEvent.click(within(panel).getByRole('button', { name: 'Merge' }));
  await waitFor(() => {
    expect(calls).toContainEqual([
      'POST',
      '/admin/curation/merge',
      { entityKind: 'item', intoId: 'i1', fromId: 'i9' },
    ]);
  });

  // Split: one source out, then the app opens the new title. (The page reloaded after the merge.)
  const again = await screen.findByRole('region', { name: 'Curation' });
  await userEvent.click(
    await within(again).findByRole('button', {
      name: 'Split out Nosferatu (1922) from Attic Plex',
    }),
  );
  await waitFor(() => {
    expect(calls).toContainEqual([
      'POST',
      '/admin/curation/split',
      { entityKind: 'item', id: 'i1', sourceId: 'src-b' },
    ]);
  });
  await waitFor(() => {
    expect(window.location.pathname).toBe('/items/i7');
  });
});

it('shows no curation to a viewer, and disables splitting the only source', async () => {
  renderApp('/items/i1', viewer, (_m, path) =>
    path === '/items/i1' ? [200, detail({ id: 'i1', title: 'Nosferatu' })] : undefined,
  );
  expect(await screen.findByRole('heading', { name: 'Nosferatu' })).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Curation' })).toBeNull();
  cleanup();

  renderApp('/people/p1', operator, (_m, path) => {
    if (path === '/people/p1') {
      return [200, { id: 'p1', name: 'Max Schreck', artworkUrl: null, credits: page([]) }];
    }
    if (path === '/admin/curation/entities/person/p1') {
      return [
        200,
        {
          entityKind: 'person',
          id: 'p1',
          name: 'Max Schreck',
          records: [{ ...entity.records[0], id: 'l1', name: 'Max Schreck' }],
        },
      ];
    }
    return undefined;
  });
  const panel = await screen.findByRole('region', { name: 'Curation' });
  const split = await within(panel).findByRole('button', { name: /Split out Max Schreck/ });
  expect((split as HTMLButtonElement).disabled).toBe(true);
});
