// T2.3, T2.9, T2.10 and M2 exit check (a): matching through the real sync, with two mock servers.
import { beforeEach, describe, expect, it } from 'vitest';
import { ProviderError } from '../../src/providers/errors';
import {
  FakeOrigin,
  collection,
  count,
  credit,
  episode,
  makeHarness,
  movie,
  one,
  resetCatalog,
  rows,
  season,
  seedServer,
  series,
  syncOnce,
} from './harness';

beforeEach(resetCatalog);

async function twoServers() {
  await seedServer({ id: 'A', priority: 2 });
  await seedServer({ id: 'B', priority: 1 });
  const a = new FakeOrigin('A');
  const b = new FakeOrigin('B');
  return { a, b, h: makeHarness({ origins: [a, b] }) };
}
const sync = async (h: ReturnType<typeof makeHarness>) => {
  await syncOnce(h, 'A');
  await syncOnce(h, 'B');
};

describe('M2 exit (a) and T2.3: title matching (FR-CAT-001, BR-2)', () => {
  it('the same movie on two mock servers yields one item with two sources', async () => {
    const { a, b, h } = await twoServers();
    a.setItems('A-plib', [movie('a1', 'Interstellar', { tmdb: '157336', imdb: 'tt0816692' })]);
    b.setItems('B-plib', [movie('b1', 'Interstellar (2014)', { tmdb: '157336' })]);
    await sync(h);
    expect(await count('media_items')).toBe(1);
    expect(await count('sources')).toBe(2);
    const item = await one<{ id: string; title: string }>('SELECT id, title FROM media_items');
    expect(await count('sources', 'media_item_id = ?', item?.id)).toBe(2);
    // The higher-priority server's metadata is shown; IDs are aggregated across sources.
    expect(item?.title).toBe('Interstellar');
    expect(
      (await rows<{ scheme: string }>('SELECT scheme FROM external_ids ORDER BY scheme')).map(
        (r) => r.scheme,
      ),
    ).toEqual(['imdb', 'tmdb']);
    expect(await count('item_availability')).toBe(2);
    expect(
      (
        await rows<{ method: string }>(
          'SELECT match_method AS method FROM sources ORDER BY server_id',
        )
      ).map((r) => r.method),
    ).toEqual(['new', 'external_id']);
  });

  it('merges on a shared IMDb ID even when TMDB is missing on one side', async () => {
    const { a, b, h } = await twoServers();
    a.setItems('A-plib', [movie('a1', 'Heat', { imdb: 'tt0113277' })]);
    b.setItems('B-plib', [movie('b1', 'Heat', { imdb: 'tt0113277', tmdb: '949' })]);
    await sync(h);
    expect(await count('media_items')).toBe(1);
  });

  it('title-only similarity never merges', async () => {
    const { a, b, h } = await twoServers();
    a.setItems('A-plib', [movie('a1', 'The Thing', { year: 1982 })]);
    b.setItems('B-plib', [movie('b1', 'The Thing', { year: 1982 })]);
    await sync(h);
    expect(await count('media_items')).toBe(2);
    expect(await count('match_conflicts')).toBe(0);
  });

  it('conflicting IDs create a conflict flag and stay separate; a re-run adds nothing', async () => {
    const { a, b, h } = await twoServers();
    a.setItems('A-plib', [movie('a1', 'Dune', { imdb: 'tt1160419', tmdb: '438631' })]);
    b.setItems('B-plib', [movie('b1', 'Dune', { imdb: 'tt1160419', tmdb: '999' })]);
    await sync(h);
    expect(await count('media_items')).toBe(2);
    const conflict = await one<{
      reason: string;
      status: string;
      details: string;
      source_id: string;
    }>('SELECT * FROM match_conflicts');
    expect(conflict).toMatchObject({ reason: 'conflicting_ids', status: 'open' });
    expect(JSON.parse(conflict!.details).candidates[0]).toMatchObject({
      sharedIds: ['imdb:tt1160419'],
      conflictingIds: ['tmdb:999!=438631'],
    });
    expect(
      (
        await one<{ server_id: string }>(
          'SELECT server_id FROM sources WHERE id = ?',
          conflict?.source_id,
        )
      )?.server_id,
    ).toBe('B');
    await syncOnce(h, 'B');
    expect(await count('match_conflicts')).toBe(1);
    expect(await count('media_items')).toBe(2);
  });

  it('IDs that match two items raise multiple_candidates', async () => {
    const { a, b, h } = await twoServers();
    a.setItems('A-plib', [movie('a1', 'X', { imdb: 'tt1' }), movie('a2', 'X', { tmdb: '2' })]);
    b.setItems('B-plib', [movie('b1', 'X', { imdb: 'tt1', tmdb: '2' })]);
    await sync(h);
    expect(await count('media_items')).toBe(3);
    expect((await one<{ reason: string }>('SELECT reason FROM match_conflicts'))?.reason).toBe(
      'multiple_candidates',
    );
  });

  it('a source that gains an ID in a later sync is re-evaluated and attaches', async () => {
    const { a, b, h } = await twoServers();
    a.setItems('A-plib', [movie('a1', 'Alien', { tmdb: '348' })]);
    b.setItems('B-plib', [movie('b1', 'Alien')]);
    await sync(h);
    expect(await count('media_items')).toBe(2);
    b.setItems('B-plib', [movie('b1', 'Alien', { tmdb: '348' })]);
    await syncOnce(h, 'B');
    expect(await count('media_items')).toBe(1);
    expect(await count('sources')).toBe(2);
    expect(await count('search_fts', "kind = 'title'")).toBe(1);
  });

  it('a pin override wins over automatic matching and survives a re-sync (BR-3)', async () => {
    const { a, b, h } = await twoServers();
    a.setItems('A-plib', [movie('a1', 'Alien', { tmdb: '348' })]);
    b.setItems('B-plib', [movie('b1', 'Aliens', { tmdb: '679' })]);
    await sync(h);
    const target = (await one<{ id: string }>(
      "SELECT media_item_id AS id FROM sources WHERE provider_item_id = 'a1'",
    ))!.id;
    await h.deps.db
      .prepare(
        "INSERT INTO curation_overrides (id, kind, entity_kind, media_item_id, server_id, provider_item_id, created_at) VALUES ('o1','pin','item',?,?,?,1)",
      )
      .bind(target, 'B', 'b1')
      .run();
    await syncOnce(h, 'B');
    b.setItems('B-plib', [movie('b1', 'Aliens', { tmdb: '679', overview: 'changed' })]);
    await syncOnce(h, 'B');
    expect(await count('media_items')).toBe(1);
    expect(await one("SELECT match_method FROM sources WHERE provider_item_id = 'b1'")).toEqual({
      match_method: 'manual',
    });
    // A pinned source does not poison the item's IDs.
    expect(
      (await rows<{ value: string }>('SELECT value FROM external_ids')).map((r) => r.value),
    ).toEqual(['348']);
  });

  it('a separate override keeps a source apart even when IDs match', async () => {
    const { a, b, h } = await twoServers();
    a.setItems('A-plib', [movie('a1', 'Alien', { tmdb: '348' })]);
    b.setItems('B-plib', [movie('b1', 'Alien', { tmdb: '348' })]);
    await syncOnce(h, 'A');
    await h.deps.db
      .prepare(
        "INSERT INTO curation_overrides (id, kind, entity_kind, server_id, provider_item_id, media_item_id, created_at) VALUES ('o1','separate','item','B','b1',(SELECT id FROM media_items),1)",
      )
      .run();
    await syncOnce(h, 'B');
    expect(await count('media_items')).toBe(2);
  });
});

describe('T2.3: episode alignment (BR-2)', () => {
  const show = (p: string, tvdb?: string) => [
    series(`${p}-s`, 'Dragnet', tvdb ? { tvdb } : {}),
    season(`${p}-s1`, `${p}-s`, 1),
    episode(`${p}-e1`, `${p}-s1`, 1, 1),
    episode(`${p}-e2`, `${p}-s1`, 1, 2),
  ];

  it('episodes align by merged series, season and episode number', async () => {
    const { a, b, h } = await twoServers();
    a.setItems('A-plib', show('a', '70843'));
    b.setItems('B-plib', [...show('b', '70843'), episode('b-e3', 'b-s1', 1, 3)]);
    await sync(h);
    expect(await count('media_items', "type = 'series'")).toBe(1);
    expect(await count('media_items', "type = 'season'")).toBe(1);
    expect(await count('media_items', "type = 'episode'")).toBe(3);
    const merged = await rows<{ n: number }>(
      "SELECT COUNT(*) AS n FROM sources WHERE item_type = 'episode' GROUP BY media_item_id ORDER BY n",
    );
    expect(merged.map((r) => r.n)).toEqual([1, 2, 2]);
    expect(await one("SELECT match_method FROM sources WHERE provider_item_id = 'b-e1'")).toEqual({
      match_method: 'episode_position',
    });
    // Parents link to the merged series; best_height comes from the episode versions.
    expect(await count('media_items', "type = 'episode' AND parent_id IS NOT NULL")).toBe(3);
    expect(await count('media_items', 'best_height = 720')).toBe(3);
  });

  it('series without strong IDs stay separate, and so do their episodes', async () => {
    const { a, b, h } = await twoServers();
    a.setItems('A-plib', show('a'));
    b.setItems('B-plib', show('b'));
    await sync(h);
    expect(await count('media_items', "type = 'series'")).toBe(2);
    expect(await count('media_items', "type = 'episode'")).toBe(4);
  });

  it('children listed before their parents are adopted at the end of the library pass', async () => {
    const { a, b, h } = await twoServers();
    a.setItems('A-plib', show('a', '70843'));
    b.setItems('B-plib', [...show('b', '70843')].reverse());
    await sync(h);
    expect(await count('media_items', "type = 'series'")).toBe(1);
    expect(await count('media_items', "type = 'season'")).toBe(1);
    expect(await count('media_items', "type = 'episode'")).toBe(2);
    expect(await count('media_items', "type <> 'series' AND parent_id IS NULL")).toBe(0);
    expect(await count('sources', 'media_item_id IN (SELECT id FROM media_items)')).toBe(8);
  });

  it('a series that gains an ID later moves its seasons and episodes with it', async () => {
    const { a, b, h } = await twoServers();
    a.setItems('A-plib', show('a', '70843'));
    b.setItems('B-plib', show('b'));
    await sync(h);
    expect(await count('media_items', "type = 'series'")).toBe(2);
    b.setItems('B-plib', show('b', '70843'));
    await syncOnce(h, 'B');
    expect(await count('media_items', "type = 'series'")).toBe(1);
    expect(await count('media_items', "type = 'season'")).toBe(1);
    expect(await count('media_items', "type = 'episode'")).toBe(2);
    expect(await count('media_items', "type <> 'series' AND parent_id IS NULL")).toBe(0);
    expect(await count('sources', "status = 'present'")).toBe(8);
  });
});

describe('T2.9: people (FR-SYNC-008, BR-10, ADR-0015)', () => {
  const cast = (id: string, name: string, tmdb?: string, imdb?: string) => [
    credit(id, name, {
      ...(tmdb ? { tmdb } : {}),
      ...(imdb ? { imdb } : {}),
      character: 'Cooper',
      order: 0,
    }),
    credit('dir', 'Christopher Nolan', { role: 'director', order: 1 }),
  ];

  it('writes credits per source with role, character and billing order', async () => {
    const { a, h } = await twoServers();
    a.setItems('A-plib', [
      movie('a1', 'Interstellar', { tmdb: '1', credits: cast('p1', 'Matthew McConaughey') }),
    ]);
    await syncOnce(h, 'A');
    expect(
      await rows('SELECT role, character, sort_order FROM credits ORDER BY sort_order'),
    ).toEqual([
      { role: 'actor', character: 'Cooper', sort_order: 0 },
      { role: 'director', character: null, sort_order: 1 },
    ]);
    expect(
      await rows("SELECT name, alt_name FROM search_fts WHERE kind = 'person' ORDER BY name"),
    ).toHaveLength(2);
  });

  it('the same TMDB person ID merges across servers, even with different names', async () => {
    const { a, b, h } = await twoServers();
    a.setItems('A-plib', [
      movie('a1', 'M', { tmdb: '1', credits: [credit('pa', 'Chris Evans', { tmdb: '16828' })] }),
    ]);
    b.setItems('B-plib', [
      movie('b1', 'M', {
        tmdb: '1',
        credits: [credit('pb', 'Christopher Evans', { tmdb: '16828' })],
      }),
    ]);
    await sync(h);
    expect(await count('people')).toBe(1);
    expect(await count('person_provider_links')).toBe(2);
    expect(await one("SELECT name, alt_name FROM search_fts WHERE kind = 'person'")).toEqual({
      name: 'Chris Evans',
      alt_name: 'Christopher Evans',
    });
    expect(
      await one("SELECT match_method FROM person_provider_links WHERE server_id = 'B'"),
    ).toEqual({ match_method: 'external_id' });
  });

  it('identical names without conflicting IDs merge', async () => {
    const { a, b, h } = await twoServers();
    a.setItems('A-plib', [
      movie('a1', 'M1', { tmdb: '1', credits: [credit('pa', "Judith O'Dea")] }),
    ]);
    b.setItems('B-plib', [
      movie('b1', 'M2', { tmdb: '2', credits: [credit('pb', 'Judith ODea', { imdb: 'nm1' })] }),
    ]);
    await sync(h);
    expect(await count('people')).toBe(1);
    expect(
      await one("SELECT match_method FROM person_provider_links WHERE server_id = 'B'"),
    ).toEqual({ match_method: 'name' });
    // Credits of both titles belong to the one person.
    expect(await count('credits', 'person_id = (SELECT id FROM people)')).toBe(2);
  });

  it('identical names with different IDs stay separate (two different people)', async () => {
    const { a, b, h } = await twoServers();
    a.setItems('A-plib', [
      movie('a1', 'M1', { tmdb: '1', credits: [credit('pa', 'Chris Evans', { tmdb: '16828' })] }),
    ]);
    b.setItems('B-plib', [
      movie('b1', 'M2', { tmdb: '2', credits: [credit('pb', 'Chris Evans', { tmdb: '99999' })] }),
    ]);
    await sync(h);
    expect(await count('people')).toBe(2);
    expect(await count('match_conflicts')).toBe(0);
  });

  it('a shared ID with a conflicting ID creates a conflict flag and stays separate', async () => {
    const { a, b, h } = await twoServers();
    a.setItems('A-plib', [
      movie('a1', 'M1', {
        tmdb: '1',
        credits: [credit('pa', 'Chris Evans', { tmdb: '16828', imdb: 'nm0262635' })],
      }),
    ]);
    b.setItems('B-plib', [
      movie('b1', 'M2', {
        tmdb: '2',
        credits: [credit('pb', 'Chris Evans', { tmdb: '555', imdb: 'nm0262635' })],
      }),
    ]);
    await sync(h);
    expect(await count('people')).toBe(2);
    const c = await one<{ entity_kind: string; reason: string; person_link_id: string }>(
      'SELECT * FROM match_conflicts',
    );
    expect(c).toMatchObject({ entity_kind: 'person', reason: 'conflicting_ids' });
    expect(
      (
        await one<{ server_id: string }>(
          'SELECT server_id FROM person_provider_links WHERE id = ?',
          c?.person_link_id,
        )
      )?.server_id,
    ).toBe('B');
  });

  it('two origin people with one name on a single server stay distinct', async () => {
    const { a, h } = await twoServers();
    a.setItems('A-plib', [
      movie('a1', 'M', {
        tmdb: '1',
        credits: [credit('p1', 'John Smith'), credit('p2', 'John Smith', { order: 1 })],
      }),
    ]);
    await syncOnce(h, 'A');
    expect(await count('people')).toBe(2);
  });

  it('same name on three servers worth of people: an ambiguous name is flagged and stays separate', async () => {
    const { a, b, h } = await twoServers();
    await seedServer({ id: 'C', priority: 0 });
    const c = new FakeOrigin('C');
    h.origins.set('C', c);
    a.setItems('A-plib', [
      movie('a1', 'M1', { tmdb: '1', credits: [credit('pa', 'Alex Kim', { tmdb: '1' })] }),
    ]);
    b.setItems('B-plib', [
      movie('b1', 'M2', { tmdb: '2', credits: [credit('pb', 'Alex Kim', { tmdb: '2' })] }),
    ]);
    c.setItems('C-plib', [movie('c1', 'M3', { tmdb: '3', credits: [credit('pc', 'Alex Kim')] })]);
    await sync(h);
    await syncOnce(h, 'C');
    expect(await count('people')).toBe(3);
    expect((await one<{ reason: string }>('SELECT reason FROM match_conflicts'))?.reason).toBe(
      'ambiguous_name',
    );
  });

  it('credits follow cast changes; a re-run changes nothing; orphans are purged by retention', async () => {
    const { a, h } = await twoServers();
    a.setItems('A-plib', [
      movie('a1', 'M', { tmdb: '1', credits: cast('p1', 'Matthew McConaughey') }),
    ]);
    await syncOnce(h, 'A');
    expect(await count('credits')).toBe(2);
    a.setItems('A-plib', [
      movie('a1', 'M', { tmdb: '1', credits: [credit('p9', 'Anne Hathaway')] }),
    ]);
    await syncOnce(h, 'A');
    expect(await rows('SELECT p.name FROM credits c JOIN people p ON p.id = c.person_id')).toEqual([
      { name: 'Anne Hathaway' },
    ]);
    const { runRetention } = await import('../../src/sync/retention');
    const r = await runRetention(h.deps);
    expect(r).toMatchObject({ linksPurged: 2, peoplePurged: 2 });
    expect(await count('people')).toBe(1);
    expect(await count('search_fts', "kind = 'person'")).toBe(1);
  });

  it('a link whose IDs change is re-matched and its credits are re-keyed', async () => {
    const { a, b, h } = await twoServers();
    a.setItems('A-plib', [
      movie('a1', 'M', { tmdb: '1', credits: [credit('pa', 'Chris Evans', { tmdb: '16828' })] }),
    ]);
    b.setItems('B-plib', [
      movie('b1', 'N', { tmdb: '2', credits: [credit('pb', 'Chris E.', { tmdb: '1' })] }),
    ]);
    await sync(h);
    expect(await count('people')).toBe(2);
    b.setItems('B-plib', [
      movie('b1', 'N', { tmdb: '2', credits: [credit('pb', 'Chris E.', { tmdb: '16828' })] }),
    ]);
    await syncOnce(h, 'B');
    expect(await count('people')).toBe(1);
    expect(await count('credits', 'person_id = (SELECT id FROM people)')).toBe(2);
  });
});

describe('T2.10: collections (FR-SYNC-008, FR-CAT-012, BR-10)', () => {
  async function withMovies() {
    const s = await twoServers();
    s.a.setItems('A-plib', [
      movie('a1', 'Alien', { tmdb: '348' }),
      movie('a2', 'Aliens', { tmdb: '679' }),
    ]);
    s.b.setItems('B-plib', [
      movie('b1', 'Alien', { tmdb: '348' }),
      movie('b3', 'Alien 3', { tmdb: '8077' }),
    ]);
    return s;
  }

  it('the same TMDB collection ID merges; members are the union over the links', async () => {
    const { a, b, h } = await withMovies();
    a.collections = [collection('ca', 'Alien Collection', ['a1', 'a2'], '8091')];
    b.collections = [collection('cb', 'Alien Anthology', ['b1', 'b3'], '8091')];
    await sync(h);
    expect(await count('collections')).toBe(1);
    expect(await count('collection_provider_links')).toBe(2);
    expect(await one('SELECT name FROM collections')).toEqual({ name: 'Alien Collection' }); // higher priority server
    expect(await one("SELECT name, alt_name FROM search_fts WHERE kind = 'collection'")).toEqual({
      name: 'Alien Collection',
      alt_name: 'Alien Anthology',
    });
    const members = await rows<{ n: number }>(
      'SELECT COUNT(DISTINCT media_item_id) AS n FROM collection_members',
    );
    expect(members[0]?.n).toBe(3); // Alien (both servers, one item), Aliens, Alien 3
    expect(await count('collection_members')).toBe(4);
  });

  it('same-name collections without a TMDB ID do not merge', async () => {
    const { a, b, h } = await withMovies();
    a.collections = [collection('ca', 'Favourites', ['a1'])];
    b.collections = [collection('cb', 'Favourites', ['b1'])];
    await sync(h);
    expect(await count('collections')).toBe(2);
    expect(
      await one("SELECT match_method FROM collection_provider_links WHERE server_id = 'B'"),
    ).toEqual({ match_method: 'new' });
  });

  it('members the origin lists but Cinewren has not synced are ignored; a re-run changes nothing', async () => {
    const { a, h } = await withMovies();
    a.collections = [collection('ca', 'Alien Collection', ['a1', 'not-synced'], '8091')];
    await syncOnce(h, 'A');
    expect(await count('collection_members')).toBe(1);
    const before = await rows('SELECT * FROM collections');
    await syncOnce(h, 'A');
    expect(await rows('SELECT * FROM collections')).toEqual(before);
    expect(await count('collection_members')).toBe(1);
  });

  it('membership changes are applied, and a collection the origin drops is removed on a full pass', async () => {
    const { a, h } = await withMovies();
    a.collections = [collection('ca', 'Alien Collection', ['a1'], '8091')];
    await syncOnce(h, 'A');
    a.collections = [collection('ca', 'Alien Collection', ['a1', 'a2'], '8091')];
    await syncOnce(h, 'A');
    expect(await count('collection_members')).toBe(2);
    a.collections = [];
    await syncOnce(h, 'A');
    expect(await count('collections')).toBe(0);
    expect(await count('collection_provider_links')).toBe(0);
    expect(await count('search_fts', "kind = 'collection'")).toBe(0);
  });

  it('when one of two merged links is dropped the collection keeps the other', async () => {
    const { a, b, h } = await withMovies();
    a.collections = [collection('ca', 'Alien Collection', ['a1'], '8091')];
    b.collections = [collection('cb', 'Alien Anthology', ['b1'], '8091')];
    await sync(h);
    a.collections = [];
    await syncOnce(h, 'A');
    expect(await one('SELECT name FROM collections')).toEqual({ name: 'Alien Anthology' });
    expect(await one("SELECT name, alt_name FROM search_fts WHERE kind = 'collection'")).toEqual({
      name: 'Alien Anthology',
      alt_name: '',
    });
  });

  it('an incremental run re-lists collections without dropping any', async () => {
    const { a, h } = await withMovies();
    a.collections = [collection('ca', 'Alien Collection', ['a1'], '8091')];
    await syncOnce(h, 'A');
    h.clock.now += 61 * 60_000;
    await syncOnce(h, 'A', 'incremental');
    expect(await count('collections')).toBe(1);
  });

  it('a collection listing failure marks the run partial without touching the catalog', async () => {
    const { a, h } = await withMovies();
    a.collectionErrors = [new ProviderError('PROTOCOL', 'bad payload', false)];
    const r = await syncOnce(h, 'A');
    expect(r.status).toBe('partial');
    expect(await count('sources')).toBe(2);
  });
});

describe('item_availability stays current for the BR-1 predicate', () => {
  it('follows source upsert, missing, restore, merge and purge', async () => {
    const { a, b, h } = await twoServers();
    a.setItems('A-plib', [movie('a1', 'Alien', { tmdb: '348' })]);
    b.setItems('B-plib', [movie('b1', 'Alien', { tmdb: '348' })]);
    await syncOnce(h, 'A');
    expect(await rows('SELECT library_id FROM item_availability')).toEqual([
      { library_id: 'A-lib' },
    ]);
    await syncOnce(h, 'B');
    expect(
      (
        await rows<{ library_id: string }>(
          'SELECT library_id FROM item_availability ORDER BY library_id',
        )
      ).map((r) => r.library_id),
    ).toEqual(['A-lib', 'B-lib']);
    a.setItems('A-plib', []);
    await syncOnce(h, 'A');
    expect(await rows('SELECT library_id FROM item_availability')).toEqual([
      { library_id: 'B-lib' },
    ]);
    a.setItems('A-plib', [movie('a1', 'Alien', { tmdb: '348' })]);
    await syncOnce(h, 'A');
    expect(await count('item_availability')).toBe(2);
    // A pin moves a source to another item: availability follows it.
    b.setItems('B-plib', [
      movie('b1', 'Alien', { tmdb: '348' }),
      movie('b2', 'Other', { tmdb: '1' }),
    ]);
    await syncOnce(h, 'B');
    expect(await count('item_availability')).toBe(3);
  });
});
