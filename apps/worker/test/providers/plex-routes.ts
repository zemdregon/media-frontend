// Recorded Plex 1.43.4 exchanges wired to the requests the adapter makes, shared by the adapter
// tests and the server registration tests. Routes marked "synthetic" have no recording: the spike
// had no managed user (B-3), so the admin probe answers and every `since` page are constructed.
import {
  loadFixture,
  type Fixture,
  type FixtureRoute,
  type InlineRoute,
  type Route,
} from './fixture-fetch';

export const BASE = 'https://plex.example.test';
export const MACHINE_ID = '<PLEX_MACHINE_ID>';
export const TOKEN = 'managed-user-token-for-tests';
export const MOVIES = '1';
export const SHOWS = '2';

export const identity: FixtureRoute = { fixture: 'identity.json' };
export const sections: FixtureRoute = { fixture: 'library_sections.json' };
export const page0: FixtureRoute = { fixture: 'items_page_movies_0_2.json' };
// Recorded with the container window as headers; the adapter sends it as query parameters.
export const page2: FixtureRoute = {
  fixture: 'items_page_movies_2_2.json',
  mutate: (f: Fixture) => {
    f.request.path += '&X-Plex-Container-Start=2&X-Plex-Container-Size=2';
    return f;
  },
};
export const detail: FixtureRoute = { fixture: 'metadata_hgf.json' };
export const detailP9: FixtureRoute = { fixture: 'metadata_p9.json' };

/** Synthetic: a restricted (managed) user is refused on an admin-only endpoint. Unverified (B-3). */
export const prefsRefused: InlineRoute = { method: 'GET', url: '/:/prefs', status: 403 };
/** Synthetic: the owner token is accepted on an admin-only endpoint (the spike's finding). */
export const prefsAllowed: InlineRoute = {
  method: 'GET',
  url: '/:/prefs',
  status: 200,
  body: { MediaContainer: { size: 0, Setting: [] } },
};

export const happy: Route[] = [identity, sections, prefsRefused, page0, page2, detail];

// Synthetic: no recording of a rejected token or an unknown item exists.
export const rejectedToken: InlineRoute = { method: 'GET', url: '/library/sections', status: 401 };
export const unknownItem: InlineRoute = {
  method: 'GET',
  url: '/library/metadata/does-not-exist?includeGuids=1',
  status: 404,
};

export const withMachine =
  (patch: (mc: Record<string, unknown>) => void) =>
  (f: Fixture): Fixture => {
    patch((f.response.body as { MediaContainer: Record<string, unknown> }).MediaContainer);
    return f;
  };

export const oldVersionIdentity: FixtureRoute = {
  fixture: 'identity.json',
  mutate: withMachine((mc) => {
    mc.version = '1.42.2.10156-f737b826c';
  }),
};

export const notPlexIdentity: FixtureRoute = {
  fixture: 'identity.json',
  mutate: (f) => {
    f.response.body = { hello: 'not plex' };
    return f;
  },
};

/** Synthetic: one movie changed since the cutoff, built from the recorded first page. */
export const SINCE_SECONDS = 1791097146;
export function sinceRoute(): InlineRoute {
  const recorded = loadFixture('plex', 'items_page_movies_0_2.json').response.body as {
    MediaContainer: Record<string, unknown> & { Metadata: unknown[] };
  };
  const mc = {
    ...recorded.MediaContainer,
    Metadata: recorded.MediaContainer.Metadata.slice(0, 1),
    size: 1,
    totalSize: 1,
  };
  return {
    method: 'GET',
    url: `/library/sections/${MOVIES}/all?includeGuids=1&updatedAt%3E=${SINCE_SECONDS}&X-Plex-Container-Start=0&X-Plex-Container-Size=50`,
    status: 200,
    body: { MediaContainer: mc },
  };
}
