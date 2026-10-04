/**
 * Operator operations reads (LLD-API): the health view (FR-OPS-004), the audit log (FR-OPS-005),
 * the metrics summary (NFR-OBS-002, TDD-D4: computed from D1) and the data export (FR-OPS-006).
 * Every query here is read-only. The export selects an explicit column list per table, so a
 * credential column can never be added to it by accident (NFR-SEC-001).
 */
import type { Context } from 'hono';
import type {
  AuditEntry,
  ExportDocument,
  MetricsSummary,
  Page,
  ServerHealth,
} from '@cinewren/shared';
import type { AppEnv } from '../api/context';
import { AppError } from '../api/errors';
import { expectKey, isNumber, isString, openCursor, sealCursor } from '../catalog/cursor';
import { getServer } from '../db/servers';

const DAY = 86_400_000;

// --- health view (FR-OPS-004) ---

export async function serverHealth(
  c: Context<AppEnv>,
  serverId: string,
  q: { since?: number | undefined; limit: number },
): Promise<ServerHealth> {
  const db = c.env.DB;
  if (!(await getServer(db, serverId))) throw new AppError('NOT_FOUND', 'Not found.');
  const state = await db
    .prepare('SELECT status, last_latency_ms, consecutive_failures FROM servers WHERE id = ?')
    .bind(serverId)
    .first<{
      status: ServerHealth['status'];
      last_latency_ms: number | null;
      consecutive_failures: number;
    }>();
  const { results } = await db
    .prepare(
      `SELECT probed_at, ok, latency_ms, error_code FROM health_probes
        WHERE server_id = ? AND probed_at >= ? ORDER BY probed_at DESC, id DESC LIMIT ?`,
    )
    .bind(serverId, q.since ?? 0, q.limit)
    .all<{ probed_at: number; ok: number; latency_ms: number | null; error_code: string | null }>();
  return {
    status: state?.status ?? 'active',
    lastLatencyMs: state?.last_latency_ms ?? null,
    consecutiveFailures: state?.consecutive_failures ?? 0,
    probes: results.map((r) => ({
      at: r.probed_at,
      ok: r.ok === 1,
      latencyMs: r.latency_ms,
      errorCode: r.error_code,
    })),
  };
}

// --- audit log (FR-OPS-005) ---

interface AuditRow {
  id: string;
  at: number;
  actor_user_id: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  details: string;
  request_id: string | null;
}

function parseDetails(raw: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(raw);
    return v !== null && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Newest first, keyed by `(at, id)`. `action` matches exactly, or as a prefix when it ends in `*`
 * (`server.*`). `from` is inclusive and `to` exclusive, in epoch milliseconds.
 */
export async function auditLog(
  c: Context<AppEnv>,
  q: {
    cursor?: string | undefined;
    limit: number;
    action?: string | undefined;
    from?: number | undefined;
    to?: number | undefined;
  },
): Promise<Page<AuditEntry>> {
  const scope = `audit|${q.action ?? ''}|${String(q.from ?? '')}|${String(q.to ?? '')}`;
  const key = expectKey<[number, string]>(await openCursor(c, scope, q.cursor), [
    isNumber,
    isString,
  ]);
  const where: string[] = [];
  const binds: unknown[] = [];
  if (q.action) {
    if (q.action.endsWith('*')) {
      where.push("action LIKE ? ESCAPE '\\'");
      binds.push(`${q.action.slice(0, -1).replace(/[\\%_]/g, '\\$&')}%`);
    } else {
      where.push('action = ?');
      binds.push(q.action);
    }
  }
  if (q.from !== undefined) {
    where.push('at >= ?');
    binds.push(q.from);
  }
  if (q.to !== undefined) {
    where.push('at < ?');
    binds.push(q.to);
  }
  if (key) {
    where.push('(at < ? OR (at = ? AND id < ?))');
    binds.push(key[0], key[0], key[1]);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT id, at, actor_user_id, action, target_type, target_id, details, request_id
       FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY at DESC, id DESC LIMIT ?`,
  )
    .bind(...binds, q.limit + 1)
    .all<AuditRow>();
  const more = results.length > q.limit;
  const kept = more ? results.slice(0, q.limit) : results;
  const last = kept[kept.length - 1];
  return {
    items: kept.map((r) => ({
      id: r.id,
      at: r.at,
      actorUserId: r.actor_user_id,
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      details: parseDetails(r.details),
      requestId: r.request_id,
    })),
    nextCursor: more && last ? await sealCursor(c, scope, [last.at, last.id]) : null,
  };
}

// --- metrics (NFR-OBS-002) ---

export async function metrics(
  c: Context<AppEnv>,
  window: '24h' | '7d',
  now = Date.now(),
): Promise<MetricsSummary> {
  const db = c.env.DB;
  const since = now - (window === '24h' ? DAY : 7 * DAY);
  const [sync, status, mode, probes] = await db.batch([
    db
      .prepare(
        `SELECT s.id AS server_id, s.name AS server_name, COUNT(*) AS runs,
                COALESCE(SUM(r.status = 'failed'), 0) AS failed,
                COALESCE(SUM(r.status = 'partial'), 0) AS partial,
                COALESCE(SUM(r.errors), 0) AS errors,
                AVG(CASE WHEN r.ended_at IS NOT NULL AND r.started_at IS NOT NULL
                         THEN r.ended_at - r.started_at END) AS avg_ms,
                MAX(CASE WHEN r.ended_at IS NOT NULL AND r.started_at IS NOT NULL
                         THEN r.ended_at - r.started_at END) AS max_ms
           FROM sync_runs r JOIN servers s ON s.id = r.server_id
          WHERE r.queued_at >= ? GROUP BY s.id ORDER BY s.name COLLATE NOCASE, s.id`,
      )
      .bind(since),
    db
      .prepare(
        'SELECT status AS k, COUNT(*) AS n FROM playback_sessions WHERE authorized_at >= ? GROUP BY status',
      )
      .bind(since),
    db
      .prepare(
        'SELECT mode AS k, COUNT(*) AS n FROM playback_sessions WHERE authorized_at >= ? GROUP BY mode',
      )
      .bind(since),
    db
      .prepare(
        `SELECT s.id AS server_id, s.name AS server_name, COUNT(*) AS probes,
                COALESCE(SUM(p.ok = 0), 0) AS failed
           FROM health_probes p JOIN servers s ON s.id = p.server_id
          WHERE p.probed_at >= ? GROUP BY s.id ORDER BY s.name COLLATE NOCASE, s.id`,
      )
      .bind(since),
  ]);
  const outcomes: Record<string, number> = {};
  let total = 0;
  for (const r of (status?.results ?? []) as { k: string; n: number }[]) {
    outcomes[r.k] = r.n;
    total += r.n;
  }
  const modes = { direct_play: 0, direct_stream: 0, transcode: 0 };
  for (const r of (mode?.results ?? []) as { k: keyof typeof modes; n: number }[]) {
    if (r.k in modes) modes[r.k] = r.n;
  }
  return {
    window,
    since,
    sync: (
      (sync?.results ?? []) as {
        server_id: string;
        server_name: string;
        runs: number;
        failed: number;
        partial: number;
        errors: number;
        avg_ms: number | null;
        max_ms: number | null;
      }[]
    ).map((r) => ({
      serverId: r.server_id,
      serverName: r.server_name,
      runs: r.runs,
      failed: r.failed,
      partial: r.partial,
      errors: r.errors,
      avgDurationMs: r.avg_ms === null ? null : Math.round(r.avg_ms),
      maxDurationMs: r.max_ms,
    })),
    play: { total, outcomes },
    modes,
    health: (
      (probes?.results ?? []) as {
        server_id: string;
        server_name: string;
        probes: number;
        failed: number;
      }[]
    ).map((r) => ({
      serverId: r.server_id,
      serverName: r.server_name,
      probes: r.probes,
      failed: r.failed,
    })),
  };
}

// --- export (FR-OPS-006) ---

/**
 * Primary data (DR-001) as JSON: users, grants, progress, curation overrides and server
 * configuration. Credentials, envelopes, sessions, passkeys and invite tokens are never selected.
 */
export async function exportData(c: Context<AppEnv>, now = Date.now()): Promise<ExportDocument> {
  const db = c.env.DB;
  const [users, grants, progress, overrides, servers, libraries] = await db.batch([
    db.prepare(
      'SELECT id, display_name, role, status, created_at FROM users ORDER BY created_at, id',
    ),
    db.prepare(
      'SELECT user_id, library_id, granted_at FROM library_grants ORDER BY user_id, library_id',
    ),
    db.prepare(
      'SELECT user_id, media_item_id, position_ms, watched, updated_at FROM watch_progress ORDER BY user_id, media_item_id',
    ),
    db.prepare(
      `SELECT id, kind, entity_kind, media_item_id, person_id, collection_id, server_id, provider_item_id, created_at
         FROM curation_overrides ORDER BY created_at, id`,
    ),
    db.prepare(
      `SELECT id, type, name, base_url, priority FROM servers
        WHERE status <> 'removing' ORDER BY priority DESC, name COLLATE NOCASE, id`,
    ),
    db.prepare(
      'SELECT id, server_id, provider_library_id, name, kind, enabled FROM libraries ORDER BY server_id, id',
    ),
  ]);
  type Row = Record<string, string | number | null>;
  const rows = (r: { results?: unknown[] } | undefined): Row[] => (r?.results ?? []) as Row[];
  const libs = rows(libraries);
  return {
    schemaVersion: 1,
    exportedAt: now,
    users: rows(users).map((r) => ({
      id: r.id as string,
      displayName: r.display_name as string,
      role: r.role as string,
      status: r.status as string,
      createdAt: r.created_at as number,
    })),
    grants: rows(grants).map((r) => ({
      userId: r.user_id as string,
      libraryId: r.library_id as string,
      grantedAt: r.granted_at as number,
    })),
    progress: rows(progress).map((r) => ({
      userId: r.user_id as string,
      mediaItemId: r.media_item_id as string,
      positionMs: r.position_ms as number,
      watched: r.watched === 1,
      updatedAt: r.updated_at as number,
    })),
    curationOverrides: rows(overrides).map((r) => ({
      id: r.id as string,
      kind: r.kind as string,
      entityKind: r.entity_kind as string,
      serverId: r.server_id as string,
      providerItemId: r.provider_item_id as string,
      mediaItemId: r.media_item_id as string | null,
      personId: r.person_id as string | null,
      collectionId: r.collection_id as string | null,
      createdAt: r.created_at as number,
    })),
    servers: rows(servers).map((r) => ({
      id: r.id as string,
      type: r.type as ExportDocument['servers'][number]['type'],
      name: r.name as string,
      baseUrl: r.base_url as string,
      priority: r.priority as number,
      libraries: libs
        .filter((l) => l.server_id === r.id)
        .map((l) => ({
          id: l.id as string,
          providerLibraryId: l.provider_library_id as string,
          name: l.name as string,
          kind: l.kind as string,
          enabled: l.enabled === 1,
        })),
    })),
  };
}
