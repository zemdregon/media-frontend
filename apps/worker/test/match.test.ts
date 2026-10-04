// T2.3, T2.9, T2.10: table-driven tests of the pure matching decisions (BR-2, BR-3, BR-10,
// ADR-0010, ADR-0015). No database: candidates are given as data.
import { describe, expect, it } from 'vitest';
import {
  decideByExternalIds,
  decideEpisode,
  decideOverride,
  type ItemCandidate,
} from '../src/match/items';
import { nameKey } from '../src/match/names';
import {
  decideCollection,
  decidePerson,
  type PersonCandidate,
  type PersonLinkInfo,
} from '../src/match/people';

const cand = (
  itemId: string,
  type: ItemCandidate['type'],
  ids: Partial<ItemCandidate['ids']>,
): ItemCandidate => ({ itemId, type, ids: { tmdb: [], imdb: [], tvdb: [], ...ids } });

describe('item matching by external ID (BR-2)', () => {
  const cases: {
    name: string;
    type: 'movie' | 'series';
    ids: { tmdb?: string; imdb?: string; tvdb?: string };
    candidates: ItemCandidate[];
    expected: string;
  }[] = [
    {
      name: 'a shared TMDB ID merges',
      type: 'movie',
      ids: { tmdb: '157336' },
      candidates: [cand('A', 'movie', { tmdb: ['157336'] })],
      expected: 'attach:A',
    },
    {
      name: 'a shared IMDb ID merges',
      type: 'movie',
      ids: { imdb: 'tt0816692' },
      candidates: [cand('A', 'movie', { imdb: ['tt0816692'] })],
      expected: 'attach:A',
    },
    {
      name: 'a shared TVDB ID merges series',
      type: 'series',
      ids: { tvdb: '70843' },
      candidates: [cand('A', 'series', { tvdb: ['70843'] })],
      expected: 'attach:A',
    },
    {
      name: 'TVDB is not a strong ID for movies',
      type: 'movie',
      ids: { tvdb: '70843' },
      candidates: [cand('A', 'movie', { tvdb: ['70843'] })],
      expected: 'new',
    },
    {
      name: 'no IDs: title-only similarity never merges',
      type: 'movie',
      ids: {},
      candidates: [],
      expected: 'new',
    },
    {
      name: 'same IMDb, different TMDB: conflicting IDs',
      type: 'movie',
      ids: { imdb: 'tt1', tmdb: '2' },
      candidates: [cand('A', 'movie', { imdb: ['tt1'], tmdb: ['3'] })],
      expected: 'flag:conflicting_ids',
    },
    {
      name: 'IDs matching two items: multiple candidates',
      type: 'movie',
      ids: { imdb: 'tt1', tmdb: '2' },
      candidates: [cand('A', 'movie', { imdb: ['tt1'] }), cand('B', 'movie', { tmdb: ['2'] })],
      expected: 'flag:multiple_candidates',
    },
    {
      name: 'a TMDB ID shared with a series is a different namespace',
      type: 'movie',
      ids: { tmdb: '5' },
      candidates: [cand('A', 'series', { tmdb: ['5'] })],
      expected: 'new',
    },
    {
      name: 'an IMDb ID shared across movie and series is a type mismatch',
      type: 'movie',
      ids: { imdb: 'tt9' },
      candidates: [cand('A', 'series', { imdb: ['tt9'] })],
      expected: 'flag:type_mismatch',
    },
  ];
  it.each(cases)('$name', ({ type, ids, candidates, expected }) => {
    const d = decideByExternalIds(type, ids, candidates);
    const got =
      d.kind === 'attach'
        ? `attach:${d.itemId}`
        : d.kind === 'flag'
          ? `flag:${d.flag.reason}`
          : 'new';
    expect(got).toBe(expected);
  });

  it('an item the source is separated from is never a candidate', () => {
    const d = decideByExternalIds(
      'movie',
      { tmdb: '1' },
      [cand('A', 'movie', { tmdb: ['1'] })],
      new Set(['A']),
    );
    expect(d.kind).toBe('keep');
  });

  it('lists shared and conflicting IDs in the flag details', () => {
    const d = decideByExternalIds('movie', { imdb: 'tt1', tmdb: '2' }, [
      cand('A', 'movie', { imdb: ['tt1'], tmdb: ['3'] }),
    ]);
    expect(d).toMatchObject({
      kind: 'flag',
      flag: { candidates: [{ id: 'A', sharedIds: ['imdb:tt1'], conflictingIds: ['tmdb:2!=3'] }] },
    });
  });

  it('overrides decide before IDs (BR-3)', () => {
    expect(decideOverride({ kind: 'pin', targetId: 'X' })).toEqual({
      kind: 'attach',
      itemId: 'X',
      method: 'manual',
    });
    expect(decideOverride({ kind: 'separate' })).toEqual({ kind: 'keep', method: 'manual' });
    expect(decideOverride(null)).toBeNull();
  });
});

describe('episode alignment (BR-2)', () => {
  const parents = (entries: [string, string | null][]) => new Map(entries);
  it('aligns by series, season and episode number', () => {
    expect(
      decideEpisode({
        ids: {},
        candidates: [],
        candidateParents: parents([]),
        parentItemId: 'S1',
        episodeNumber: 3,
      }),
    ).toEqual({ kind: 'align', parentItemId: 'S1', number: 3 });
  });
  it('merges by episode external ID under the same season', () => {
    expect(
      decideEpisode({
        ids: { tvdb: '9' },
        candidates: [cand('E', 'episode', { tvdb: ['9'] })],
        candidateParents: parents([['E', 'S1']]),
        parentItemId: 'S1',
        episodeNumber: 3,
      }),
    ).toEqual({ kind: 'attach', itemId: 'E', method: 'external_id' });
  });
  it('ignores an episode ID that points into a different season item', () => {
    expect(
      decideEpisode({
        ids: { tvdb: '9' },
        candidates: [cand('E', 'episode', { tvdb: ['9'] })],
        candidateParents: parents([['E', 'OTHER']]),
        parentItemId: 'S1',
        episodeNumber: 3,
      }).kind,
    ).toBe('align');
  });
  it('without a known parent or number the episode stays its own item', () => {
    expect(
      decideEpisode({
        ids: {},
        candidates: [],
        candidateParents: parents([]),
        parentItemId: null,
        episodeNumber: 3,
      }).kind,
    ).toBe('keep');
  });
});

describe('people matching (BR-10, ADR-0015)', () => {
  const link = (p: Partial<PersonLinkInfo> & { linkId: string }): PersonLinkInfo => ({
    serverId: 'other',
    providerPersonId: p.linkId,
    name: 'Chris Evans',
    tmdbId: null,
    imdbId: null,
    serverPriority: 0,
    ...p,
  });
  const person = (personId: string, ...links: PersonLinkInfo[]): PersonCandidate => ({
    personId,
    links,
  });
  const subject = {
    serverId: 'me',
    providerPersonId: 'p1',
    name: 'Chris Evans',
    tmdbId: null as string | null,
    imdbId: null as string | null,
  };
  const run = (
    s: typeof subject,
    idCandidates: PersonCandidate[],
    nameCandidates: PersonCandidate[],
  ) => {
    const d = decidePerson({ subject: s, override: null, idCandidates, nameCandidates });
    return d.kind === 'attach'
      ? `attach:${d.targetId}:${d.method}`
      : d.kind === 'flag'
        ? `flag:${d.flag.reason}`
        : 'new';
  };

  it('the same TMDB person ID merges', () => {
    expect(
      run(
        { ...subject, tmdbId: '16828' },
        [person('P', link({ linkId: 'l', tmdbId: '16828', name: 'Christopher Evans' }))],
        [],
      ),
    ).toBe('attach:P:external_id');
  });
  it('identical names without conflicting IDs merge', () => {
    expect(run(subject, [], [person('P', link({ linkId: 'l' }))])).toBe('attach:P:name');
  });
  it('identical names with different IDs stay separate, with no flag', () => {
    expect(
      run({ ...subject, tmdbId: '1' }, [], [person('P', link({ linkId: 'l', tmdbId: '2' }))]),
    ).toBe('new');
  });
  it('a shared ID with a conflicting ID creates a conflict flag', () => {
    expect(
      run(
        { ...subject, tmdbId: '1', imdbId: 'nm1' },
        [person('P', link({ linkId: 'l', tmdbId: '2', imdbId: 'nm1' }))],
        [],
      ),
    ).toBe('flag:conflicting_ids');
  });
  it('two people on one server with the same name are distinct', () => {
    expect(
      run(
        subject,
        [],
        [person('P', link({ linkId: 'l', serverId: 'me', providerPersonId: 'other-person' }))],
      ),
    ).toBe('new');
  });
  it('several same-name candidates are ambiguous and stay separate', () => {
    expect(
      run(subject, [], [person('P', link({ linkId: 'a' })), person('Q', link({ linkId: 'b' }))]),
    ).toBe('flag:ambiguous_name');
  });
  it('an ID shared with two people is multiple candidates', () => {
    expect(
      run(
        { ...subject, tmdbId: '1' },
        [
          person('P', link({ linkId: 'a', tmdbId: '1' })),
          person('Q', link({ linkId: 'b', tmdbId: '1' })),
        ],
        [],
      ),
    ).toBe('flag:multiple_candidates');
  });
  it('folds case, diacritics and punctuation in the name key', () => {
    expect(nameKey("  Judith  O'DEA ")).toBe('judith odea');
    expect(nameKey('Penélope Cruz')).toBe(nameKey('penelope cruz'));
  });
});

describe('collection matching (ADR-0015)', () => {
  it('merges only on a shared TMDB collection ID', () => {
    const c = [{ collectionId: 'C', tmdbCollectionIds: ['900'] }];
    expect(decideCollection({ tmdbCollectionId: '900', override: null, candidates: c })).toEqual({
      kind: 'attach',
      targetId: 'C',
      method: 'external_id',
    });
    expect(decideCollection({ tmdbCollectionId: '901', override: null, candidates: c }).kind).toBe(
      'keep',
    );
  });
  it('never merges by name: no ID means a separate collection', () => {
    expect(
      decideCollection({
        tmdbCollectionId: null,
        override: null,
        candidates: [{ collectionId: 'C', tmdbCollectionIds: ['900'] }],
      }).kind,
    ).toBe('keep');
  });
  it('flags an ID shared by two collections (after an operator split)', () => {
    const d = decideCollection({
      tmdbCollectionId: '900',
      override: null,
      candidates: [
        { collectionId: 'C', tmdbCollectionIds: ['900'] },
        { collectionId: 'D', tmdbCollectionIds: ['900'] },
      ],
    });
    expect(d).toMatchObject({ kind: 'flag', flag: { reason: 'multiple_candidates' } });
  });
});
