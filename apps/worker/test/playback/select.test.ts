// T3.2: source selection (BR-5, LLD-SEL; FR-PLAY-003, FR-PLAY-004, FR-PLAY-005, FR-PLAY-010,
// FR-SRV-006). A fixture-driven table over the pure selection functions, including the LLD-SEL
// worked example (Interstellar on three servers) and the exclusion/failover request.
import { must } from './util';
import { describe, expect, it } from 'vitest';
import {
  copyTable,
  predictMode,
  rankAll,
  reasonsFor,
  selectCandidates,
  type Candidate,
  type SelectionPrefs,
} from '../../src/playback/select';
import { pickNextEpisode, reachesWatched, resumePosition } from '../../src/playback/progress';
import type { DeviceCapabilities } from '../../src/providers/types';

function cand(over: Partial<Candidate> & { sourceId: string }): Candidate {
  return {
    versionId: `${over.sourceId}-v`,
    providerItemId: `p-${over.sourceId}`,
    providerVersionId: `pv-${over.sourceId}`,
    serverId: `srv-${over.sourceId}`,
    serverName: `Server ${over.sourceId}`,
    serverType: 'emby',
    serverStatus: 'active',
    priority: 0,
    latencyMs: null,
    container: 'mp4',
    videoCodec: 'h264',
    width: 1920,
    height: 1080,
    hdr: 'none',
    sizeBytes: null,
    runtimeMs: 7_200_000,
    audio: [{ index: 1, codec: 'aac', channels: 2, language: 'en', title: null, default: true }],
    subtitles: [],
    ...over,
  };
}

const caps = (over: Partial<DeviceCapabilities> = {}): DeviceCapabilities => ({
  containers: ['mp4', 'webm'],
  video: [{ codec: 'h264' }, { codec: 'vp9' }, { codec: 'av1' }],
  audio: ['aac', 'mp3', 'opus'],
  maxHeight: 1080,
  hdr: [],
  textSubtitles: ['vtt'],
  nativeHls: false,
  mse: true,
  ...over,
});

const ids = (r: { c: Candidate }[]) => r.map((x) => x.c.sourceId);

// --- the LLD-SEL worked example ---

const A = cand({
  sourceId: 'A',
  serverName: 'Server A',
  serverType: 'jellyfin',
  priority: 0,
  latencyMs: 40,
  height: 2160,
  width: 3840,
  videoCodec: 'hevc',
  hdr: 'hdr10',
  container: 'mp4',
  audio: [{ index: 1, codec: 'eac3', channels: 6, language: 'en', title: null, default: true }],
});
const B = cand({
  sourceId: 'B',
  serverName: 'Server B',
  serverType: 'plex',
  latencyMs: 25,
  height: 1080,
  videoCodec: 'h264',
  container: 'mp4',
});
const C = cand({
  sourceId: 'C',
  serverName: 'Server C',
  serverType: 'emby',
  priority: 5,
  serverStatus: 'degraded',
  latencyMs: 90,
  height: 2160,
  width: 3840,
  videoCodec: 'av1',
  container: 'mkv',
  audio: [{ index: 1, codec: 'opus', channels: 6, language: 'en', title: null, default: true }],
});

const viewer1 = caps(); // Chrome, 1080p SDR laptop
const viewer2 = caps({
  // Safari, 4K HDR display
  containers: ['mp4', 'hls'],
  video: [{ codec: 'h264' }, { codec: 'hevc' }],
  audio: ['aac', 'eac3'],
  maxHeight: 2160,
  hdr: ['hdr10'],
  nativeHls: true,
  mse: false,
});

describe('LLD-SEL worked example: Interstellar (2014) on three servers', () => {
  it('viewer 1 (Chrome, 1080p SDR): B direct play, then C direct stream, then A transcode', () => {
    const out = selectCandidates([A, B, C], viewer1, {});
    if (!out.ok) throw new Error('expected candidates');
    expect(ids(out.ranked)).toEqual(['B', 'C', 'A']);
    const [b, c, a] = out.ranked;
    expect(b?.mode).toBe('direct_play');
    expect(b?.keys).toMatchObject({ mode: 2, res: [1, 1080], hdr: 1, health: 1 });
    expect(c?.mode).toBe('direct_stream');
    expect(c?.modeReasons).toEqual(['direct_stream_container']); // AV1 ok, MKV not
    expect(c?.keys).toMatchObject({ mode: 1, res: [0, -2160], hdr: 1, health: 0 });
    expect(a?.mode).toBe('transcode');
    expect(a?.modeReasons).toEqual(['transcode_video_codec']); // HEVC unsupported
    expect(a?.keys).toMatchObject({ mode: 0, res: [0, -2160], hdr: 0, health: 1 });
    // Rule 1 decides; priority and latency are never consulted.
    expect(
      reasonsFor(must(b), {
        ranked: out.ranked,
        maxHeight: 1080,
        manual: false,
        failedBefore: false,
      }),
    ).toEqual(['direct_play']);
  });

  it('viewer 2 (Safari, 4K HDR), example as written (A on a direct-play provider): A, then B, then C', () => {
    const A2 = { ...A, serverType: 'emby' as const };
    const out = selectCandidates([A2, B, C], viewer2, {});
    if (!out.ok) throw new Error('expected candidates');
    expect(ids(out.ranked)).toEqual(['A', 'B', 'C']);
    const [a, b, c] = out.ranked;
    expect(a?.mode).toBe('direct_play');
    expect(b?.mode).toBe('direct_play');
    expect(a?.keys.res).toEqual([1, 2160]); // rule 2 prefers A's 2160p
    expect(b?.keys.hdr).toBe(0); // SDR on an HDR client
    expect(c?.mode).toBe('transcode'); // AV1 unsupported
    expect(
      reasonsFor(must(a), {
        ranked: out.ranked,
        maxHeight: 2160,
        manual: false,
        failedBefore: false,
      }),
    ).toEqual(['direct_play', 'hdr_match', 'highest_playable_resolution']);
  });

  it('viewer 2 with A timing out: B is next within the same request, explained as failover', () => {
    const A2 = { ...A, serverType: 'emby' as const };
    const out = selectCandidates([A2, B, C], viewer2, {});
    if (!out.ok) throw new Error('expected candidates');
    const b = must(out.ranked[1]);
    expect(
      reasonsFor(b, { ranked: out.ranked, maxHeight: 2160, manual: false, failedBefore: true }),
    ).toEqual(['direct_play', 'failover']);
  });

  it('viewer 2 with A on Jellyfin (forced HLS, ADR-0013): A is a remux, so B direct play ranks first', () => {
    // Owner decision 2026-10-04: Jellyfin never yields direct_play. Under the LLD-SEL ranking a
    // Jellyfin remux (mode 1) ranks below another server's direct play (mode 2).
    const out = selectCandidates([A, B, C], viewer2, {});
    if (!out.ok) throw new Error('expected candidates');
    expect(ids(out.ranked)).toEqual(['B', 'A', 'C']);
    expect(out.ranked[1]?.mode).toBe('direct_stream');
    expect(out.ranked[1]?.modeReasons).toEqual(['remux_for_token_auth']);
  });
});

// --- filter: exclusions, server status, manual choice (FR-PLAY-004, FR-PLAY-005) ---

describe('BR-5 filter', () => {
  it('a replacement request excluding the failed source returns the next candidate', () => {
    const out = selectCandidates([A, B, C], viewer1, {}, ['B']);
    if (!out.ok) throw new Error('expected candidates');
    expect(out.excluded).toBe(true);
    expect(ids(out.ranked)).toEqual(['C', 'A']);
    expect(
      reasonsFor(must(out.ranked[0]), {
        ranked: out.ranked,
        maxHeight: 1080,
        manual: false,
        failedBefore: out.excluded,
      }),
    ).toContain('failover');
  });

  it('excluding every source is NO_PLAYABLE_SOURCE (none_available)', () => {
    expect(selectCandidates([A, B, C], viewer1, {}, ['A', 'B', 'C'])).toEqual({
      ok: false,
      error: 'no_playable',
      reason: 'none_available',
    });
  });

  it('only unreachable servers left is NO_PLAYABLE_SOURCE (servers_unreachable)', () => {
    const down = { ...B, serverStatus: 'unreachable' };
    expect(selectCandidates([down], viewer1, {})).toEqual({
      ok: false,
      error: 'no_playable',
      reason: 'servers_unreachable',
    });
    const out = selectCandidates([down, A], viewer1, {});
    expect(out.ok && ids(out.ranked)).toEqual(['A']);
  });

  it('a manual version choice overrides the ranking and is explained as user_selected', () => {
    const prefs: SelectionPrefs = { versionId: 'A-v' };
    const out = selectCandidates([A, B, C], viewer1, prefs);
    if (!out.ok) throw new Error('expected candidates');
    expect(ids(out.ranked)).toEqual(['A']);
    expect(
      reasonsFor(must(out.ranked[0]), {
        ranked: out.ranked,
        maxHeight: 1080,
        manual: true,
        failedBefore: false,
      }),
    ).toEqual([
      'transcode_video_codec',
      'hdr_unsupported',
      'resolution_exceeds_device',
      'user_selected',
    ]);
  });

  it('a manual choice that matches nothing visible is not_found (404)', () => {
    expect(selectCandidates([A, B], viewer1, { sourceId: 'hidden' })).toEqual({
      ok: false,
      error: 'not_found',
    });
  });

  it('a manual choice on an unreachable server says so instead of choosing another', () => {
    const down = { ...B, serverStatus: 'unreachable' };
    expect(selectCandidates([A, down], viewer1, { sourceId: 'B' })).toEqual({
      ok: false,
      error: 'no_playable',
      reason: 'servers_unreachable',
    });
  });
});

// --- ranking table: rules 1 to 7 ---

interface Row {
  name: string;
  cands: Candidate[];
  caps?: Partial<DeviceCapabilities>;
  prefs?: SelectionPrefs;
  order: string[];
  topReasons: string[];
}

const ROWS: Row[] = [
  {
    name: 'rule 1: direct play beats direct stream beats transcode',
    cands: [
      cand({ sourceId: 't', videoCodec: 'hevc' }),
      cand({ sourceId: 's', container: 'mkv' }),
      cand({ sourceId: 'p' }),
    ],
    order: ['p', 's', 't'],
    topReasons: ['direct_play'],
  },
  {
    name: 'rule 1 with an unsupported audio codec: direct stream with audio transcoded',
    cands: [
      cand({
        sourceId: 'x',
        audio: [
          { index: 1, codec: 'dts', channels: 6, language: 'en', title: null, default: true },
        ],
      }),
    ],
    order: ['x'],
    topReasons: ['audio_transcoded'],
  },
  {
    name: 'rule 2: the tallest copy within the device limit wins, over a taller copy beyond it',
    cands: [
      cand({ sourceId: 'h720', height: 720 }),
      cand({ sourceId: 'h2160', height: 2160 }),
      cand({ sourceId: 'h1080', height: 1080 }),
    ],
    order: ['h1080', 'h720', 'h2160'],
    topReasons: ['direct_play', 'highest_playable_resolution'],
  },
  {
    name: "rule 2: the user's quality preference lowers the limit",
    cands: [cand({ sourceId: 'h720', height: 720 }), cand({ sourceId: 'h1080', height: 1080 })],
    prefs: { maxHeight: 720 },
    order: ['h720', 'h1080'],
    topReasons: ['direct_play'],
  },
  {
    name: 'rule 2: beyond the limit, the copy closest to it ranks first',
    cands: [cand({ sourceId: 'h2160', height: 2160 }), cand({ sourceId: 'h1440', height: 1440 })],
    order: ['h1440', 'h2160'],
    topReasons: ['direct_play', 'resolution_exceeds_device'],
  },
  {
    name: 'rule 3: HDR match on an HDR display',
    caps: { hdr: ['hdr10'], maxHeight: 2160 },
    cands: [cand({ sourceId: 'sdr' }), cand({ sourceId: 'hdr', hdr: 'hdr10' })],
    order: ['hdr', 'sdr'],
    topReasons: ['direct_play', 'hdr_match'],
  },
  {
    name: 'rule 3: SDR preferred on an SDR display',
    cands: [cand({ sourceId: 'hdr', hdr: 'dolby_vision' }), cand({ sourceId: 'sdr' })],
    order: ['sdr', 'hdr'],
    topReasons: ['direct_play'],
  },
  {
    name: 'rule 4: active beats degraded',
    cands: [
      cand({ sourceId: 'deg', serverStatus: 'degraded', priority: 9 }),
      cand({ sourceId: 'act' }),
    ],
    order: ['act', 'deg'],
    topReasons: ['direct_play'],
  },
  {
    name: 'rule 5: operator priority breaks the tie (FR-SRV-006)',
    cands: [cand({ sourceId: 'lo', priority: 1 }), cand({ sourceId: 'hi', priority: 7 })],
    order: ['hi', 'lo'],
    topReasons: ['direct_play', 'server_priority'],
  },
  {
    name: 'rule 6: lower latency breaks a priority tie; unknown latency sorts last',
    cands: [
      cand({ sourceId: 'unknown', latencyMs: null }),
      cand({ sourceId: 'slow', latencyMs: 120 }),
      cand({ sourceId: 'fast', latencyMs: 30 }),
    ],
    order: ['fast', 'slow', 'unknown'],
    topReasons: ['direct_play', 'server_latency'],
  },
  {
    name: 'rule 7: source ID is the stable final tie-break',
    cands: [cand({ sourceId: 'zz' }), cand({ sourceId: 'aa' })],
    order: ['aa', 'zz'],
    topReasons: ['direct_play'],
  },
  {
    name: 'a degraded winner carries server_degraded',
    cands: [
      cand({ sourceId: 'deg', serverStatus: 'degraded' }),
      cand({ sourceId: 't', videoCodec: 'mpeg2video' }),
    ],
    order: ['deg', 't'],
    topReasons: ['direct_play', 'server_degraded'],
  },
  {
    name: 'an image subtitle forces burn-in (FR-PLAY-006)',
    prefs: { subtitle: { mode: 'track', index: 4 } },
    cands: [
      cand({
        sourceId: 'pgs',
        subtitles: [
          {
            index: 4,
            format: 'pgssub',
            kind: 'image',
            language: 'en',
            title: null,
            forced: false,
            default: false,
          },
        ],
      }),
    ],
    order: ['pgs'],
    topReasons: ['subtitle_burn_in'],
  },
  {
    name: 'Jellyfin never predicts direct play; its all-supported copy is a token-gated remux',
    cands: [cand({ sourceId: 'jf', serverType: 'jellyfin' })],
    order: ['jf'],
    topReasons: ['remux_for_token_auth'],
  },
  {
    name: 'without MSE or native HLS a container mismatch needs a transcode',
    caps: { mse: false, nativeHls: false },
    cands: [cand({ sourceId: 'mkv', container: 'mkv' })],
    order: ['mkv'],
    topReasons: ['transcode_video_codec'],
  },
];

describe('BR-5 ranking table', () => {
  for (const row of ROWS) {
    it(row.name, () => {
      const c = caps(row.caps);
      const prefs = row.prefs ?? {};
      const out = selectCandidates(row.cands, c, prefs);
      if (!out.ok) throw new Error('expected candidates');
      expect(ids(out.ranked)).toEqual(row.order);
      expect(
        reasonsFor(must(out.ranked[0]), {
          ranked: out.ranked,
          maxHeight: out.maxHeight,
          manual: out.manual,
          failedBefore: false,
        }),
      ).toEqual(row.topReasons);
    });
  }

  it('is deterministic whatever the input order', () => {
    const cands = ROWS.flatMap((r) => r.cands).map((x, i) => ({
      ...x,
      sourceId: `${x.sourceId}-${i}`,
    }));
    const forward = ids(rankAll(cands, caps(), {}));
    const backward = ids(rankAll([...cands].reverse(), caps(), {}));
    expect(backward).toEqual(forward);
  });

  it('reports origin_changed_mode when the negotiation disagrees with the prediction', () => {
    const out = selectCandidates([cand({ sourceId: 'p' })], caps(), {});
    if (!out.ok) throw new Error('expected candidates');
    expect(
      reasonsFor(must(out.ranked[0]), {
        ranked: out.ranked,
        maxHeight: 1080,
        manual: false,
        failedBefore: false,
        actualMode: 'transcode',
      }),
    ).toEqual(['direct_play', 'origin_changed_mode']);
  });
});

describe('track choice', () => {
  const multi = cand({
    sourceId: 'm',
    audio: [
      { index: 1, codec: 'aac', channels: 2, language: 'eng', title: null, default: true },
      { index: 2, codec: 'aac', channels: 2, language: 'fre', title: null, default: false },
    ],
    subtitles: [
      {
        index: 3,
        format: 'pgssub',
        kind: 'image',
        language: 'fr',
        title: null,
        forced: false,
        default: false,
      },
      {
        index: 4,
        format: 'subrip',
        kind: 'text',
        language: 'fr',
        title: null,
        forced: false,
        default: false,
      },
    ],
  });

  it('picks audio by language (ISO 639-1 against 639-2), else the default', () => {
    expect(predictMode(multi, caps(), { audioLanguage: 'fr' }).audio?.index).toBe(2);
    expect(predictMode(multi, caps(), {}).audio?.index).toBe(1);
    expect(predictMode(multi, caps(), { audioIndex: 2 }).audio?.index).toBe(2);
  });

  it('prefers a text subtitle in the requested language, so no burn-in is needed', () => {
    const p = predictMode(multi, caps(), { subtitle: { mode: 'language', language: 'fr' } });
    expect(p.subtitle?.index).toBe(4);
    expect(p.mode).toBe('direct_play');
  });
});

describe('copy table (FR-CAT-013)', () => {
  it('marks the copy select would pick and predicts playability per copy', () => {
    const down = cand({ sourceId: 'down', serverStatus: 'unreachable', height: 2160 });
    const rows = copyTable([A, B, C, down], viewer1);
    expect(rows.map((r) => r.c.sourceId)).toEqual(['B', 'C', 'A', 'down']);
    expect(rows.map((r) => r.selected)).toEqual([true, false, false, false]);
    expect(rows.map((r) => r.expectedPlayability)).toEqual([
      'direct_play',
      'direct_play', // direct_stream is reported as direct_play
      'transcode',
      'unavailable',
    ]);
    expect(rows[2]?.reasons).toEqual([
      'transcode_video_codec',
      'hdr_unsupported',
      'resolution_exceeds_device',
    ]);
    expect(rows[1]?.reasons).toEqual([
      'direct_stream_container',
      'resolution_exceeds_device',
      'server_degraded',
    ]);
    expect(rows[3]?.reasons).toEqual(['server_unreachable']);
    // The same pick as selection with default preferences.
    const sel = selectCandidates([A, B, C, down], viewer1, {});
    expect(sel.ok && sel.ranked[0]?.c.sourceId).toBe('B');
  });

  it('has null playability and no reasons without device capabilities', () => {
    const rows = copyTable([A, B], null);
    expect(rows.every((r) => r.expectedPlayability === null && r.reasons.length === 0)).toBe(true);
    expect(rows.filter((r) => r.selected)).toHaveLength(1);
  });
});

describe('BR-7 and FR-PROG-004 helpers', () => {
  it('marks watched at 90 %, or with under 5 minutes left on items over 45 minutes', () => {
    expect(reachesWatched(89_000, 100_000)).toBe(false);
    expect(reachesWatched(90_000, 100_000)).toBe(true);
    // 48 minutes: 90 % is 43.2 min, but under 5 minutes left already counts from 43 min.
    const min48 = 48 * 60_000;
    expect(reachesWatched(42.9 * 60_000, min48)).toBe(false);
    expect(reachesWatched(43.1 * 60_000, min48)).toBe(true);
    // Two hours: the 90 % rule (108 min) fires first.
    expect(reachesWatched(107 * 60_000, 7_200_000)).toBe(false);
    expect(reachesWatched(108 * 60_000, 7_200_000)).toBe(true);
    // 40-minute episode: the 5-minute rule does not apply.
    expect(reachesWatched(36 * 60_000, 40 * 60_000)).toBe(true);
    expect(reachesWatched(35 * 60_000, 40 * 60_000)).toBe(false);
    expect(reachesWatched(10_000_000, null)).toBe(false);
  });

  it('offers resume above 60 s on an unwatched item only', () => {
    expect(resumePosition({ position_ms: 61_000, watched: 0 }, 60_000)).toBe(61_000);
    expect(resumePosition({ position_ms: 59_000, watched: 0 }, 60_000)).toBeNull();
    expect(resumePosition({ position_ms: 0, watched: 1 }, 60_000)).toBeNull();
    expect(resumePosition(null, 60_000)).toBeNull();
  });

  const ep = (id: string, season: number, episode: number, p?: [number, number, number]) => ({
    id,
    season,
    episode,
    watched: p ? p[0] : null,
    position_ms: p ? p[1] : null,
    updated_at: p ? p[2] : null,
  });

  it('next episode: first after the last watched; the in-progress one if unfinished', () => {
    const list = [
      ep('e1', 1, 1, [1, 0, 10]),
      ep('e2', 1, 2, [1, 0, 20]),
      ep('e3', 1, 3),
      ep('e4', 2, 1),
    ];
    expect(pickNextEpisode(list)).toBe('e3');
    expect(
      pickNextEpisode([
        ep('e1', 1, 1, [1, 0, 10]),
        ep('e2', 1, 2, [0, 500_000, 30]),
        ep('e3', 1, 3),
      ]),
    ).toBe('e2');
    expect(pickNextEpisode([ep('e1', 1, 1), ep('e2', 1, 2)])).toBe('e1');
    // The last watched (by time) decides, not the furthest.
    expect(
      pickNextEpisode([ep('e1', 1, 1, [1, 0, 50]), ep('e2', 1, 2), ep('e3', 1, 3, [1, 0, 10])]),
    ).toBe('e2');
    expect(pickNextEpisode([ep('e1', 1, 1, [1, 0, 10]), ep('e2', 1, 2, [1, 0, 20])])).toBeNull();
    expect(pickNextEpisode([])).toBeNull();
  });
});
