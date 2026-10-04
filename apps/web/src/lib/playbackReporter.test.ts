// T3.5: progress cadence and session events (FR-PROG-001, FR-PLAY-009).
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PROGRESS_INTERVAL_MS, createReporter } from './playbackReporter';

function stubFetch(status = 204) {
  const fn = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(() =>
    Promise.resolve(
      new Response(status === 204 ? null : JSON.stringify({ error: { code: 'SESSION_EXPIRED' } }), {
        status,
      }),
    ),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}
const bodies = (fn: ReturnType<typeof stubFetch>) =>
  fn.mock.calls.map(
    ([, init]) =>
      JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>,
  );

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(navigator, 'sendBeacon', { value: undefined, configurable: true });
});

it('sends progress every 15 s while the ticker runs, with increasing seq', async () => {
  const fetchMock = stubFetch();
  let pos = 1000;
  const r = createReporter({ sessionId: 's/1', getPositionMs: () => pos });
  r.send('start');
  r.startTicker();
  pos = 16_000;
  await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS);
  pos = 31_000;
  await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS);
  expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/play/s%2F1/events');
  expect(bodies(fetchMock)).toEqual([
    { seq: 1, type: 'start', positionMs: 1000 },
    { seq: 2, type: 'progress', positionMs: 16_000 },
    { seq: 3, type: 'progress', positionMs: 31_000 },
  ]);
  r.stopTicker();
  await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS * 2);
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it('carries the error code, and stops sending after close', () => {
  const fetchMock = stubFetch();
  const r = createReporter({ sessionId: 's', getPositionMs: () => 0 });
  r.send('error', 'media_error_4');
  r.close();
  r.send('stop');
  expect(bodies(fetchMock)).toEqual([
    { seq: 1, type: 'error', positionMs: 0, errorCode: 'media_error_4' },
  ]);
});

it('on page hide it uses sendBeacon with a JSON blob', async () => {
  const fetchMock = stubFetch();
  const beacon = vi.fn(() => true);
  Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true });
  const r = createReporter({ sessionId: 's1', getPositionMs: () => 42_400 });
  r.hide();
  expect(beacon).toHaveBeenCalledTimes(1);
  const [url, blob] = beacon.mock.calls[0] as unknown as [string, Blob];
  expect(url).toBe('/api/v1/play/s1/events');
  expect(blob.type).toBe('application/json');
  expect(JSON.parse(await blob.text())).toEqual({ seq: 1, type: 'progress', positionMs: 42_400 });
  expect(fetchMock).not.toHaveBeenCalled();
});

it('on page hide it falls back to fetch keepalive when sendBeacon is missing or refuses', () => {
  const fetchMock = stubFetch();
  const r = createReporter({ sessionId: 's1', getPositionMs: () => 5000 });
  r.hide();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', keepalive: true });

  Object.defineProperty(navigator, 'sendBeacon', { value: () => false, configurable: true });
  r.hide();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('tells the player when the session is gone (410) and stops reporting', async () => {
  const fetchMock = stubFetch(410);
  const onExpired = vi.fn();
  const r = createReporter({ sessionId: 's', getPositionMs: () => 0, onExpired });
  r.send('progress');
  await vi.advanceTimersByTimeAsync(0);
  expect(onExpired).toHaveBeenCalledTimes(1);
  r.send('progress');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
