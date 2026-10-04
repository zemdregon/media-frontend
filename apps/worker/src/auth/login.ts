/** Passkey login and logout (FR-USR-001, FR-USR-006, WF-7 flows D and E). */
import type { Context } from 'hono';
import type { CeremonyOptions, UserSummary } from '@cinewren/shared';
import type { AppEnv } from '../api/context';
import { findActivePasskey, getUser, recordPasskeyUseStmt, touchUserStmt } from '../db/auth';
import { prepareSession, setSessionCookie } from './sessions';
import {
  authenticationOptions,
  ceremonyFailed,
  storeChallenge,
  takeChallenge,
  verifyAuthentication,
} from './webauthn';

export async function loginOptions(c: Context<AppEnv>): Promise<CeremonyOptions> {
  const config = c.get('config');
  const options = await authenticationOptions(config);
  const challengeId = await storeChallenge(c.env.DB, config, 'login', options.challenge);
  return { challengeId, options: options as unknown as Record<string, unknown> };
}

/** Unknown credential, disabled user and bad signature all look the same (401, LLD-API). */
export async function loginVerify(
  c: Context<AppEnv>,
  body: { challengeId: string; response: { id: string } },
): Promise<UserSummary> {
  const db = c.env.DB;
  const config = c.get('config');
  const logger = c.get('logger');
  const challenge = await takeChallenge(db, body.challengeId, ['login'], 401);
  const passkey = await findActivePasskey(db, body.response.id);
  if (!passkey) {
    logger.info('auth.login.failed', { reason: 'unknown_credential' });
    throw ceremonyFailed(401);
  }
  const newCounter = await verifyAuthentication(config, logger, body.response, challenge.challenge, passkey);
  const user = await getUser(db, passkey.user_id);
  if (user?.status !== 'active') throw ceremonyFailed(401);
  const now = Date.now();
  const session = await prepareSession(db, config, user.id, passkey.id, now, c.req.header('user-agent'));
  await db.batch([
    recordPasskeyUseStmt(db, passkey.id, newCounter, now),
    touchUserStmt(db, user.id, now),
    session.stmt,
  ]);
  setSessionCookie(c, session.cookieValue, config);
  logger.info('auth.login.succeeded', { user_id: user.id });
  return { id: user.id, displayName: user.display_name, role: user.role };
}
