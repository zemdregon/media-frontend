// T3.4, T3.5, T3.7 component tests: player states, track switching, failover, resume prompt,
// progress events, continue watching, watched state and the copies picker on the title page.
// The API is a stubbed `fetch` that follows LLD-API; media elements are stubbed (jsdom has none).
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PlaybackDescriptor } from '@cinewren/shared';
import { resetCapabilitiesCache } from '../lib/capabilities';
import {
  card,
  copyRow,
  descriptor,
  detail,
  page,
  renderApp,
  viewer,
  type Handler,
} from '../test-utils';

const hls = vi.hoisted(() => ({
  supported: true,
  instances: [] as {
    loadSource: ReturnType<typeof vi.fn>;
    attachMedia: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    fire: (event: string, data: unknown) => void;
  }[],
}));
vi.mock('hls.js', () => {
  class FakeHls {
    static Events = { ERROR: 'hlsError' };
    static ErrorTypes = { MEDIA_ERROR: 'mediaError', NETWORK_ERROR: 'networkError' };
    static isSupported = () => hls.supported;
    handlers: Record<string, (e: string, d: unknown) => void> = {};
    loadSource = vi.fn();
    attachMedia = vi.fn();
    destroy = vi.fn();
    recoverMediaError = vi.fn();
    constructor() {
      hls.instances.push({
        loadSource: this.loadSource,
        attachMedia: this.attachMedia,
        destroy: this.destroy,
        fire: (event, data) => this.handlers[event]?.(event, data),
      });
    }
    on(event: string, fn: (e: string, d: unknown) => void) {
      this.handlers[event] = fn;
    }
  }
  return { default: FakeHls };
});

// ---- media element stubs ----
const state = new WeakMap<HTMLMediaElement, { time: number; paused: boolean }>();
const st = (el: HTMLMediaElement) => {
  let s = state.get(el);
  if (!s) state.set(el, (s = { time: 0, paused: true }));
  return s;
};
let nativeHls = false;
const beacon = vi.fn(() => true);
const play = vi.fn(function (this: HTMLMediaElement) {
  st(this).paused = false;
  return Promise.resolve();
});
const pause = vi.fn(function (this: HTMLMediaElement) {
  st(this).paused = true;
});

beforeEach(() => {
  hls.supported = true;
  hls.instances.length = 0;
  nativeHls = false;
  play.mockClear();
  pause.mockClear();
  beacon.mockClear();
  Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true });
  Object.defineProperty(HTMLMediaElement.prototype, 'play', { value: play, configurable: true });
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', { value: pause, configurable: true });
  Object.defineProperty(HTMLMediaElement.prototype, 'canPlayType', {
    configurable: true,
    value: (m: string) => (m === 'application/vnd.apple.mpegurl' && nativeHls ? 'maybe' : ''),
  });
  Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
    configurable: true,
    get() {
      return st(this as HTMLMediaElement).time;
    },
    set(v: number) {
      st(this as HTMLMediaElement).time = v;
    },
  });
  Object.defineProperty(HTMLMediaElement.prototype, 'paused', {
    configurable: true,
    get() {
      return st(this as HTMLMediaElement).paused;
    },
  });
  // jsdom has no TextTrack on <track>; give each element one so modes can be observed.
  Object.defineProperty(HTMLTrackElement.prototype, 'track', {
    configurable: true,
    get() {
      const el = this as HTMLTrackElement & { _t?: { mode: string } };
      return (el._t ??= { mode: 'disabled' });
    },
  });
  resetCapabilitiesCache();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---- helpers ----
interface Body {
  [k: string]: unknown;
  preferences?: Record<string, unknown>;
}
type Fetch = ReturnType<typeof renderApp>;
const calls = (f: Fetch, method: string, path: string) =>
  f.mock.calls
    .filter(([u, init]) => u === `/api/v1${path}` && (init?.method ?? 'GET') === method)
    .map(([, init]) => ({
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Body) : null,
      headers: (init?.headers ?? {}) as Record<string, string>,
    }));
const events = (f: Fetch, sessionId = 'ps1') =>
  calls(f, 'POST', `/play/${sessionId}/events`).map((c) => c.body as Record<string, unknown>);

function player(
  d: PlaybackDescriptor | ((n: number, body: Body) => [number, unknown]),
  extra: Handler = () => undefined,
  path = '/watch/m1',
) {
  let n = 0;
  return renderApp(path, viewer, (m, p, b) => {
    if (m === 'POST' && p === '/play') {
      n++;
      return typeof d === 'function' ? d(n, b as Body) : [201, d];
    }
    if (m === 'POST' && p.endsWith('/events')) return [204, null];
    return extra(m, p, b);
  });
}
const video = () => document.querySelector('video') as HTMLVideoElement;
const ready = () => screen.findByLabelText('Seek');

// ---- player: start ----
it('direct play: requests play with capabilities and an idempotency key, then plays the descriptor URL', async () => {
  const f = player(descriptor());
  await ready();
  const [req] = calls(f, 'POST', '/play');
  expect(req?.headers['Idempotency-Key']).toBeTruthy();
  expect(req?.body).toMatchObject({
    itemId: 'm1',
    excludeSourceIds: [],
    replacesSessionId: null,
    preferences: { subtitle: { mode: 'off' }, sourceId: null, versionId: null },
    capabilities: { textSubtitles: ['vtt'] },
  });
  expect(req?.body?.capabilities).toHaveProperty('containers');
  expect(req?.body?.capabilities).toHaveProperty('maxHeight');
  expect(video().getAttribute('src')).toBe('https://media-a.example.net/stream/m1.mp4?token=t1');
  expect(video().getAttribute('crossorigin')).toBe('anonymous');
  expect(hls.instances).toHaveLength(0);
  expect(screen.getByRole('heading', { level: 1, name: 'Metropolis' })).toBeInTheDocument();
  expect(play).toHaveBeenCalled();
  expect(screen.getByText('Buffering')).toBeInTheDocument();
});

it('HLS uses hls.js where the browser has MSE but no native HLS', async () => {
  player(
    descriptor({
      mode: 'transcode',
      streamType: 'hls',
      streamUrl: 'https://media-a.example.net/master.m3u8?token=t',
    }),
  );
  await ready();
  await waitFor(() => {
    expect(hls.instances).toHaveLength(1);
  });
  expect(hls.instances[0]?.loadSource).toHaveBeenCalledWith(
    'https://media-a.example.net/master.m3u8?token=t',
  );
  expect(hls.instances[0]?.attachMedia).toHaveBeenCalledWith(video());
  expect(video().getAttribute('src')).toBeNull();
});

it('HLS plays natively where the browser supports it (Safari), without loading hls.js', async () => {
  nativeHls = true;
  player(
    descriptor({
      streamType: 'hls',
      streamUrl: 'https://media-a.example.net/master.m3u8?token=t',
    }),
  );
  await ready();
  expect(video().getAttribute('src')).toBe('https://media-a.example.net/master.m3u8?token=t');
  expect(hls.instances).toHaveLength(0);
});

it('a browser with neither MSE nor native HLS reports an unsupported error with a recovery path', async () => {
  hls.supported = false;
  player(descriptor({ streamType: 'hls', alternatives: 0 }));
  expect(
    await screen.findByRole('heading', { name: 'This copy did not start' }),
  ).toBeInTheDocument();
  expect(screen.getByText(/no other copy to try/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Try another copy' })).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Back to title' })).toHaveAttribute('href', '/items/m1');
});

// ---- player: events and progress ----
it('reports start, pause, seek-end and stop on unmount', async () => {
  const f = player(descriptor());
  await ready();
  fireEvent.playing(video());
  await waitFor(() => {
    expect(events(f)).toEqual([{ seq: 1, type: 'start', positionMs: 0 }]);
  });
  video().currentTime = 61;
  fireEvent.pause(video());
  fireEvent.seeked(video());
  await waitFor(() => {
    expect(events(f).map((e) => e.type)).toEqual(['start', 'pause', 'progress']);
  });
  expect(events(f)[1]).toMatchObject({ type: 'pause', positionMs: 61_000, seq: 2 });
  await userEvent.click(screen.getAllByRole('button', { name: /Back/ })[0] as HTMLElement);
  await waitFor(() => {
    expect(events(f).at(-1)).toMatchObject({ type: 'stop' });
  });
});

it('sends a progress beacon when the page is hidden', async () => {
  player(descriptor());
  await ready();
  fireEvent.playing(video());
  video().currentTime = 90;
  const original = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
  if (original) Object.defineProperty(document, 'visibilityState', original);
  else delete (document as { visibilityState?: string }).visibilityState;
  expect(beacon).toHaveBeenCalledTimes(1);
  const [url, blob] = beacon.mock.calls[0] as unknown as [string, Blob];
  expect(url).toBe('/api/v1/play/ps1/events');
  expect(JSON.parse(await blob.text())).toMatchObject({ type: 'progress', positionMs: 90_000 });
});

// ---- player: resume prompt ----
const resuming = () => descriptor({ resume: { positionMs: 3_605_000 } });

it('offers to resume from the stored position, and Resume starts there', async () => {
  player(resuming());
  const dialog = await screen.findByRole('dialog', { name: 'Pick up where you left off?' });
  expect(video()).toBeNull();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Resume from 1:00:05' }));
  await ready();
  fireEvent.loadedMetadata(video());
  expect(video().currentTime).toBe(3605);
});

it('Start over plays from the beginning', async () => {
  player(resuming());
  await userEvent.click(await screen.findByRole('button', { name: 'Start over' }));
  await ready();
  fireEvent.loadedMetadata(video());
  expect(video().currentTime).toBe(0);
});

it('does not prompt for a position under a minute, and Resume from the home hero skips the prompt', async () => {
  player(descriptor({ resume: { positionMs: 30_000 } }));
  await ready();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('?resume=1 resumes without the prompt', async () => {
  player(resuming(), () => undefined, '/watch/m1?resume=1');
  await ready();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.loadedMetadata(video());
  expect(video().currentTime).toBe(3605);
});

// ---- player: failover (FR-PLAY-004) ----
it('a media error shows the error panel; Try another copy re-requests play excluding the failed source', async () => {
  const second = descriptor({
    sessionId: 'ps2',
    source: { id: 's2', versionId: 'v2', serverName: 'Seedbox', label: '720p' },
    streamUrl: 'https://media-b.example.net/m1.mp4?token=t2',
    reasons: ['direct_play', 'failover'],
    alternatives: 0,
  });
  const f = player((n) => [201, n === 1 ? descriptor() : second]);
  await ready();
  fireEvent.playing(video());
  video().currentTime = 125;
  fireEvent.error(video());

  const panel = await screen.findByRole('alert');
  expect(within(panel).getByText('This copy did not start')).toBeInTheDocument();
  expect(within(panel).getByText(/Basement NAS could not play this copy/)).toBeInTheDocument();
  await waitFor(() => {
    const last = events(f).at(-1);
    expect(last?.type).toBe('error');
    expect(String(last?.errorCode)).toContain('media_error');
  });

  await userEvent.click(within(panel).getByRole('button', { name: 'Try another copy' }));
  await ready();
  const requests = calls(f, 'POST', '/play');
  expect(requests).toHaveLength(2);
  expect(requests[1]?.body).toMatchObject({
    excludeSourceIds: ['s1'],
    replacesSessionId: 'ps1',
    preferences: { sourceId: null, versionId: null },
  });
  expect(video().getAttribute('src')).toBe('https://media-b.example.net/m1.mp4?token=t2');
  fireEvent.loadedMetadata(video());
  expect(video().currentTime).toBe(125); // continues where it stopped
});

it('a second failure accumulates the exclude list', async () => {
  const mk = (n: number) =>
    descriptor({
      sessionId: `ps${String(n)}`,
      source: {
        id: `s${String(n)}`,
        versionId: 'v',
        serverName: `Server ${String(n)}`,
        label: 'x',
      },
    });
  const f = player((n) => [201, mk(n)]);
  await ready();
  fireEvent.error(video());
  await userEvent.click(await screen.findByRole('button', { name: 'Try another copy' }));
  await ready();
  fireEvent.error(video());
  await userEvent.click(await screen.findByRole('button', { name: 'Try another copy' }));
  await ready();
  expect(calls(f, 'POST', '/play')[2]?.body).toMatchObject({
    excludeSourceIds: ['s1', 's2'],
    replacesSessionId: 'ps2',
  });
});

it('shows an error when no copy can play, with Retry and Back to title', async () => {
  const f = player(() => [
    409,
    { error: { code: 'NO_PLAYABLE_SOURCE', message: 'No source.', requestId: 'r' } },
  ]);
  expect(
    await screen.findByRole('heading', { name: 'No copy can play right now' }),
  ).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Back to title' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Try another copy' })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => {
    expect(calls(f, 'POST', '/play')).toHaveLength(2);
  });
});

it('a copy that never starts fails over after the start timeout', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  player(descriptor());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50);
  });
  expect(screen.getByLabelText('Seek')).toBeInTheDocument();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });
  expect(screen.getByRole('heading', { name: 'This copy did not start' })).toBeInTheDocument();
  expect(screen.getByText(/start_timeout/)).toBeInTheDocument();
});

// ---- player: tracks (FR-PLAY-006) ----
const withTracks = () =>
  descriptor({
    audioTracks: [
      { index: 1, label: 'English 5.1 (AAC)', language: 'en', codec: 'aac', channels: 6, selected: true },
      { index: 2, label: 'Deutsch 2.0 (AAC)', language: 'de', codec: 'aac', channels: 2, selected: false },
    ],
    subtitleTracks: [
      {
        index: 3,
        label: 'English',
        language: 'en',
        kind: 'text',
        forced: false,
        url: 'https://media-a.example.net/s3.vtt?token=t',
        selected: false,
      },
      {
        index: 4,
        label: 'Français',
        language: 'fr',
        kind: 'text',
        forced: false,
        url: 'https://media-a.example.net/s4.vtt?token=t',
        selected: false,
      },
      {
        index: 5,
        label: 'Japanese (PGS)',
        language: 'ja',
        kind: 'image',
        forced: false,
        url: null,
        selected: false,
      },
    ],
  });
const tracksMenu = async () => {
  await userEvent.click(screen.getByRole('button', { name: 'Audio and subtitles' }));
  return screen.getByRole('group', { name: 'Audio and subtitles' });
};
const modes = () =>
  Array.from(document.querySelectorAll('track')).map(
    (t) => (t.track as unknown as { mode: string }).mode,
  );

it('renders WebVTT tracks and switches text subtitles in place, including Off', async () => {
  const f = player(withTracks());
  await ready();
  const els = document.querySelectorAll('track');
  expect(els).toHaveLength(2); // text tracks only; image tracks are burned in
  expect(els[0]).toHaveAttribute('src', 'https://media-a.example.net/s3.vtt?token=t');
  expect(els[0]).toHaveAttribute('kind', 'subtitles');
  expect(els[0]).toHaveAttribute('srclang', 'en');
  expect(els[1]).toHaveAttribute('label', 'Français');
  expect(modes()).toEqual(['disabled', 'disabled']);

  const menu = await tracksMenu();
  expect(within(menu).getByRole('radio', { name: 'Off' })).toBeChecked();
  await userEvent.click(within(menu).getByRole('radio', { name: 'Français' }));
  expect(modes()).toEqual(['disabled', 'showing']);
  expect(within(menu).getByRole('radio', { name: 'Français' })).toBeChecked();
  await userEvent.click(within(menu).getByRole('radio', { name: 'Off' }));
  expect(modes()).toEqual(['disabled', 'disabled']);
  expect(calls(f, 'POST', '/play')).toHaveLength(1); // no new request for text tracks
});

it('switching audio re-requests play for the same copy with the chosen track', async () => {
  const f = player((n) => [201, n === 1 ? withTracks() : descriptor({ sessionId: 'ps2' })]);
  await ready();
  fireEvent.playing(video());
  video().currentTime = 300;
  const menu = await tracksMenu();
  expect(within(menu).getByRole('radio', { name: 'English 5.1 (AAC)' })).toBeChecked();
  await userEvent.click(within(menu).getByRole('radio', { name: 'Deutsch 2.0 (AAC)' }));
  await waitFor(() => {
    expect(calls(f, 'POST', '/play')).toHaveLength(2);
  });
  expect(calls(f, 'POST', '/play')[1]?.body).toMatchObject({
    replacesSessionId: 'ps1',
    preferences: { audioLanguage: 'de', audioIndex: 2, sourceId: 's1', versionId: 'v1' },
  });
  await ready();
  fireEvent.loadedMetadata(video());
  expect(video().currentTime).toBe(300);
});

it('an image subtitle is burned in by a new request', async () => {
  const f = player((n) => [201, n === 1 ? withTracks() : descriptor({ sessionId: 'ps2' })]);
  await ready();
  const menu = await tracksMenu();
  await userEvent.click(within(menu).getByRole('radio', { name: 'Japanese (PGS) (burned in)' }));
  await waitFor(() => {
    expect(calls(f, 'POST', '/play')).toHaveLength(2);
  });
  expect(calls(f, 'POST', '/play')[1]?.body?.preferences?.subtitle).toEqual({
    mode: 'track',
    index: 5,
  });
});

it('keyboard: K toggles play, C toggles captions, M mutes, arrows seek', async () => {
  player(withTracks());
  await ready();
  const user = userEvent.setup();
  const region = screen.getByRole('region', { name: 'Video player' });
  region.focus();
  // Autoplay has already started the video, so K pauses and then plays again.
  play.mockClear();
  await user.keyboard('k');
  expect(pause).toHaveBeenCalledTimes(1);
  await user.keyboard('k');
  expect(play).toHaveBeenCalledTimes(1);

  expect(screen.getByRole('button', { name: 'Captions' })).toHaveAttribute('aria-pressed', 'false');
  await user.keyboard('c');
  expect(screen.getByRole('button', { name: 'Captions' })).toHaveAttribute('aria-pressed', 'true');
  expect(modes()).toEqual(['showing', 'disabled']);
  await user.keyboard('c');
  expect(modes()).toEqual(['disabled', 'disabled']);

  video().currentTime = 100;
  await user.keyboard('{ArrowRight}');
  expect(video().currentTime).toBe(110);
  await user.keyboard('{ArrowLeft}');
  expect(video().currentTime).toBe(100);
  await user.keyboard('m');
  expect(video().muted).toBe(true);
});

it('every control is a real, labelled control reachable by keyboard', async () => {
  player(withTracks());
  await ready();
  for (const name of [
    'Play',
    'Back 10 s',
    'Forward 10 s',
    'Mute',
    'Captions',
    'Audio and subtitles',
    'Copy',
    'Fullscreen',
  ]) {
    const b = screen.getByRole('button', { name });
    expect(b.tabIndex).toBeGreaterThanOrEqual(0);
  }
  expect(screen.getByRole('slider', { name: 'Seek' })).toBeInTheDocument();
  expect(screen.getByRole('slider', { name: 'Volume' })).toBeInTheDocument();
});

// ---- player: manual copy choice (FR-PLAY-005) ----
it('the Copy menu lists the copies and switches to the chosen one', async () => {
  const copies = [
    copyRow({ sourceId: 's1', versionId: 'v1', selected: true }),
    copyRow({
      sourceId: 's2',
      versionId: 'v2',
      serverName: "Dad's Plex",
      serverType: 'plex',
      resolution: { width: 1280, height: 720, label: '720p' },
      reasons: ['direct_play', 'user_selected'],
    }),
  ];
  const f = player(
    (n) => [
      201,
      n === 1 ? descriptor() : descriptor({ sessionId: 'ps2', reasons: ['user_selected'] }),
    ],
    (_m, p) =>
      p === '/items/m1'
        ? [200, { ...detail({ id: 'm1', title: 'Metropolis' }), copies }]
        : undefined,
  );
  await ready();
  video().currentTime = 42;
  await userEvent.click(screen.getByRole('button', { name: 'Copy' }));
  const group = await screen.findByRole('radiogroup');
  expect(within(group).getAllByRole('radio')).toHaveLength(2);
  expect(screen.getByRole('button', { name: 'Playing this copy' })).toBeDisabled();
  await userEvent.click(within(group).getByRole('radio', { name: /Dad's Plex/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Play this copy' }));
  await waitFor(() => {
    expect(calls(f, 'POST', '/play')).toHaveLength(2);
  });
  expect(calls(f, 'POST', '/play')[1]?.body).toMatchObject({
    replacesSessionId: 'ps1',
    preferences: { sourceId: 's2', versionId: 'v2' },
    excludeSourceIds: [],
  });
  // the item request for the menu carries the device capabilities
  expect(calls(f, 'GET', '/items/m1')[0]?.headers['X-Device-Caps']).toBeTruthy();
});

// ---- player: next episode (FR-PROG-004) ----
it('at the end it offers the next episode with a countdown that can be cancelled', async () => {
  player(descriptor({ item: { id: 'e1', title: 'The Big Casing', runtimeMs: 60_000 } }), (_m, p) =>
    p === '/items/e1/next-episode'
      ? [
          200,
          card({
            id: 'e2',
            title: 'The Big Bounce',
            type: 'episode',
            seasonNumber: 1,
            episodeNumber: 2,
          }),
        ]
      : undefined,
  );
  await ready();
  fireEvent.playing(video());
  fireEvent.ended(video());
  expect(await screen.findByText('The Big Bounce')).toBeInTheDocument();
  expect(screen.getByText('Starts in 10 s')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Play next episode' })).toHaveAttribute(
    'href',
    '/watch/e2',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByText(/Starts in/)).not.toBeInTheDocument();
});

it('at the end with no next episode it offers Back to title', async () => {
  player(descriptor(), (_m, p) => (p === '/items/m1/next-episode' ? [200, null] : undefined));
  await ready();
  fireEvent.ended(video());
  expect(await screen.findByText('That is the end')).toBeInTheDocument();
});

// ---- title page: copies, X-Device-Caps, Play, watched ----
const copyList = [
  copyRow({
    sourceId: 's1',
    versionId: 'v1',
    selected: true,
    reasons: ['direct_play', 'highest_playable_resolution'],
  }),
  copyRow({
    sourceId: 's2',
    versionId: 'v2',
    serverName: 'Seedbox',
    serverStatus: 'unreachable',
    expectedPlayability: 'unavailable',
    reasons: ['server_unreachable'],
  }),
];
const titlePage = (over = {}, extra: Handler = () => undefined) =>
  renderApp('/items/m1', viewer, (m, p, b) =>
    p === '/items/m1'
      ? [200, { ...detail({ id: 'm1', title: 'Metropolis', ...over }), copies: copyList }]
      : extra(m, p, b),
  );

it('title page sends X-Device-Caps and shows the copies radiogroup with the why callout', async () => {
  const f = titlePage();
  const group = await screen.findByRole('radiogroup', { name: 'Copies' });
  expect(calls(f, 'GET', '/items/m1')[0]?.headers['X-Device-Caps']).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(within(group).getAllByRole('radio')).toHaveLength(2);
  expect(screen.getByText('Basement NAS: 1080p, direct play')).toBeInTheDocument();
  const play = screen.getByRole('link', { name: /Play from Basement NAS/ });
  expect(play).toHaveAttribute('href', '/watch/m1');
});

it('choosing another copy overrides the automatic choice in the Play link; unavailable copies disable Play', async () => {
  titlePage({}, () => undefined);
  const group = await screen.findByRole('radiogroup', { name: 'Copies' });
  await userEvent.click(within(group).getByRole('radio', { name: /Seedbox/ }));
  expect(screen.getByText('Seedbox: 1080p, unavailable right now')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Unavailable right now' })).toBeDisabled();
  await userEvent.click(within(group).getAllByRole('radio')[0] as HTMLElement);
  expect(screen.getByRole('link', { name: /Play from Basement NAS/ })).toHaveAttribute(
    'href',
    '/watch/m1',
  );
});

it('a manual pick that differs from the best copy is passed to the player', async () => {
  renderApp('/items/m1', viewer, (_m, p) =>
    p === '/items/m1'
      ? [
          200,
          {
            ...detail({ id: 'm1', title: 'Metropolis' }),
            copies: [
              copyRow({ sourceId: 's1', versionId: 'v1', selected: true }),
              copyRow({ sourceId: 's2', versionId: 'v2', serverName: "Dad's Plex" }),
            ],
          },
        ]
      : undefined,
  );
  const group = await screen.findByRole('radiogroup', { name: 'Copies' });
  await userEvent.click(within(group).getByRole('radio', { name: /Dad's Plex/ }));
  expect(screen.getByRole('link', { name: /Play from Dad's Plex/ })).toHaveAttribute(
    'href',
    '/watch/m1?sourceId=s2&versionId=v2',
  );
});

it('marks an item watched and unwatched', async () => {
  const f = titlePage({ progress: { positionMs: 5000, watched: false } }, (m, p, b) => {
    if (m === 'PUT' && p === '/progress/m1') {
      const watched = (b as { watched: boolean }).watched;
      return [200, { positionMs: 0, watched }];
    }
    return undefined;
  });
  const btn = await screen.findByRole('button', { name: 'Mark as watched' });
  await userEvent.click(btn);
  expect(await screen.findByRole('button', { name: 'Mark as unwatched' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(screen.getByText('Watched')).toBeInTheDocument();
  expect(calls(f, 'PUT', '/progress/m1')[0]?.body).toEqual({ watched: true });
  await userEvent.click(screen.getByRole('button', { name: 'Mark as unwatched' }));
  expect(await screen.findByRole('button', { name: 'Mark as watched' })).toBeInTheDocument();
  expect(calls(f, 'PUT', '/progress/m1')[1]?.body).toEqual({ watched: false });
});

it('series page offers the next episode to play', async () => {
  renderApp('/items/sr1', viewer, (_m, p) => {
    if (p === '/items/sr1') return [200, detail({ id: 'sr1', title: 'Dragnet', type: 'series' })];
    if (p === '/items/sr1/next-episode')
      return [
        200,
        card({
          id: 'e4',
          title: 'The Big Gun',
          type: 'episode',
          seasonNumber: 2,
          episodeNumber: 4,
        }),
      ];
    if (p.startsWith('/items/sr1/children')) return [200, page([])];
    return undefined;
  });
  expect(await screen.findByRole('link', { name: 'Play S2 E4' })).toHaveAttribute(
    'href',
    '/watch/e4',
  );
});

// ---- home: continue watching ----
it('home shows continue-watching hero cards with progress, Resume and Choose another copy', async () => {
  renderApp('/', viewer, () => [
    200,
    {
      recentlyAdded: [],
      continueWatching: [
        {
          ...card({ id: 'm1', title: 'Metropolis', year: 1927 }),
          progress: { positionMs: 74 * 60_000, runtimeMs: 100 * 60_000 },
        },
      ],
    },
  ]);
  const hero = await screen.findByRole('article', { name: 'Metropolis, 1927' });
  expect(within(hero).getByRole('progressbar', { name: '74% watched' })).toHaveAttribute(
    'aria-valuenow',
    '74',
  );
  expect(
    within(hero).getByText(/26 min left · resuming from 1:14:00/),
  ).toBeInTheDocument();
  expect(within(hero).getByRole('link', { name: 'Resume' })).toHaveAttribute(
    'href',
    '/watch/m1?resume=1',
  );
  expect(within(hero).getByRole('link', { name: 'Choose another copy' })).toHaveAttribute(
    'href',
    '/items/m1',
  );
  expect(screen.getByRole('heading', { name: 'Continue watching' })).toBeInTheDocument();
});
