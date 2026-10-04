/**
 * D1 queries for health probing (LLD-SCHEMA `health_probes`, `servers` health columns).
 */
import type { ProbePoint } from '../health/derive';
import type { SyncServerRow } from './sync';

export interface ProbeTargetRow extends SyncServerRow {
  consecutive_failures: number;
  consecutive_ok: number;
}

const TARGET_SELECT = `SELECT id, type, base_url, origin_server_id, priority, status,
       consecutive_failures, consecutive_ok FROM servers`;

/** Enabled servers that are probed: `disabled`, `removing` and `pending_validation` are not. */
export function listProbeTargets(db: D1Database): Promise<ProbeTargetRow[]> {
  return db
    .prepare(`${TARGET_SELECT} WHERE status IN ('active','degraded','unreachable') ORDER BY id`)
    .all<ProbeTargetRow>()
    .then((r) => r.results);
}

export function getProbeTarget(db: D1Database, id: string): Promise<ProbeTargetRow | null> {
  return db
    .prepare(`${TARGET_SELECT} WHERE id = ? AND status IN ('active','degraded','unreachable')`)
    .bind(id)
    .first<ProbeTargetRow>();
}

export function insertProbeStmt(
  db: D1Database,
  p: {
    id: string;
    serverId: string;
    at: number;
    ok: boolean;
    latencyMs: number | null;
    errorCode: string | null;
  },
): D1PreparedStatement {
  return db
    .prepare(
      'INSERT INTO health_probes (id, server_id, probed_at, ok, latency_ms, error_code) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(p.id, p.serverId, p.at, p.ok ? 1 : 0, p.latencyMs, p.errorCode);
}

/** The newest `n` probes, newest first (index `hp_server`). */
export async function recentProbePoints(
  db: D1Database,
  serverId: string,
  n: number,
): Promise<ProbePoint[]> {
  const { results } = await db
    .prepare(
      'SELECT ok, latency_ms FROM health_probes WHERE server_id = ? ORDER BY probed_at DESC, id DESC LIMIT ?',
    )
    .bind(serverId, n)
    .all<{ ok: number; latency_ms: number | null }>();
  return results.map((r) => ({ ok: r.ok === 1, latencyMs: r.latency_ms }));
}

/** Latencies of the last `n` successful probes (BR-5 rule 6 input). */
export async function lastSuccessLatencies(
  db: D1Database,
  serverId: string,
  n: number,
): Promise<ProbePoint[]> {
  const { results } = await db
    .prepare(
      `SELECT latency_ms FROM health_probes WHERE server_id = ? AND ok = 1 AND latency_ms IS NOT NULL
        ORDER BY probed_at DESC, id DESC LIMIT ?`,
    )
    .bind(serverId, n)
    .all<{ latency_ms: number }>();
  return results.map((r) => ({ ok: true, latencyMs: r.latency_ms }));
}

/**
 * Stores the derived state. Guarded on the status still being a probed one, so a server the
 * operator disabled or removed while the probe was in flight is never flipped back.
 */
export function applyHealthStmt(
  db: D1Database,
  s: {
    id: string;
    status: string;
    failures: number;
    oks: number;
    latencyMs: number | null;
    now: number;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE servers
          SET status = ?, consecutive_failures = ?, consecutive_ok = ?,
              last_latency_ms = COALESCE(?, last_latency_ms), updated_at = ?
        WHERE id = ? AND status IN ('active','degraded','unreachable')`,
    )
    .bind(s.status, s.failures, s.oks, s.latencyMs, s.now, s.id);
}
