/** Own-passkey management (FR-USR-006). */
import type { Context } from 'hono';
import type { CeremonyOptions, PasskeySummary } from '@cinewren/shared';
import type { AppEnv } from '../api/context';
import { AppError } from '../api/errors';
import {
  credentialIdsForUser,
  deleteOwnPasskey,
  insertPasskeyStmt,
  isGuardOrConstraintError,
  listPasskeys,
  type PasskeyRow,
} from '../db/auth';
import { ulid } from '../platform/ids';
import { currentUser } from './sessions';
import {
  ceremonyFailed,
  registrationOptions,
  storeChallenge,
  takeChallenge,
  verifyRegistration,
} from './webauthn';

function toSummary(p: Pick<PasskeyRow, 'id' | 'label' | 'created_at' | 'last_used_at' | 'backed_up'>): PasskeySummary {
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

export async function addPasskeyOptions(c: Context<AppEnv>): Promise<CeremonyOptions> {
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
  const user = currentUser(c);
  const db = c.env.DB;
  const challenge = await takeChallenge(db, body.challengeId, ['add_passkey']);
  if (challenge.user_id !== user.userId) throw ceremonyFailed();
  const verified = await verifyRegistration(c.get('config'), c.get('logger'), body.response, challenge.challenge);
  const now = Date.now();
  const id = ulid();
  const label = body.label ?? null;
  try {
    await insertPasskeyStmt(db, { ...verified, id, userId: user.userId, label, now }).run();
  } catch (err) {
    if (isGuardOrConstraintError(err)) throw ceremonyFailed(); // credential already registered
    throw err;
  }
  return toSummary({ id, label, created_at: now, last_used_at: null, backed_up: verified.backedUp ? 1 : 0 });
}

export async function removePasskey(c: Context<AppEnv>, id: string): Promise<void> {
  const result = await deleteOwnPasskey(c.env.DB, id, currentUser(c).userId);
  if (result === 'not_found') throw new AppError('NOT_FOUND', 'Not found.');
  if (result === 'last') {
    throw new AppError('LAST_PASSKEY', "Add another passkey first. You can't remove your only one.");
  }
}
