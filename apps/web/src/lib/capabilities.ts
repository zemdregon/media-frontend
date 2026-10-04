/**
 * Device capability detection (FR-PLAY-002, TDD §11.1). Always live: the browser is probed with
 * `canPlayType`, `MediaSource.isTypeSupported` and MediaCapabilities; there is no per-browser table.
 */
import type { DeviceCapabilities } from '../api-client/playback-types';

export interface MediaCapabilitiesLike {
  decodingInfo(config: unknown): Promise<{ supported: boolean }>;
}

/** Everything detection reads from the browser, so tests can supply a mock. */
export interface CapabilityEnv {
  canPlayType: (mime: string) => string;
  isTypeSupported: ((mime: string) => boolean) | null;
  mediaCapabilities: MediaCapabilitiesLike | null;
  screenWidth: number;
  screenHeight: number;
  pixelRatio: number;
  hdrDisplay: boolean;
}

export function browserEnv(): CapabilityEnv {
  const video = typeof document === 'undefined' ? null : document.createElement('video');
  const ms = (globalThis as { MediaSource?: { isTypeSupported?: (m: string) => boolean } })
    .MediaSource;
  const nav = typeof navigator === 'undefined' ? null : navigator;
  const mc = (nav as { mediaCapabilities?: MediaCapabilitiesLike } | null)?.mediaCapabilities;
  return {
    canPlayType: (mime) => (video?.canPlayType ? video.canPlayType(mime) : ''),
    isTypeSupported: ms?.isTypeSupported ? (m) => ms.isTypeSupported?.(m) === true : null,
    mediaCapabilities: mc ?? null,
    screenWidth: typeof screen === 'undefined' ? 1920 : screen.width,
    screenHeight: typeof screen === 'undefined' ? 1080 : screen.height,
    pixelRatio: typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1,
    hdrDisplay:
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(dynamic-range: high)').matches,
  };
}

/** Candidate codec strings (TDD §11.1). */
const H264_LEVELS: [string, string][] = [
  ['5.2', 'avc1.640034'],
  ['5.1', 'avc1.640033'],
  ['5.0', 'avc1.640032'],
  ['4.2', 'avc1.64002a'],
  ['4.1', 'avc1.640029'],
  ['4.0', 'avc1.640028'],
];

const VIDEO_CODECS: { codec: string; mime: string; mc: string }[] = [
  {
    codec: 'hevc',
    mime: 'video/mp4; codecs="hvc1.2.4.L153.B0"',
    mc: 'video/mp4; codecs="hvc1.2.4.L153.B0"',
  },
  {
    codec: 'vp9',
    mime: 'video/webm; codecs="vp09.00.40.08"',
    mc: 'video/webm; codecs="vp09.00.40.08"',
  },
  {
    codec: 'av1',
    mime: 'video/mp4; codecs="av01.0.08M.10"',
    mc: 'video/mp4; codecs="av01.0.08M.10"',
  },
];

const AUDIO_CODECS: { codec: string; mime: string }[] = [
  { codec: 'aac', mime: 'audio/mp4; codecs="mp4a.40.2"' },
  { codec: 'mp3', mime: 'audio/mpeg' },
  { codec: 'opus', mime: 'audio/webm; codecs="opus"' },
  { codec: 'flac', mime: 'audio/mp4; codecs="flac"' },
  { codec: 'ac3', mime: 'audio/mp4; codecs="ac-3"' },
  { codec: 'eac3', mime: 'audio/mp4; codecs="ec-3"' },
];

const HLS_MIME = 'application/vnd.apple.mpegurl';

function supports(env: CapabilityEnv, mime: string): boolean {
  if (env.isTypeSupported?.(mime)) return true;
  return env.canPlayType(mime) !== '';
}

async function decodes(
  env: CapabilityEnv,
  contentType: string,
  width: number,
  height: number,
  extra: Record<string, string> = {},
): Promise<boolean> {
  if (!env.mediaCapabilities) return false;
  try {
    const info = await env.mediaCapabilities.decodingInfo({
      type: 'media-source',
      video: {
        contentType,
        width,
        height,
        bitrate: 20_000_000,
        framerate: 24,
        ...extra,
      },
    });
    return info.supported;
  } catch {
    return false;
  }
}

/** Builds the capability payload for this browser (LLD-API "Device capabilities"). */
export async function detectCapabilities(
  env: CapabilityEnv = browserEnv(),
  opts: { maxHeightPreference?: number | null } = {},
): Promise<DeviceCapabilities> {
  const nativeHls = env.canPlayType(HLS_MIME) !== '';
  const mse = env.isTypeSupported !== null;

  const containers: string[] = [];
  if (env.canPlayType('video/mp4') !== '') containers.push('mp4');
  if (env.canPlayType('video/webm') !== '') containers.push('webm');
  if (env.canPlayType('video/x-matroska') !== '') containers.push('mkv');
  if (nativeHls || mse) containers.push('hls');

  const video: DeviceCapabilities['video'] = [];
  const h264 = H264_LEVELS.find(([, mime]) => supports(env, `video/mp4; codecs="${mime}"`));
  if (h264) video.push({ codec: 'h264', maxLevel: h264[0] });
  for (const c of VIDEO_CODECS) {
    if (supports(env, c.mime)) video.push({ codec: c.codec });
  }

  // MediaCapabilities refines each codec's tallest decodable height (2160p, then 1080p).
  if (env.mediaCapabilities) {
    for (const entry of video) {
      const probe =
        entry.codec === 'h264'
          ? `video/mp4; codecs="${h264?.[1] ?? 'avc1.640028'}"`
          : (VIDEO_CODECS.find((c) => c.codec === entry.codec)?.mc ?? '');
      if (!probe) continue;
      if (await decodes(env, probe, 3840, 2160)) entry.maxHeight = 2160;
      else if (await decodes(env, probe, 1920, 1080)) entry.maxHeight = 1080;
    }
  }

  const audio = AUDIO_CODECS.filter((c) => supports(env, c.mime)).map((c) => c.codec);

  // HDR needs a display that can show it and a decoder that reports PQ or HLG support.
  const hdr: string[] = [];
  if (env.hdrDisplay) {
    const hevc = 'video/mp4; codecs="hvc1.2.4.L153.B0"';
    const av1 = 'video/mp4; codecs="av01.0.08M.10"';
    const pq = { transferFunction: 'pq', colorGamut: 'rec2020', hdrMetadataType: 'smpteSt2086' };
    const hlg = { transferFunction: 'hlg', colorGamut: 'rec2020', hdrMetadataType: 'smpteSt2086' };
    const anyOf = async (extra: Record<string, string>) =>
      (await decodes(env, hevc, 3840, 2160, extra)) || (await decodes(env, av1, 3840, 2160, extra));
    if (await anyOf(pq)) hdr.push('hdr10');
    if (await anyOf(hlg)) hdr.push('hlg');
    if (supports(env, 'video/mp4; codecs="dvh1.05.06"')) hdr.push('dolby_vision');
  }

  const pr = env.pixelRatio > 0 ? env.pixelRatio : 1;
  let maxWidth = Math.round(env.screenWidth * pr);
  let maxHeight = Math.round(env.screenHeight * pr);
  const pref = opts.maxHeightPreference;
  if (pref && pref > 0 && pref < maxHeight) {
    maxWidth = Math.round((maxWidth * pref) / maxHeight);
    maxHeight = pref;
  }

  return {
    containers,
    video,
    audio,
    maxWidth,
    maxHeight,
    hdr,
    textSubtitles: ['vtt'],
    nativeHls,
    mse,
  };
}

let cached: Promise<DeviceCapabilities> | null = null;

/** Detected once per page load and kept in memory (TDD §11.1). */
export function getCapabilities(): Promise<DeviceCapabilities> {
  cached ??= detectCapabilities().catch(() => FALLBACK);
  return cached;
}

export function resetCapabilitiesCache(): void {
  cached = null;
}

/** What we send when detection itself fails: the baseline every supported browser plays. */
const FALLBACK: DeviceCapabilities = {
  containers: ['mp4'],
  video: [{ codec: 'h264' }],
  audio: ['aac'],
  maxWidth: 1920,
  maxHeight: 1080,
  hdr: [],
  textSubtitles: ['vtt'],
  nativeHls: false,
  mse: false,
};

const HEADER_LIMIT = 2048;

function b64url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** `X-Device-Caps` value: base64url JSON, at most 2 KB (LLD-API); trims optional detail if needed. */
export function encodeCapsHeader(caps: DeviceCapabilities): string {
  let out = b64url(JSON.stringify(caps));
  if (out.length <= HEADER_LIMIT) return out;
  const slim: DeviceCapabilities = {
    ...caps,
    video: caps.video.map((v) => ({ codec: v.codec })),
  };
  out = b64url(JSON.stringify(slim));
  return out.length <= HEADER_LIMIT ? out : b64url(JSON.stringify(FALLBACK));
}

export async function capsHeaders(): Promise<Record<string, string>> {
  return { 'X-Device-Caps': encodeCapsHeader(await getCapabilities()) };
}
