// T4.3 groundwork (FR-CAT-001): one movie on a Jellyfin, an Emby and a Plex server normalizes to
// the same external IDs, which is what the catalog merge keys on. Each provider's recorded movie
// listing goes through that provider's own normalizer. Emby's adapter (T4.1) is not merged yet; its
// responses share the Jellyfin shape (`ProviderIds`, spike 3d), so the shared MediaBrowser
// normalizer reads the Emby recording.
import { describe, expect, it } from 'vitest';
import { normalizeItem } from '../../src/providers/jellyfin-normalize';
import { normalizePlexItem } from '../../src/providers/plex-normalize';
import type { NormalizedItem } from '../../src/providers/types';
import { loadFixture } from './fixture-fetch';

function mediaBrowserMovies(provider: 'jellyfin' | 'emby'): NormalizedItem[] {
  const body = loadFixture(provider, 'items_page_movies_0_2.json').response.body as {
    Items: unknown[];
  };
  return body.Items.flatMap((i) => normalizeItem(i) ?? []);
}

function plexMovies(): NormalizedItem[] {
  const body = loadFixture('plex', 'items_page_movies_0_2.json').response.body as {
    MediaContainer: { Metadata: unknown[] };
  };
  return body.MediaContainer.Metadata.flatMap((i) => normalizePlexItem(i) ?? []);
}

/** The merge key inputs: the IDs every provider reports for a movie (FR-CAT-001). */
const mergeIds = (item: NormalizedItem) => ({
  tmdb: item.externalIds.tmdb,
  imdb: item.externalIds.imdb,
});

const byTitle = (items: NormalizedItem[], title: string): NormalizedItem => {
  const found = items.find((i) => i.title === title);
  if (!found) throw new Error(`${title} not in fixture`);
  return found;
};

describe('cross-provider matching: the same title normalizes to identical external IDs', () => {
  const sources = {
    jellyfin: mediaBrowserMovies('jellyfin'),
    emby: mediaBrowserMovies('emby'),
    plex: plexMovies(),
  };

  it.each([
    ['Night of the Living Dead', { tmdb: '10331', imdb: 'tt0063350' }],
    ['His Girl Friday', { tmdb: '3085', imdb: 'tt0032599' }],
  ])('%s', (title, expected) => {
    for (const [provider, items] of Object.entries(sources)) {
      const item = byTitle(items, title);
      expect(item.type, provider).toBe('movie');
      expect(mergeIds(item), provider).toEqual(expected);
    }
  });

  it('keeps provider item IDs distinct, so the three copies stay three sources of one title', () => {
    const ids = Object.values(sources).map(
      (items) => byTitle(items, 'Night of the Living Dead').providerItemId,
    );
    expect(new Set(ids).size).toBe(3);
  });

  it('reports a TVDB ID only where the origin has one (Plex), and never invents the others', () => {
    expect(byTitle(sources.plex, 'Night of the Living Dead').externalIds.tvdb).toBe('1831');
    expect(byTitle(sources.jellyfin, 'Night of the Living Dead').externalIds.tvdb).toBeUndefined();
    expect(byTitle(sources.emby, 'Night of the Living Dead').externalIds.tvdb).toBeUndefined();
  });

  it('agrees on the year across providers, the fallback key when IDs are missing', () => {
    const years = Object.values(sources).map((i) => byTitle(i, 'His Girl Friday').year);
    expect(new Set(years)).toEqual(new Set([1940]));
  });
});
