/**
 * D1 queries for sync run records (LLD-SYNC, FR-SYNC-002, FR-SYNC-006). The per-server lock is
 * the partial unique index `sync_one_active`; state transitions are compare-and-set (LLD-ERR).
 */

export type RunType = 'full' | 'incremental';
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed';

export interface RunRow {
  id: string;
  server_id: string;
  type: RunType;
  trigger: 'schedule' | 'manual';
  status: RunStatus;
  since_ms: number | null;
  checkpoint: string | null;
  lease_token: string | null;
  lease_expires_at: number | null;
  libraries_ok: string;
  libraries_failed: string;
  added: number;
  updated: number;
  missing: number;
  errors: number;
  error_summary: string | null;
  queued_at: number;
  started_at: number | null;
  ended_at: number | null;
}

const RUN_COLUMNS = `id, server_id, type, trigger, status, since_ms, checkpoint, lease_token,
  lease_expires_at, libraries_ok, libraries_failed, added, updated, missing, errors, error_summary,
  queued_at, started_at, ended_at`;

export function getRun(db: D1Database, id: string): Promise<RunRow | null> {
  return db.prepare(`SELECT ${RUN_COLUMNS} FROM sync_runs WHERE id = ?`).bind(id).first<RunRow>();
}

export function getActiveRun(db: D1Database, serverId: string): Promise<RunRow | null> {
  return db
    .prepare(
      `SELECT ${RUN_COLUMNS} FROM sync_runs WHERE server_id = ? AND status IN ('queued','running')`,
    )
    .bind(serverId)
    .first<RunRow>();
}

/** Inserts a queued run. Returns false when the server already has an active run (FR-SYNC-002). */
export async function insertRun(
  db: D1Database,
  r: {
    id: string;
    serverId: string;
    type: RunType;
    trigger: 'schedule' | 'manual';
    sinceMs: number | null;
    checkpoint: string | null;
    now: number;
  },
): Promise<boolean> {
  try {
    await db
      .prepare(
        `INSERT INTO sync_runs (id, server_id, type, trigger, status, since_ms, checkpoint, queued_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`,
      )
      .bind(r.id, r.serverId, r.type, r.trigger, r.sinceMs, r.checkpoint, r.now)
      .run();
    return true;
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) return false;
    throw err;
  }
}

/** A full run requested while an incremental is still queued upgrades it (LLD-SYNC). */
export async function upgradeQueuedToFull(db: D1Database, serverId: string): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE sync_runs SET type = 'full', since_ms = NULL
        WHERE server_id = ? AND status = 'queued' AND type = 'incremental'`,
    )
    .bind(serverId)
    .run();
  return res.meta.changes > 0;
}

/**
 * Claims a run for this consumer: from `queued`, or from `running` when the caller holds the
 * lease or the lease has expired. Returns false when someone else owns it.
 */
export async function claimRun(
  db: D1Database,
  runId: string,
  presentedToken: string | null,
  newToken: string,
  now: number,
  leaseMs: number,
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE sync_runs SET status = 'running', lease_token = ?, lease_expires_at = ?,
              started_at = COALESCE(started_at, ?)
        WHERE id = ? AND (status = 'queued'
           OR (status = 'running' AND (lease_token = ? OR lease_expires_at < ?)))`,
    )
    .bind(newToken, now + leaseMs, now, runId, presentedToken, now)
    .run();
  return res.meta.changes > 0;
}

export interface ProgressWrite {
  checkpoint: string;
  added: number;
  updated: number;
  missing: number;
  errors: number;
  librariesOk: string;
  librariesFailed: string;
  errorSummary: string | null;
  leaseExpiresAt: number;
}

/** The checkpoint statement, submitted in the last chunk of a page's batch (LLD-SYNC). */
export function saveProgressStmt(
  db: D1Database,
  runId: string,
  token: string,
  p: ProgressWrite,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE sync_runs SET checkpoint = ?, added = added + ?, updated = updated + ?,
              missing = missing + ?, errors = errors + ?, libraries_ok = ?, libraries_failed = ?,
              error_summary = ?, lease_expires_at = ?
        WHERE id = ? AND lease_token = ?`,
    )
    .bind(
      p.checkpoint,
      p.added,
      p.updated,
      p.missing,
      p.errors,
      p.librariesOk,
      p.librariesFailed,
      p.errorSummary,
      p.leaseExpiresAt,
      runId,
      token,
    );
}

export async function finishRun(
  db: D1Database,
  runId: string,
  token: string,
  status: 'succeeded' | 'partial' | 'failed',
  errorSummary: string | null,
  now: number,
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE sync_runs SET status = ?, ended_at = ?, lease_token = NULL, lease_expires_at = NULL,
              error_summary = ?
        WHERE id = ? AND lease_token = ? AND status = 'running'`,
    )
    .bind(status, now, errorSummary, runId, token)
    .run();
  return res.meta.changes > 0;
}

/** Lets the next delivery claim the run immediately after an unexpected error. */
export function releaseLease(db: D1Database, runId: string, token: string): Promise<unknown> {
  return db
    .prepare('UPDATE sync_runs SET lease_expires_at = 0 WHERE id = ? AND lease_token = ?')
    .bind(runId, token)
    .run();
}

/** Terminal state without a lease (reaper, dead-lettered runs). */
export async function failRunUnleased(
  db: D1Database,
  runId: string,
  summary: string,
  now: number,
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE sync_runs SET status = 'failed', ended_at = ?, lease_token = NULL,
              lease_expires_at = NULL, error_summary = ?, errors = errors + 1
        WHERE id = ? AND status = 'running'`,
    )
    .bind(now, summary, runId)
    .run();
  return res.meta.changes > 0;
}

export function listStaleRuns(db: D1Database, cutoff: number): Promise<RunRow[]> {
  return db
    .prepare(
      `SELECT ${RUN_COLUMNS} FROM sync_runs WHERE status = 'running' AND lease_expires_at < ?`,
    )
    .bind(cutoff)
    .all<RunRow>()
    .then((r) => r.results);
}

export function setCheckpoint(db: D1Database, runId: string, checkpoint: string): Promise<unknown> {
  return db
    .prepare('UPDATE sync_runs SET checkpoint = ? WHERE id = ?')
    .bind(checkpoint, runId)
    .run();
}

// --- scheduling ---

export interface DueServerRow {
  id: string;
  type: 'jellyfin' | 'emby' | 'plex';
  status: string;
  /** Latest `started_at` (or `queued_at` while unstarted) of any run; null if there is none. */
  last_started: number | null;
  /** `started_at` of the latest fully succeeded run of any type (the incremental lower bound). */
  last_ok_started: number | null;
  /** `ended_at` of the latest succeeded full run. */
  last_full_ok: number | null;
}

/** The scheduling facts for one server, or null when the scheduler would skip it. */
export async function dueServer(db: D1Database, serverId: string): Promise<DueServerRow | null> {
  const all = await listSchedulableServers(db);
  return all.find((s) => s.id === serverId) ?? null;
}

/** Run history, newest first, keyed by `(queued_at, id)` for stable cursor paging. */
export function listRunsPage(
  db: D1Database,
  serverId: string,
  after: [number, string] | undefined,
  take: number,
): Promise<RunRow[]> {
  const where = after ? 'AND (queued_at < ? OR (queued_at = ? AND id < ?))' : '';
  const binds = after ? [serverId, after[0], after[0], after[1], take] : [serverId, take];
  return db
    .prepare(
      `SELECT ${RUN_COLUMNS} FROM sync_runs WHERE server_id = ? ${where}
        ORDER BY queued_at DESC, id DESC LIMIT ?`,
    )
    .bind(...binds)
    .all<RunRow>()
    .then((r) => r.results);
}

/** Active and degraded servers with at least one enabled library (WF-2 preconditions). */
export function listSchedulableServers(db: D1Database): Promise<DueServerRow[]> {
  return db
    .prepare(
      `SELECT s.id, s.type, s.status,
         (SELECT MAX(COALESCE(r.started_at, r.queued_at)) FROM sync_runs r WHERE r.server_id = s.id) AS last_started,
         (SELECT MAX(r.started_at) FROM sync_runs r WHERE r.server_id = s.id AND r.status = 'succeeded') AS last_ok_started,
         (SELECT MAX(r.ended_at) FROM sync_runs r WHERE r.server_id = s.id AND r.status = 'succeeded' AND r.type = 'full') AS last_full_ok
       FROM servers s
      WHERE s.status IN ('active','degraded')
        AND EXISTS (SELECT 1 FROM libraries l WHERE l.server_id = s.id AND l.enabled = 1)
      ORDER BY s.id`,
    )
    .all<DueServerRow>()
    .then((r) => r.results);
}

export interface SyncLibraryRow {
  id: string;
  provider_library_id: string;
  name: string;
  kind: 'movies' | 'tv';
  last_full_sync_id: string | null;
}

export function listEnabledLibraries(db: D1Database, serverId: string): Promise<SyncLibraryRow[]> {
  return db
    .prepare(
      `SELECT id, provider_library_id, name, kind, last_full_sync_id FROM libraries
        WHERE server_id = ? AND enabled = 1 ORDER BY id`,
    )
    .bind(serverId)
    .all<SyncLibraryRow>()
    .then((r) => r.results);
}

export interface SyncServerRow {
  id: string;
  type: 'jellyfin' | 'emby' | 'plex';
  base_url: string;
  origin_server_id: string;
  priority: number;
  status: string;
}

export function getSyncServer(db: D1Database, id: string): Promise<SyncServerRow | null> {
  return db
    .prepare(
      'SELECT id, type, base_url, origin_server_id, priority, status FROM servers WHERE id = ?',
    )
    .bind(id)
    .first<SyncServerRow>();
}

/** Bumps the catalog version so cached catalog responses can be invalidated (LLD-SYNC). */
export function bumpCatalogVersionStmt(db: D1Database): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO meta (k, v) VALUES ('catalog_version', '1')
       ON CONFLICT (k) DO UPDATE SET v = CAST(CAST(v AS INTEGER) + 1 AS TEXT)`,
  );
}

// --- service-token cache (LLD-TOKEN "Service-token caching") ---

export function getServiceTokenEnvelope(db: D1Database, serverId: string): Promise<string | null> {
  return db
    .prepare('SELECT service_token_envelope FROM server_credentials WHERE server_id = ?')
    .bind(serverId)
    .first<{ service_token_envelope: string | null }>()
    .then((r) => r?.service_token_envelope ?? null);
}

export function setServiceTokenEnvelope(
  db: D1Database,
  serverId: string,
  envelope: string | null,
  now: number,
): Promise<unknown> {
  return db
    .prepare(
      'UPDATE server_credentials SET service_token_envelope = ?, updated_at = ? WHERE server_id = ?',
    )
    .bind(envelope, now, serverId)
    .run();
}
