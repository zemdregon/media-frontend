// Recorded Jellyfin 12.1 exchanges wired to the requests the adapter makes, shared by the adapter
// tests and the server registration API tests.
import type { Fixture, FixtureRoute, InlineRoute, Route } from './fixture-fetch';

export const BASE = 'https://jellyfin.example.test';
export const USER_ID = '148dded263c74cb885d9819605d68044';
export const MOVIES = 'f137a2dd21bbc1b99aa5c0f6bf02a805';
export const SHOWS = 'a656b907eb3a73532e40e44b968d0225';
export const PAGING = ['StartIndex', 'Limit', 'EnableTotalRecordCount'];

export const publicInfo: FixtureRoute = { fixture: 'system_info_public.json' };
export const auth: FixtureRoute = { fixture: 'auth_svc.json' };
export const views: FixtureRoute = { fixture: 'views.json' };
// The adapter now also asks for `People` (T2.9, inline credits; recorded in
// items_page_with_people_field.json). The listing recordings pre-date that field, so the recorded
// `Fields` value is replaced by the one the adapter sends.
export const ITEM_FIELDS_WITH_PEOPLE =
  'ProviderIds,MediaSources,MediaStreams,Overview,Genres,DateCreated,DateLastSaved,Path,SortName,OriginalTitle,ProductionYear,RunTimeTicks,ParentId,Etag,People';
const withPeople = { Fields: ITEM_FIELDS_WITH_PEOPLE };
export const page0: FixtureRoute = {
  fixture: 'items_page_movies_0_2.json',
  overrideParams: withPeople,
};
export const page2: FixtureRoute = {
  fixture: 'items_page_movies_2_2.json',
  overrideParams: withPeople,
};
export const detail: FixtureRoute = { fixture: 'item_detail_with_people.json' };
export const sinceRoute: FixtureRoute = {
  fixture: 'items_changed_since_MinDateLastSaved.json',
  ignoreParams: PAGING,
  overrideParams: withPeople,
};
// The recording of the TV library used a different IncludeItemTypes list, no sort and no paging.
export const tvAll: FixtureRoute = {
  fixture: 'items_tv_all.json',
  ignoreParams: [...PAGING, 'SortBy', 'SortOrder'],
  overrideParams: { IncludeItemTypes: 'Movie,Series,Season,Episode', ...withPeople },
};

export const happy: Route[] = [publicInfo, auth, views, page0, page2, sinceRoute, tvAll, detail];

export const withBody = (patch: (body: Record<string, unknown>) => void) => (f: Fixture) => {
  patch(f.response.body as Record<string, unknown>);
  return f;
};

// Synthetic: no recording of a rejected sign-in or an unknown item exists.
export const rejectedSignIn: InlineRoute = {
  method: 'POST',
  url: '/Users/AuthenticateByName',
  status: 401,
  body: 'Invalid username or password',
};
export const unknownItem: InlineRoute = {
  method: 'GET',
  url: `/Items/does-not-exist?userId=${USER_ID}&Fields=People,ProviderIds`,
  status: 404,
};

export const logout: FixtureRoute = { fixture: 'session_logout_A.json' };

/** The service account is an administrator (spike: `Policy.IsAdministrator` in the auth response). */
export const adminAuth: FixtureRoute = {
  fixture: 'auth_svc.json',
  mutate: withBody((b) => {
    ((b.User as Record<string, unknown>).Policy as Record<string, unknown>).IsAdministrator = true;
  }),
};

export const oldVersionInfo: FixtureRoute = {
  fixture: 'system_info_public.json',
  mutate: withBody((b) => {
    b.Version = '10.10.7';
  }),
};

export const notJellyfinInfo: FixtureRoute = {
  fixture: 'system_info_public.json',
  mutate: withBody((b) => {
    b.ProductName = 'Plex Media Server';
  }),
};

/** Same address, but it now answers as a different server. */
export const otherServerInfo: FixtureRoute = {
  fixture: 'system_info_public.json',
  mutate: withBody((b) => {
    b.Id = 'ffffffffffffffffffffffffffffffff';
  }),
};

/** The sign-in of that same different server (its auth response names its own server ID). */
export const otherServerAuth: FixtureRoute = {
  fixture: 'auth_svc.json',
  mutate: withBody((b) => {
    b.ServerId = 'ffffffffffffffffffffffffffffffff';
  }),
};

/** The origin errors while listing libraries. Synthetic. */
export const viewsDown: InlineRoute = {
  method: 'GET',
  url: `/UserViews?userId=${USER_ID}`,
  status: 503,
};
