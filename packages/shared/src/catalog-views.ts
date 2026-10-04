/**
 * Response shapes of the catalog read API as the SPA consumes them (LLD-API "Endpoints" and
 * "Card shapes and the copy table"; FR-CAT-002 to FR-CAT-005, FR-CAT-008, FR-CAT-011,
 * FR-CAT-012, FR-CAT-013, FR-OPS-003).
 *
 * LLD-API names `ItemCard` and `ItemDetail` without listing every field. The fields below are the
 * subset the UI needs and are an agent proposal (T2.7); reconcile them with the Worker's real
 * serializers when the catalog read API (T2.4) lands. Types only; no secrets.
 */
import type { Page } from './auth';

export type ItemKind = 'movie' | 'series' | 'season' | 'episode';

export interface BestCopy {
  serverName: string;
  serverStatus: string;
  /** For example "1080p". */
  label: string;
}

export interface Progress {
  positionMs: number;
  durationMs: number;
  watched: boolean;
}

export interface ItemCard {
  id: string;
  kind: ItemKind;
  title: string;
  year: number | null;
  artworkUrl: string | null;
  /** Visible copies (movies and episodes). Series and seasons report their episodes' copies. */
  copyCount: number;
  serverCount: number;
  bestCopy: BestCopy | null;
  /** Episode and season numbering, when `kind` is `episode` or `season`. */
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  runtimeMinutes?: number | null;
  progress?: Progress | null;
}

export interface HomeResponse {
  recentlyAdded: ItemCard[];
  continueWatching: ItemCard[];
}

export interface PersonCard {
  id: string;
  name: string;
  artworkUrl: string | null;
}

export interface CollectionCard {
  id: string;
  name: string;
  artworkUrl: string | null;
  /** Set only when another visible collection has the same name (ADR-0015). */
  serverLabel?: string;
}

export interface SearchResponse {
  titles: Page<ItemCard>;
  people: Page<PersonCard>;
  collections: Page<CollectionCard>;
}

export interface PersonCredit {
  item: ItemCard;
  role: string;
  character?: string;
}

export interface PersonDetail extends PersonCard {
  credits: Page<PersonCredit>;
}

export interface CollectionDetail extends CollectionCard {
  overview: string | null;
  members: Page<ItemCard>;
}

export interface ItemCopy {
  sourceId: string;
  versionId: string;
  serverName: string;
  serverStatus: string;
  resolution: { width: number; height: number; label: string } | null;
  hdr: string;
  videoCodec: string;
  container: string;
  audio: { codec: string; channels: number; language: string | null }[];
  sizeBytes: number | null;
  expectedPlayability: 'direct_play' | 'transcode' | 'unavailable' | null;
  reasons: string[];
  selected: boolean;
}

export interface ItemDetail extends ItemCard {
  overview: string | null;
  backdropUrl?: string | null;
  genres: string[];
  /** For example `["4K HDR", "1080p"]`. */
  versionsSummary: string[];
  childrenSummary?: { seasons?: number; episodes?: number } | null;
  cast: { person: PersonCard; role: string; character?: string }[];
  collections: { id: string; name: string }[];
  copies: ItemCopy[];
}

export type SyncRunStatus = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed';

/** An entry of `GET /api/v1/admin/servers/{id}/sync-runs` (FR-SYNC-006). */
export interface SyncRun {
  id: string;
  type: 'full' | 'incremental';
  trigger: 'schedule' | 'manual';
  status: SyncRunStatus;
  added: number;
  updated: number;
  missing: number;
  errors: number;
  errorSummary: string | null;
  queuedAt: number;
  startedAt: number | null;
  endedAt: number | null;
}

export interface SyncRunsPage extends Page<SyncRun> {
  nextScheduled: number | null;
}
