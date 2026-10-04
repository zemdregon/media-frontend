/**
 * D1 queries for C-SRV: servers, their encrypted credentials and libraries (LLD-SCHEMA, DR-002).
 * All SQL for these tables lives here (TDD-D1); every statement is a constant string with bound
 * parameters. Credential envelopes are only ever selected by `getCredentialRow`, never by the
 * catalog-facing queries.
 */
import type { LibraryKind, ServerStatus, ServerType } from '@cinewren/shared';

export interface ServerRow {
  id: string;
  type: ServerType;
  name: string;
  base_url: string;
  origin_server_id: string;
  version: string | null;
  priority: number;
  status: ServerStatus;
  last_validated_at: number | null;
  created_at: number;
  updated_at: number;
  key_version: number;
  library_count: number;
  enabled_library_count: number;
}

export interface LibraryRow {
  id: string;
  server_id: string;
  provider_library_id: string;
  name: string;
  kind: LibraryKind;
  enabled: number;
}

export interface CredentialRow {
  server_id: string;
  key_version: number;
  secret_envelope: string;
}

const SERVER_SELECT = `
  SELECT s.id, s.type, s.name, s.base_url, s.origin_server_id, s.version, s.priority, s.status,
         s.last_validated_at, s.created_at, s.updated_at, c.key_version,
         (SELECT COUNT(*) FROM libraries l WHERE l.server_id = s.id) AS library_count,
         (SELECT COUNT(*) FROM libraries l WHERE l.server_id = s.id AND l.enabled = 1)
           AS enabled_library_count
    FROM servers s JOIN server_credentials c ON c.server_id = s.id`;

export function listServers(db: D1Database): Promise<ServerRow[]> {
  return db
    .prepare(`${SERVER_SELECT} ORDER BY s.priority DESC, s.name COLLATE NOCASE, s.id`)
    .all<ServerRow>()
    .then((r) => r.results);
}

export function getServer(db: D1Database, id: string): Promise<ServerRow | null> {
  return db.prepare(`${SERVER_SELECT} WHERE s.id = ?`).bind(id).first<ServerRow>();
}

export function findServerByOriginId(
  db: D1Database,
  originServerId: string,
): Promise<{ id: string; name: string } | null> {
  return db
    .prepare('SELECT id, name FROM servers WHERE origin_server_id = ?')
    .bind(originServerId)
    .first<{ id: string; name: string }>();
}

export function getCredentialRow(db: D1Database, serverId: string): Promise<CredentialRow | null> {
  return db
    .prepare(
      'SELECT server_id, key_version, secret_envelope FROM server_credentials WHERE server_id = ?',
    )
    .bind(serverId)
    .first<CredentialRow>();
}

export function insertServerStmt(
  db: D1Database,
  s: {
    id: string;
    type: ServerType;
    name: string;
    baseUrl: string;
    originServerId: string;
    version: string;
    priority: number;
    now: number;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO servers (id, type, name, base_url, origin_server_id, version, priority, status,
                            last_validated_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_validation', ?, ?, ?)`,
    )
    .bind(
      s.id,
      s.type,
      s.name,
      s.baseUrl,
      s.originServerId,
      s.version,
      s.priority,
      s.now,
      s.now,
      s.now,
    );
}

export function insertCredentialStmt(
  db: D1Database,
  c: { serverId: string; keyVersion: number; envelope: string; now: number },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO server_credentials (server_id, key_version, secret_envelope, updated_at)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(c.serverId, c.keyVersion, c.envelope, c.now);
}

/** Library discovery: new libraries start disabled (FR-SRV-003); known ones keep their flag. */
export function upsertLibraryStmt(
  db: D1Database,
  l: { id: string; serverId: string; providerLibraryId: string; name: string; kind: LibraryKind },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO libraries (id, server_id, provider_library_id, name, kind, enabled)
       VALUES (?, ?, ?, ?, ?, 0)
       ON CONFLICT (server_id, provider_library_id) DO UPDATE SET name = excluded.name`,
    )
    .bind(l.id, l.serverId, l.providerLibraryId, l.name, l.kind);
}

export function markValidatedStmt(
  db: D1Database,
  serverId: string,
  version: string,
  now: number,
  activate: boolean,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE servers
          SET version = ?, last_validated_at = ?, updated_at = ?,
              status = CASE WHEN ? = 1 THEN 'active' ELSE status END
        WHERE id = ?`,
    )
    .bind(version, now, now, activate ? 1 : 0, serverId);
}

export interface ServerPatch {
  name?: string;
  baseUrl?: string;
  priority?: number;
  status?: ServerStatus;
}

/** Applies only the fields present in `patch`. */
export function updateServerStmt(
  db: D1Database,
  serverId: string,
  patch: ServerPatch,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE servers
          SET name = COALESCE(?, name), base_url = COALESCE(?, base_url),
              priority = COALESCE(?, priority), status = COALESCE(?, status), updated_at = ?
        WHERE id = ?`,
    )
    .bind(
      patch.name ?? null,
      patch.baseUrl ?? null,
      patch.priority ?? null,
      patch.status ?? null,
      now,
      serverId,
    );
}

export function listLibraries(db: D1Database, serverId: string): Promise<LibraryRow[]> {
  return db
    .prepare(
      `SELECT id, server_id, provider_library_id, name, kind, enabled
         FROM libraries WHERE server_id = ? ORDER BY name COLLATE NOCASE, id`,
    )
    .bind(serverId)
    .all<LibraryRow>()
    .then((r) => r.results);
}

export function getLibrary(db: D1Database, id: string): Promise<LibraryRow | null> {
  return db
    .prepare(
      `SELECT id, server_id, provider_library_id, name, kind, enabled FROM libraries WHERE id = ?`,
    )
    .bind(id)
    .first<LibraryRow>();
}

export function setLibraryEnabledStmt(
  db: D1Database,
  id: string,
  enabled: boolean,
): D1PreparedStatement {
  return db.prepare('UPDATE libraries SET enabled = ? WHERE id = ?').bind(enabled ? 1 : 0, id);
}
