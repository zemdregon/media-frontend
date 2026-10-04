/**
 * Invite create, list, revoke, inspect and redeem (FR-USR-002, FR-USR-004, FR-USR-005,
 * ADR-0014 §2, LLD-TOKEN). The token appears only in the link fragment; only its hash is stored.
 */
import type { Context } from 'hono';
import type {
  CeremonyOptions,
  CreatedInvite,
  Invite,
  InviteInspection,
  InviteStatus,
  Page,
  Role,
  UserSummary,
} from '@cinewren/shared';
import type { AppEnv } from '../api/context';
import { AppError } from '../api/errors';
import {
  activateInvitedUserStmt,
  auditStmt,
  countEnabledLibraries,
  credentialIdsForUser,
  deleteInvitedUserOfRevokedInviteStmt,
  displayNameTaken,
  findOpenInviteByHash,
  getInvite,
  grantAllEnabledStmt,
  grantListedStmt,
  guardChangedStmt,
  insertInvitedUserStmt,
  insertInviteStmt,
  insertPasskeyStmt,
  isGuardOrConstraintError,
  listInvites as listInviteRows,
  redeemInviteStmt,
  revokeInviteStmt,
  type InviteRow,
} from '../db/auth';
import { ulid } from '../platform/ids';
import { currentUser, prepareSession, setSessionCookie } from './sessions';
import { randomToken, sha256Hex } from './tokens';
import {
  ceremonyFailed,
  registrationOptions,
  storeChallenge,
  takeChallenge,
  verifyRegistration,
} from './webauthn';

const LIST_LIMIT = 200;

/** Unknown, expired, revoked and used invites are indistinguishable (LLD-ERR). */
const inviteInvalid = () =>
  new AppError(
    'INVITE_INVALID',
    'This invite link is no longer valid. Ask the person who runs this app for a new one.',
  );

function statusOf(row: InviteRow, now: number): InviteStatus {
  if (row.redeemed_at !== null) return 'redeemed';
  if (row.revoked_at !== null) return 'revoked';
  return row.expires_at <= now ? 'expired' : 'open';
}

function toInvite(row: InviteRow, now: number): Invite {
  return {
    id: row.id,
    kind: row.kind,
    userId: row.user_id,
    displayName: row.display_name,
    role: row.role,
    status: statusOf(row, now),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    redeemedAt: row.redeemed_at,
    revokedAt: row.revoked_at,
  };
}

// --- operator: create, list, revoke ---

export async function createInvite(
  c: Context<AppEnv>,
  body: { displayName: string; role: Role; libraryIds?: string[] | undefined },
): Promise<CreatedInvite> {
  const db = c.env.DB;
  const config = c.get('config');
  const operator = currentUser(c);
  if (await displayNameTaken(db, body.displayName)) {
    throw new AppError('DISPLAY_NAME_TAKEN', 'Someone already has that name.');
  }
  const libraryIds = body.libraryIds ? [...new Set(body.libraryIds)] : undefined;
  if (
    body.role === 'viewer' &&
    libraryIds &&
    (await countEnabledLibraries(db, libraryIds)) !== libraryIds.length
  ) {
    throw new AppError('VALIDATION_FAILED', 'Grants may only name enabled libraries.', {
      fields: ['libraryIds'],
    });
  }
  const now = Date.now();
  const userId = ulid();
  const inviteId = ulid();
  const token = randomToken(32);
  const expiresAt = now + config.inviteTtlMs;
  const grants =
    body.role === 'operator'
      ? [] // operators implicitly see every enabled library (FR-USR-005)
      : [
          libraryIds
            ? grantListedStmt(db, userId, libraryIds, now)
            : grantAllEnabledStmt(db, userId, now),
        ];
  try {
    await db.batch([
      insertInvitedUserStmt(db, userId, body.displayName, body.role, now),
      ...grants,
      insertInviteStmt(db, {
        id: inviteId,
        kind: 'signup',
        tokenHash: await sha256Hex(token),
        userId,
        createdBy: operator.userId,
        now,
        expiresAt,
      }),
      auditStmt(db, {
        id: ulid(),
        now,
        actorUserId: operator.userId,
        action: 'invite.create',
        targetType: 'invite',
        targetId: inviteId,
        details: { userId, role: body.role },
        requestId: c.get('requestId'),
      }),
    ]);
  } catch (err) {
    if (
      err instanceof Error &&
      /UNIQUE/i.test(err.message) &&
      (await displayNameTaken(db, body.displayName))
    ) {
      throw new AppError('DISPLAY_NAME_TAKEN', 'Someone already has that name.');
    }
    throw err;
  }
  return { id: inviteId, userId, link: `${config.appOrigin}/invite#t=${token}`, expiresAt };
}

export async function listInvites(
  c: Context<AppEnv>,
  status?: InviteStatus,
): Promise<Page<Invite>> {
  const now = Date.now();
  const items = (await listInviteRows(c.env.DB, LIST_LIMIT))
    .map((r) => toInvite(r, now))
    .filter((i) => !status || i.status === status);
  return { items, nextCursor: null };
}

export async function revokeInvite(c: Context<AppEnv>, id: string): Promise<void> {
  const db = c.env.DB;
  const invite = await getInvite(db, id);
  if (!invite) throw new AppError('NOT_FOUND', 'Not found.');
  if (invite.redeemed_at !== null) {
    throw new AppError('INVITE_ALREADY_REDEEMED', 'This invite has already been used.');
  }
  if (invite.revoked_at !== null) return; // idempotent
  const now = Date.now();
  const results = await db.batch([
    revokeInviteStmt(db, id, now),
    deleteInvitedUserOfRevokedInviteStmt(db, id),
    auditStmt(db, {
      id: ulid(),
      now,
      actorUserId: currentUser(c).userId,
      action: 'invite.revoke',
      targetType: 'invite',
      targetId: id,
      details: { userId: invite.user_id, kind: invite.kind },
      requestId: c.get('requestId'),
    }),
  ]);
  if ((results[0]?.meta.changes ?? 0) === 0) {
    // Redeemed between the read and the batch.
    throw new AppError('INVITE_ALREADY_REDEEMED', 'This invite has already been used.');
  }
}

// --- public: inspect and redeem ---

/** An `issued` invite whose user is in the state its kind requires. */
async function openInvite(db: D1Database, token: string): Promise<InviteRow> {
  const invite = await findOpenInviteByHash(db, await sha256Hex(token), Date.now());
  const userOk =
    invite !== null &&
    ((invite.kind === 'signup' && invite.user_status === 'invited') ||
      (invite.kind === 'reenroll' && invite.user_status === 'active'));
  if (!invite || !userOk) throw inviteInvalid();
  return invite;
}

export async function inspectInvite(c: Context<AppEnv>, token: string): Promise<InviteInspection> {
  const invite = await openInvite(c.env.DB, token);
  return {
    kind: invite.kind,
    role: invite.role,
    displayName: invite.display_name,
    expiresAt: invite.expires_at,
  };
}

export async function redeemOptions(c: Context<AppEnv>, token: string): Promise<CeremonyOptions> {
  const db = c.env.DB;
  const config = c.get('config');
  const invite = await openInvite(db, token);
  const options = await registrationOptions(config, {
    userId: invite.user_id,
    displayName: invite.display_name,
    excludeCredentialIds: await credentialIdsForUser(db, invite.user_id),
  });
  const challengeId = await storeChallenge(db, config, invite.kind, options.challenge, {
    inviteId: invite.id,
    userId: invite.user_id,
  });
  return { challengeId, options: options as unknown as Record<string, unknown> };
}

export async function redeemVerify(
  c: Context<AppEnv>,
  body: { token: string; challengeId: string; response: unknown; label?: string | undefined },
): Promise<UserSummary> {
  const db = c.env.DB;
  const config = c.get('config');
  const logger = c.get('logger');
  const challenge = await takeChallenge(db, body.challengeId, ['signup', 'reenroll']);
  const invite = await openInvite(db, body.token);
  if (challenge.invite_id !== invite.id || challenge.purpose !== invite.kind)
    throw ceremonyFailed();
  const passkey = await verifyRegistration(config, logger, body.response, challenge.challenge);
  const now = Date.now();
  const passkeyId = ulid();
  const session = await prepareSession(
    db,
    config,
    invite.user_id,
    passkeyId,
    now,
    c.req.header('user-agent'),
  );
  try {
    // One batch: CAS-consume the invite (guarded), activate the user, store the passkey and
    // start the session. Any failure rolls all of it back, leaving the invite `issued`.
    await db.batch([
      redeemInviteStmt(db, invite.id, now),
      guardChangedStmt(db),
      ...(invite.kind === 'signup'
        ? [activateInvitedUserStmt(db, invite.user_id, now), guardChangedStmt(db)]
        : []),
      insertPasskeyStmt(db, {
        ...passkey,
        id: passkeyId,
        userId: invite.user_id,
        label: body.label ?? null,
        now,
      }),
      session.stmt,
    ]);
  } catch (err) {
    if (isGuardOrConstraintError(err)) {
      logger.info('auth.redeem.failed', { invite_id: invite.id, error: err });
      throw inviteInvalid();
    }
    throw err;
  }
  setSessionCookie(c, session.cookieValue, config);
  logger.info('auth.redeem.succeeded', { user_id: invite.user_id, kind: invite.kind });
  return { id: invite.user_id, displayName: invite.display_name, role: invite.role };
}
