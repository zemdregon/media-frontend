/**
 * Playback API types (LLD-API: device capabilities, play request, descriptor, reasons table, copy
 * table, events, progress).
 *
 * TODO(M3 merge): these are local copies. Once `packages/shared/src/playback.ts` lands, delete this
 * file and import the same names from `@cinewren/shared`. Names and shapes follow LLD-API; the
 * fields marked "assumed" are not spelled out in the LLD yet.
 */
import type { ItemCard } from '@cinewren/shared';

export interface DeviceCapabilities {
  containers: string[];
  video: { codec: string; maxLevel?: string; maxHeight?: number }[];
  audio: string[];
  maxWidth: number;
  maxHeight: number;
  hdr: string[];
  textSubtitles: string[];
  nativeHls: boolean;
  mse: boolean;
}

/** `preferences.subtitle`: `track` is assumed, as the LLD sample only shows `{mode:"off"}`. */
export type SubtitlePreference =
  { mode: 'off' } | { mode: 'track'; index: number; kind: 'text' | 'image' };

export interface PlayPreferences {
  audioLanguage: string | null;
  /** Assumed: the provider interface negotiates by `audioIndex` (LLD-PROV). */
  audioIndex?: number | null;
  subtitle: SubtitlePreference;
  maxHeight: number | null;
  sourceId: string | null;
  versionId: string | null;
}

export interface PlayRequest {
  itemId: string;
  capabilities: DeviceCapabilities;
  preferences: PlayPreferences;
  excludeSourceIds: string[];
  replacesSessionId: string | null;
}

export type PlaybackMode = 'direct_play' | 'direct_stream' | 'transcode';

export interface AudioTrack {
  index: number;
  label: string;
  language: string | null;
  selected: boolean;
}

export interface SubtitleTrack {
  index: number;
  label: string;
  language: string | null;
  kind: 'text' | 'image';
  /** WebVTT URL on the origin host; absent for image tracks, which are burned in. */
  url?: string;
  selected: boolean;
}

export interface PlaybackDescriptor {
  sessionId: string;
  expiresAt: number;
  item: { id: string; title: string; runtimeMs: number | null };
  source: { id: string; versionId: string; serverName: string; label: string };
  mode: PlaybackMode;
  streamUrl: string;
  streamType: 'progressive' | 'hls';
  audioTracks: AudioTrack[];
  subtitleTracks: SubtitleTrack[];
  resume: { positionMs: number } | null;
  reasons: string[];
  alternatives: number;
}

/** The reasons table (LLD-API, Playback descriptor). Unknown codes must be ignored by the UI. */
export const REASON_CODES = [
  'direct_play',
  'direct_stream_container',
  'audio_transcoded',
  'transcode_video_codec',
  'subtitle_burn_in',
  'hdr_unsupported',
  'hdr_match',
  'resolution_exceeds_device',
  'highest_playable_resolution',
  'server_priority',
  'server_latency',
  'server_degraded',
  'server_unreachable',
  'user_selected',
  'failover',
  'origin_changed_mode',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export type ExpectedPlayability = 'direct_play' | 'transcode' | 'unavailable';

/** One row of `ItemDetail.copies` (FR-CAT-013). */
export interface CopyRow {
  sourceId: string;
  versionId: string;
  serverName: string;
  /** Assumed: the server type (`jellyfin`, `emby`, `plex`) for the "TYPE · network" line. */
  serverType?: string;
  serverStatus: string;
  resolution: { width: number; height: number; label: string } | null;
  hdr: string;
  videoCodec: string | null;
  container: string | null;
  audio: { codec: string; channels: number | null; language: string | null }[];
  sizeBytes: number | null;
  expectedPlayability: ExpectedPlayability | null;
  reasons: string[];
  selected: boolean;
}

/** `ItemDetail` as M3 returns it: the M2 shape plus the copy table. */
export interface WithCopies {
  copies?: CopyRow[];
}

export type PlayEventType = 'start' | 'progress' | 'pause' | 'stop' | 'error';

export interface PlayEvent {
  seq: number;
  type: PlayEventType;
  positionMs: number;
  errorCode?: string;
}

export interface ProgressResult {
  positionMs: number;
  watched: boolean;
}

/** Continue-watching entry: `ItemCard + progress` (LLD-API `/home`). `runtimeMs` is assumed. */
export type ContinueItem = ItemCard & {
  progress?: { positionMs: number; watched?: boolean } | null;
  runtimeMs?: number | null;
  /** Assumed: the server that would resume, for "resuming from Basement NAS, direct play". */
  resumeSource?: { serverName: string; mode?: string } | null;
};
