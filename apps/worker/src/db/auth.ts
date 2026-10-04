/**
 * D1 queries for C-AUTH: users, passkeys, sessions, invites, WebAuthn challenges and their audit
 * rows (LLD-SCHEMA, LLD-TOKEN). All SQL for these tables lives here (TDD-D1); every statement is
 * a constant string with bound parameters.
 */
import type { Role, ThemePreference } from '@cinewren/shared';

export type ChallengePurpose = 'setup' | 'signup' | 'reenroll' | 'login' | 'add_passkey';
export type InviteKind = 'signup' | 'reenroll';

export interface UserRow {
  id: string;
  display_name: string;
  role: Role;
  status: 'invited' | 'active' | 'disabled';
  theme_preference: ThemePreference;
}

export interface SessionRow {
  id_hash: string;
  user_id: string;
  passkey_id: string | null;
  last_seen_at: number;
  idle_expires_at: number;
  absolute_expires_at: number;
  /** Last fresh passkey ceremony on this session (SR-04); NULL once used or never. */
  reauth_at: number | null;
  display_name: string;
  role: Role;
  theme_preference: ThemePreference;
}

export interface ChallengeRow {
  id: string;
  challenge: string;
  purpose: ChallengePurpose;
  invite_id: string | null;
  user_id: string | null;
  expires_at: number;
}

export interface PasskeyRow {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: ArrayBuffer | number[];
  sign_count: number;
  transports: string;
  label: string | null;
  backed_up: number | null;
  created_at: number;
  last_used_at: number | null;
}

export interface NewPasskey {
  id: string;
  userId: string;
  credentialId: string;
  publicKey: Uint8Array;
  signCount: number;
  transports: string[];
  aaguid: string | null;
  backedUp: boolean;
  label: string | null;
  now: number;
}

export interface NewSession {
  idHash: string;
  userId: string;
  passkeyId: string | null;
  now: number;
  idleExpiresAt: number;
  absoluteExpiresAt: number;
  userAgentHint: string | null;
}

export interface InviteRow {
  id: string;
  kind: InviteKind;
  user_id: string;
  created_at: number;
  expires_at: number;
  redeemed_at: number | null;
  revoked_at: number | null;
  display_name: string;
  role: Role;
  user_status: UserRow['status'];
}

export interface AuditEntry {
  id: string;
  now: number;
  actorUserId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  details?: Record<string, unknown>;
  requestId: string | null;
}

/** BLOB columns come back as ArrayBuffer (or number[] on older runtimes). */
export function blobToBytes(value: ArrayBuffer | number[] | Uint8Array): Uint8Array<ArrayBuffer> {
  return value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value);
}

/**
 * Batch guard (LLD-TOKEN, LLD-ERR "D1 concurrency"): placed right after a compare-and-set
 * statement, it violates `meta.v NOT NULL` when that statement changed no rows, so the whole
 * `batch()` rolls back.
 */
export function guardChangedStmt(db: D1Database): D1PreparedStatement {
  return db.prepare("INSERT INTO meta (k, v) SELECT 'cas_guard', NULL WHERE changes() = 0");
}

export function isGuardOrConstraintError(err: unknown): boolean {
  return err instanceof Error && /constraint|NOT NULL/i.test(err.message);
}

// --- audit ---

export function auditStmt(db: D1Database, e: AuditEntry): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_log (id, at, actor_user_id, action, target_type, target_id, details, request_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      e.id,
      e.now,
      e.actorUserId,
      e.action,
      e.targetType,
      e.targetId,
      JSON.stringify(e.details ?? {}),
      e.requestId,
    );
}

// --- users ---

export async function operatorExists(db: D1Database): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS x FROM users WHERE role = 'operator' LIMIT 1").first();
  return row !== null;
}

export async function displayNameTaken(db: D1Database, name: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS x FROM users WHERE display_name = ?')
    .bind(name)
    .first();
  return row !== null;
}

export async function getUser(db: D1Database, id: string): Promise<UserRow | null> {
  return db
    .prepare('SELECT id, display_name, role, status, theme_preference FROM users WHERE id = ?')
    .bind(id)
    .first<UserRow>();
}

/** Guarded: inserts nothing if any operator exists, so concurrent setups cannot both win. */
export function insertFirstOperatorStmt(
  db: D1Database,
  id: string,
  displayName: string,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO users (id, display_name, role, status, created_at, last_seen_at)
       SELECT ?1, ?2, 'operator', 'active', ?3, ?3
       WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'operator')`,
    )
    .bind(id, displayName, now);
}

export function insertInvitedUserStmt(
  db: D1Database,
  id: string,
  displayName: string,
  role: Role,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO users (id, display_name, role, status, created_at) VALUES (?, ?, ?, 'invited', ?)`,
    )
    .bind(id, displayName, role, now);
}

export function activateInvitedUserStmt(
  db: D1Database,
  id: string,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      "UPDATE users SET status = 'active', last_seen_at = ? WHERE id = ? AND status = 'invited'",
    )
    .bind(now, id);
}

export function touchUserStmt(db: D1Database, id: string, now: number): D1PreparedStatement {
  return db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').bind(now, id);
}

// --- library grants ---

export async function countEnabledLibraries(db: D1Database, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const row = await db
    .prepare(
      'SELECT COUNT(*) AS n FROM libraries WHERE enabled = 1 AND id IN (SELECT value FROM json_each(?))',
    )
    .bind(JSON.stringify(ids))
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export function grantAllEnabledStmt(
  db: D1Database,
  userId: string,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      'INSERT INTO library_grants (user_id, library_id, granted_at) SELECT ?, id, ? FROM libraries WHERE enabled = 1',
    )
    .bind(userId, now);
}

export function grantListedStmt(
  db: D1Database,
  userId: string,
  libraryIds: string[],
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO library_grants (user_id, library_id, granted_at)
       SELECT ?, id, ? FROM libraries WHERE enabled = 1 AND id IN (SELECT value FROM json_each(?))`,
    )
    .bind(userId, now, JSON.stringify(libraryIds));
}

// --- passkeys ---

export function insertPasskeyStmt(db: D1Database, p: NewPasskey): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO passkey_credentials
         (id, user_id, credential_id, public_key, sign_count, transports, aaguid, backed_up, label, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      p.id,
      p.userId,
      p.credentialId,
      p.publicKey,
      p.signCount,
      JSON.stringify(p.transports),
      p.aaguid,
      p.backedUp ? 1 : 0,
      p.label,
      p.now,
    );
}

/** Looks up a credential for login; only an `active` user's passkey is returned. */
export async function findActivePasskey(
  db: D1Database,
  credentialId: string,
): Promise<PasskeyRow | null> {
  return db
    .prepare(
      `SELECT p.id, p.user_id, p.credential_id, p.public_key, p.sign_count, p.transports, p.label,
              p.backed_up, p.created_at, p.last_used_at
       FROM passkey_credentials p JOIN users u ON u.id = p.user_id
       WHERE p.credential_id = ? AND u.status = 'active'`,
    )
    .bind(credentialId)
    .first<PasskeyRow>();
}

export function recordPasskeyUseStmt(
  db: D1Database,
  id: string,
  signCount: number,
  now: number,
): D1PreparedStatement {
  return db
    .prepare('UPDATE passkey_credentials SET sign_count = ?, last_used_at = ? WHERE id = ?')
    .bind(signCount, now, id);
}

export async function listPasskeys(db: D1Database, userId: string): Promise<PasskeyRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, user_id, credential_id, public_key, sign_count, transports, label, backed_up,
              created_at, last_used_at
       FROM passkey_credentials WHERE user_id = ? ORDER BY created_at, id`,
    )
    .bind(userId)
    .all<PasskeyRow>();
  return results;
}

export async function credentialIdsForUser(db: D1Database, userId: string): Promise<string[]> {
  const { results } = await db
    .prepare('SELECT credential_id FROM passkey_credentials WHERE user_id = ?')
    .bind(userId)
    .all<{ credential_id: string }>();
  return results.map((r) => r.credential_id);
}

/**
 * Deletes one of the user's passkeys unless it is their last (FR-USR-006). The guard is in the
 * statement itself, so two concurrent removals cannot leave the user with none. Sessions created
 * with that passkey end by cascade.
 */
export async function deleteOwnPasskey(
  db: D1Database,
  id: string,
  userId: string,
): Promise<'deleted' | 'last' | 'not_found'> {
  const res = await db
    .prepare(
      `DELETE FROM passkey_credentials WHERE id = ?1 AND user_id = ?2
         AND (SELECT COUNT(*) FROM passkey_credentials WHERE user_id = ?2) > 1`,
    )
    .bind(id, userId)
    .run();
  if (res.meta.changes > 0) return 'deleted';
  const exists = await db
    .prepare('SELECT 1 AS x FROM passkey_credentials WHERE id = ? AND user_id = ?')
    .bind(id, userId)
    .first();
  return exists ? 'last' : 'not_found';
}

// --- sessions ---

/**
 * Every session is created by a passkey ceremony with user verification (setup, invite redemption
 * or login), so it starts fresh: `reauth_at = created_at` (SR-04).
 */
export function insertSessionStmt(db: D1Database, s: NewSession): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO sessions (id_hash, user_id, passkey_id, created_at, last_seen_at, idle_expires_at,
         absolute_expires_at, user_agent_hint, reauth_at)
       VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6, ?7, ?4)`,
    )
    .bind(
      s.idHash,
      s.userId,
      s.passkeyId,
      s.now,
      s.idleExpiresAt,
      s.absoluteExpiresAt,
      s.userAgentHint,
    );
}

/** A live session of an active user (LLD-TOKEN "Session ... Validated"). */
export async function findLiveSession(
  db: D1Database,
  idHash: string,
  now: number,
): Promise<SessionRow | null> {
  return db
    .prepare(
      `SELECT s.id_hash, s.user_id, s.passkey_id, s.last_seen_at, s.idle_expires_at, s.absolute_expires_at,
              s.reauth_at, u.display_name, u.role, u.theme_preference
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id_hash = ?1 AND u.status = 'active' AND s.idle_expires_at > ?2 AND s.absolute_expires_at > ?2`,
    )
    .bind(idHash, now)
    .first<SessionRow>();
}

export async function slideSession(
  db: D1Database,
  idHash: string,
  userId: string,
  now: number,
  idleExpiresAt: number,
): Promise<void> {
  await db.batch([
    db
      .prepare('UPDATE sessions SET last_seen_at = ?, idle_expires_at = ? WHERE id_hash = ?')
      .bind(now, idleExpiresAt, idHash),
    touchUserStmt(db, userId, now),
  ]);
}

/** Records a successful re-authentication on the session (`POST /me/reauth/verify`, SR-04). */
export function markReauthStmt(db: D1Database, idHash: string, now: number): D1PreparedStatement {
  return db.prepare('UPDATE sessions SET reauth_at = ? WHERE id_hash = ?').bind(now, idHash);
}

/**
 * Consumes the session's fresh authentication: clears `reauth_at` only if it is at or after
 * `notBefore`. Compare-and-set, so two concurrent add-passkey verifies cannot both use one
 * re-authentication. Returns true when it was consumed.
 */
export async function consumeReauth(
  db: D1Database,
  idHash: string,
  notBefore: number,
): Promise<boolean> {
  const res = await db
    .prepare('UPDATE sessions SET reauth_at = NULL WHERE id_hash = ? AND reauth_at >= ?')
    .bind(idHash, notBefore)
    .run();
  return res.meta.changes > 0;
}

export async function deleteSession(db: D1Database, idHash: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(idHash).run();
}

// --- WebAuthn challenges ---

export async function insertChallenge(db: D1Database, c: ChallengeRow): Promise<void> {
  await db
    .prepare(
      'INSERT INTO webauthn_challenges (id, challenge, purpose, invite_id, user_id, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(c.id, c.challenge, c.purpose, c.invite_id, c.user_id, c.expires_at)
    .run();
}

/** Deletes first and returns the row, so a challenge is single-use even when verification fails. */
export async function consumeChallenge(db: D1Database, id: string): Promise<ChallengeRow | null> {
  return db
    .prepare(
      'DELETE FROM webauthn_challenges WHERE id = ? RETURNING id, challenge, purpose, invite_id, user_id, expires_at',
    )
    .bind(id)
    .first<ChallengeRow>();
}

// --- invites ---

const INVITE_SELECT = `SELECT i.id, i.kind, i.user_id, i.created_at, i.expires_at, i.redeemed_at, i.revoked_at,
         u.display_name, u.role, u.status AS user_status
  FROM invites i JOIN users u ON u.id = i.user_id`;

/** An `issued` invite: token matches, not redeemed, not revoked, not expired. */
export async function findOpenInviteByHash(
  db: D1Database,
  tokenHash: string,
  now: number,
): Promise<InviteRow | null> {
  return db
    .prepare(
      `${INVITE_SELECT} WHERE i.token_hash = ? AND i.redeemed_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ?`,
    )
    .bind(tokenHash, now)
    .first<InviteRow>();
}

export async function getInvite(db: D1Database, id: string): Promise<InviteRow | null> {
  return db.prepare(`${INVITE_SELECT} WHERE i.id = ?`).bind(id).first<InviteRow>();
}

export async function listInvites(db: D1Database, limit: number): Promise<InviteRow[]> {
  const { results } = await db
    .prepare(`${INVITE_SELECT} ORDER BY i.created_at DESC, i.id DESC LIMIT ?`)
    .bind(limit)
    .all<InviteRow>();
  return results;
}

export function insertInviteStmt(
  db: D1Database,
  i: {
    id: string;
    kind: InviteKind;
    tokenHash: string;
    userId: string;
    createdBy: string | null;
    now: number;
    expiresAt: number;
  },
): D1PreparedStatement {
  return db
    .prepare(
      'INSERT INTO invites (id, kind, token_hash, user_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(i.id, i.kind, i.tokenHash, i.userId, i.createdBy, i.now, i.expiresAt);
}

/** CAS that consumes an invite; must be followed by `guardChangedStmt`. */
export function redeemInviteStmt(db: D1Database, id: string, now: number): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE invites SET redeemed_at = ?1
       WHERE id = ?2 AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > ?1`,
    )
    .bind(now, id);
}

export function revokeInviteStmt(db: D1Database, id: string, now: number): D1PreparedStatement {
  return db
    .prepare(
      'UPDATE invites SET revoked_at = ? WHERE id = ? AND redeemed_at IS NULL AND revoked_at IS NULL',
    )
    .bind(now, id);
}

/** FRD rule: revoking a signup invite deletes its still-`invited` user (cascades grants and invite). */
export function deleteInvitedUserOfRevokedInviteStmt(
  db: D1Database,
  inviteId: string,
): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM users WHERE status = 'invited' AND id = (
         SELECT user_id FROM invites
         WHERE id = ? AND kind = 'signup' AND revoked_at IS NOT NULL AND redeemed_at IS NULL)`,
    )
    .bind(inviteId);
}

// --- sweep (LLD-TOKEN `sweepAuth`) ---

export interface AuthSweepResult {
  challenges: number;
  sessions: number;
  expiredInvitees: number;
}

const SWEEP_CHUNK = 500;
/** Chunks per step per tick; whatever is left is picked up on the next tick. */
const SWEEP_MAX_CHUNKS = 20;

/**
 * `sweepAuth()` on the five-minute tick (LLD-TOKEN): deletes expired WebAuthn challenges and
 * expired sessions, and deletes the still-`invited` user of every signup invite that expired
 * unredeemed (FRD rule), which cascades their grants and the invite. Chunked so one tick stays
 * inside D1's per-query limits. Counts include rows removed by cascades.
 */
export async function sweepAuth(db: D1Database, now: number): Promise<AuthSweepResult> {
  const steps: [keyof AuthSweepResult, string][] = [
    [
      'challenges',
      `DELETE FROM webauthn_challenges WHERE rowid IN
         (SELECT rowid FROM webauthn_challenges WHERE expires_at <= ?1 LIMIT ?2)`,
    ],
    [
      'sessions',
      `DELETE FROM sessions WHERE rowid IN
         (SELECT rowid FROM sessions
           WHERE idle_expires_at <= ?1 OR absolute_expires_at <= ?1 LIMIT ?2)`,
    ],
    [
      'expiredInvitees',
      `DELETE FROM users WHERE status = 'invited' AND id IN
         (SELECT i.user_id FROM invites i JOIN users u ON u.id = i.user_id
           WHERE i.kind = 'signup' AND i.redeemed_at IS NULL AND i.expires_at <= ?1
             AND u.status = 'invited' LIMIT ?2)`,
    ],
  ];
  const out: AuthSweepResult = { challenges: 0, sessions: 0, expiredInvitees: 0 };
  for (const [key, sql] of steps) {
    for (let i = 0; i < SWEEP_MAX_CHUNKS; i++) {
      const changed = (await db.prepare(sql).bind(now, SWEEP_CHUNK).run()).meta.changes;
      if (changed === 0) break;
      out[key] += changed;
    }
  }
  return out;
}
