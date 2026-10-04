/**
 * Source selection (BR-5, LLD-SEL; FR-PLAY-003, FR-PLAY-004, FR-PLAY-005, FR-PLAY-010,
 * FR-SRV-006, FR-CAT-013). Pure functions only: no I/O, no clock, no randomness, so the same
 * inputs always give the same ranking and the same reason codes.
 *
 * Candidates are (source, version) pairs that already passed the BR-1 visibility predicate in
 * SQL. This module applies the rest of the BR-5 filter (server status, exclusions, the manual
 * choice), predicts the playback mode per candidate, ranks them by the seven BR-5 keys and
 * explains the result with reason codes.
 */
import type { ReasonCode, SubtitlePreference } from '@cinewren/shared';
import type { DeviceCapabilities, ProviderType } from '../providers/types';

export type Mode = 'direct_play' | 'direct_stream' | 'transcode';

export interface AudioInfo {
  index: number;
  codec: string | null;
  channels: number | null;
  language: string | null;
  title: string | null;
  default: boolean;
}

export interface SubtitleInfo {
  index: number;
  format: string | null;
  kind: 'text' | 'image';
  language: string | null;
  title: string | null;
  forced: boolean;
  default: boolean;
  external?: boolean;
}

export interface Candidate {
  sourceId: string;
  versionId: string;
  providerItemId: string;
  providerVersionId: string;
  serverId: string;
  serverName: string;
  serverType: ProviderType;
  /** `active`, `degraded` or `unreachable` (other statuses are not visible, BR-1). */
  serverStatus: string;
  priority: number;
  latencyMs: number | null;
  container: string | null;
  videoCodec: string | null;
  width: number | null;
  height: number | null;
  hdr: string;
  sizeBytes: number | null;
  runtimeMs: number | null;
  audio: AudioInfo[];
  subtitles: SubtitleInfo[];
}

export interface SelectionPrefs {
  audioLanguage?: string | null | undefined;
  audioIndex?: number | null | undefined;
  subtitle?: SubtitlePreference | undefined;
  maxHeight?: number | null | undefined;
  sourceId?: string | null | undefined;
  versionId?: string | null | undefined;
}

export interface Ranked {
  c: Candidate;
  mode: Mode;
  modeReasons: ReasonCode[];
  audio: AudioInfo | null;
  subtitle: SubtitleInfo | null;
  /** The BR-5 ranking keys, in order (higher is better except latency). */
  keys: {
    mode: number;
    res: [number, number];
    hdr: number;
    health: number;
    priority: number;
    latency: number | null;
  };
}

export type SelectOutcome =
  | { ok: true; ranked: Ranked[]; maxHeight: number; manual: boolean; excluded: boolean }
  /** The manual choice matches no visible candidate: 404 (LLD-SEL). */
  | { ok: false; error: 'not_found' }
  /** Nothing survived the filter: 409 NO_PLAYABLE_SOURCE with this reason. */
  | { ok: false; error: 'no_playable'; reason: 'servers_unreachable' | 'none_available' };

// --- normalization ---

const CODEC_ALIASES: Record<string, string> = {
  h265: 'hevc',
  hvc1: 'hevc',
  hev1: 'hevc',
  avc: 'h264',
  avc1: 'h264',
  av01: 'av1',
  vp09: 'vp9',
  'e-ac-3': 'eac3',
  'ac-3': 'ac3',
};

export function codecKey(codec: string | null | undefined): string | null {
  if (!codec) return null;
  const c = codec.trim().toLowerCase();
  return CODEC_ALIASES[c] ?? c;
}

const CONTAINER_ALIASES: Record<string, string> = {
  matroska: 'mkv',
  m4v: 'mp4',
  mov: 'mp4',
  m4a: 'mp4',
  '3gp': 'mp4',
  '3g2': 'mp4',
  mj2: 'mp4',
};

/** Origins may report a list such as `mov,mp4,m4a`; each entry is normalized. */
function containerKeys(container: string | null): string[] {
  if (!container) return [];
  return container
    .toLowerCase()
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => CONTAINER_ALIASES[c] ?? c);
}

const LANG3: Record<string, string> = {
  eng: 'en',
  fre: 'fr',
  fra: 'fr',
  ger: 'de',
  deu: 'de',
  spa: 'es',
  ita: 'it',
  jpn: 'ja',
  por: 'pt',
  rus: 'ru',
  chi: 'zh',
  zho: 'zh',
  kor: 'ko',
  dut: 'nl',
  nld: 'nl',
  swe: 'sv',
  nor: 'no',
  dan: 'da',
  fin: 'fi',
  pol: 'pl',
};

export function langKey(lang: string | null | undefined): string | null {
  if (!lang) return null;
  const l = lang.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  if (l === '' || l === 'und') return null;
  return LANG3[l] ?? l;
}

// --- tracks ---

export function chooseAudio(c: Candidate, prefs: SelectionPrefs): AudioInfo | null {
  if (prefs.audioIndex != null) {
    const exact = c.audio.find((a) => a.index === prefs.audioIndex);
    if (exact) return exact;
  }
  const want = langKey(prefs.audioLanguage);
  if (want) {
    const byLang = c.audio.filter((a) => langKey(a.language) === want);
    const pick = byLang.find((a) => a.default) ?? byLang[0];
    if (pick) return pick;
  }
  return c.audio.find((a) => a.default) ?? c.audio[0] ?? null;
}

export function chooseSubtitle(c: Candidate, prefs: SelectionPrefs): SubtitleInfo | null {
  const pref = prefs.subtitle ?? { mode: 'off' };
  if (pref.mode === 'off') return null;
  if (pref.mode === 'track') return c.subtitles.find((s) => s.index === pref.index) ?? null;
  const want = langKey(pref.language);
  const matching = c.subtitles.filter((s) => langKey(s.language) === want);
  // Text before image (no burn-in), then non-forced before forced.
  return (
    matching.find((s) => s.kind === 'text' && !s.forced) ??
    matching.find((s) => s.kind === 'text') ??
    matching[0] ??
    null
  );
}

// --- mode prediction (LLD-SEL predictMode) ---

function videoSupported(c: Candidate, caps: DeviceCapabilities): boolean {
  const codec = codecKey(c.videoCodec);
  if (!codec) return false;
  return caps.video.some(
    (v) =>
      codecKey(v.codec) === codec &&
      (v.maxHeight === undefined || c.height === null || c.height <= v.maxHeight),
  );
}

export function predictMode(
  c: Candidate,
  caps: DeviceCapabilities,
  prefs: SelectionPrefs,
): { mode: Mode; reasons: ReasonCode[]; audio: AudioInfo | null; subtitle: SubtitleInfo | null } {
  const audio = chooseAudio(c, prefs);
  const subtitle = chooseSubtitle(c, prefs);
  if (subtitle?.kind === 'image') {
    return { mode: 'transcode', reasons: ['subtitle_burn_in'], audio, subtitle };
  }
  const videoOk = videoSupported(c, caps);
  const capContainers = new Set(caps.containers.map((x) => CONTAINER_ALIASES[x] ?? x));
  const containerOk = containerKeys(c.container).some((k) => capContainers.has(k));
  const audioCodec = codecKey(audio?.codec);
  // No audio track at all is not an audio problem.
  const audioOk =
    audio === null || (audioCodec !== null && caps.audio.some((a) => codecKey(a) === audioCodec));
  // Jellyfin never yields direct_play: its static streams are unauthenticated (ADR-0013).
  const jellyfin = c.serverType === 'jellyfin';
  if (videoOk && containerOk && audioOk) {
    return jellyfin
      ? { mode: 'direct_stream', reasons: ['remux_for_token_auth'], audio, subtitle }
      : { mode: 'direct_play', reasons: ['direct_play'], audio, subtitle };
  }
  if (videoOk && (caps.nativeHls || caps.mse)) {
    const reasons: ReasonCode[] = [];
    if (!containerOk) reasons.push('direct_stream_container');
    if (!audioOk) reasons.push('audio_transcoded');
    return { mode: 'direct_stream', reasons, audio, subtitle };
  }
  return {
    mode: 'transcode',
    reasons: videoOk ? [] : ['transcode_video_codec'],
    audio,
    subtitle,
  };
}

// --- ranking (LLD-SEL select) ---

const MODE_SCORE: Record<Mode, number> = { direct_play: 2, direct_stream: 1, transcode: 0 };

export function effectiveMaxHeight(caps: DeviceCapabilities, prefs: SelectionPrefs): number {
  return Math.min(caps.maxHeight ?? Infinity, prefs.maxHeight ?? Infinity);
}

export function rankOne(
  c: Candidate,
  caps: DeviceCapabilities,
  prefs: SelectionPrefs,
  maxH: number,
): Ranked {
  const p = predictMode(c, caps, prefs);
  const h = c.height ?? 0;
  const capsHdr = caps.hdr.map((x) => x.toLowerCase());
  const hdr =
    (c.hdr !== 'none' && capsHdr.includes(c.hdr)) || (c.hdr === 'none' && capsHdr.length === 0)
      ? 1
      : 0;
  return {
    c,
    mode: p.mode,
    modeReasons: p.reasons,
    audio: p.audio,
    subtitle: p.subtitle,
    keys: {
      mode: MODE_SCORE[p.mode],
      res: h <= maxH ? [1, h] : [0, -h],
      hdr,
      health: c.serverStatus === 'active' ? 1 : 0,
      priority: c.priority,
      latency: c.latencyMs,
    },
  };
}

type KeyName = 'mode' | 'res' | 'hdr' | 'health' | 'priority' | 'latency' | 'id';

/** Negative when `a` ranks first. Returns the first deciding key too (for reason codes). */
export function compareRanked(a: Ranked, b: Ranked): { cmp: number; key: KeyName | null } {
  const ka = a.keys;
  const kb = b.keys;
  if (ka.mode !== kb.mode) return { cmp: kb.mode - ka.mode, key: 'mode' };
  if (ka.res[0] !== kb.res[0]) return { cmp: kb.res[0] - ka.res[0], key: 'res' };
  if (ka.res[1] !== kb.res[1]) return { cmp: kb.res[1] - ka.res[1], key: 'res' };
  if (ka.hdr !== kb.hdr) return { cmp: kb.hdr - ka.hdr, key: 'hdr' };
  if (ka.health !== kb.health) return { cmp: kb.health - ka.health, key: 'health' };
  if (ka.priority !== kb.priority) return { cmp: kb.priority - ka.priority, key: 'priority' };
  if (ka.latency !== kb.latency) {
    // Lower is better; unknown latency sorts last.
    if (ka.latency === null) return { cmp: 1, key: 'latency' };
    if (kb.latency === null) return { cmp: -1, key: 'latency' };
    return { cmp: ka.latency - kb.latency, key: 'latency' };
  }
  const ida = `${a.c.sourceId}\u0000${a.c.versionId}`;
  const idb = `${b.c.sourceId}\u0000${b.c.versionId}`;
  return { cmp: ida < idb ? -1 : ida > idb ? 1 : 0, key: ida === idb ? null : 'id' };
}

export function rankAll(
  cands: Candidate[],
  caps: DeviceCapabilities,
  prefs: SelectionPrefs,
): Ranked[] {
  const maxH = effectiveMaxHeight(caps, prefs);
  return cands.map((c) => rankOne(c, caps, prefs, maxH)).sort((a, b) => compareRanked(a, b).cmp);
}

const PLAYABLE_STATUS = new Set(['active', 'degraded']);

/**
 * The BR-5 filter and ranking. `visible` holds every candidate the caller may see (BR-1),
 * including those on unreachable servers, which are filtered here (and reported in the reason).
 */
export function selectCandidates(
  visible: Candidate[],
  caps: DeviceCapabilities,
  prefs: SelectionPrefs,
  excludeSourceIds: readonly string[] = [],
): SelectOutcome {
  const manual = Boolean(prefs.sourceId || prefs.versionId);
  let pool = visible;
  if (manual) {
    pool = pool.filter(
      (c) =>
        (!prefs.sourceId || c.sourceId === prefs.sourceId) &&
        (!prefs.versionId || c.versionId === prefs.versionId),
    );
    if (pool.length === 0) return { ok: false, error: 'not_found' };
  }
  const exclude = new Set(excludeSourceIds);
  const notExcluded = pool.filter((c) => !exclude.has(c.sourceId));
  const cands = notExcluded.filter((c) => PLAYABLE_STATUS.has(c.serverStatus));
  if (cands.length === 0) {
    const anyUnreachable = notExcluded.some((c) => c.serverStatus === 'unreachable');
    return {
      ok: false,
      error: 'no_playable',
      reason: anyUnreachable ? 'servers_unreachable' : 'none_available',
    };
  }
  return {
    ok: true,
    ranked: rankAll(cands, caps, prefs),
    maxHeight: effectiveMaxHeight(caps, prefs),
    manual,
    excluded: exclude.size > 0,
  };
}

// --- reasons (LLD-SEL reasons) ---

const MODE_FALLBACK: Record<Mode, ReasonCode> = {
  direct_play: 'direct_play',
  direct_stream: 'direct_stream_container',
  transcode: 'transcode_video_codec',
};

export interface ReasonContext {
  ranked: Ranked[];
  maxHeight: number;
  manual: boolean;
  failedBefore: boolean;
  actualMode?: Mode | undefined;
}

/** The descriptor's `reasons` for the chosen candidate `pick` (an element of `ranked`). */
export function reasonsFor(pick: Ranked, ctx: ReasonContext): ReasonCode[] {
  const out: ReasonCode[] = [...pick.modeReasons];
  const { c } = pick;
  if (c.hdr !== 'none') out.push(pick.keys.hdr === 1 ? 'hdr_match' : 'hdr_unsupported');
  const h = c.height ?? 0;
  if (h > ctx.maxHeight) {
    out.push('resolution_exceeds_device');
  } else {
    const topOnRes = ctx.ranked.every(
      (r) =>
        r.keys.res[0] < pick.keys.res[0] ||
        (r.keys.res[0] === pick.keys.res[0] && r.keys.res[1] <= pick.keys.res[1]),
    );
    const someShorter = ctx.ranked.some(
      (r) => r !== pick && (r.c.height ?? 0) < h && (r.c.height ?? 0) <= ctx.maxHeight,
    );
    if (topOnRes && someShorter) out.push('highest_playable_resolution');
  }
  if (ctx.manual) {
    out.push('user_selected');
  } else {
    const at = ctx.ranked.indexOf(pick);
    const runnerUp = ctx.ranked[at + 1];
    if (runnerUp) {
      const { key } = compareRanked(pick, runnerUp);
      if (key === 'priority') out.push('server_priority');
      else if (key === 'latency') out.push('server_latency');
    }
  }
  if (c.serverStatus === 'degraded') out.push('server_degraded');
  if (ctx.failedBefore) out.push('failover');
  if (ctx.actualMode !== undefined && ctx.actualMode !== pick.mode) out.push('origin_changed_mode');
  const deduped = [...new Set(out)];
  return deduped.length > 0 ? deduped : [MODE_FALLBACK[ctx.actualMode ?? pick.mode]];
}

// --- copy table (FR-CAT-013, LLD-API "Card shapes and the copy table") ---

export interface CopyRow {
  c: Candidate;
  expectedPlayability: 'direct_play' | 'transcode' | 'unavailable' | null;
  reasons: ReasonCode[];
  selected: boolean;
}

/** Reasons emitted per copy: mode, HDR mismatch, resolution, server status (LLD-API table). */
function copyReasons(r: Ranked, maxH: number): ReasonCode[] {
  const out: ReasonCode[] = [...r.modeReasons];
  if (r.c.hdr !== 'none' && r.keys.hdr === 0) out.push('hdr_unsupported');
  if ((r.c.height ?? 0) > maxH) out.push('resolution_exceeds_device');
  if (r.c.serverStatus === 'degraded') out.push('server_degraded');
  return out.length > 0 ? out : [MODE_FALLBACK[r.mode]];
}

/**
 * One row per visible copy, ordered like the selection ranking, with unreachable copies last.
 * `selected` marks exactly the copy `select` would pick with default preferences, so the table
 * and the Play button agree. Without capabilities the prediction is null.
 */
export function copyTable(visible: Candidate[], caps: DeviceCapabilities | null): CopyRow[] {
  const known = caps !== null;
  const effective: DeviceCapabilities = caps ?? {
    containers: [],
    video: [],
    audio: [],
    hdr: [],
    textSubtitles: [],
    nativeHls: false,
    mse: false,
  };
  const prefs: SelectionPrefs = {};
  const playable = visible.filter((c) => PLAYABLE_STATUS.has(c.serverStatus));
  const unreachable = visible.filter((c) => !PLAYABLE_STATUS.has(c.serverStatus));
  const maxH = effectiveMaxHeight(effective, prefs);
  const ranked = rankAll(playable, effective, prefs);
  const rows: CopyRow[] = ranked.map((r, i) => ({
    c: r.c,
    expectedPlayability: known ? (r.mode === 'transcode' ? 'transcode' : 'direct_play') : null,
    reasons: known ? copyReasons(r, maxH) : [],
    selected: i === 0,
  }));
  for (const r of rankAll(unreachable, effective, prefs)) {
    rows.push({
      c: r.c,
      expectedPlayability: known ? 'unavailable' : null,
      reasons: known ? ['server_unreachable'] : [],
      selected: false,
    });
  }
  return rows;
}
