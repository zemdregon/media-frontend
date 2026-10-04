/**
 * Own-passkey management (FR-USR-006) and the re-authentication that adding a passkey needs
 * (T5.8 SR-04, ADR-0014 notes): a stolen session cookie alone cannot enroll a new passkey.
 */
import type { Context } from 'hono';
import type { CeremonyOptions, PasskeySummary, ReauthResult } from '@cinewren/shared';
import type { AppEnv } from '../api/context';
import { AppError } from '../api/errors';
import {
  consumeReauth,
  credentialIdsForUser,
  deleteOwnPasskey,
  findActivePasskey,
  insertPasskeyStmt,
  isGuardOrConstraintError,
  listPasskeys,
  markReauthStmt,
  recordPasskeyUseStmt,
  type PasskeyRow,
} from '../db/auth';
import { ulid } from '../platform/ids';
import { currentUser, isFresh, REAUTH_WINDOW_MS, reauthRequired } from './sessions';
import {
  authenticationOptions,
  ceremonyFailed,
  registrationOptions,
  storeChallenge,
  takeChallenge,
  verifyAuthentication,
  verifyRegistration,
} from './webauthn';

function toSummary(
  p: Pick<PasskeyRow, 'id' | 'label' | 'created_at' | 'last_used_at' | 'backed_up'>,
): PasskeySummary {
  return {
    id: p.id,
    label: p.label,
    createdAt: p.created_at,
    lastUsedAt: p.last_used_at,
    backedUp: p.backed_up === 1,
  };
}

export async function ownPasskeys(c: Context<AppEnv>): Promise<PasskeySummary[]> {
  return (await listPasskeys(c.env.DB, currentUser(c).userId)).map(toSummary);
}

/**
 * `POST /me/reauth/options`: an assertion challenge limited to the caller's own passkeys. It is a
 * `login`-purpose challenge bound to the user, which login verify refuses (no schema change to the
 * purpose CHECK).
 */
export async function reauthOptions(c: Context<AppEnv>): Promise<CeremonyOptions> {
  const user = currentUser(c);
  const config = c.get('config');
  const options = await authenticationOptions(
    config,
    await credentialIdsForUser(c.env.DB, user.userId),
  );
  const challengeId = await storeChallenge(c.env.DB, config, 'login', options.challenge, {
    userId: user.userId,
  });
  return { challengeId, options: options as unknown as Record<string, unknown> };
}

/**
 * `POST /me/reauth/verify`: a user-verified assertion from one of the caller's own passkeys marks
 * the current session fresh. Another user's passkey, a challenge issued to someone else or a
 * sign-in challenge all fail with the generic ceremony error (400, so the SPA keeps the session).
 */
export async function reauthVerify(
  c: Context<AppEnv>,
  body: { challengeId: string; response: { id: string } },
): Promise<ReauthResult> {
  const user = currentUser(c);
  const db = c.env.DB;
  const logger = c.get('logger');
  const challenge = await takeChallenge(db, body.challengeId, ['login']);
  if (challenge.user_id !== user.userId) throw ceremonyFailed();
  const passkey = await findActivePasskey(db, body.response.id);
  if (passkey?.user_id !== user.userId) {
    logger.warn('auth.reauth.failed', { reason: 'foreign_credential' });
    throw ceremonyFailed();
  }
  const newCounter = await verifyAuthentication(
    c.get('config'),
    logger,
    body.response,
    challenge.challenge,
    passkey,
    400,
  );
  const now = Date.now();
  await db.batch([
    recordPasskeyUseStmt(db, passkey.id, newCounter, now),
    markReauthStmt(db, user.sessionIdHash, now),
  ]);
  logger.info('auth.reauth.succeeded', { passkey_id: passkey.id });
  return { freshUntil: now + REAUTH_WINDOW_MS };
}

/** Adding a passkey needs a fresh authentication on this session (SR-04). */
function requireFresh(c: Context<AppEnv>): void {
  if (!isFresh(currentUser(c).reauthAt, Date.now())) {
    c.get('logger').info('auth.denied', { reason: 'reauth_required' });
    throw reauthRequired();
  }
}

export async function addPasskeyOptions(c: Context<AppEnv>): Promise<CeremonyOptions> {
  requireFresh(c);
  const user = currentUser(c);
  const config = c.get('config');
  const options = await registrationOptions(config, {
    userId: user.userId,
    displayName: user.displayName,
    excludeCredentialIds: await credentialIdsForUser(c.env.DB, user.userId),
  });
  const challengeId = await storeChallenge(c.env.DB, config, 'add_passkey', options.challenge, {
    userId: user.userId,
  });
  return { challengeId, options: options as unknown as Record<string, unknown> };
}

export async function addPasskeyVerify(
  c: Context<AppEnv>,
  body: { challengeId: string; response: unknown; label?: string | undefined },
): Promise<PasskeySummary> {
  requireFresh(c);
  const user = currentUser(c);
  const db = c.env.DB;
  const challenge = await takeChallenge(db, body.challengeId, ['add_passkey']);
  if (challenge.user_id !== user.userId) throw ceremonyFailed();
  const verified = await verifyRegistration(
    c.get('config'),
    c.get('logger'),
    body.response,
    challenge.challenge,
  );
  const now = Date.now();
  // Single use: each new passkey spends one fresh authentication. The compare-and-set also stops
  // two concurrent verifies from sharing one.
  if (!(await consumeReauth(db, user.sessionIdHash, now - REAUTH_WINDOW_MS))) {
    throw reauthRequired();
  }
  const id = ulid();
  const label = body.label ?? null;
  try {
    await insertPasskeyStmt(db, { ...verified, id, userId: user.userId, label, now }).run();
  } catch (err) {
    if (isGuardOrConstraintError(err)) throw ceremonyFailed(); // credential already registered
    throw err;
  }
  return toSummary({
    id,
    label,
    created_at: now,
    last_used_at: null,
    backed_up: verified.backedUp ? 1 : 0,
  });
}

/**
 * Removal is not gated by re-authentication (agent decision, SR-04): it can only reduce access,
 * the last passkey cannot be removed, and the sessions created with the removed passkey end.
 */
export async function removePasskey(c: Context<AppEnv>, id: string): Promise<void> {
  const result = await deleteOwnPasskey(c.env.DB, id, currentUser(c).userId);
  if (result === 'not_found') throw new AppError('NOT_FOUND', 'Not found.');
  if (result === 'last') {
    throw new AppError(
      'LAST_PASSKEY',
      "Add another passkey first. You can't remove your only one.",
    );
  }
}
