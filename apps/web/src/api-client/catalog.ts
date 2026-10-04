/** Typed functions for the catalog read API and the operator sync API (LLD-API). */
import type {
  CollectionCard,
  CollectionDetail,
  HomeResponse,
  ItemCard,
  ItemDetail,
  Page,
  PersonDetail,
  SearchResponse,
  Server,
  SyncRunsPage,
  ThemePreference,
  VersionEntry,
} from '@cinewren/shared';
import { api } from './index';

export type BrowseSort = 'title' | 'year' | 'added';

export interface BrowseFilters {
  type: 'movie' | 'series';
  sort?: BrowseSort;
  order?: 'asc' | 'desc';
  genre?: string;
  yearFrom?: number;
  yearTo?: number;
  /** Best available resolution, in pixels of height (720, 1080, 2160). */
  minHeight?: number;
  cursor?: string | null;
  limit?: number;
}

/** Builds `?a=1&b=2`, skipping undefined, null and empty values. */
export function queryString(params: Record<string, string | number | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

const enc = encodeURIComponent;

export const getHome = () => api<HomeResponse>('GET', '/home');

export const listItems = (f: BrowseFilters) =>
  api<Page<ItemCard>>('GET', `/items${queryString({ ...f })}`);

export type SearchKind = 'title' | 'person' | 'collection';

export const search = (q: string, kind?: SearchKind, cursor?: string | null) =>
  api<SearchResponse>('GET', `/search${queryString({ q, kind, cursor })}`);

/** `caps` is the `X-Device-Caps` header value, so the copy table carries per-device playability. */
export const getItem = (id: string, caps?: Record<string, string>) =>
  api<ItemDetail>('GET', `/items/${enc(id)}`, undefined, caps ? { headers: caps } : {});

export const getVersions = (id: string) => api<VersionEntry[]>('GET', `/items/${enc(id)}/versions`);

export const getChildren = (id: string, cursor?: string | null) =>
  api<Page<ItemCard>>('GET', `/items/${enc(id)}/children${queryString({ cursor, limit: 100 })}`);

export const getPerson = (id: string, cursor?: string | null) =>
  api<PersonDetail>('GET', `/people/${enc(id)}${queryString({ cursor })}`);

export const listCollections = (cursor?: string | null) =>
  api<Page<CollectionCard>>('GET', `/collections${queryString({ cursor })}`);

export const getCollection = (id: string, cursor?: string | null) =>
  api<CollectionDetail>('GET', `/collections/${enc(id)}${queryString({ cursor })}`);

export const listServers = () => api<Server[]>('GET', '/admin/servers');

export const listSyncRuns = (serverId: string) =>
  api<SyncRunsPage>('GET', `/admin/servers/${enc(serverId)}/sync-runs${queryString({ limit: 5 })}`);

export const startSync = (serverId: string, type: 'full' | 'incremental') =>
  api<{ runId: string }>('POST', `/admin/servers/${enc(serverId)}/sync`, { type });

export const savePreferences = (theme: ThemePreference) =>
  api<{ theme: ThemePreference }>('PATCH', '/me/preferences', { theme });
