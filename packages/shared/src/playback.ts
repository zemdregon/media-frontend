/**
 * Playback, progress and copy-table contracts (LLD-API "Device capabilities and play request",
 * "Playback descriptor", "Card shapes and the copy table"; FR-PLAY-001 to FR-PLAY-010,
 * FR-PROG-001 to FR-PROG-004, FR-CAT-008, FR-CAT-013). Request bodies are zod schemas so the
 * Worker validates with the same definitions the SPA types against.
 */
import { z } from 'zod';
import type { ItemCard, ItemDetail } from './catalog';

// --- device capabilities (FR-PLAY-002) ---

const codecName = z.string().trim().toLowerCase().min(1).max(32);
const height = z.number().int().min(1).max(10_000);

export const deviceCapabilitiesSchema = z.object({
  /** Containers the browser plays as files, plus `hls` when it can play HLS at all. */
  containers: z.array(codecName).max(16),
  video: z
    .array(
      z.object({
        codec: codecName,
        maxLevel: z.string().max(16).optional(),
        maxHeight: height.optional(),
      }),
    )
    .max(16),
  audio: z.array(codecName).max(16),
  maxWidth: height.optional(),
  maxHeight: height.optional(),
  /** HDR formats the display can show: `hdr10`, `hdr10plus`, `hlg`, `dolby_vision`. */
  hdr: z.array(codecName).max(8).default([]),
  textSubtitles: z.array(codecName).max(8).default(['vtt']),
  nativeHls: z.boolean().default(false),
  mse: z.boolean().default(false),
});
export type DeviceCapabilitiesPayload = z.output<typeof deviceCapabilitiesSchema>;

// --- play request (FR-PLAY-001, FR-PLAY-004, FR-PLAY-005, FR-PLAY-006) ---

const id = z.string().min(1).max(64);

export const subtitlePreferenceSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('off') }),
  /** The first track in this language (text preferred). */
  z.object({ mode: z.literal('language'), language: z.string().min(1).max(16) }),
  /** A specific subtitle track of the chosen version (FR-PLAY-006). */
  z.object({ mode: z.literal('track'), index: z.number().int().min(0).max(10_000) }),
]);
export type SubtitlePreference = z.output<typeof subtitlePreferenceSchema>;

export const playRequestSchema = z.object({
  itemId: id,
  capabilities: deviceCapabilitiesSchema,
  preferences: z
    .object({
      audioLanguage: z.string().min(1).max(16).nullish(),
      /** A specific audio track of the chosen version (FR-PLAY-006). */
      audioIndex: z.number().int().min(0).max(10_000).nullish(),
      subtitle: subtitlePreferenceSchema.default({ mode: 'off' }),
      maxHeight: height.nullish(),
      /** Manual choice (FR-PLAY-005): overrides automatic selection for this request. */
      sourceId: id.nullish(),
      versionId: id.nullish(),
    })
    .default({ subtitle: { mode: 'off' } }),
  /** Sources that failed on this device; a replacement request (FR-PLAY-004). */
  excludeSourceIds: z.array(id).max(32).default([]),
  /** The session this request replaces; it is ended and revoked first. */
  replacesSessionId: id.nullish(),
  /** Where the origin should start a transcode; the player may also seek. */
  startPositionMs: z
    .number()
    .int()
    .min(0)
    .max(100 * 3_600_000)
    .nullish(),
});
export type PlayRequest = z.input<typeof playRequestSchema>;

// --- descriptor (FR-PLAY-001, FR-PLAY-010) ---

export type PlaybackMode = 'direct_play' | 'direct_stream' | 'transcode';

/**
 * Selection reason codes (LLD-API table). Clients must ignore codes they do not know.
 * `remux_for_token_auth` is an addition for Jellyfin's forced token-gated HLS (ADR-0013).
 * `provider_unverified` marks a source whose server type has no verified stream-credential model
 * yet (Plex until B-3); it is shown instead of offering playback.
 */
export const REASON_CODES = [
  'direct_play',
  'direct_stream_container',
  'remux_for_token_auth',
  'provider_unverified',
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

export interface AudioTrackEntry {
  index: number;
  label: string;
  language: string | null;
  codec: string | null;
  channels: number | null;
  selected: boolean;
}

export interface SubtitleTrackEntry {
  index: number;
  label: string;
  language: string | null;
  /** `image` tracks are burned in by the origin and need a new play request to switch. */
  kind: 'text' | 'image';
  forced: boolean;
  /** WebVTT on the origin host for text tracks; null for image tracks. */
  url: string | null;
  selected: boolean;
}

export interface PlaybackDescriptor {
  sessionId: string;
  /** Epoch ms: the session expires if playback has not started by then (BR-9). */
  expiresAt: number;
  item: { id: string; title: string; runtimeMs: number | null };
  source: { id: string; versionId: string; serverName: string; label: string };
  mode: PlaybackMode;
  /** Always on the selected server's own host (FR-PLAY-008); carries only the session credential. */
  streamUrl: string;
  streamType: 'progressive' | 'hls';
  audioTracks: AudioTrackEntry[];
  subtitleTracks: SubtitleTrackEntry[];
  /** Set when a resumable position exists (BR-7: over 60 s and not watched). */
  resume: { positionMs: number } | null;
  reasons: ReasonCode[];
  /** Other candidates the user may see, for offering a replacement (FR-PLAY-004). */
  alternatives: number;
}

// --- session events (FR-PROG-001, FR-PLAY-009, BR-9) ---

export const playbackEventSchema = z.object({
  seq: z.number().int().min(1).max(2_147_483_647),
  type: z.enum(['start', 'progress', 'pause', 'stop', 'error']),
  positionMs: z
    .number()
    .int()
    .min(0)
    .max(100 * 3_600_000),
  errorCode: z.string().max(64).optional(),
});
export type PlaybackEvent = z.output<typeof playbackEventSchema>;

// --- progress (FR-PROG-003) ---

export const progressUpdateSchema = z.union([
  z.object({ watched: z.boolean() }).strict(),
  z
    .object({
      positionMs: z
        .number()
        .int()
        .min(0)
        .max(100 * 3_600_000),
    })
    .strict(),
]);
export type ProgressUpdate = z.output<typeof progressUpdateSchema>;

export interface ProgressResponse {
  positionMs: number;
  watched: boolean;
}

/** A "Continue watching" entry on `/home` (FR-CAT-008): an item card plus its progress. */
export interface ContinueWatchingCard extends ItemCard {
  progress: { positionMs: number; runtimeMs: number | null };
}

// --- copy table (FR-CAT-013) ---

export type ExpectedPlayability = 'direct_play' | 'transcode' | 'unavailable';

export interface ItemCopy {
  sourceId: string;
  versionId: string;
  serverName: string;
  /** The origin's type (`jellyfin`, `emby`, `plex`) for the "TYPE · network" line. */
  serverType: 'jellyfin' | 'emby' | 'plex';
  serverStatus: string;
  resolution: { width: number | null; height: number | null; label: string };
  hdr: string;
  videoCodec: string | null;
  container: string | null;
  audio: { codec: string | null; channels: number | null; language: string | null }[];
  sizeBytes: number | null;
  /** Null when the request had no `X-Device-Caps` header. */
  expectedPlayability: ExpectedPlayability | null;
  reasons: ReasonCode[];
  selected: boolean;
}

/** `GET /api/v1/items/{id}` with the copy table (FR-CAT-013); `[]` for series and seasons. */
export type ItemDetailWithCopies = ItemDetail & { copies: ItemCopy[] };

/** Name of the request header that carries base64url device capabilities (≤ 2 KB). */
export const DEVICE_CAPS_HEADER = 'X-Device-Caps';
