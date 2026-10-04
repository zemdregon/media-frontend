/**
 * The provider abstraction (IR-002, ADR-0004, LLD-PROV). Nothing outside `providers/` may name a
 * provider-specific type; adapters translate to and from the normalized types below.
 *
 * Timestamps are epoch milliseconds. Identifiers are opaque strings (they differ in shape across
 * providers, spike section 5).
 */
import type { OriginFetch } from './origin-fetch';

export type ProviderType = 'jellyfin' | 'emby' | 'plex';

/** Decrypted service-account secret. Exists only in memory inside the Worker (BR-6). */
export type ServerSecret =
  { kind: 'password'; username: string; password: string } | { kind: 'token'; token: string };

export interface ProviderContext {
  server: { id: string; type: ProviderType; baseUrl: URL; originServerId?: string };
  secret: ServerSecret;
  /** The only way an adapter may reach the origin (TDD 6.4): host pinned, timeouts, retries. */
  fetch: OriginFetch;
  /**
   * An adapter-private, opaque cache of its derived access token, or undefined. The adapter
   * refreshes it on a 401 (once) and hands the new value back through `onTokenRefresh`. Callers
   * must treat it as a secret and must not log it.
   */
  serviceToken?: string | undefined;
  onTokenRefresh(token: string): Promise<void>;
}

// --- validation (FR-SRV-002) ---

export type ValidationCheck = 'tls' | 'credentials' | 'identity' | 'version';

export type ValidationFailureReason =
  | 'unreachable'
  | 'timeout'
  | 'redirect_refused'
  | 'invalid_credentials'
  | 'admin_account'
  | 'admin_status_unknown'
  | 'account_disabled'
  | 'unsupported_credential'
  | 'not_a_server'
  | 'server_id_mismatch'
  | 'version_too_old'
  | 'version_unparseable';

export type ValidationResult =
  | { ok: true; originServerId: string; version: string; serverName?: string }
  | {
      ok: false;
      /** The first failed check, in the order tls, credentials, identity, version. */
      check: ValidationCheck;
      reason: ValidationFailureReason;
      /** For `version_too_old`: the minimum, for example "12.1". Never origin text. */
      minimumVersion?: string;
    };

// --- catalog ---

export type LibraryKind = 'movies' | 'tv';
export type ItemType = 'movie' | 'series' | 'season' | 'episode';
export type ArtworkKind = 'poster' | 'backdrop' | 'thumb';

/** Names an image on the origin; `tag` versions it for caching. */
export interface ArtworkRef {
  providerItemId: string;
  tag: string;
}

export interface NormalizedLibrary {
  providerLibraryId: string;
  name: string;
  kind: LibraryKind;
}

export type HdrFormat = 'none' | 'hdr10' | 'hdr10plus' | 'hlg' | 'dolby_vision';

export interface AudioTrack {
  index: number;
  codec?: string;
  language?: string;
  channels?: number;
  title?: string;
  isDefault: boolean;
}

export interface SubtitleTrack {
  index: number;
  codec?: string;
  language?: string;
  title?: string;
  /** `text` tracks can be delivered as WebVTT; `image` tracks need burn-in. */
  kind: 'text' | 'image';
  isForced: boolean;
  isDefault: boolean;
  isExternal: boolean;
}

export interface NormalizedVersion {
  providerVersionId: string;
  container?: string;
  videoCodec?: string;
  videoProfile?: string;
  width?: number;
  height?: number;
  hdr: HdrFormat;
  bitrate?: number;
  runtimeMs?: number;
  /** Feeds FR-CAT-013. */
  sizeBytes?: number;
  audio: AudioTrack[];
  subtitles: SubtitleTrack[];
}

/** FR-SYNC-008. External IDs only when the origin reports them; never guessed. */
export interface NormalizedPerson {
  providerPersonId: string;
  name: string;
  externalIds: { tmdb?: string; imdb?: string };
  artwork?: ArtworkRef;
}

export interface NormalizedCredit {
  person: NormalizedPerson;
  role: 'actor' | 'director' | 'writer' | 'producer' | 'other';
  character?: string;
  /** Billing order within the origin's list, 0-based. */
  order: number;
}

export interface NormalizedItem {
  providerItemId: string;
  providerParentId?: string;
  type: ItemType;
  title: string;
  originalTitle?: string;
  sortTitle?: string;
  year?: number;
  overview?: string;
  genres: string[];
  runtimeMs?: number;
  seasonNumber?: number;
  episodeNumber?: number;
  externalIds: { tmdb?: string; imdb?: string; tvdb?: string };
  artwork: Partial<Record<ArtworkKind, ArtworkRef>>;
  dateAdded?: number;
  providerUpdatedAt?: number;
  /** Empty for series and seasons. */
  versions: NormalizedVersion[];
  /** Movies and series only; capped per item by the adapter (proposed: 40). */
  credits: NormalizedCredit[];
}

/** Plex collection, Jellyfin or Emby box set (FR-SYNC-008, ADR-0015). */
export interface NormalizedCollection {
  providerCollectionId: string;
  name: string;
  overview?: string;
  /** The TMDB collection ID is the only cross-server merge key. */
  externalIds: { tmdb?: string };
  artwork: Partial<Record<ArtworkKind, ArtworkRef>>;
  memberProviderItemIds: string[];
  providerUpdatedAt?: number;
}

export interface ListItemsRequest {
  libraryId: string;
  /** Opaque; from a previous page's `nextCursor`. */
  cursor?: string;
  pageSize: number;
  /** Incremental sync: only items the origin changed at or after this time (FR-SYNC-003). */
  since?: number;
}

export interface ItemsPage {
  items: NormalizedItem[];
  nextCursor: string | null;
}

// --- playback (FR-PLAY-001, FR-PLAY-006, FR-PLAY-007, FR-PLAY-009; ADR-0013) ---

/** FR-PLAY-002; the JSON shape is in LLD-API "Device capabilities". */
export interface DeviceCapabilities {
  containers: string[];
  video: { codec: string; maxLevel?: string | undefined; maxHeight?: number | undefined }[];
  audio: string[];
  maxWidth?: number | undefined;
  maxHeight?: number | undefined;
  hdr: string[];
  textSubtitles: string[];
  nativeHls: boolean;
  mse: boolean;
}

export interface SessionCredential {
  kind: 'session_token' | 'delegated_token' | 'shared_restricted';
  token: string;
  ref?: string;
  expiresAt?: number;
  /** The DeviceId the token was minted under (Jellyfin: one per session; Emby: a pool slot). */
  deviceId?: string;
  /** The origin account the token belongs to (some negotiation calls name it). */
  accountId?: string;
}

export interface NegotiatedStream {
  mode: 'direct_play' | 'direct_stream' | 'transcode';
  streamType: 'progressive' | 'hls';
  /** MUST be on `ctx.server.baseUrl`'s host; the caller asserts it. */
  url: string;
  /** WebVTT URLs of text subtitle tracks, by track index, on the same host. */
  subtitleUrls: Record<number, string>;
  /** Opaque to callers: what the adapter needs later for telemetry. Holds no credential. */
  providerSessionRef?: string;
}

export interface NegotiateRequest {
  providerItemId: string;
  providerVersionId: string;
  caps: DeviceCapabilities;
  audioIndex?: number | undefined;
  subtitle?: { index: number; kind: 'text' | 'image' } | null | undefined;
  startPositionMs?: number | undefined;
  cred: SessionCredential;
}

export interface PlaybackEvent {
  type: 'start' | 'progress' | 'stop';
  positionMs: number;
  /** Only `mode`, `streamType` and `providerSessionRef` are read; `url` may be empty. */
  stream: NegotiatedStream;
  paused?: boolean;
}

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  errorCode?: string;
}

/**
 * The playback half of an adapter (LLD-PROV). Emby has only this half until T4.1, so it is its
 * own interface; `MediaProvider` includes it.
 */
export interface PlaybackProvider {
  readonly type: ProviderType;
  /**
   * How stream credentials get their DeviceId (ADR-0013 amendments): `per_session` (Jellyfin:
   * unique, since re-auth on a DeviceId kills its previous token) or `pooled` (Emby: a leased slot
   * of a bounded pool, since logout leaves device entries behind). Default `per_session`.
   */
  readonly streamDevices?: 'per_session' | 'pooled';
  /** FR-PLAY-007. `lease` is set for `pooled` adapters: the pool slot leased to this session. */
  createSessionCredential(
    ctx: ProviderContext,
    sessionId: string,
    lease?: { slot: number },
  ): Promise<SessionCredential>;
  /** Idempotent: a credential the origin already rejects counts as revoked. */
  revokeSessionCredential(ctx: ProviderContext, cred: SessionCredential): Promise<void>;
  /** FR-PLAY-001, FR-PLAY-006. */
  negotiatePlayback(ctx: ProviderContext, req: NegotiateRequest): Promise<NegotiatedStream>;
  /** FR-PLAY-009: telemetry only. */
  reportPlayback(ctx: ProviderContext, cred: SessionCredential, ev: PlaybackEvent): Promise<void>;
}

export interface MediaProvider extends PlaybackProvider {
  readonly type: ProviderType;
  /** FR-SRV-002: tls, credentials (refusing admin accounts), identity, version, in that order. */
  validate(ctx: ProviderContext): Promise<ValidationResult>;
  /** FR-SRV-003: the movie and TV libraries visible to the service account. */
  listLibraries(ctx: ProviderContext): Promise<NormalizedLibrary[]>;
  /** FR-SYNC-003. */
  listItems(ctx: ProviderContext, req: ListItemsRequest): Promise<ItemsPage>;
  /** FR-SYNC-008. */
  listCollections(
    ctx: ProviderContext,
    req: { libraryId?: string; cursor?: string; pageSize: number },
  ): Promise<{ collections: NormalizedCollection[]; nextCursor: string | null }>;
  /** `null` when the origin has no such item. */
  getItem(ctx: ProviderContext, providerItemId: string): Promise<NormalizedItem | null>;
  /** FR-CAT-009. */
  getArtworkRequest(ctx: ProviderContext, ref: ArtworkRef, kind: ArtworkKind): Request;
  /** FR-OPS-001. */
  probe(ctx: ProviderContext): Promise<ProbeResult>;
}
