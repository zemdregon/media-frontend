/**
 * Server status derivation (LLD-SYNC "Health probing and status derivation", FRD server state
 * machine, FR-OPS-001, FR-OPS-002). Pure: the same inputs always give the same status. All
 * thresholds are *(proposed)* in the LLD.
 */
export type HealthStatus = 'active' | 'degraded' | 'unreachable';

/** Median probe latency above this makes an active server `degraded` (LLD-SYNC). */
export const SLOW_LATENCY_MS = 1500;
/** Consecutive failures (about 15 min of probes) that make a server `unreachable`. */
export const UNREACHABLE_AFTER_FAILURES = 3;
/** Consecutive successes that recover `degraded` to `active`. */
export const ACTIVE_AFTER_OK = 3;
/** Consecutive successes that lift `unreachable` to `degraded`. */
export const DEGRADED_AFTER_OK = 2;
/** The window the "last 3" rules look at. */
export const WINDOW = 3;

export interface ProbePoint {
  ok: boolean;
  latencyMs: number | null;
}

export const isHealthStatus = (s: string): s is HealthStatus =>
  s === 'active' || s === 'degraded' || s === 'unreachable';

/** Median of the successful probes' latencies among `recent`, or null when there are none. */
export function medianLatency(recent: readonly ProbePoint[]): number | null {
  const xs: number[] = [];
  for (const p of recent) if (p.ok && p.latencyMs !== null) xs.push(p.latencyMs);
  xs.sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  if (xs.length % 2 === 1) return xs[mid] ?? null;
  return Math.round(((xs[mid - 1] ?? 0) + (xs[mid] ?? 0)) / 2);
}

/**
 * `recent` is newest first and already includes the result being applied; the counters are the
 * values after applying it.
 */
export function deriveStatus(
  status: HealthStatus,
  counters: { consecutiveFailures: number; consecutiveOk: number },
  recent: readonly ProbePoint[],
): HealthStatus {
  const last = recent.slice(0, WINDOW);
  const failures = counters.consecutiveFailures;
  const oks = counters.consecutiveOk;
  if (status !== 'unreachable' && failures >= UNREACHABLE_AFTER_FAILURES) return 'unreachable';
  const median = medianLatency(last);
  switch (status) {
    case 'unreachable':
      return oks >= DEGRADED_AFTER_OK ? 'degraded' : 'unreachable';
    case 'active': {
      const slow = last[0]?.ok === true && median !== null && median > SLOW_LATENCY_MS;
      return last.some((p) => !p.ok) || slow ? 'degraded' : 'active';
    }
    case 'degraded': {
      const healthy =
        oks >= ACTIVE_AFTER_OK &&
        last.length >= WINDOW &&
        (median === null || median <= SLOW_LATENCY_MS);
      return healthy ? 'active' : 'degraded';
    }
  }
}
