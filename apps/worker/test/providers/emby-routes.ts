// Recorded Emby 4.10.1.0 exchanges wired to the requests the adapter makes (T4.1). Counterpart of
// jellyfin-routes.ts; shared by the adapter tests and the server registration API test.
import type { FixtureRoute, InlineRoute, Route } from './fixture-fetch';
import { ITEM_FIELDS_WITH_PEOPLE, PAGING, withBody } from './jellyfin-routes';

export const BASE = 'https://emby.example.test';
export const USER_ID = '5c84ecbdbf494494a7fa03913ea2e020';
export const MOVIES = '3';
export const SHOWS = '5';
export const SERVER_ID = '66831b99153e41cb824035fd4f81aa23';

export const publicInfo: FixtureRoute = { fixture: 'system_info_public.json' };
export const auth: FixtureRoute = { fixture: 'auth_svc.json' };
export const views: FixtureRoute = { fixture: 'views.json' };
// The adapter asks for `People` inline (T2.9); the Emby listing recordings pre-date that field.
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
// The recording of the TV library had no sort, no paging and no `Movie` in the type list.
export const tvAll: FixtureRoute = {
  fixture: 'items_tv_all.json',
  ignoreParams: [...PAGING, 'SortBy', 'SortOrder'],
  overrideParams: { IncludeItemTypes: 'Movie,Series,Season,Episode', ...withPeople },
};
export const boxsets: FixtureRoute = { fixture: 'boxsets.json', ignoreParams: PAGING };
export const boxsetMembers: FixtureRoute = {
  fixture: 'boxset_members.json',
  ignoreParams: PAGING,
};
export const logout: FixtureRoute = { fixture: 'session_logout_A.json' };

export const happy: Route[] = [
  publicInfo,
  auth,
  views,
  page0,
  page2,
  sinceRoute,
  tvAll,
  detail,
  boxsets,
  boxsetMembers,
];

// Synthetic: no recording of a rejected sign-in or an unknown item exists.
export const rejectedSignIn: InlineRoute = {
  method: 'POST',
  url: '/Users/AuthenticateByName',
  status: 401,
  body: 'Invalid username or password',
};
export const unknownItem: InlineRoute = {
  method: 'GET',
  url: `/Users/${USER_ID}/Items/does-not-exist?Fields=People,ProviderIds`,
  status: 404,
};

export const adminAuth: FixtureRoute = {
  fixture: 'auth_svc.json',
  mutate: withBody((b) => {
    ((b.User as Record<string, unknown>).Policy as Record<string, unknown>).IsAdministrator = true;
  }),
};

export const oldVersionInfo: FixtureRoute = {
  fixture: 'system_info_public.json',
  mutate: withBody((b) => {
    b.Version = '4.8.10.0';
  }),
};

export const notEmbyInfo: FixtureRoute = {
  fixture: 'system_info_public.json',
  mutate: withBody((b) => {
    b.ProductName = 'Jellyfin Server';
  }),
};
