/**
 * D1 queries for the user lifecycle (T2.6; FR-USR-005, FR-USR-007, FR-USR-008, DR-005, BR-8,
 * NFR-UX-001). Constant statements with bound parameters (TDD-D1). The BR-8 guards are inside the
 * statements, so two concurrent requests cannot both remove the last operator.
 */
import type { Role, ThemePreference, UserStatus } from '@cinewren/shared';
import { guardChangedStmt } from './auth';

export interface AdminUserRow {
  id: string;
  display_name: string;
  role: Role;
  status: UserStatus;
  created_at: number;
  last_seen_at: number | null;
  passkey_count: number;
  library_ids: string;
}

const USER_SELECT = `
  SELECT u.id, u.display_name, u.role, u.status, u.created_at, u.last_seen_at,
         (SELECT COUNT(*) FROM passkey_credentials p WHERE p.user_id = u.id) AS passkey_count,
         (SELECT json_group_array(g.library_id) FROM library_grants g WHERE g.user_id = u.id)
           AS library_ids
    FROM users u`;

export async function listUsers(
  db: D1Database,
  after: [string, string] | undefined,
  limit: number,
): Promise<(AdminUserRow & { name_key: string })[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM (SELECT x.*, lower(x.display_name) AS name_key FROM (${USER_SELECT}) x)
        WHERE (?1 IS NULL OR (name_key, id) > (?1, ?2))
        ORDER BY name_key, id LIMIT ?3`,
    )
    .bind(after?.[0] ?? null, after?.[1] ?? null, limit)
    .all<AdminUserRow & { name_key: string }>();
  return results;
}

export function getAdminUser(db: D1Database, id: string): Promise<AdminUserRow | null> {
  return db.prepare(`${USER_SELECT} WHERE u.id = ?`).bind(id).first<AdminUserRow>();
}

export function setThemeStmt(
  db: D1Database,
  userId: string,
  theme: ThemePreference,
): D1PreparedStatement {
  return db.prepare('UPDATE users SET theme_preference = ? WHERE id = ?').bind(theme, userId);
}

/**
 * Applies role, status and name together. The WHERE clause refuses any change that would leave
 * no active operator (BR-8): the row must not be an active operator that this change turns into
 * something else while no other active operator exists. Follow with `guardChangedStmt`.
 */
export function updateUserStmt(
  db: D1Database,
  id: string,
  patch: {
    role?: Role | undefined;
    status?: 'active' | 'disabled' | undefined;
    displayName?: string | undefined;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE users SET role = COALESCE(?2, role), status = COALESCE(?3, status),
                        display_name = COALESCE(?4, display_name)
        WHERE id = ?1
          AND NOT (role = 'operator' AND status = 'active'
                   AND (COALESCE(?2, role) <> 'operator' OR COALESCE(?3, status) <> 'active')
                   AND NOT EXISTS (SELECT 1 FROM users o WHERE o.role = 'operator'
                                    AND o.status = 'active' AND o.id <> ?1))`,
    )
    .bind(id, patch.role ?? null, patch.status ?? null, patch.displayName ?? null);
}

export function deleteSessionsOfUserStmt(db: D1Database, userId: string): D1PreparedStatement {
  return db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId);
}

/** DR-005: audit rows keep their action and time but lose the pointer to the deleted user. */
export function anonymizeUserAuditStmt(db: D1Database, userId: string): D1PreparedStatement {
  return db
    .prepare("UPDATE audit_log SET target_id = NULL WHERE target_type = 'user' AND target_id = ?")
    .bind(userId);
}

/** `idempotency_keys` has no FK to users, so it is deleted explicitly (LLD-SCHEMA). */
export function deleteIdempotencyOfUserStmt(db: D1Database, userId: string): D1PreparedStatement {
  return db.prepare('DELETE FROM idempotency_keys WHERE user_id = ?').bind(userId);
}

/**
 * Deletes the user unless they are the last active operator (BR-8). FK cascades remove passkeys,
 * sessions, invites, grants, progress and playback sessions. Follow with `guardChangedStmt`.
 */
export function deleteUserStmt(db: D1Database, id: string): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM users WHERE id = ?1
         AND NOT (role = 'operator' AND status = 'active'
                  AND NOT EXISTS (SELECT 1 FROM users o WHERE o.role = 'operator'
                                   AND o.status = 'active' AND o.id <> ?1))`,
    )
    .bind(id);
}

/** True when `id` is the only active operator (BR-8); a pre-check, the batch guard stays final. */
export async function isLastActiveOperator(db: D1Database, id: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS x FROM users WHERE id = ?1 AND role = 'operator' AND status = 'active'
         AND NOT EXISTS (SELECT 1 FROM users o WHERE o.role = 'operator'
                          AND o.status = 'active' AND o.id <> ?1)`,
    )
    .bind(id)
    .first();
  return row !== null;
}

export function clearGrantsStmt(db: D1Database, userId: string): D1PreparedStatement {
  return db.prepare('DELETE FROM library_grants WHERE user_id = ?').bind(userId);
}

export function revokeOpenReenrollInvitesStmt(
  db: D1Database,
  userId: string,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE invites SET revoked_at = ? WHERE user_id = ? AND kind = 'reenroll'
         AND redeemed_at IS NULL AND revoked_at IS NULL`,
    )
    .bind(now, userId);
}

export { guardChangedStmt };
