// T2.4, T2.9 and T2.10 read side: catalog query layer with central BR-1 filtering (FR-CAT-002 to
// FR-CAT-006, FR-CAT-008, FR-CAT-011, FR-CAT-012, NFR-REL-001). M2 exit check (b): the IDOR test.
import type {
  CollectionCard,
  CollectionDetail,
  HomeResponse,
  ItemCard,
  ItemDetail,
  Page,
  PersonDetail,
  SearchResponse,
  VersionEntry,
} from '@cinewren/shared';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app';
import { call, errorCode, json, type CallOptions } from './auth-harness';
import { resetAll, seedWorld, T0, type World } from './catalog-seed';

const db = env.DB;
let w: World;

beforeEach(async () => {
  await resetAll();
  w = await seedWorld();
});

type U = { cookie: string };
const get = (u: U | null, path: string, opts: CallOptions = {}) =>
  call('GET', `/api/v1${path}`, { cookie: u?.cookie, ...opts });
const ids = (page: { items: { id: string }[] }) => page.items.map((i) => i.id);
const browse = async (u: U, qs = '') => json<Page<ItemCard>>(await get(u, `/items${qs}`));

describe('authentication', () => {
  it('answers 401 to every catalog route without a session', async () => {
    for (const path of [
      '/home',
      '/items',
      '/items/m-amelie',
      '/items/m-amelie/children',
      '/items/m-amelie/versions',
      '/search?q=ame',
      '/people/p-evans',
      '/collections',
      '/collections/c-duo',
      '/artwork/m-amelie/poster',
      '/artwork/people/p-evans',
      '/artwork/collections/c-duo',
    ]) {
      const res = await get(null, path);
      expect(res.status, path).toBe(401);
      expect(await errorCode(res), path).toBe('AUTH_REQUIRED');
    }
  });
});

describe('M2 exit check (b): a viewer without a grant cannot reach, count or infer hidden titles (IDOR)', () => {
  const hiddenFromBob = ['m-amelie', 'm-inter', 's-sev', 'se-1', 'ep-1'];

  it('returns 404 for detail, children, versions and artwork, identical to an unknown ID', async () => {
    const unknown = await get(w.bob, '/items/does-not-exist');
    expect(unknown.status).toBe(404);
    const reference = await json<{ error: { code: string; message: string } }>(unknown);
    expect(reference.error.code).toBe('NOT_FOUND');

    for (const id of hiddenFromBob) {
      for (const path of [`/items/${id}`, `/items/${id}/children`, `/items/${id}/versions`]) {
        const res = await get(w.bob, path);
        expect(res.status, path).toBe(404);
        const body = await json<{ error: { code: string; message: string } }>(res);
        expect(body.error.code, path).toBe('NOT_FOUND');
        expect(body.error.message, path).toBe(reference.error.message);
      }
      for (const slot of ['poster', 'backdrop', 'thumb']) {
        expect((await get(w.bob, `/artwork/${id}/${slot}?v=tagA`)).status, `${id}/${slot}`).toBe(
          404,
        );
      }
    }
  });

  it('returns 404 for person and collection pages and their artwork', async () => {
    for (const path of [
      '/people/p-evans',
      '/people/p-hidden',
      '/collections/c-duo',
      '/collections/c-fav-a',
      '/artwork/people/p-evans?v=face1',
      '/artwork/collections/c-duo?v=cover1',
    ]) {
      const res = await get(w.bob, path);
      expect(res.status, path).toBe(404);
      expect(await errorCode(res), path).toBe('NOT_FOUND');
    }
  });

  it('shows Alice only what her grants allow: detail, person and collection pages 404 on the rest', async () => {
    expect((await get(w.alice, '/items/m-amelie')).status).toBe(200);
    for (const path of [
      '/items/m-inter', // only on Bravo (L3), which she is not granted
      '/items/m-secret', // disabled library
      '/items/m-gone', // disabled server
      '/people/p-hidden', // credits only on a hidden title
      '/collections/c-hidden', // members all hidden
      '/artwork/m-inter/poster',
      '/artwork/people/p-hidden',
    ]) {
      expect((await get(w.alice, path)).status, path).toBe(404);
    }
  });

  it('never lists a hidden item in browse, search, home or any count', async () => {
    expect((await browse(w.bob)).items).toEqual([]);
    expect((await browse(w.bob, '?type=movie&sort=added')).items).toEqual([]);
    const search = await json<SearchResponse>(await get(w.bob, '/search?q=a'));
    expect(search.titles.items).toEqual([]);
    expect(search.people.items).toEqual([]);
    expect(search.collections.items).toEqual([]);
    expect(await json<HomeResponse>(await get(w.bob, '/home'))).toEqual({
      recentlyAdded: [],
      continueWatching: [],
    });
    expect((await json<Page<unknown>>(await get(w.bob, '/collections'))).items).toEqual([]);

    const alice = await browse(w.alice);
    expect(ids(alice).sort()).toEqual(['m-amelie', 's-sev']);
    for (const hidden of ['m-inter', 'm-secret', 'm-gone']) {
      expect(JSON.stringify(alice)).not.toContain(hidden);
    }
    const aliceSearch = await json<SearchResponse>(await get(w.alice, '/search?q=interstellar'));
    expect(aliceSearch.titles.items).toEqual([]);
    expect(JSON.stringify(await json(await get(w.alice, '/home')))).not.toContain('m-inter');
  });

  it('counts, versions and server counts use only the caller’s visible sources (BR-1)', async () => {
    const alice = await json<ItemDetail>(await get(w.alice, '/items/m-amelie'));
    expect(alice.versionsSummary).toEqual(['1080p']);
    expect(alice.serverCount).toBe(1);
    const aliceVersions = await json<VersionEntry[]>(
      await get(w.alice, '/items/m-amelie/versions'),
    );
    expect(aliceVersions.map((v) => v.serverName)).toEqual(['Alpha']);

    const op = await json<ItemDetail>(await get(w.op, '/items/m-amelie'));
    expect(op.versionsSummary).toEqual(['4K HDR', '1080p']);
    expect(op.serverCount).toBe(2);
    const opVersions = await json<VersionEntry[]>(await get(w.op, '/items/m-amelie/versions'));
    expect(opVersions.map((v) => `${v.serverName}:${v.serverStatus}`)).toEqual([
      'Bravo:unreachable',
      'Alpha:active',
    ]);
  });

  it('does not let a minHeight filter probe a hidden version', async () => {
    // The 2160p copy of Amélie is on Bravo; Alice cannot see it.
    expect(ids(await browse(w.alice, '?minHeight=2160'))).toEqual(['s-sev']); // via ep-2 (DV)
    expect(ids(await browse(w.alice, '?minHeight=2160&type=movie'))).toEqual([]);
    expect(ids(await browse(w.op, '?minHeight=2160&type=movie')).sort()).toEqual([
      'm-amelie',
      'm-inter',
    ]);
  });

  it('shows hidden-title credits and members neither on person pages nor as counts', async () => {
    const aliceEvans = await json<PersonDetail>(await get(w.alice, '/people/p-evans'));
    expect(aliceEvans.credits.items.map((c) => c.item.id)).toEqual(['m-amelie']);
    expect(JSON.stringify(aliceEvans)).not.toMatch(/inter|Cooper/i);
    const opEvans = await json<PersonDetail>(await get(w.op, '/people/p-evans'));
    expect(opEvans.credits.items.map((c) => c.item.id)).toEqual(['m-inter', 'm-amelie']); // year desc

    const aliceDuo = await json<CollectionDetail>(await get(w.alice, '/collections/c-duo'));
    expect(ids(aliceDuo.members)).toEqual(['m-amelie']);
    const opDuo = await json<CollectionDetail>(await get(w.op, '/collections/c-duo'));
    expect(ids(opDuo.members)).toEqual(['m-amelie', 'm-inter']); // year ascending

    const cast = (await json<ItemDetail>(await get(w.alice, '/items/m-amelie'))).cast;
    expect(cast.map((m) => m.person.id)).toEqual(['p-evans']);
    expect(
      (await json<ItemDetail>(await get(w.alice, '/items/m-amelie'))).collections
        .map((x) => x.id)
        .sort(),
    ).toEqual(['c-duo', 'c-fav-a']);
  });

  it('hides a collection whose members are all hidden from browse and search (T2.10)', async () => {
    const aliceList = await json<Page<CollectionCard>>(await get(w.alice, '/collections'));
    expect(aliceList.items.map((c) => c.id)).toEqual(['c-duo', 'c-fav-a']);
    const opList = await json<Page<CollectionCard>>(await get(w.op, '/collections'));
    expect(opList.items.map((c) => c.id)).toEqual(['c-duo', 'c-fav-a', 'c-fav-b', 'c-hidden']);
    const search = await json<SearchResponse>(await get(w.alice, '/search?q=hidden'));
    expect(search.collections.items).toEqual([]);
    expect(search.people.items).toEqual([]);
  });

  it('applies grants and server and library status at once', async () => {
    expect(ids(await browse(w.carol, '?type=movie')).sort()).toEqual(['m-amelie', 'm-inter']);
    // Disabling Alpha hides its sources from Alice immediately.
    await db.prepare("UPDATE servers SET status = 'disabled' WHERE id = 'alpha'").run();
    expect((await browse(w.alice)).items).toEqual([]);
    expect((await get(w.alice, '/items/m-amelie')).status).toBe(404);
    // The operator still sees the Bravo copy.
    expect(ids(await browse(w.op, '?type=movie')).sort()).toEqual(['m-amelie', 'm-inter']);
    await db.prepare("UPDATE servers SET status = 'removing' WHERE id = 'bravo'").run();
    expect((await browse(w.op, '?type=movie')).items).toEqual([]);
  });

  it('treats a missing source as absent', async () => {
    await db.prepare("UPDATE sources SET status = 'missing' WHERE id = 'src-m-amelie-alpha'").run();
    await db
      .prepare(
        "DELETE FROM item_availability WHERE media_item_id = 'm-amelie' AND library_id = 'L1'",
      )
      .run();
    expect((await get(w.alice, '/items/m-amelie')).status).toBe(404);
    expect((await get(w.carol, '/items/m-amelie')).status).toBe(200);
  });
});

describe('browse (FR-CAT-002, FR-CAT-003)', () => {
  it('lists movies and series, never seasons or episodes, sorted by title by default', async () => {
    const page = await browse(w.op);
    expect(ids(page)).toEqual(['m-amelie', 'm-inter', 's-sev']);
    expect(page.nextCursor).toBeNull();
    expect(page.items[0]).toEqual({
      id: 'm-amelie',
      type: 'movie',
      seasonNumber: null,
      episodeNumber: null,
      title: 'Amélie',
      year: 2001,
      artworkUrl: '/api/v1/artwork/m-amelie/poster?v=tagA',
    });
  });

  it('sorts by year and date added, in either order', async () => {
    expect(ids(await browse(w.op, '?sort=year'))).toEqual(['s-sev', 'm-inter', 'm-amelie']);
    expect(ids(await browse(w.op, '?sort=year&order=asc'))).toEqual([
      'm-amelie',
      'm-inter',
      's-sev',
    ]);
    expect(ids(await browse(w.op, '?sort=added'))).toEqual(['m-amelie', 'm-inter', 's-sev']);
    expect(ids(await browse(w.op, '?sort=title&order=desc'))).toEqual([
      's-sev',
      'm-inter',
      'm-amelie',
    ]);
    expect(ids(await browse(w.op, '?type=series'))).toEqual(['s-sev']);
  });

  it('pages with signed cursors that cover every row once and carry no total', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const qs: string = `?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const page: Page<ItemCard> = await browse(w.op, qs);
      expect(Object.keys(page).sort()).toEqual(['items', 'nextCursor']);
      seen.push(...ids(page));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(seen).toEqual(['m-amelie', 'm-inter', 's-sev']);
    expect(pages).toBe(3);
  });

  it('rejects forged, foreign and stale cursors and bad parameters', async () => {
    const first = await browse(w.op, '?limit=1');
    const cursor = encodeURIComponent(first.nextCursor ?? '');
    expect((await get(w.op, '/items?cursor=garbage')).status).toBe(400);
    expect((await get(w.op, `/items?limit=1&cursor=${cursor.slice(0, -2)}xx`)).status).toBe(400);
    // Another user's cursor, and the same cursor under a different sort, are refused.
    expect((await get(w.alice, `/items?limit=1&cursor=${cursor}`)).status).toBe(400);
    expect((await get(w.op, `/items?limit=1&sort=year&cursor=${cursor}`)).status).toBe(400);
    for (const qs of ['?limit=0', '?limit=101', '?sort=random', '?type=season', '?yearFrom=abc']) {
      const res = await get(w.op, `/items${qs}`);
      expect(res.status, qs).toBe(400);
      expect(await errorCode(res), qs).toBe('VALIDATION_FAILED');
    }
  });

  it('filters by genre (any case), year range and best visible resolution', async () => {
    expect(ids(await browse(w.op, '?genre=sci-fi'))).toEqual(['m-inter']);
    expect(ids(await browse(w.op, '?genre=comedy'))).toEqual(['m-amelie']);
    expect(ids(await browse(w.op, '?yearFrom=2010'))).toEqual(['m-inter', 's-sev']);
    expect(ids(await browse(w.op, '?yearFrom=2002&yearTo=2015'))).toEqual(['m-inter']);
    expect(ids(await browse(w.op, '?minHeight=2160'))).toEqual(['m-amelie', 'm-inter', 's-sev']);
    expect(ids(await browse(w.op, '?minHeight=1080&genre=drama'))).toEqual(['s-sev']);
  });
});

describe('home (FR-CAT-008)', () => {
  it('returns recently added titles, newest first, visible only', async () => {
    const op = await json<HomeResponse>(await get(w.op, '/home'));
    expect(ids({ items: op.recentlyAdded })).toEqual(['m-amelie', 'm-inter', 's-sev']);
    expect(op.continueWatching).toEqual([]);
    const alice = await json<HomeResponse>(await get(w.alice, '/home'));
    expect(ids({ items: alice.recentlyAdded })).toEqual(['m-amelie', 's-sev']);
  });
});

describe('item detail (FR-CAT-005)', () => {
  it('returns metadata, artwork proxy URLs, summary, cast and collections', async () => {
    const d = await json<ItemDetail>(await get(w.op, '/items/m-amelie'));
    expect(d).toMatchObject({
      id: 'm-amelie',
      type: 'movie',
      title: 'Amélie',
      originalTitle: null,
      year: 2001,
      genres: ['Comedy', 'Romance'],
      parentId: null,
      progress: null,
      children: null,
    });
    expect(d.artwork).toEqual({
      poster: '/api/v1/artwork/m-amelie/poster?v=tagA',
      backdrop: '/api/v1/artwork/m-amelie/backdrop?v=bdA',
      thumb: null,
    });
    expect(d.cast).toEqual([
      {
        person: {
          id: 'p-evans',
          name: 'Chris Evans',
          artworkUrl: '/api/v1/artwork/people/p-evans?v=face1',
        },
        role: 'actor',
        character: 'Nino',
      },
    ]);
    expect(JSON.stringify(d)).not.toContain('example.test');
  });

  it('lists seasons and episodes of a series, with a visible-only child summary', async () => {
    const series = await json<ItemDetail>(await get(w.alice, '/items/s-sev'));
    expect(series.children).toEqual({ type: 'season', count: 1 });
    expect(series.versionsSummary).toEqual(['4K Dolby Vision', '1080p']);
    expect(series.serverCount).toBe(1);

    const seasons = await json<Page<ItemCard>>(await get(w.alice, '/items/s-sev/children'));
    expect(seasons.items.map((i) => i.title)).toEqual(['Season 1']);
    expect(seasons.items[0]).toMatchObject({ seasonNumber: 1, episodeNumber: null });
    const episodes = await json<Page<ItemCard>>(await get(w.alice, '/items/se-1/children'));
    expect(episodes.items.map((i) => i.id)).toEqual(['ep-1', 'ep-2']);
    expect(episodes.items.map((i) => i.episodeNumber)).toEqual([1, 2]);
    const page = await json<Page<ItemCard>>(await get(w.alice, '/items/se-1/children?limit=1'));
    expect(ids(page)).toEqual(['ep-1']);
    const next = await json<Page<ItemCard>>(
      await get(
        w.alice,
        `/items/se-1/children?limit=1&cursor=${encodeURIComponent(page.nextCursor ?? '')}`,
      ),
    );
    expect(ids(next)).toEqual(['ep-2']);

    const ep = await json<ItemDetail>(await get(w.alice, '/items/ep-2'));
    expect(ep).toMatchObject({
      parentId: 'se-1',
      seasonNumber: 1,
      episodeNumber: 2,
      children: null,
    });
  });

  it('reports the caller’s own progress', async () => {
    await db
      .prepare(
        `INSERT INTO watch_progress (user_id, media_item_id, position_ms, watched, updated_at)
         VALUES ('alice', 'm-amelie', 1234, 0, ?)`,
      )
      .bind(T0)
      .run();
    expect((await json<ItemDetail>(await get(w.alice, '/items/m-amelie'))).progress).toEqual({
      positionMs: 1234,
      watched: false,
    });
    expect((await json<ItemDetail>(await get(w.op, '/items/m-amelie'))).progress).toBeNull();
  });
});

describe('search (FR-CAT-004, FR-CAT-011, FR-CAT-012)', () => {
  const search = async (u: U, qs: string) => json<SearchResponse>(await get(u, `/search?${qs}`));

  it('ignores case and diacritics, matches prefixes and the alternate title', async () => {
    for (const q of [
      'amelie',
      'AMELIE',
      'Amélie',
      'amél',
      'AME',
      'fabuleux destin',
      'destin fab',
    ]) {
      const r = await search(w.op, `q=${encodeURIComponent(q)}`);
      expect(ids(r.titles), q).toEqual(['m-amelie']);
    }
    expect(ids((await search(w.op, 'q=zzz')).titles)).toEqual([]);
    expect(ids((await search(w.op, 'q=sever')).titles)).toEqual(['s-sev']);
  });

  it('returns grouped titles, people and collections', async () => {
    const r = await search(w.op, 'q=chris');
    expect(r.people.items).toEqual([
      { id: 'p-evans', name: 'Chris Evans', artworkUrl: '/api/v1/artwork/people/p-evans?v=face1' },
    ]);
    expect(r.titles.items).toEqual([]);
    expect(r.collections.items).toEqual([]);
    const c = await search(w.op, 'q=duology');
    expect(c.collections.items).toEqual([
      { id: 'c-duo', name: 'Duology', artworkUrl: '/api/v1/artwork/collections/c-duo?v=cover1' },
    ]);
    // A person search is case- and diacritic-insensitive too.
    expect(ids((await search(w.op, 'q=CHRÍS%20evans')).people)).toEqual(['p-evans']);
  });

  it('with kind returns only that group; cursor pages it and needs kind', async () => {
    const r = await json<Partial<SearchResponse>>(
      await get(w.op, '/search?q=favourites&kind=collection'),
    );
    expect(Object.keys(r)).toEqual(['collections']);
    const one = await json<Partial<SearchResponse>>(
      await get(w.op, '/search?q=favourites&kind=collection&limit=1'),
    );
    expect(one.collections?.items).toHaveLength(1);
    const cursor = one.collections?.nextCursor;
    expect(cursor).toBeTruthy();
    const two = await json<Partial<SearchResponse>>(
      await get(
        w.op,
        `/search?q=favourites&kind=collection&limit=1&cursor=${encodeURIComponent(cursor ?? '')}`,
      ),
    );
    expect(two.collections?.items).toHaveLength(1);
    expect(two.collections?.nextCursor).toBeNull();
    expect(two.collections?.items[0]?.id).not.toBe(one.collections?.items[0]?.id);
    expect(
      (await get(w.op, `/search?q=favourites&cursor=${encodeURIComponent(cursor ?? '')}`)).status,
    ).toBe(400);
  });

  it('labels same-name collections with a server the caller can see (ADR-0015)', async () => {
    const op = await json<Partial<SearchResponse>>(
      await get(w.op, '/search?q=favourites&kind=collection'),
    );
    const labels = Object.fromEntries(
      (op.collections?.items ?? []).map((c) => [c.id, c.serverLabel]),
    );
    expect(labels).toEqual({ 'c-fav-a': 'Alpha', 'c-fav-b': 'Bravo' });
    // Alice sees only one of them, so there is nothing to disambiguate and no label.
    const alice = await json<Partial<SearchResponse>>(
      await get(w.alice, '/search?q=favourites&kind=collection'),
    );
    expect(alice.collections?.items).toEqual([
      { id: 'c-fav-a', name: 'Favourites', artworkUrl: null },
    ]);
  });

  it('never leaks a hidden title through ranking, paging or prefix search', async () => {
    for (const q of ['inter', 'interstellar', 'secret', 'gone', 'evan', 'cooper']) {
      const r = await search(w.alice, `q=${q}`);
      expect(JSON.stringify(r), q).not.toMatch(/m-inter|m-secret|m-gone|p-hidden/);
    }
    expect(ids((await search(w.alice, 'q=evans')).people)).toEqual(['p-evans']); // visible via Amélie
    expect(ids((await search(w.alice, 'q=hidden')).people)).toEqual([]);
  });

  it('is safe against FTS syntax in the query and validates its parameters', async () => {
    for (const q of ['"', 'a OR b', 'name:amelie', 'amelie*', '(', '--', 'NEAR(a b)', '*']) {
      const res = await get(w.op, `/search?q=${encodeURIComponent(q)}`);
      expect(res.status, q).toBe(200);
    }
    const none = await search(w.op, 'q=%21%21');
    expect(none.titles).toEqual({ items: [], nextCursor: null });
    for (const qs of ['', 'q=', `q=${'a'.repeat(101)}`, 'q=a&kind=movie', 'q=a&limit=51']) {
      const res = await get(w.op, `/search?${qs}`);
      expect(res.status, qs).toBe(400);
    }
  });
});

describe('people and collections pages (T2.9, T2.10 read side)', () => {
  it('lists credits once per title and role, year descending, with the character', async () => {
    // A second source credits the same person for the same title and role: still one row.
    await db
      .prepare(
        `INSERT INTO credits (source_id, link_id, role, person_id, media_item_id, character, sort_order)
         VALUES ('src-m-amelie-bravo', 'plink-evans-bravo', 'actor', 'p-evans', 'm-amelie', NULL, 3)`,
      )
      .run();
    const p = await json<PersonDetail>(await get(w.op, '/people/p-evans'));
    expect(p.name).toBe('Chris Evans');
    expect(p.credits.items.map((c) => [c.item.id, c.role, c.character])).toEqual([
      ['m-inter', 'actor', 'Cooper'],
      ['m-amelie', 'actor', 'Nino'],
    ]);
    const paged = await json<PersonDetail>(await get(w.op, '/people/p-evans?limit=1'));
    expect(paged.credits.items).toHaveLength(1);
    expect(paged.credits.nextCursor).toBeTruthy();
    const rest = await json<PersonDetail>(
      await get(
        w.op,
        `/people/p-evans?limit=1&cursor=${encodeURIComponent(paged.credits.nextCursor ?? '')}`,
      ),
    );
    expect(rest.credits.items.map((c) => c.item.id)).toEqual(['m-amelie']);
    expect(rest.credits.nextCursor).toBeNull();
  });

  it('returns 404 for an unknown person or collection', async () => {
    expect((await get(w.op, '/people/nope')).status).toBe(404);
    expect((await get(w.op, '/collections/nope')).status).toBe(404);
  });

  it('returns a collection with its overview and artwork URL', async () => {
    const c = await json<CollectionDetail>(await get(w.op, '/collections/c-duo'));
    expect(c).toMatchObject({
      id: 'c-duo',
      name: 'Duology',
      overview: 'About it.',
      artworkUrl: '/api/v1/artwork/collections/c-duo?v=cover1',
    });
  });

  it('pages collections by name', async () => {
    const first = await json<Page<CollectionCard>>(await get(w.op, '/collections?limit=2'));
    expect(first.items.map((c) => c.id)).toEqual(['c-duo', 'c-fav-a']);
    const second = await json<Page<CollectionCard>>(
      await get(w.op, `/collections?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? '')}`),
    );
    expect(second.items.map((c) => c.id)).toEqual(['c-fav-b', 'c-hidden']);
    expect(second.nextCursor).toBeNull();
  });
});

describe('NFR-REL-001: browse, search and detail with every origin offline', () => {
  it('works from synced data and never calls an origin', async () => {
    let calls = 0;
    const offline = createApp({
      originFetch: () => {
        calls++;
        return Promise.reject(new TypeError('network down'));
      },
    });
    const via = (path: string) => get(w.op, path, { app: offline });
    expect((await via('/items')).status).toBe(200);
    expect((await via('/home')).status).toBe(200);
    expect((await via('/search?q=amelie')).status).toBe(200);
    expect((await via('/items/m-amelie')).status).toBe(200);
    expect((await via('/items/s-sev/children')).status).toBe(200);
    expect((await via('/people/p-evans')).status).toBe(200);
    expect((await via('/collections/c-duo')).status).toBe(200);
    // Every server is down, as far as health is concerned; titles stay browsable.
    await db.prepare("UPDATE servers SET status = 'unreachable' WHERE status = 'active'").run();
    const page = await json<Page<ItemCard>>(await via('/items'));
    expect(ids(page)).toEqual(['m-amelie', 'm-inter', 's-sev']);
    expect(calls).toBe(0);
  });
});
