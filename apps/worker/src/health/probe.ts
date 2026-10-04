/**
 * Health probing (LLD-SYNC "Health probing and status derivation"; FR-OPS-001, FR-OPS-002, WF-8).
 * `probeAll` runs on the scheduler tick at concurrency 6. Each probe has a 5 s timeout and up to
 * 3 attempts with 0.5 s and 1 s jittered backoff (NFR-REL-002). The result is stored in
 * `health_probes` and the derived status in `servers`. A play-time origin failure counts at once
 * (`recordOriginFailure`), so failover does not wait for the next tick.
 *
 * Probes go through `MediaProvider.probe` only; no provider-specific code lives here (ADR-0004).
 */
import {
  applyHealthStmt,
  getProbeTarget,
  insertProbeStmt,
  lastSuccessLatencies,
  listProbeTargets,
  recentProbePoints,
  type ProbeTargetRow,
} from '../db/health';
import { ProviderError } from '../providers/errors';
import { isSupportedProvider } from '../providers/registry';
import type { ProbeResult } from '../providers/types';
import { CredentialsUnavailableError, type SyncDeps } from '../sync/deps';
import { deriveStatus, isHealthStatus, medianLatency, WINDOW, type HealthStatus } from './derive';

export const PROBE_CONCURRENCY = 6;
export const PROBE_TIMEOUT_MS = 5_000;
export const PROBE_ATTEMPTS = 3;
const BACKOFF_MS = [500, 1000];

export interface ProbeOptions {
  timeoutMs?: number;
  attempts?: number;
}

export interface ProbeOutcome {
  serverId: string;
  ok: boolean;
  latencyMs: number | null;
  errorCode: string | null;
  from: HealthStatus;
  to: HealthStatus;
}

/** One attempt, bounded by the timeout. Never throws. */
async function attemptOnce(
  deps: SyncDeps,
  server: ProbeTargetRow,
  timeoutMs: number,
): Promise<ProbeResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const started = deps.now();
  try {
    const { provider, ctx } = await deps.openServer(server);
    const timeout = new Promise<ProbeResult>((resolve) => {
      timer = setTimeout(() => {
        resolve({ ok: false, latencyMs: timeoutMs, errorCode: 'TIMEOUT' });
      }, timeoutMs);
    });
    return await Promise.race([provider.probe(ctx), timeout]);
  } catch (err) {
    const errorCode =
      err instanceof CredentialsUnavailableError
        ? 'CREDENTIALS_UNAVAILABLE'
        : err instanceof ProviderError
          ? err.code
          : 'UNAVAILABLE';
    return { ok: false, latencyMs: Math.max(0, deps.now() - started), errorCode };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Up to `attempts` tries; the first success wins, else the last failure is the result. */
export async function runProbe(
  deps: SyncDeps,
  server: ProbeTargetRow,
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  const attempts = options.attempts ?? PROBE_ATTEMPTS;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  let result: ProbeResult = { ok: false, latencyMs: 0, errorCode: 'UNAVAILABLE' };
  for (let i = 0; i < attempts; i++) {
    result = await attemptOnce(deps, server, timeoutMs);
    if (result.ok) return result;
    const base = BACKOFF_MS[i];
    if (base !== undefined && i < attempts - 1) await deps.sleep(base * (0.5 + deps.random()));
  }
  return result;
}

/** Probes one server, stores the probe and the derived status. */
export async function probeServer(
  deps: SyncDeps,
  server: ProbeTargetRow,
  options: ProbeOptions = {},
): Promise<ProbeOutcome> {
  const result = await runProbe(deps, server, options);
  const now = deps.now();
  const ok = result.ok;
  const latencyMs = ok ? result.latencyMs : null;
  const errorCode = ok ? null : (result.errorCode ?? 'UNAVAILABLE');
  const from = isHealthStatus(server.status) ? server.status : 'active';
  const failures = ok ? 0 : server.consecutive_failures + 1;
  const oks = ok ? server.consecutive_ok + 1 : 0;

  const prior = await recentProbePoints(deps.db, server.id, WINDOW - 1);
  const recent = [{ ok, latencyMs }, ...prior];
  const to = deriveStatus(from, { consecutiveFailures: failures, consecutiveOk: oks }, recent);
  // `servers.last_latency_ms` is the median of the last 3 successful probes (LLD-SYNC).
  const successes = ok
    ? [{ ok: true, latencyMs }, ...(await lastSuccessLatencies(deps.db, server.id, 2))]
    : null;
  await deps.db.batch([
    insertProbeStmt(deps.db, {
      id: deps.newId(),
      serverId: server.id,
      at: now,
      ok,
      latencyMs,
      errorCode,
    }),
    applyHealthStmt(deps.db, {
      id: server.id,
      status: to,
      failures,
      oks,
      latencyMs: successes ? medianLatency(successes) : null,
      now,
    }),
  ]);
  deps.logger.info('probe.result', {
    server_id: server.id,
    ok,
    latency_ms: latencyMs,
    error_code: errorCode,
    status_from: from,
    status_to: to,
    metric: 'health.probe',
  });
  if (from !== to) {
    deps.logger.warn('server.status_changed', { server_id: server.id, from, to });
  }
  return { serverId: server.id, ok, latencyMs, errorCode, from, to };
}

/** Probes every enabled server at concurrency 6. One server's failure never stops the others. */
export async function probeAll(
  deps: SyncDeps,
  options: ProbeOptions = {},
): Promise<ProbeOutcome[]> {
  const targets = (await listProbeTargets(deps.db)).filter((s) => isSupportedProvider(s.type));
  const outcomes: ProbeOutcome[] = [];
  let next = 0;
  const worker = async () => {
    for (;;) {
      const server = targets[next++];
      if (!server) return;
      try {
        outcomes.push(await probeServer(deps, server, options));
      } catch (err) {
        deps.logger.error('probe.failed', {
          server_id: server.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, targets.length) }, worker));
  return outcomes;
}

/** Whether this 5-minute tick is a probe tick for the configured interval (FR-OPS-001). */
export function isProbeTick(nowMs: number, intervalMin: number, tickMin = 5): boolean {
  const every = Math.max(1, Math.round(intervalMin / tickMin));
  return Math.floor(nowMs / (tickMin * 60_000)) % every === 0;
}

/**
 * A play-time origin failure (timeout or 5xx during negotiation) counts as a failed probe at
 * once (LLD-SYNC), without adding a probe row: the history holds only real probes.
 */
export async function recordOriginFailure(
  deps: Pick<SyncDeps, 'db' | 'now' | 'logger'>,
  serverId: string,
): Promise<void> {
  const server = await getProbeTarget(deps.db, serverId);
  if (!server) return;
  const from = isHealthStatus(server.status) ? server.status : 'active';
  const failures = server.consecutive_failures + 1;
  const prior = await recentProbePoints(deps.db, serverId, WINDOW - 1);
  const to = deriveStatus(from, { consecutiveFailures: failures, consecutiveOk: 0 }, [
    { ok: false, latencyMs: null },
    ...prior,
  ]);
  await deps.db.batch([
    applyHealthStmt(deps.db, {
      id: serverId,
      status: to,
      failures,
      oks: 0,
      latencyMs: null,
      now: deps.now(),
    }),
  ]);
  if (from !== to)
    deps.logger.warn('server.status_changed', { server_id: serverId, from, to, cause: 'play' });
}
