/**
 * D1 queries for C-PLAY (LLD-SCHEMA `playback_sessions`, `watch_progress`, `idempotency_keys`,
 * `stream_device_leases`; LLD-TOKEN "Playback session lifecycle"; LLD-ERR "D1 concurrency").
 *
 * Visibility reuses the one BR-1 predicate of `db/catalog.ts` (`?1` operator flag, `?2` user ID),
 * so a play request can never reach a source the catalog would hide (NFR-SEC-002). Session state
 * changes are compare-and-set on `status` and report whether they won.
 */
import { Params, visibleItem, visibleSource, type Viewer } from './catalog';

async function all<T>(db: D1Database, sql: string, values: unknown[]): Promise<T[]> {
  const { results } = await db
    .prepare(sql)
    .bind(...values)
    .all<T>();
  return results;
}

// --- items and candidates ---

export interface PlayableItemRow {
  id: string;
  type: 'movie' | 'series' | 'season' | 'episode';
  title: string;
  runtime_ms: number | null;
  parent_id: string | null;
}

export async function getVisiblePlayItem(
  db: D1Database,
  viewer: Viewer,
  id: string,
): Promise<PlayableItemRow | null> {
  const p = new Params(viewer);
  const rows = await all<PlayableItemRow>(
    db,
    `SELECT i.id, i.type, i.title, i.runtime_ms, i.parent_id FROM media_items i
      WHERE i.id = ${p.add(id)} AND ${visibleItem('i')}`,
    p.values,
  );
  return rows[0] ?? null;
}

export interface CandidateRow {
  source_id: string;
  version_id: string;
  provider_item_id: string;
  provider_version_id: string;
  server_id: string;
  server_name: string;
  server_type: 'jellyfin' | 'emby' | 'plex';
  server_status: string;
  priority: number;
  last_latency_ms: number | null;
  container: string | null;
  video_codec: string | null;
  width: number | null;
  height: number | null;
  hdr: string;
  size_bytes: number | null;
  runtime_ms: number | null;
  audio_tracks: string;
  subtitle_tracks: string;
}

/**
 * Every (source, version) of one movie or episode that the caller may see (BR-1), including
 * those on `unreachable` servers (the copy table shows them; selection filters them).
 */
export function visibleCandidates(
  db: D1Database,
  viewer: Viewer,
  itemId: string,
): Promise<CandidateRow[]> {
  const p = new Params(viewer);
  return all<CandidateRow>(
    db,
    `SELECT s.id AS source_id, v.id AS version_id, s.provider_item_id, v.provider_version_id,
            sv.id AS server_id, sv.name AS server_name, sv.type AS server_type,
            sv.status AS server_status, sv.priority, sv.last_latency_ms,
            v.container, v.video_codec, v.width, v.height, v.hdr, v.size_bytes, v.runtime_ms,
            v.audio_tracks, v.subtitle_tracks
       FROM sources s
       JOIN media_versions v ON v.source_id = s.id
       JOIN servers sv ON sv.id = s.server_id
      WHERE s.media_item_id = ${p.add(itemId)} AND ${visibleSource('s')}`,
    p.values,
  );
}

export interface PlaybackServerRow {
  id: string;
  type: 'jellyfin' | 'emby' | 'plex';
  base_url: string;
  origin_server_id: string;
  status: string;
}

/** Any server row, whatever its status: revocation must still reach a disabled server. */
export function getPlaybackServer(db: D1Database, id: string): Promise<PlaybackServerRow | null> {
  return db
    .prepare('SELECT id, type, base_url, origin_server_id, status FROM servers WHERE id = ?')
    .bind(id)
    .first<PlaybackServerRow>();
}

// --- episodes (FR-PROG-004) ---

export interface EpisodeRow {
  id: string;
  season: number;
  episode: number;
  watched: number | null;
  position_ms: number | null;
  updated_at: number | null;
}

/** Visible regular-season episodes of a series in order, with the caller's progress. */
export function seriesEpisodes(
  db: D1Database,
  viewer: Viewer,
  seriesId: string,
): Promise<EpisodeRow[]> {
  const p = new Params(viewer);
  return all<EpisodeRow>(
    db,
    `SELECT ep.id, COALESCE(se.season_number, ep.season_number, 0) AS season,
            COALESCE(ep.episode_number, 0) AS episode,
            wp.watched, wp.position_ms, wp.updated_at
       FROM media_items ep
       JOIN media_items se ON se.id = ep.parent_id
       LEFT JOIN watch_progress wp ON wp.media_item_id = ep.id AND wp.user_id = ?2
      WHERE se.parent_id = ${p.add(seriesId)} AND ep.type = 'episode'
        AND COALESCE(se.season_number, ep.season_number, 0) > 0
        AND ${visibleItem('ep')}
      ORDER BY season, episode, ep.id`,
    p.values,
  );
}

export interface CardRow {
  id: string;
  type: 'movie' | 'series' | 'season' | 'episode';
  title: string;
  year: number | null;
  season_number: number | null;
  episode_number: number | null;
  poster_tag: string | null;
}

const CARD = `i.id, i.type, i.title, i.year, i.season_number, i.episode_number,
  (SELECT json_extract(ms.artwork, '$.poster.tag') FROM sources ms
    WHERE ms.id = i.metadata_source_id) AS poster_tag`;

export async function itemCardById(
  db: D1Database,
  viewer: Viewer,
  id: string,
): Promise<CardRow | null> {
  const p = new Params(viewer);
  const rows = await all<CardRow>(
    db,
    `SELECT ${CARD} FROM media_items i WHERE i.id = ${p.add(id)} AND ${visibleItem('i')}`,
    p.values,
  );
  return rows[0] ?? null;
}

export type ContinueRow = CardRow & { position_ms: number; runtime_ms: number | null };

/** FR-CAT-008: resumable, unwatched, visible items, most recently watched first. */
export function continueWatching(
  db: D1Database,
  viewer: Viewer,
  resumeFloorMs: number,
  limit: number,
): Promise<ContinueRow[]> {
  const p = new Params(viewer);
  return all<ContinueRow>(
    db,
    `SELECT ${CARD}, wp.position_ms, COALESCE(wp.runtime_ms, i.runtime_ms) AS runtime_ms
       FROM watch_progress wp
       JOIN media_items i ON i.id = wp.media_item_id
      WHERE wp.user_id = ?2 AND wp.watched = 0 AND wp.position_ms > ${p.add(resumeFloorMs)}
        AND i.type IN ('movie','episode') AND ${visibleItem('i')}
      ORDER BY wp.updated_at DESC, i.id DESC LIMIT ${p.add(limit)}`,
    p.values,
  );
}

// --- progress (FR-PROG-001, FR-PROG-003, BR-7) ---

export interface ProgressRow {
  position_ms: number;
  runtime_ms: number | null;
  watched: number;
  watched_at: number | null;
}

export function getProgress(
  db: D1Database,
  userId: string,
  itemId: string,
): Promise<ProgressRow | null> {
  return db
    .prepare(
      'SELECT position_ms, runtime_ms, watched, watched_at FROM watch_progress WHERE user_id = ? AND media_item_id = ?',
    )
    .bind(userId, itemId)
    .first<ProgressRow>();
}

export interface ProgressWrite {
  userId: string;
  itemId: string;
  positionMs: number;
  runtimeMs: number | null;
  watched: boolean;
  /** Keep the existing `watched_at` when the item was already watched. */
  now: number;
  sourceId: string | null;
}

/** Last write wins by server receive time (LLD-ERR "Idempotency"). */
export function upsertProgressStmt(db: D1Database, w: ProgressWrite): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO watch_progress (user_id, media_item_id, position_ms, runtime_ms, watched, watched_at,
         last_source_id, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, CASE WHEN ?5 = 1 THEN ?6 ELSE NULL END, ?7, ?6)
       ON CONFLICT (user_id, media_item_id) DO UPDATE SET
         position_ms = excluded.position_ms,
         runtime_ms = COALESCE(excluded.runtime_ms, watch_progress.runtime_ms),
         watched = excluded.watched,
         watched_at = CASE WHEN excluded.watched = 0 THEN NULL
                           ELSE COALESCE(watch_progress.watched_at, excluded.watched_at) END,
         last_source_id = COALESCE(excluded.last_source_id, watch_progress.last_source_id),
         updated_at = excluded.updated_at`,
    )
    .bind(w.userId, w.itemId, w.positionMs, w.runtimeMs, w.watched ? 1 : 0, w.now, w.sourceId);
}

// --- playback sessions (BR-9) ---

export type SessionStatus = 'authorized' | 'started' | 'ended' | 'expired' | 'failed';

export interface SessionRow {
  id: string;
  user_id: string;
  media_item_id: string | null;
  source_id: string | null;
  server_id: string | null;
  version_id: string | null;
  mode: 'direct_play' | 'direct_stream' | 'transcode';
  status: SessionStatus;
  credential_envelope: string | null;
  revoke_pending: number;
  provider_session_ref: string | null;
  last_event_seq: number;
  authorized_at: number;
  auth_expires_at: number;
  started_at: number | null;
  last_progress_at: number | null;
  ended_at: number | null;
  end_reason: string | null;
}

const SESSION_COLUMNS = `id, user_id, media_item_id, source_id, server_id, version_id, mode, status,
  credential_envelope, revoke_pending, provider_session_ref, last_event_seq, authorized_at,
  auth_expires_at, started_at, last_progress_at, ended_at, end_reason`;

export interface NewSession {
  id: string;
  userId: string;
  itemId: string;
  sourceId: string;
  serverId: string;
  versionId: string;
  mode: SessionRow['mode'];
  credentialEnvelope: string;
  replacesSessionId: string | null;
  decision: string;
  now: number;
  authExpiresAt: number;
}

/**
 * Inserted as soon as the stream credential exists and before negotiation, so a credential is
 * never minted without a row that lets the sweep revoke it (LLD-TOKEN: "negotiation failed after
 * the session row was created" → failed).
 */
export function insertSession(db: D1Database, s: NewSession): Promise<unknown> {
  return db
    .prepare(
      `INSERT INTO playback_sessions (id, user_id, media_item_id, source_id, server_id, version_id,
         mode, status, credential_envelope, revoke_pending, replaces_session_id, decision,
         last_event_seq, authorized_at, auth_expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'authorized', ?, 0, ?, ?, 0, ?, ?)`,
    )
    .bind(
      s.id,
      s.userId,
      s.itemId,
      s.sourceId,
      s.serverId,
      s.versionId,
      s.mode,
      s.credentialEnvelope,
      s.replacesSessionId,
      s.decision,
      s.now,
      s.authExpiresAt,
    )
    .run();
}

export function setNegotiated(
  db: D1Database,
  id: string,
  mode: SessionRow['mode'],
  providerSessionRef: string | null,
  decision: string,
): Promise<unknown> {
  return db
    .prepare(
      `UPDATE playback_sessions SET mode = ?, provider_session_ref = ?, decision = ?
        WHERE id = ? AND status = 'authorized'`,
    )
    .bind(mode, providerSessionRef, decision, id)
    .run();
}

export function getSession(db: D1Database, id: string): Promise<SessionRow | null> {
  return db
    .prepare(`SELECT ${SESSION_COLUMNS} FROM playback_sessions WHERE id = ?`)
    .bind(id)
    .first<SessionRow>();
}

export function getUserSession(
  db: D1Database,
  userId: string,
  id: string,
): Promise<SessionRow | null> {
  return db
    .prepare(`SELECT ${SESSION_COLUMNS} FROM playback_sessions WHERE id = ? AND user_id = ?`)
    .bind(id, userId)
    .first<SessionRow>();
}

/**
 * Moves a live session to a terminal status (CAS) and marks its credential for revocation.
 * Returns whether this call won the transition.
 */
export async function endSession(
  db: D1Database,
  id: string,
  to: 'ended' | 'expired' | 'failed',
  reason: string,
  now: number,
  from: readonly SessionStatus[] = ['authorized', 'started'],
): Promise<boolean> {
  const marks = from.map(() => '?').join(',');
  const res = await db
    .prepare(
      `UPDATE playback_sessions
          SET status = ?, end_reason = ?, ended_at = ?,
              revoke_pending = CASE WHEN credential_envelope IS NULL THEN 0 ELSE 1 END
        WHERE id = ? AND status IN (${marks})`,
    )
    .bind(to, reason, now, id, ...from)
    .run();
  return res.meta.changes > 0;
}

/**
 * Accepts an event `seq` once (LLD-ERR "Idempotency"): advances `last_event_seq`, starts an
 * authorized session and refreshes `last_progress_at`. False for a duplicate, an out-of-order
 * event or a session that is no longer live.
 */
export async function acceptEvent(
  db: D1Database,
  id: string,
  seq: number,
  now: number,
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE playback_sessions
          SET last_event_seq = ?2, last_progress_at = ?3,
              started_at = COALESCE(started_at, ?3),
              status = 'started'
        WHERE id = ?1 AND last_event_seq < ?2 AND status IN ('authorized','started')`,
    )
    .bind(id, seq, now)
    .run();
  return res.meta.changes > 0;
}

/** Records the event seq of a terminal event without changing status (ended by the caller). */
export async function acceptFinalEvent(
  db: D1Database,
  id: string,
  seq: number,
  now: number,
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE playback_sessions SET last_event_seq = ?2, last_progress_at = ?3
        WHERE id = ?1 AND last_event_seq < ?2 AND status IN ('authorized','started')`,
    )
    .bind(id, seq, now)
    .run();
  return res.meta.changes > 0;
}

/** Sessions the BR-9 sweep must expire: unstarted past their window, or silent too long. */
export function listExpirable(
  db: D1Database,
  now: number,
  idleCutoff: number,
  limit: number,
): Promise<{ id: string; status: SessionStatus }[]> {
  return all(
    db,
    `SELECT id, status FROM playback_sessions
      WHERE (status = 'authorized' AND auth_expires_at < ?1)
         OR (status = 'started' AND COALESCE(last_progress_at, started_at, authorized_at) < ?2)
      LIMIT ?3`,
    [now, idleCutoff, limit],
  );
}

export function listRevokePending(db: D1Database, limit: number): Promise<SessionRow[]> {
  return all(
    db,
    `SELECT ${SESSION_COLUMNS} FROM playback_sessions WHERE revoke_pending = 1
      ORDER BY ended_at LIMIT ?`,
    [limit],
  );
}

/** The credential is gone from the origin (or abandoned): forget it. */
export function clearCredential(db: D1Database, id: string): Promise<unknown> {
  return db
    .prepare(
      'UPDATE playback_sessions SET credential_envelope = NULL, revoke_pending = 0 WHERE id = ?',
    )
    .bind(id)
    .run();
}

/**
 * Every session of a user or a server that still holds an origin credential: live ones, and ended
 * ones whose revocation has not happened yet. Used before a user or server is removed, so the
 * credentials are revoked while the rows and the server credentials still exist (T5.8 SR-01,
 * SR-02; LLD-SCHEMA "Cascades and deletion": revoking open sessions comes first).
 */
export function listCredentialHoldingSessions(
  db: D1Database,
  by: { userId: string } | { serverId: string },
): Promise<SessionRow[]> {
  const column = 'userId' in by ? 'user_id' : 'server_id';
  return all(
    db,
    `SELECT ${SESSION_COLUMNS} FROM playback_sessions
      WHERE ${column} = ? AND credential_envelope IS NOT NULL
        AND (status IN ('authorized','started') OR revoke_pending = 1)
      ORDER BY authorized_at`,
    ['userId' in by ? by.userId : by.serverId],
  );
}

/** Whether the caller may still see a session's source (BR-1), checked on every event (SR-06). */
export async function sourceStillVisible(
  db: D1Database,
  viewer: Viewer,
  sourceId: string,
): Promise<boolean> {
  const p = new Params(viewer);
  const rows = await all<{ x: number }>(
    db,
    `SELECT 1 AS x FROM sources s WHERE s.id = ${p.add(sourceId)} AND ${visibleSource('s')}`,
    p.values,
  );
  return rows.length > 0;
}

/** Marks a live session for revocation without changing status (used before an inline revoke). */
export function markRevokePending(db: D1Database, id: string): Promise<unknown> {
  return db
    .prepare(
      'UPDATE playback_sessions SET revoke_pending = 1 WHERE id = ? AND credential_envelope IS NOT NULL',
    )
    .bind(id)
    .run();
}

// --- DeviceId pool (ADR-0013 Emby amendment) ---

/** Leases the lowest free slot below `size`; null when the pool is exhausted. */
export async function leaseDeviceSlot(
  db: D1Database,
  serverId: string,
  sessionId: string,
  size: number,
  now: number,
): Promise<number | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await db
      .prepare(
        `WITH RECURSIVE n(slot) AS (SELECT 0 UNION ALL SELECT slot + 1 FROM n WHERE slot + 1 < ?4)
         INSERT OR IGNORE INTO stream_device_leases (server_id, slot, session_id, leased_at)
         SELECT ?1, n.slot, ?2, ?3 FROM n
          WHERE n.slot NOT IN (SELECT slot FROM stream_device_leases WHERE server_id = ?1)
          ORDER BY n.slot LIMIT 1
         RETURNING slot`,
      )
      .bind(serverId, sessionId, now, size)
      .first<{ slot: number }>();
    if (row) return row.slot;
    // Either the pool is full or a concurrent lease took the same slot: look again.
    const used = await db
      .prepare('SELECT COUNT(*) AS n FROM stream_device_leases WHERE server_id = ?')
      .bind(serverId)
      .first<{ n: number }>();
    if ((used?.n ?? 0) >= size) return null;
  }
  return null;
}

export function getLease(
  db: D1Database,
  sessionId: string,
): Promise<{ server_id: string; slot: number } | null> {
  return db
    .prepare('SELECT server_id, slot FROM stream_device_leases WHERE session_id = ?')
    .bind(sessionId)
    .first();
}

export function releaseLease(db: D1Database, sessionId: string): Promise<unknown> {
  return db.prepare('DELETE FROM stream_device_leases WHERE session_id = ?').bind(sessionId).run();
}

/** Leases whose session row never got written (a crash between mint and insert). */
export function listOrphanLeases(
  db: D1Database,
  olderThan: number,
  limit: number,
): Promise<{ server_id: string; slot: number; session_id: string }[]> {
  return all(
    db,
    `SELECT l.server_id, l.slot, l.session_id FROM stream_device_leases l
      WHERE l.leased_at < ?1
        AND NOT EXISTS (SELECT 1 FROM playback_sessions ps WHERE ps.id = l.session_id)
      LIMIT ?2`,
    [olderThan, limit],
  );
}

// --- idempotency keys (LLD-ERR "Idempotency") ---

export interface IdempotencyRow {
  route: string;
  request_hash: string;
  status_code: number | null;
  response: string | null;
  created_at: number;
}

/** Claims the key; false when a row already exists (the caller then reads it). */
export async function claimIdempotencyKey(
  db: D1Database,
  userId: string,
  key: string,
  route: string,
  requestHash: string,
  now: number,
): Promise<boolean> {
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO idempotency_keys (user_id, key, route, request_hash, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(userId, key, route, requestHash, now)
    .run();
  return res.meta.changes > 0;
}

export function getIdempotencyKey(
  db: D1Database,
  userId: string,
  key: string,
): Promise<IdempotencyRow | null> {
  return db
    .prepare(
      'SELECT route, request_hash, status_code, response, created_at FROM idempotency_keys WHERE user_id = ? AND key = ?',
    )
    .bind(userId, key)
    .first<IdempotencyRow>();
}

export function completeIdempotencyKey(
  db: D1Database,
  userId: string,
  key: string,
  status: number,
  response: string,
): Promise<unknown> {
  return db
    .prepare(
      'UPDATE idempotency_keys SET status_code = ?, response = ? WHERE user_id = ? AND key = ?',
    )
    .bind(status, response, userId, key)
    .run();
}

export function releaseIdempotencyKey(
  db: D1Database,
  userId: string,
  key: string,
): Promise<unknown> {
  return db
    .prepare('DELETE FROM idempotency_keys WHERE user_id = ? AND key = ? AND response IS NULL')
    .bind(userId, key)
    .run();
}

/** Takes over an abandoned claim (no response after `staleBefore`). */
export async function retakeIdempotencyKey(
  db: D1Database,
  userId: string,
  key: string,
  requestHash: string,
  staleBefore: number,
  now: number,
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE idempotency_keys SET created_at = ?
        WHERE user_id = ? AND key = ? AND request_hash = ? AND response IS NULL AND created_at < ?`,
    )
    .bind(now, userId, key, requestHash, staleBefore)
    .run();
  return res.meta.changes > 0;
}
