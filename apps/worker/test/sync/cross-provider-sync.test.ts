/* eslint-disable @typescript-eslint/no-non-null-assertion -- test fixtures: the rows asserted on were just written */
// T4.3 (FR-CAT-001, BR-2, BR-10): one title present on a Jellyfin, an Emby and a Plex server goes
// through the real adapters (over the recorded exchanges, no network) and the real sync pipeline,
// and comes out as ONE canonical item with three sources and one merged person. The same title
// carries a TMDB ID on all three; the people are matched by exact normalized name because the
// origins give no person IDs (Jellyfin and Plex) or only local ones (BR-10).
import { beforeEach, describe, expect, it } from 'vitest';
import { getProvider, buildProviderContext } from '../../src/providers/registry';
import { decidePerson, type PersonCandidate } from '../../src/match/people';
import type { ServerSecret } from '../../src/providers/types';
import * as emby from '../providers/emby-routes';
import {
  createFakeOrigin,
  loadFixture,
  type Fixture,
  type Route,
} from '../providers/fixture-fetch';
import * as jf from '../providers/jellyfin-routes';
import * as plex from '../providers/plex-routes';
import {
  FakeOrigin,
  count,
  credit,
  makeHarness,
  movie,
  one,
  resetCatalog,
  rows,
  seedServer,
  syncOnce,
} from './harness';

beforeEach(resetCatalog);

/** The recorded listing predates `People`; copy the credits from the recorded People response. */
const withRecordedPeople =
  (provider: 'jellyfin' | 'emby') =>
  (f: Fixture): Fixture => {
    const people = new Map(
      (
        loadFixture(provider, 'items_page_with_people_field.json').response.body as {
          Items: { Name: string; People: unknown }[];
        }
      ).Items.map((i) => [i.Name, i.People]),
    );
    for (const item of (f.response.body as { Items: { Name: string; People?: unknown }[] }).Items) {
      const p = people.get(item.Name);
      if (p) item.People = p;
    }
    return f;
  };

const noShowCollections: Route = {
  method: 'GET',
  url: `/library/sections/${plex.SHOWS}/collections?includeGuids=1`,
  status: 200,
  body: { MediaContainer: { size: 0 } },
};

const SERVERS = [
  {
    id: 'JF',
    type: 'jellyfin',
    priority: 3,
    library: jf.MOVIES,
    base: jf.BASE,
    secret: { kind: 'password', username: 'cinewren-svc', password: 'pw-123456' } as ServerSecret,
    routes: [
      jf.auth,
      { ...jf.page0, mutate: withRecordedPeople('jellyfin') },
      { ...jf.page2, mutate: withRecordedPeople('jellyfin') },
      { fixture: 'boxsets.json', ignoreParams: jf.PAGING },
      { fixture: 'boxset_members.json', ignoreParams: jf.PAGING },
    ] as Route[],
  },
  {
    id: 'EM',
    type: 'emby',
    priority: 2,
    library: emby.MOVIES,
    base: emby.BASE,
    secret: { kind: 'password', username: 'cinewren-svc', password: 'pw-123456' } as ServerSecret,
    routes: [
      emby.auth,
      { ...emby.page0, mutate: withRecordedPeople('emby') },
      { ...emby.page2, mutate: withRecordedPeople('emby') },
      emby.boxsets,
      emby.boxsetMembers,
    ] as Route[],
  },
  {
    id: 'PX',
    type: 'plex',
    priority: 1,
    library: plex.MOVIES,
    base: plex.BASE,
    secret: { kind: 'token', token: plex.TOKEN } as ServerSecret,
    routes: [
      plex.page0,
      plex.page2,
      plex.sections,
      { fixture: 'collections.json' },
      { fixture: 'collection_children.json' },
      noShowCollections,
    ] as Route[],
  },
] as const;

async function syncAllThreeProviders() {
  const origins = new Map<string, ReturnType<typeof createFakeOrigin>>();
  for (const s of SERVERS) {
    await seedServer({
      id: s.id,
      type: s.type,
      priority: s.priority,
      baseUrl: s.base,
      libraries: [{ id: `${s.id}-lib`, providerId: s.library, kind: 'movies' }],
    });
    origins.set(s.id, createFakeOrigin(s.type, [...s.routes]));
  }
  const h = makeHarness();
  h.deps.config.pageSize = 2;
  h.deps.openServer = (server) => {
    const spec = SERVERS.find((s) => s.id === server.id)!;
    const provider = getProvider(spec.type)!; // the real adapter for this server type
    const ctx = buildProviderContext({
      server: { id: spec.id, type: spec.type, baseUrl: new URL(spec.base) },
      secret: spec.secret,
      fetchImpl: origins.get(spec.id)!.fetch,
      maxAttempts: 1,
    });
    return Promise.resolve({ provider, ctx });
  };
  const runs = [];
  for (const s of SERVERS) runs.push(await syncOnce(h, s.id));
  return { h, origins, runs };
}

describe('T4.3: one title on Jellyfin, Emby and Plex through the real adapters and sync', () => {
  it('yields one canonical item with three sources and one merged person', async () => {
    const { origins, runs } = await syncAllThreeProviders();
    for (const [i, run] of runs.entries()) {
      expect(run.status, SERVERS[i]!.id).toBe('succeeded');
    }
    for (const [id, origin] of origins) expect(origin.unmatched, id).toEqual([]);

    // The title: TMDB 10331 on all three servers is ONE canonical movie.
    const night = await rows<{ id: string }>(
      `SELECT DISTINCT media_item_id AS id FROM sources WHERE title LIKE 'Night of the Living Dead%'`,
    );
    expect(night).toHaveLength(1);
    const itemId = night[0]!.id;
    const sources = await rows<{ server_id: string; match_method: string; type: string }>(
      `SELECT s.server_id, s.match_method, sv.type FROM sources s JOIN servers sv ON sv.id = s.server_id
        WHERE s.media_item_id = ? ORDER BY sv.priority DESC`,
      itemId,
    );
    expect(sources.map((s) => s.type)).toEqual(['jellyfin', 'emby', 'plex']);
    expect(sources.map((s) => s.match_method)).toEqual(['new', 'external_id', 'external_id']);
    // Every title of the three libraries merged the same way: 3 canonical movies, 9 sources.
    expect(await count('media_items')).toBe(3);
    expect(await count('sources')).toBe(9);
    expect(await count('match_conflicts')).toBe(0);
    expect(
      (
        await rows<{ scheme: string; value: string }>(
          'SELECT scheme, value FROM external_ids WHERE media_item_id = ? ORDER BY scheme',
          itemId,
        )
      ).map((r) => `${r.scheme}:${r.value}`),
    ).toEqual(['imdb:tt0063350', 'tmdb:10331']); // a movie keys on TMDB and IMDb only (BR-2)
    expect(await count('item_availability', 'media_item_id = ?', itemId)).toBe(3);
    expect(
      (await one<{ title: string }>('SELECT title FROM media_items WHERE id = ?', itemId))?.title,
    ).toBe('Night of the Living Dead');

    // The person: "Duane Jones" is credited on all three, with three different provider IDs
    // (a Jellyfin ID, an Emby ID and Plex's `name:` ID), and is ONE canonical person.
    const links = await rows<{ person_id: string; provider_person_id: string; type: string }>(
      `SELECT l.person_id, l.provider_person_id, sv.type FROM person_provider_links l
         JOIN servers sv ON sv.id = l.server_id WHERE l.name = 'Duane Jones' ORDER BY sv.priority DESC`,
    );
    expect(links.map((l) => l.type)).toEqual(['jellyfin', 'emby', 'plex']);
    expect(links[2]!.provider_person_id).toBe('name:Duane Jones');
    expect(new Set(links.map((l) => l.person_id)).size).toBe(1);
    expect(await count('people', "name = 'Duane Jones'")).toBe(1);
    expect(
      await count('credits', 'person_id = ? AND media_item_id = ?', links[0]!.person_id, itemId),
    ).toBe(3);
    expect(await count('search_fts', "kind = 'person' AND name = 'Duane Jones'")).toBe(1);
    // Each provider contributed a distinct person link; none was invented for a missing ID.
    expect(
      await count('person_provider_links', "name = 'Duane Jones' AND tmdb_id IS NOT NULL"),
    ).toBe(0);
  });
});

describe('BR-10: the Plex person ID is the global tagKey when known, else name:<tag>', () => {
  const subject = {
    serverId: 'PX',
    providerPersonId: 'plex://person/5d77',
    name: 'Duane Jones',
    tmdbId: null,
    imdbId: null,
  };
  const person = (providerPersonId: string, serverId: string): PersonCandidate => ({
    personId: `person-${providerPersonId}`,
    links: [
      {
        linkId: `link-${providerPersonId}`,
        serverId,
        providerPersonId,
        name: 'Duane Jones',
        tmdbId: null,
        imdbId: null,
        serverPriority: 1,
      },
    ],
  });
  const decide = (candidates: PersonCandidate[], over = subject) =>
    decidePerson({ subject: over, override: null, idCandidates: [], nameCandidates: candidates });

  it('merges a tagKey link with the name-derived link of the same Plex server', () => {
    expect(decide([person('name:Duane Jones', 'PX')])).toEqual({
      kind: 'attach',
      targetId: 'person-name:Duane Jones',
      method: 'name',
    });
    // ... and the other way round: a list-response link arriving after the detail one.
    expect(
      decide([person('plex://person/5d77', 'PX')], {
        ...subject,
        providerPersonId: 'name:Duane Jones',
      }),
    ).toMatchObject({ kind: 'attach', method: 'name' });
  });

  it('still keeps two real origin people of one server apart', () => {
    expect(decide([person('plex://person/other', 'PX')])).toEqual({ kind: 'keep', method: 'new' });
    expect(decide([person('name:Duane Jones', 'JF')])).toMatchObject({ kind: 'attach' });
  });

  it('through sync: the name: link and the tagKey link of one Plex person end as one canonical person', async () => {
    await seedServer({ id: 'JF', priority: 2 });
    await seedServer({ id: 'PX', priority: 1, type: 'plex' });
    const jfo = new FakeOrigin('JF');
    const pxo = new FakeOrigin('PX');
    jfo.setItems('JF-plib', [
      movie('j1', 'Night', { tmdb: '10331', credits: [credit('jf-dj', 'Duane Jones')] }),
    ]);
    pxo.setItems('PX-plib', [
      movie('p1', 'Night', { tmdb: '10331', credits: [credit('name:Duane Jones', 'Duane Jones')] }),
    ]);
    const h = makeHarness({ origins: [jfo, pxo] });
    await syncOnce(h, 'JF');
    await syncOnce(h, 'PX');
    expect(await count('people')).toBe(1);

    // The Plex origin now reports the global key for the same person (an item detail).
    pxo.setItems('PX-plib', [
      movie('p1', 'Night', {
        tmdb: '10331',
        title: 'Night',
        credits: [credit('plex://person/5d77', 'Duane Jones')],
        versions: [],
      }),
    ]);
    await syncOnce(h, 'PX');
    expect(await count('people')).toBe(1);
    expect(await count('person_provider_links', "provider_person_id = 'plex://person/5d77'")).toBe(
      1,
    );
    expect(
      new Set(
        (await rows<{ person_id: string }>('SELECT person_id FROM person_provider_links')).map(
          (r) => r.person_id,
        ),
      ).size,
    ).toBe(1);
    expect(await count('match_conflicts')).toBe(0);
  });
});
