/* eslint-disable @typescript-eslint/no-non-null-assertion -- test fixtures: the rows asserted on were just written */
// T5.2: operator curation through the real app and local D1, with sync driven by the fake origin
// harness: merge and split for titles, people and collections, overrides that survive a full
// re-sync (BR-3), the match-conflict list and its resolutions (FR-CAT-010), BR-1 after a merge,
// and one audit row per mutation (FR-OPS-005).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ConflictsPage,
  CurationEntity,
  ItemDetail,
  Page,
  PersonDetail,
  ResolveConflictResult,
} from '@cinewren/shared';
import { createApp } from '../../src/api/app';
import { call, errorCode, json, resetDb, setupOperator, type CallOptions } from '../auth-harness';
import { seedUser } from '../catalog-seed';
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

const app = createApp();
let cookie = '';
const api = (method: string, path: string, opts: CallOptions = {}) =>
  call(method, `/api/v1${path}`, { cookie, app, ...opts });
const post = (path: string, body: unknown) => api('POST', path, { body });

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  await resetDb();
  await resetCatalog();
  cookie = (await setupOperator()).cookie;
});

async function twoServers() {
  await seedServer({ id: 'A', priority: 2 });
  await seedServer({ id: 'B', priority: 1 });
  const a = new FakeOrigin('A');
  const b = new FakeOrigin('B');
  const h = makeHarness({ origins: [a, b] });
  const both = async (type: 'full' | 'incremental' = 'full') => {
    await syncOnce(h, 'A', type);
    await syncOnce(h, 'B', type);
  };
  return { a, b, h, both };
}

const itemIds = async (type = 'movie') =>
  (await rows<{ id: string }>('SELECT id FROM media_items WHERE type = ? ORDER BY id', type)).map(
    (r) => r.id,
  );
const sourceItem = async (provider: string) =>
  (await one<{ media_item_id: string }>(
    'SELECT media_item_id FROM sources WHERE provider_item_id = ?',
    provider,
  ))!.media_item_id;
const audit = async () =>
  (await rows<{ action: string }>('SELECT action FROM audit_log ORDER BY at, rowid')).map(
    (r) => r.action,
  );
const curationAudit = async () => (await audit()).filter((a) => a.startsWith('curation.'));
const titleFts = () => count('search_fts', "kind = 'title'");

describe('merge and split of titles (FR-CAT-007, BR-3)', () => {
  it('merges two titles, updates availability and search, and survives a full re-sync', async () => {
    const { a, b, both } = await twoServers();
    // No shared ID, so automatic matching keeps them apart (BR-2).
    a.setItems('A-plib', [movie('a1', 'Nosferatu', { year: 1922 })]);
    b.setItems('B-plib', [movie('b1', 'Nosferatu, eine Symphonie des Grauens', { year: 1922 })]);
    await both();
    expect(await itemIds()).toHaveLength(2);
    expect(await titleFts()).toBe(2);
    const [intoId, fromId] = [await sourceItem('a1'), await sourceItem('b1')];

    const res = await post('/admin/curation/merge', { intoId, fromId });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ id: intoId });
    expect(await itemIds()).toEqual([intoId]);
    expect(await count('sources', 'media_item_id = ?', intoId)).toBe(2);
    expect(
      (await rows<{ library_id: string }>('SELECT library_id FROM item_availability')).map(
        (r) => r.library_id,
      ),
    ).toEqual(['A-lib', 'B-lib']);
    expect(await titleFts()).toBe(1);
    expect((await one<{ title: string }>('SELECT title FROM media_items'))?.title).toBe(
      'Nosferatu', // the higher-priority server's metadata
    );
    expect(await count('curation_overrides', "kind = 'pin'")).toBe(1);
    expect(await curationAudit()).toEqual(['curation.merge']);

    // BR-3: a full re-sync of both servers, even with changed metadata, keeps the merge.
    a.setItems('A-plib', [movie('a1', 'Nosferatu (1922)', { year: 1922 })]);
    await both('full');
    await both('full');
    expect(await itemIds()).toEqual([intoId]);
    expect(await count('sources', 'media_item_id = ?', intoId)).toBe(2);
    expect(await count('match_conflicts')).toBe(0);
    expect(await titleFts()).toBe(1);
  });

  it('rejects a merge of different types and of an item into itself, and writes no audit row', async () => {
    const { a, b, both } = await twoServers();
    a.setItems('A-plib', [movie('a1', 'Heat')]);
    b.setItems('B-plib', [series('b1', 'Heat TV')]);
    await both();
    const m = await sourceItem('a1');
    const s = await sourceItem('b1');
    const mismatch = await post('/admin/curation/merge', { intoId: m, fromId: s });
    expect(mismatch.status).toBe(409);
    expect(await errorCode(mismatch)).toBe('TYPE_MISMATCH');
    expect((await post('/admin/curation/merge', { intoId: m, fromId: m })).status).toBe(400);
    expect((await post('/admin/curation/merge', { intoId: m, fromId: 'nope' })).status).toBe(404);
    expect(await curationAudit()).toEqual([]);
    expect(await count('media_items')).toBe(2);
  });

  it('splits a source out of an automatic merge; the split survives a full re-sync', async () => {
    const { a, b, both } = await twoServers();
    a.setItems('A-plib', [movie('a1', 'Alien', { tmdb: '348' })]);
    b.setItems('B-plib', [movie('b1', 'Alien', { tmdb: '348' })]);
    await both();
    const merged = await sourceItem('a1');
    expect(await sourceItem('b1')).toBe(merged);
    const bSource = (await one<{ id: string }>(
      "SELECT id FROM sources WHERE provider_item_id = 'b1'",
    ))!;

    const res = await post('/admin/curation/split', {
      id: merged,
      sourceId: bSource.id,
    });
    expect(res.status).toBe(200);
    const { newId } = await json<{ newId: string }>(res);
    expect(await itemIds()).toHaveLength(2);
    expect(await sourceItem('b1')).toBe(newId);
    expect(await sourceItem('a1')).toBe(merged);
    expect(
      await rows('SELECT media_item_id, library_id FROM item_availability ORDER BY library_id'),
    ).toEqual([
      { media_item_id: merged, library_id: 'A-lib' },
      { media_item_id: newId, library_id: 'B-lib' },
    ]);
    expect(await titleFts()).toBe(2);
    expect(await count('curation_overrides', "kind = 'separate'")).toBe(1);
    expect(await curationAudit()).toEqual(['curation.split']);

    await both('full');
    await both('full');
    expect(await itemIds()).toHaveLength(2);
    expect(await sourceItem('b1')).toBe(newId);
    expect(await count('match_conflicts')).toBe(0);

    // The only source of an item cannot be split (LAST_SOURCE).
    const lone = await post('/admin/curation/split', { id: newId, sourceId: bSource.id });
    expect(lone.status).toBe(409);
    expect(await errorCode(lone)).toBe('LAST_SOURCE');
    expect(await curationAudit()).toEqual(['curation.split']);
  });

  it('merges two series with their seasons and episodes, and splits one back out', async () => {
    const { a, b, both } = await twoServers();
    const tree = (p: string, title: string) => [
      series(`${p}s`, title, { year: 1951 }),
      season(`${p}s1`, `${p}s`, 1),
      episode(`${p}e1`, `${p}s1`, 1, 1),
      episode(`${p}e2`, `${p}s1`, 1, 2),
    ];
    a.setItems('A-plib', tree('a', 'I Love Lucy'));
    b.setItems('B-plib', [...tree('b', 'I Love Lucy (1951)'), episode('be3', 'bs1', 1, 3)]);
    await both();
    expect(await itemIds('series')).toHaveLength(2);
    const [intoId, fromId] = [await sourceItem('as'), await sourceItem('bs')];

    expect((await post('/admin/curation/merge', { intoId, fromId })).status).toBe(200);
    expect(await itemIds('series')).toEqual([intoId]);
    expect(await itemIds('season')).toHaveLength(1);
    expect(await itemIds('episode')).toHaveLength(3); // e1 and e2 merged, e3 moved across
    expect(await count('sources', 'media_item_id = ?', await sourceItem('ae1'))).toBe(2);
    expect(await sourceItem('bs1')).toBe(await sourceItem('as1'));
    expect(await count('media_items', 'parent_id = ?', await sourceItem('as1'))).toBe(3);

    await both('full');
    expect(await itemIds('series')).toEqual([intoId]);
    expect(await itemIds('episode')).toHaveLength(3);

    const bSeries = (await one<{ id: string }>(
      "SELECT id FROM sources WHERE provider_item_id = 'bs'",
    ))!;
    const split = await post('/admin/curation/split', { id: intoId, sourceId: bSeries.id });
    expect(split.status).toBe(200);
    const { newId } = await json<{ newId: string }>(split);
    expect(await itemIds('series')).toHaveLength(2);
    expect(await sourceItem('bs')).toBe(newId);
    expect(await sourceItem('bs1')).not.toBe(await sourceItem('as1'));
    expect(
      await one('SELECT parent_id FROM media_items WHERE id = ?', await sourceItem('be3')),
    ).toEqual({ parent_id: await sourceItem('bs1') });
    await both('full');
    expect(await itemIds('series')).toHaveLength(2);
    expect(await itemIds('episode')).toHaveLength(5); // 2 shared on A, 3 of B's own after the split
    expect(await curationAudit()).toEqual(['curation.merge', 'curation.split']);
  });

  it('keeps a title the operator merged by hand merged when automatic matching would have split it', async () => {
    const { a, b, both } = await twoServers();
    a.setItems('A-plib', [movie('a1', 'Heat', { tmdb: '949' })]);
    b.setItems('B-plib', [movie('b1', 'Heat', { tmdb: '950' })]); // a different ID: separate
    await both();
    expect(await itemIds()).toHaveLength(2);
    expect(
      (
        await post('/admin/curation/merge', {
          intoItemId: await sourceItem('a1'),
          fromItemId: await sourceItem('b1'),
        })
      ).status,
    ).toBe(200); // the documented aliases
    await both('full');
    expect(await itemIds()).toHaveLength(1);
    expect(await count('match_conflicts', "status = 'open'")).toBe(0);
  });
});

describe('match conflicts (FR-CAT-010)', () => {
  async function flagged() {
    const { a, b, h, both } = await twoServers();
    a.setItems('A-plib', [movie('a1', 'Blade Runner', { tmdb: '78', imdb: 'tt0083658' })]);
    b.setItems('B-plib', [movie('b1', 'Blade Runner (cut)', { tmdb: '78', imdb: 'tt9999999' })]);
    await both();
    return { a, b, h, both };
  }
  const open = async () => json<ConflictsPage>(await api('GET', '/admin/curation/conflicts'));

  it('lists a flagged source with its candidate, and "merge" resolves it and clears the flag', async () => {
    await flagged();
    const list = await open();
    expect(list.items).toHaveLength(1);
    const c = list.items[0]!;
    expect(c).toMatchObject({
      entityKind: 'item',
      reason: 'conflicting_ids',
      status: 'open',
      source: { title: 'Blade Runner (cut)', serverName: 'Server B' },
    });
    expect(c.candidates).toHaveLength(1);
    expect(c.candidates[0]).toMatchObject({ title: 'Blade Runner', externalIds: { tmdb: ['78'] } });
    expect(c.candidates[0]!.conflictingIds[0]).toContain('imdb');

    const bad = await post(`/admin/curation/conflicts/${c.id}/resolve`, {
      action: 'merge',
      intoId: 'not-a-candidate',
    });
    expect(bad.status).toBe(400);

    const res = await post(`/admin/curation/conflicts/${c.id}/resolve`, {
      action: 'merge',
      intoId: c.candidates[0]!.id,
    });
    expect(res.status).toBe(200);
    expect(await json<ResolveConflictResult>(res)).toEqual({
      id: c.candidates[0]!.id,
      itemId: c.candidates[0]!.id,
    });
    expect((await open()).items).toEqual([]); // a resolved conflict leaves the list
    const resolved = await json<ConflictsPage>(
      await api('GET', '/admin/curation/conflicts?status=resolved'),
    );
    expect(resolved.items.map((r) => r.id)).toEqual([c.id]);
    expect(await itemIds()).toHaveLength(1);
    expect(await curationAudit()).toEqual(['curation.conflict.resolve']);

    // Resolving again is stale.
    const again = await post(`/admin/curation/conflicts/${c.id}/resolve`, {
      action: 'dismiss',
    });
    expect(again.status).toBe(404);
  });

  it('"keep separate" leaves the flag cleared and a full re-sync never re-flags or merges them', async () => {
    const { both } = await flagged();
    const c = (await open()).items[0]!;
    expect(
      (await post(`/admin/curation/conflicts/${c.id}/resolve`, { action: 'keep_separate' })).status,
    ).toBe(200);
    expect((await open()).items).toEqual([]);
    expect(await count('curation_overrides', "kind = 'separate'")).toBe(1);
    await both('full');
    await both('full');
    expect(await itemIds()).toHaveLength(2);
    expect((await open()).items).toEqual([]);
    expect(await curationAudit()).toEqual(['curation.conflict.resolve']);
  });

  it('"dismiss" hides the flag without an override, and identical details do not re-flag it', async () => {
    const { both } = await flagged();
    const c = (await open()).items[0]!;
    expect(
      (await post(`/admin/curation/conflicts/${c.id}/resolve`, { action: 'dismiss' })).status,
    ).toBe(200);
    expect(await count('curation_overrides')).toBe(0);
    await both('full');
    expect((await open()).items).toEqual([]);
    const dismissed = await json<ConflictsPage>(
      await api('GET', '/admin/curation/conflicts?status=dismissed'),
    );
    expect(dismissed.items).toHaveLength(1);
    expect(await itemIds()).toHaveLength(2);
  });

  it('lists people and collections under their own kind, and pages with a sealed cursor', async () => {
    const { a, b, both } = await twoServers();
    // Two "Chris Evans" on A, one on B: B's link is an ambiguous name.
    a.setItems('A-plib', [
      movie('a1', 'One', { tmdb: '1', credits: [credit('pa', 'Chris Evans', { tmdb: '16828' })] }),
      movie('a2', 'Two', { tmdb: '2', credits: [credit('pb', 'Chris Evans', { tmdb: '999' })] }),
    ]);
    b.setItems('B-plib', [
      movie('b1', 'One', { tmdb: '1', credits: [credit('qa', 'Chris Evans')] }),
    ]);
    await both();
    const people = await json<ConflictsPage>(
      await api('GET', '/admin/curation/conflicts?entityKind=person'),
    );
    expect(people.items).toHaveLength(1);
    expect(people.items[0]).toMatchObject({ reason: 'ambiguous_name', entityKind: 'person' });
    expect(people.items[0]!.candidates).toHaveLength(2);
    expect((await open()).items).toHaveLength(1); // the same list without the filter
    const items = await json<ConflictsPage>(
      await api('GET', '/admin/curation/conflicts?entityKind=item'),
    );
    expect(items.items).toEqual([]);
    expect((await api('GET', '/admin/curation/conflicts?status=bogus')).status).toBe(400);
    expect((await api('GET', '/admin/curation/conflicts?cursor=forged')).status).toBe(400);

    // Resolve by merging the flagged person into one candidate: one person fewer, flag gone.
    const c = people.items[0]!;
    const before = await count('people');
    expect(
      (
        await post(`/admin/curation/conflicts/${c.id}/resolve`, {
          action: 'merge',
          intoId: c.candidates[0]!.id,
        })
      ).status,
    ).toBe(200);
    expect(await count('people')).toBe(before - 1);
    expect((await open()).items).toEqual([]);
  });
});

describe('people and collections (BR-10, FR-CAT-007)', () => {
  it('merges two people and splits a link back out; both survive a full re-sync', async () => {
    const { a, b, both } = await twoServers();
    a.setItems('A-plib', [
      movie('a1', 'Heat', { tmdb: '949', credits: [credit('pa', 'Cary Grant')] }),
    ]);
    b.setItems('B-plib', [
      movie('b1', 'Heat', { tmdb: '949', credits: [credit('pb', 'Archibald Leach')] }),
    ]);
    await both();
    expect(await count('people')).toBe(2);
    const intoId = (await one<{ person_id: string }>(
      "SELECT person_id FROM person_provider_links WHERE provider_person_id = 'pa'",
    ))!.person_id;
    const fromId = (await one<{ person_id: string }>(
      "SELECT person_id FROM person_provider_links WHERE provider_person_id = 'pb'",
    ))!.person_id;

    const res = await post('/admin/curation/merge', { entityKind: 'person', intoId, fromId });
    expect(res.status).toBe(200);
    expect(await count('people')).toBe(1);
    expect(await count('credits', 'person_id = ?', intoId)).toBe(2);
    expect(await count('search_fts', "kind = 'person'")).toBe(1);
    expect(
      (await one<{ alt_name: string }>("SELECT alt_name FROM search_fts WHERE kind = 'person'"))
        ?.alt_name,
    ).toBe('Archibald Leach');
    await both('full');
    expect(await count('people')).toBe(1);

    const entity = await json<CurationEntity>(
      await api('GET', `/admin/curation/entities/person/${intoId}`),
    );
    expect(entity.records.map((r) => r.name).sort()).toEqual(['Archibald Leach', 'Cary Grant']);
    const link = entity.records.find((r) => r.name === 'Archibald Leach')!;
    const split = await post('/admin/curation/split', {
      entityKind: 'person',
      id: intoId,
      linkId: link.id,
    });
    expect(split.status).toBe(200);
    expect(await count('people')).toBe(2);
    expect(await count('search_fts', "kind = 'person'")).toBe(2);
    await both('full');
    expect(await count('people')).toBe(2);
    const lone = await post('/admin/curation/split', {
      entityKind: 'person',
      id: (await json<{ newId: string }>(split)).newId,
      linkId: link.id,
    });
    expect(await errorCode(lone)).toBe('LAST_SOURCE');
    expect(await curationAudit()).toEqual(['curation.merge', 'curation.split']);
  });

  it('merges two same-name collections that carry no TMDB ID, and splits one link out again', async () => {
    const { a, b, both } = await twoServers();
    a.setItems('A-plib', [movie('a1', 'Heat', { tmdb: '949' })]);
    b.setItems('B-plib', [movie('b1', 'Ronin', { tmdb: '8' })]);
    a.collections = [collection('ca', 'Favourites', ['a1'])];
    b.collections = [collection('cb', 'Favourites', ['b1'])];
    await both();
    expect(await count('collections')).toBe(2);
    const ids = (
      await rows<{ collection_id: string }>(
        'SELECT collection_id FROM collection_provider_links ORDER BY provider_collection_id',
      )
    ).map((r) => r.collection_id);
    const res = await post('/admin/curation/merge', {
      entityKind: 'collection',
      intoId: ids[0],
      fromId: ids[1],
    });
    expect(res.status).toBe(200);
    expect(await count('collections')).toBe(1);
    expect(await count('collection_members')).toBe(2);
    await both('full');
    expect(await count('collections')).toBe(1);

    const entity = await json<CurationEntity>(
      await api('GET', `/admin/curation/entities/collection/${ids[0]}`),
    );
    expect(entity.records).toHaveLength(2);
    const split = await post('/admin/curation/split', {
      entityKind: 'collection',
      id: ids[0],
      linkId: entity.records[1]!.id,
    });
    expect(split.status).toBe(200);
    await both('full');
    expect(await count('collections')).toBe(2);
    expect(await count('search_fts', "kind = 'collection'")).toBe(2);
    expect(await curationAudit()).toEqual(['curation.merge', 'curation.split']);
  });

  it('lists overrides and deletes one, with one audit row each', async () => {
    const { a, b, both } = await twoServers();
    a.setItems('A-plib', [movie('a1', 'Nosferatu')]);
    b.setItems('B-plib', [movie('b1', 'Nosferatu 1922')]);
    await both();
    await post('/admin/curation/merge', {
      intoId: await sourceItem('a1'),
      fromId: await sourceItem('b1'),
    });
    const list = await json<Page<{ id: string; kind: string; providerId: string }>>(
      await api('GET', '/admin/curation/overrides'),
    );
    expect(list.items).toMatchObject([{ kind: 'pin', providerId: 'b1' }]);
    expect((await api('DELETE', `/admin/curation/overrides/${list.items[0]!.id}`)).status).toBe(
      204,
    );
    expect((await api('DELETE', `/admin/curation/overrides/${list.items[0]!.id}`)).status).toBe(
      404,
    );
    expect(await count('curation_overrides')).toBe(0);
    expect(await curationAudit()).toEqual(['curation.merge', 'curation.override.delete']);
  });
});

describe('BR-1 after a merge, and the operator guard', () => {
  it('never exposes a hidden source, its copies, its cast or its collections through a merged title', async () => {
    const { a, b, both } = await twoServers();
    a.setItems('A-plib', [
      movie('a1', 'Nosferatu', {
        year: 1922,
        credits: [credit('pa', 'Max Schreck')],
      }),
    ]);
    b.setItems('B-plib', [
      movie('b1', 'Nosferatu (1922)', {
        year: 1922,
        credits: [credit('pb', 'Gustav von Wangenheim')],
      }),
    ]);
    a.collections = [collection('ca', 'Silent Horror', ['a1'])];
    await both();
    const intoId = await sourceItem('a1');
    expect(
      (await post('/admin/curation/merge', { intoId, fromId: await sourceItem('b1') })).status,
    ).toBe(200);

    // The viewer may see library B only.
    const viewer = await seedUser('v1', 'viewer', ['B-lib']);
    const get = (path: string) => call('GET', `/api/v1${path}`, { cookie: viewer.cookie, app });
    const detail = await json<ItemDetail & { copies: { sourceId: string; serverName: string }[] }>(
      await get(`/items/${intoId}`),
    );
    expect(detail.serverCount).toBe(1);
    expect(detail.copies.map((c) => c.serverName)).toEqual(['Server B']);
    expect(detail.cast.map((m) => m.person.name)).toEqual(['Gustav von Wangenheim']);
    expect(detail.collections).toEqual([]);
    const hiddenPerson = (await one<{ person_id: string }>(
      "SELECT person_id FROM person_provider_links WHERE provider_person_id = 'pa'",
    ))!.person_id;
    expect((await get(`/people/${hiddenPerson}`)).status).toBe(404);
    const collectionId = (await one<{ id: string }>('SELECT id FROM collections'))!.id;
    expect((await get(`/collections/${collectionId}`)).status).toBe(404);
    expect(JSON.stringify(detail)).not.toMatch(/Schreck|Server A/);
    expect(
      (
        await json<PersonDetail>(
          await call('GET', `/api/v1/people/${hiddenPerson}`, { cookie, app }),
        )
      ).credits.items,
    ).toHaveLength(1); // the operator still sees it
  });

  it('is operator-only, and a viewer cannot read or change anything', async () => {
    const viewer = await seedUser('v2', 'viewer', []);
    for (const [method, path, body] of [
      ['GET', '/admin/curation/conflicts', undefined],
      ['GET', '/admin/curation/overrides', undefined],
      ['POST', '/admin/curation/merge', { intoId: 'a', fromId: 'b' }],
      ['POST', '/admin/curation/split', { id: 'a', sourceId: 'b' }],
      ['POST', '/admin/curation/conflicts/x/resolve', { action: 'dismiss' }],
    ] as const) {
      const res = await call(method, `/api/v1${path}`, {
        cookie: viewer.cookie,
        app,
        ...(body ? { body } : {}),
      });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    expect((await call('GET', '/api/v1/admin/curation/conflicts', { app })).status).toBe(401);
    expect(await curationAudit()).toEqual([]);
  });
});
