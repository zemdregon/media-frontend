// T5.1: health probing, status derivation and the health view (FR-OPS-001, FR-OPS-002,
// FR-OPS-004, WF-8, LLD-SYNC "Health probing and status derivation"). The origin is a scripted
// provider; no test touches the network. Selection's use of the status is covered in
// playback/select.test.ts (pure ranking) and playback/play.test.ts (end to end).
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ACTIVE_AFTER_OK,
  deriveStatus,
  medianLatency,
  SLOW_LATENCY_MS,
  type HealthStatus,
} from '../src/health/derive';
import { isProbeTick, probeAll, probeServer } from '../src/health/probe';
import { listProbeTargets } from '../src/db/health';
import { ProviderError } from '../src/providers/errors';
import type { ProbeResult } from '../src/providers/types';
import { call, errorCode, json, resetDb, setupOperator } from './auth-harness';
import { FakeOrigin, makeHarness, one, rows, seedServer } from './sync/harness';

const db = env.DB;
const MIN5 = 5 * 60_000;

const ok = (latencyMs = 40): ProbeResult => ({ ok: true, latencyMs });
const fail = (errorCode = 'UNAVAILABLE'): ProbeResult => ({ ok: false, latencyMs: 5, errorCode });

describe('deriveStatus (the LLD-SYNC state machine)', () => {
  const pt = (okay: boolean, latencyMs: number | null = okay ? 40 : null) => ({
    ok: okay,
    latencyMs,
  });
  const step = (
    s: HealthStatus,
    failures: number,
    oks: number,
    ...recent: ReturnType<typeof pt>[]
  ) => deriveStatus(s, { consecutiveFailures: failures, consecutiveOk: oks }, recent);

  it('one failure in the last three makes an active server degraded', () => {
    expect(step('active', 1, 0, pt(false), pt(true), pt(true))).toBe('degraded');
    expect(step('active', 0, 3, pt(true), pt(true), pt(true))).toBe('active');
  });

  it('a slow median of the last three makes an active server degraded', () => {
    const slow = SLOW_LATENCY_MS + 1;
    expect(step('active', 0, 3, pt(true, slow), pt(true, slow), pt(true, 10))).toBe('degraded');
    expect(step('active', 0, 3, pt(true, slow), pt(true, 10), pt(true, 10))).toBe('active');
  });

  it('three consecutive failures make active and degraded servers unreachable', () => {
    expect(step('active', 3, 0, pt(false), pt(false), pt(false))).toBe('unreachable');
    expect(step('degraded', 3, 0, pt(false), pt(false), pt(false))).toBe('unreachable');
    expect(step('degraded', 2, 0, pt(false), pt(false), pt(true))).toBe('degraded');
  });

  it('two consecutive successes lift unreachable to degraded, three more recover it', () => {
    expect(step('unreachable', 0, 1, pt(true), pt(false), pt(false))).toBe('unreachable');
    expect(step('unreachable', 0, 2, pt(true), pt(true), pt(false))).toBe('degraded');
    expect(step('degraded', 0, 2, pt(true), pt(true), pt(false))).toBe('degraded');
    expect(step('degraded', 0, ACTIVE_AFTER_OK, pt(true), pt(true), pt(true))).toBe('active');
  });

  it('a degraded server with three fast successes only recovers when the median is fast', () => {
    const slow = SLOW_LATENCY_MS + 500;
    expect(step('degraded', 0, 3, pt(true, slow), pt(true, slow), pt(true, 10))).toBe('degraded');
  });

  it('median ignores failures and handles even counts', () => {
    expect(medianLatency([pt(false), pt(true, 10), pt(true, 30)])).toBe(20);
    expect(medianLatency([pt(false)])).toBeNull();
  });

  it('probes on every tick at the 5 minute interval, and every Nth at a longer one', () => {
    const t = 1_800_000_000_000 - (1_800_000_000_000 % MIN5);
    expect(isProbeTick(t, 5)).toBe(true);
    expect(isProbeTick(t + MIN5, 5)).toBe(true);
    const hits = [0, 1, 2, 3].filter((i) => isProbeTick(t + i * MIN5, 10)).length;
    expect(hits).toBe(2);
  });
});

describe('probeAll (FR-OPS-001, WF-8)', () => {
  const origin = new FakeOrigin('A');
  let script: (ProbeResult | 'hang' | Error)[] = [];
  let calls = 0;
  const h = makeHarness({ origins: [origin], serverIds: ['A'] });
  h.deps.openServer = (server) => {
    const provider = origin.provider();
    provider.probe = () => {
      calls++;
      const next = script.shift() ?? ok();
      if (next === 'hang') return new Promise<ProbeResult>(() => undefined);
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next);
    };
    return Promise.resolve({ provider, ctx: origin.ctx(server.id) });
  };

  const round = async (...results: (ProbeResult | 'hang' | Error)[]) => {
    script = results;
    h.clock.now += MIN5;
    return probeAll(h.deps, { attempts: 1, timeoutMs: 25 });
  };
  const status = async (id = 'A') =>
    one<{
      status: string;
      consecutive_failures: number;
      consecutive_ok: number;
      last_latency_ms: number | null;
    }>(
      'SELECT status, consecutive_failures, consecutive_ok, last_latency_ms FROM servers WHERE id = ?',
      id,
    );

  beforeEach(async () => {
    await resetDb();
    await seedServer({ id: 'A' });
    script = [];
    calls = 0;
    h.sleeps.length = 0;
  });

  it('walks active to degraded to unreachable on failures, and back on successes', async () => {
    expect((await round(ok()))[0]?.to).toBe('active');
    expect((await round(fail()))[0]?.to).toBe('degraded');
    expect((await status())?.consecutive_failures).toBe(1);
    expect((await round(fail()))[0]?.to).toBe('degraded');
    expect((await round(fail()))[0]?.to).toBe('unreachable');
    // Unreachable servers keep being probed (LLD-SYNC); two successes lift them to degraded.
    expect((await round(ok()))[0]?.to).toBe('unreachable');
    expect((await round(ok()))[0]?.to).toBe('degraded');
    expect((await round(ok()))[0]?.to).toBe('active');
    expect(await status()).toMatchObject({ status: 'active', consecutive_failures: 0 });
    expect(await rows('SELECT ok FROM health_probes')).toHaveLength(7);
  });

  it('records reachability, latency and the error code of every probe (FR-OPS-001)', async () => {
    await round(ok(77));
    await round(fail('TIMEOUT'));
    const probes = await rows<{ ok: number; latency_ms: number | null; error_code: string | null }>(
      'SELECT ok, latency_ms, error_code FROM health_probes ORDER BY probed_at',
    );
    expect(probes).toEqual([
      { ok: 1, latency_ms: 77, error_code: null },
      { ok: 0, latency_ms: null, error_code: 'TIMEOUT' },
    ]);
  });

  it('a slow server is degraded, and last_latency_ms is the median of the last three successes', async () => {
    await round(ok(10));
    await round(ok(20));
    await round(ok(30));
    expect((await status())?.last_latency_ms).toBe(20);
    await round(ok(2000));
    expect((await round(ok(2000)))[0]?.to).toBe('degraded');
  });

  it('a hung probe times out and a thrown error is a failure with a code', async () => {
    expect((await round('hang'))[0]).toMatchObject({ ok: false, errorCode: 'TIMEOUT' });
    expect((await round(new ProviderError('REDIRECT_REFUSED', 'x')))[0]).toMatchObject({
      ok: false,
      errorCode: 'REDIRECT_REFUSED',
    });
  });

  it('retries a probe up to three times with jittered 0.5 s and 1 s backoff (NFR-REL-002)', async () => {
    script = [fail(), fail(), ok(15)];
    const [target] = await listProbeTargets(db);
    if (!target) throw new Error('no target');
    const out = await probeServer(h.deps, target, { timeoutMs: 25 });
    expect(out.ok).toBe(true);
    expect(calls).toBe(3);
    expect(h.sleeps).toEqual([500, 1000]); // random() is 0.5 in the harness: base x 1.0
    expect(await rows('SELECT id FROM health_probes')).toHaveLength(1); // one probe row per round
  });

  it('does not probe disabled, removing or pending servers', async () => {
    await seedServer({ id: 'D', status: 'disabled' });
    await seedServer({ id: 'R', status: 'removing' });
    await seedServer({ id: 'P', status: 'pending_validation' });
    // Every provider type (jellyfin, emby, plex) now has an adapter, so none is skipped by type.
    await round(ok());
    const probed = await rows<{ server_id: string }>(
      'SELECT DISTINCT server_id FROM health_probes',
    );
    expect(probed.map((r) => r.server_id)).toEqual(['A']);
  });

  it('one failing server does not stop the others (FR-SYNC-007 isolation)', async () => {
    await seedServer({ id: 'B' });
    h.origins.set('B', new FakeOrigin('B'));
    const out = await round(fail(), ok());
    expect(out).toHaveLength(2);
    expect(new Set(out.map((o) => o.to))).toEqual(new Set(['degraded', 'active']));
  });

  it('never flips a server the operator disabled while its probe was in flight', async () => {
    const [target] = await listProbeTargets(db);
    if (!target) throw new Error('no target');
    await db.prepare("UPDATE servers SET status = 'disabled' WHERE id = 'A'").run();
    await probeServer(h.deps, target, { attempts: 1, timeoutMs: 25 });
    expect((await status())?.status).toBe('disabled');
  });
});

describe('GET /admin/servers/{id}/health (FR-OPS-004)', () => {
  beforeEach(async () => {
    await resetDb();
    await seedServer({ id: 'A' });
  });

  it('returns the status and the recent probes, newest first, filtered by since', async () => {
    const { cookie } = await setupOperator();
    await db.batch([
      db.prepare(
        "UPDATE servers SET status = 'degraded', last_latency_ms = 40, consecutive_failures = 1 WHERE id = 'A'",
      ),
      ...[1, 2, 3].map((i) =>
        db
          .prepare(
            "INSERT INTO health_probes (id, server_id, probed_at, ok, latency_ms, error_code) VALUES (?, 'A', ?, ?, ?, ?)",
          )
          .bind(
            `p${i}`,
            i * 1000,
            i === 3 ? 0 : 1,
            i === 3 ? null : 40,
            i === 3 ? 'TIMEOUT' : null,
          ),
      ),
    ]);
    const res = await call('GET', '/api/v1/admin/servers/A/health', { cookie });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      status: 'degraded',
      lastLatencyMs: 40,
      consecutiveFailures: 1,
      probes: [
        { at: 3000, ok: false, latencyMs: null, errorCode: 'TIMEOUT' },
        { at: 2000, ok: true, latencyMs: 40, errorCode: null },
        { at: 1000, ok: true, latencyMs: 40, errorCode: null },
      ],
    });
    const since = await json<{ probes: unknown[] }>(
      await call('GET', '/api/v1/admin/servers/A/health?since=2000', { cookie }),
    );
    expect(since.probes).toHaveLength(2);
  });

  it('is 404 for an unknown server, 400 for a bad query, and operator-only', async () => {
    const { cookie } = await setupOperator();
    expect(
      await errorCode(await call('GET', '/api/v1/admin/servers/nope/health', { cookie })),
    ).toBe('NOT_FOUND');
    expect(
      await errorCode(await call('GET', '/api/v1/admin/servers/A/health?limit=0', { cookie })),
    ).toBe('VALIDATION_FAILED');
    expect((await call('GET', '/api/v1/admin/servers/A/health')).status).toBe(401);
  });
});
