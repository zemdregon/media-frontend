/**
 * User lifecycle and grants (T2.6; FR-USR-005, FR-USR-007, FR-USR-008, DR-005, BR-8, WF-7) and the
 * caller's own preferences (NFR-UX-001). Operator-only except `setTheme`. Every operator mutation
 * writes its audit row in the same batch (FR-OPS-005); audit details name users by ID only.
 *
 * Failure codes: `NOT_FOUND` (unknown user), `LAST_OPERATOR` (BR-8), `GRANTS_NOT_APPLICABLE`
 * (grants for an operator), `DISPLAY_NAME_TAKEN`, `VALIDATION_FAILED`.
 */
import type { Context } from 'hono';
import type {
  AdminUser,
  Page,
  Preferences,
  ReenrollLink,
  ThemePreference,
  UpdateUserRequest,
} from '@cinewren/shared';
import type { AppEnv } from '../api/context';
import { AppError } from '../api/errors';
import { expectKey, isString, openCursor, sealCursor } from '../catalog/cursor';
import { currentUser } from '../auth/sessions';
import { randomToken, sha256Hex } from '../auth/tokens';
import {
  auditStmt,
  countEnabledLibraries,
  grantListedStmt,
  guardChangedStmt,
  insertInviteStmt,
  isGuardOrConstraintError,
} from '../db/auth';
import {
  anonymizeUserAuditStmt,
  clearGrantsStmt,
  deleteIdempotencyOfUserStmt,
  deleteSessionsOfUserStmt,
  deleteUserStmt,
  getAdminUser,
  isLastActiveOperator,
  listUsers,
  revokeOpenReenrollInvitesStmt,
  setThemeStmt,
  updateUserStmt,
  type AdminUserRow,
} from '../db/users';
import { ulid } from '../platform/ids';
import { createPlaybackDeps } from '../playback/deps';
import { revokeAllSessions } from '../playback/lifecycle';

/** Re-enrollment link lifetime (FR-USR-007, proposed 24 h). */
export const REENROLL_TTL_MS = 24 * 3_600_000;

const notFound = () => new AppError('NOT_FOUND', 'Not found.');
const lastOperator = () => new AppError('LAST_OPERATOR', 'At least one operator must remain.');

function toAdminUser(row: AdminUserRow): AdminUser {
  let libraryIds: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.library_ids);
    if (Array.isArray(parsed)) libraryIds = parsed.filter(isString).sort();
  } catch {
    libraryIds = [];
  }
  return {
    id: row.id,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    passkeyCount: row.passkey_count,
    libraryIds: row.role === 'operator' ? [] : libraryIds,
  };
}

async function loadUser(c: Context<AppEnv>, id: string): Promise<AdminUserRow> {
  const row = await getAdminUser(c.env.DB, id);
  if (!row) throw notFound();
  return row;
}

// --- own preferences (NFR-UX-001) ---

/** Writes `users.theme_preference`; idempotent and not audited (not an operator mutation). */
export async function setTheme(c: Context<AppEnv>, theme: ThemePreference): Promise<Preferences> {
  await setThemeStmt(c.env.DB, currentUser(c).userId, theme).run();
  return { theme };
}

// --- operator: list, update, delete ---

export async function list(
  c: Context<AppEnv>,
  q: { cursor?: string | undefined; limit: number },
): Promise<Page<AdminUser>> {
  const scope = 'admin-users';
  const key = expectKey<[string, string]>(await openCursor(c, scope, q.cursor), [
    isString,
    isString,
  ]);
  const rows = await listUsers(c.env.DB, key, q.limit + 1);
  const more = rows.length > q.limit;
  const kept = more ? rows.slice(0, q.limit) : rows;
  const last = kept[kept.length - 1];
  return {
    items: kept.map(toAdminUser),
    nextCursor: more && last ? await sealCursor(c, scope, [last.name_key, last.id]) : null,
  };
}

/**
 * Role, status (disable or re-enable) and display name. Disabling deletes the user's sessions in
 * the same batch, so the next request fails (FR-USR-008). Re-enabling keeps the grants that were
 * left in place, so the user gets their previous access back (WF-7). The last active operator
 * can be neither disabled nor demoted (BR-8).
 */
export async function update(
  c: Context<AppEnv>,
  id: string,
  body: UpdateUserRequest,
): Promise<AdminUser> {
  const db = c.env.DB;
  const operator = currentUser(c);
  const row = await loadUser(c, id);

  const patch: Parameters<typeof updateUserStmt>[2] = {};
  const changes: Record<string, unknown> = {};
  if (body.role !== undefined && body.role !== row.role) {
    patch.role = body.role;
    changes.role = body.role;
  }
  if (body.status !== undefined && body.status !== row.status) {
    if (row.status === 'invited') {
      throw new AppError(
        'VALIDATION_FAILED',
        'This person has not accepted their invite yet. Revoke the invite instead.',
        { fields: ['status'] },
      );
    }
    patch.status = body.status;
    changes.status = body.status;
  }
  if (body.displayName !== undefined && body.displayName !== row.display_name) {
    patch.displayName = body.displayName;
    changes.fields = ['displayName'];
  }
  if (Object.keys(patch).length === 0) return toAdminUser(row); // idempotent, not audited

  const now = Date.now();
  const action =
    patch.status === 'disabled'
      ? 'user.disable'
      : patch.status === 'active'
        ? 'user.enable'
        : 'user.update';
  try {
    await db.batch([
      updateUserStmt(db, id, patch),
      guardChangedStmt(db), // aborts the batch when BR-8 or a vanished row blocked the update
      ...(patch.status === 'disabled' ? [deleteSessionsOfUserStmt(db, id)] : []),
      auditStmt(db, {
        id: ulid(),
        now,
        actorUserId: operator.userId,
        action,
        targetType: 'user',
        targetId: id,
        details: changes,
        requestId: c.get('requestId'),
      }),
    ]);
  } catch (err) {
    if (!isGuardOrConstraintError(err)) throw err;
    if (err instanceof Error && /UNIQUE/i.test(err.message)) {
      throw new AppError('DISPLAY_NAME_TAKEN', 'Someone already has that name.');
    }
    if (!(await getAdminUser(db, id))) throw notFound();
    throw lastOperator();
  }
  if (patch.status === 'disabled') {
    // FR-USR-008, FR-PLAY-007 (T5.8 SR-01): a disabled user's stream credentials end now, not
    // when BR-9 idles their sessions out. Failures stay revoke_pending for the sweep.
    await revokeAllSessions(playbackDepsOf(c), { userId: id }, 'user_disabled');
  }
  return toAdminUser(await loadUser(c, id));
}

function playbackDepsOf(c: Context<AppEnv>) {
  return createPlaybackDeps(c.env, { fetchImpl: c.get('originFetch'), logger: c.get('logger') });
}

/**
 * Deletes a user and their personal data (DR-005, FR-USR-008). First their open playback
 * sessions are ended and their origin stream credentials revoked (LLD-SCHEMA: revoking open
 * sessions comes first), because the delete cascades the session rows the revocation needs
 * (T5.8 SR-01). Then one batch: audit rows lose the pointer to the user, idempotency keys go,
 * and the guarded `DELETE` cascades passkeys, sessions (access ends at once), invites, grants,
 * progress and playback sessions. If it would leave no active operator the guard aborts the
 * whole batch (BR-8).
 */
export async function remove(c: Context<AppEnv>, id: string): Promise<void> {
  const db = c.env.DB;
  const operator = currentUser(c);
  const row = await loadUser(c, id);
  if (await isLastActiveOperator(db, id)) throw lastOperator();
  const { unrevoked } = await revokeAllSessions(playbackDepsOf(c), { userId: id }, 'user_deleted');
  if (unrevoked > 0) {
    // The origin could not be reached; the rows go with the user, so nothing can retry. The
    // operator sees this in the logs (residual risk, T5.8 report).
    c.get('logger').error('playback.revoke_abandoned', {
      reason: 'user_deleted',
      user_id: id,
      sessions: unrevoked,
    });
  }
  const now = Date.now();
  try {
    await db.batch([
      anonymizeUserAuditStmt(db, id),
      deleteIdempotencyOfUserStmt(db, id),
      deleteUserStmt(db, id),
      guardChangedStmt(db),
      auditStmt(db, {
        id: ulid(),
        now,
        // A self-deleting operator no longer exists to point at.
        actorUserId: operator.userId === id ? null : operator.userId,
        action: 'user.delete',
        targetType: 'user',
        targetId: null, // nothing may point at a deleted user (DR-005)
        details: { role: row.role },
        requestId: c.get('requestId'),
      }),
    ]);
  } catch (err) {
    if (!isGuardOrConstraintError(err)) throw err;
    if (!(await getAdminUser(db, id))) throw notFound();
    throw lastOperator();
  }
}

// --- operator: grants (FR-USR-005) ---

/** Replaces a viewer's library grants. Operators see every enabled library, so they have none. */
export async function setGrants(
  c: Context<AppEnv>,
  id: string,
  libraryIds: string[],
): Promise<{ libraryIds: string[] }> {
  const db = c.env.DB;
  const row = await loadUser(c, id);
  if (row.role === 'operator') {
    throw new AppError(
      'GRANTS_NOT_APPLICABLE',
      'Operators can see every enabled library, so they have no grants.',
    );
  }
  const ids = [...new Set(libraryIds)];
  if (ids.length > 0 && (await countEnabledLibraries(db, ids)) !== ids.length) {
    throw new AppError('VALIDATION_FAILED', 'Grants may only name enabled libraries.', {
      fields: ['libraryIds'],
    });
  }
  const now = Date.now();
  await db.batch([
    clearGrantsStmt(db, id),
    ...(ids.length > 0 ? [grantListedStmt(db, id, ids, now)] : []),
    auditStmt(db, {
      id: ulid(),
      now,
      actorUserId: currentUser(c).userId,
      action: 'user.grants',
      targetType: 'user',
      targetId: id,
      details: { libraryIds: ids.sort() },
      requestId: c.get('requestId'),
    }),
  ]);
  return { libraryIds: ids.sort() };
}

// --- operator: re-enrollment link (FR-USR-007) ---

/**
 * Issues a single-use re-enrollment link (24 h) that adds a passkey to an existing active user;
 * it changes neither role nor grants. Any earlier open link for the user is revoked, so only the
 * newest one works. The token is returned once and only its hash is stored (NFR-SEC-007).
 */
export async function reenroll(c: Context<AppEnv>, id: string): Promise<ReenrollLink> {
  const db = c.env.DB;
  const row = await loadUser(c, id);
  if (row.status !== 'active') {
    throw new AppError(
      'VALIDATION_FAILED',
      row.status === 'disabled'
        ? 'Re-enable this user before issuing a link.'
        : 'This person has not accepted their invite yet.',
      { fields: ['status'] },
    );
  }
  const now = Date.now();
  const inviteId = ulid();
  const token = randomToken(32);
  const expiresAt = now + REENROLL_TTL_MS;
  await db.batch([
    revokeOpenReenrollInvitesStmt(db, id, now),
    insertInviteStmt(db, {
      id: inviteId,
      kind: 'reenroll',
      tokenHash: await sha256Hex(token),
      userId: id,
      createdBy: currentUser(c).userId,
      now,
      expiresAt,
    }),
    auditStmt(db, {
      id: ulid(),
      now,
      actorUserId: currentUser(c).userId,
      action: 'user.reenroll',
      targetType: 'user',
      targetId: id,
      details: { inviteId },
      requestId: c.get('requestId'),
    }),
  ]);
  return { id: inviteId, link: `${c.get('config').appOrigin}/invite#t=${token}`, expiresAt };
}
