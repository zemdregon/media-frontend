// T3.1: capability detection over mocked browser APIs for representative browsers (FR-PLAY-002).
import { afterEach, expect, it, vi } from 'vitest';
import {
  browserEnv,
  detectCapabilities,
  encodeCapsHeader,
  getCapabilities,
  resetCapabilitiesCache,
  type CapabilityEnv,
} from './capabilities';

/** Builds an env from the codec strings a browser claims to support. */
function env(opts: {
  mp4?: string[];
  webm?: string[];
  nativeHls?: boolean;
  mse?: boolean;
  decode?: (contentType: string, width: number, extra: Record<string, string>) => boolean;
  screen?: [number, number, number];
  hdrDisplay?: boolean;
  noMediaCapabilities?: boolean;
}): CapabilityEnv {
  const supported = new Set([...(opts.mp4 ?? []), ...(opts.webm ?? [])]);
  const canPlay = (mime: string) => {
    if (mime === 'application/vnd.apple.mpegurl') return opts.nativeHls ? 'maybe' : '';
    if (mime === 'video/mp4') return (opts.mp4?.length ?? 0) > 0 ? 'maybe' : '';
    if (mime === 'video/webm') return (opts.webm?.length ?? 0) > 0 ? 'maybe' : '';
    if (mime === 'video/x-matroska') return '';
    return supported.has(mime) ? 'probably' : '';
  };
  const [w, h, dpr] = opts.screen ?? [1920, 1080, 1];
  return {
    canPlayType: canPlay,
    isTypeSupported: opts.mse === false ? null : (mime) => supported.has(mime),
    mediaCapabilities: opts.noMediaCapabilities
      ? null
      : {
          decodingInfo: (cfg) => {
            const v = (cfg as { video: Record<string, string | number> }).video;
            const { contentType, width, ...extra } = v;
            return Promise.resolve({
              supported: opts.decode?.(String(contentType), Number(width), extra as never) ?? false,
            });
          },
        },
    screenWidth: w,
    screenHeight: h,
    pixelRatio: dpr,
    hdrDisplay: opts.hdrDisplay ?? false,
  };
}

const H264 = 'video/mp4; codecs="avc1.640033"'; // level 5.1
const H264_42 = 'video/mp4; codecs="avc1.64002a"';
const HEVC = 'video/mp4; codecs="hvc1.2.4.L153.B0"';
const VP9 = 'video/webm; codecs="vp09.00.40.08"';
const AV1 = 'video/mp4; codecs="av01.0.08M.10"';
const AAC = 'audio/mp4; codecs="mp4a.40.2"';
const OPUS = 'audio/webm; codecs="opus"';
const FLAC = 'audio/mp4; codecs="flac"';
const EAC3 = 'audio/mp4; codecs="ec-3"';
const AC3 = 'audio/mp4; codecs="ac-3"';

afterEach(() => {
  resetCapabilitiesCache();
  vi.unstubAllGlobals();
});

it('Chrome-like desktop: MSE, no native HLS, h264/vp9/av1 and an SDR 1080p screen', async () => {
  const caps = await detectCapabilities(
    env({
      mp4: [H264, AV1, AAC, FLAC, 'audio/mpeg'],
      webm: [VP9, OPUS],
      mse: true,
      decode: (_t, width) => width <= 3840,
      screen: [1920, 1080, 1],
    }),
  );
  expect(caps.mse).toBe(true);
  expect(caps.nativeHls).toBe(false);
  expect(caps.containers).toEqual(['mp4', 'webm', 'hls']);
  expect(caps.video.map((v) => v.codec)).toEqual(['h264', 'vp9', 'av1']);
  expect(caps.video[0]).toMatchObject({ codec: 'h264', maxLevel: '5.1', maxHeight: 2160 });
  expect(caps.audio).toEqual(['aac', 'mp3', 'opus', 'flac']);
  expect(caps.hdr).toEqual([]);
  expect(caps.maxWidth).toBe(1920);
  expect(caps.maxHeight).toBe(1080);
  expect(caps.textSubtitles).toEqual(['vtt']);
});

it('Safari-like: native HLS and no MSE, with HEVC, Dolby audio and an HDR display', async () => {
  const caps = await detectCapabilities(
    env({
      mp4: [H264_42, HEVC, AAC, AC3, EAC3, 'audio/mpeg', 'video/mp4; codecs="dvh1.05.06"'],
      nativeHls: true,
      mse: false,
      hdrDisplay: true,
      decode: (t, _w, extra) => t === HEVC && extra.transferFunction !== 'hlg',
      screen: [1512, 982, 2],
    }),
  );
  expect(caps.nativeHls).toBe(true);
  expect(caps.mse).toBe(false);
  expect(caps.containers).toEqual(['mp4', 'hls']);
  expect(caps.video[0]).toMatchObject({ codec: 'h264', maxLevel: '4.2' });
  expect(caps.video.map((v) => v.codec)).toContain('hevc');
  expect(caps.audio).toEqual(['aac', 'mp3', 'ac3', 'eac3']);
  expect(caps.hdr).toEqual(['hdr10', 'dolby_vision']);
  expect(caps.maxWidth).toBe(3024);
  expect(caps.maxHeight).toBe(1964);
});

it('Firefox-like: no HEVC, no HDR, no MediaCapabilities refinement', async () => {
  const caps = await detectCapabilities(
    env({
      mp4: [H264, AAC, 'audio/mpeg'],
      webm: [VP9, OPUS],
      noMediaCapabilities: true,
      hdrDisplay: true,
    }),
  );
  expect(caps.video).toEqual([{ codec: 'h264', maxLevel: '5.1' }, { codec: 'vp9' }]);
  expect(caps.video.every((v) => v.maxHeight === undefined)).toBe(true);
  expect(caps.hdr).toEqual([]);
});

it('a failing MediaCapabilities call degrades to codec support only', async () => {
  const e = env({ mp4: [H264, AAC] });
  e.mediaCapabilities = { decodingInfo: () => Promise.reject(new Error('boom')) };
  const caps = await detectCapabilities(e);
  expect(caps.video).toEqual([{ codec: 'h264', maxLevel: '5.1' }]);
});

it('the quality preference caps the maximum resolution', async () => {
  const caps = await detectCapabilities(env({ mp4: [H264], screen: [3840, 2160, 1] }), {
    maxHeightPreference: 1080,
  });
  expect(caps.maxHeight).toBe(1080);
  expect(caps.maxWidth).toBe(1920);
});

it('encodes X-Device-Caps as base64url JSON that round-trips and stays under 2 KB', async () => {
  const caps = await detectCapabilities(
    env({ mp4: [H264, HEVC, AV1, AAC, FLAC], webm: [VP9, OPUS], decode: () => true }),
  );
  const header = encodeCapsHeader(caps);
  expect(header).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(header.length).toBeLessThanOrEqual(2048);
  const json = atob(header.replace(/-/g, '+').replace(/_/g, '/'));
  expect(JSON.parse(json)).toEqual(caps);
});

it('trims optional detail when the payload would exceed 2 KB', () => {
  const caps = {
    containers: ['mp4'],
    video: Array.from({ length: 80 }, (_, i) => ({ codec: `codec${String(i)}`, maxLevel: '5.1' })),
    audio: ['aac'],
    maxWidth: 1920,
    maxHeight: 1080,
    hdr: [],
    textSubtitles: ['vtt'],
    nativeHls: false,
    mse: true,
  };
  expect(encodeCapsHeader(caps).length).toBeLessThanOrEqual(2048);
});

it('reads the real browser globals and caches the result for the page', async () => {
  vi.stubGlobal('MediaSource', { isTypeSupported: (m: string) => m === H264 });
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(dynamic-range: high)' }));
  const spy = vi
    .spyOn(HTMLMediaElement.prototype, 'canPlayType')
    .mockImplementation((m) => (m === 'video/mp4' ? 'maybe' : ''));
  const env1 = browserEnv();
  expect(env1.isTypeSupported?.(H264)).toBe(true);
  expect(env1.hdrDisplay).toBe(true);
  const first = await getCapabilities();
  const second = await getCapabilities();
  expect(second).toBe(first);
  expect(first.mse).toBe(true);
  expect(first.video[0]?.codec).toBe('h264');
  spy.mockRestore();
});
