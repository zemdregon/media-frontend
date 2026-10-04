/** First-operator bootstrap via `/setup` and `SETUP_TOKEN` (FR-USR-002, ADR-0014 §3, TDD §5.1). */
import type { Context } from 'hono';
import type { CeremonyOptions, UserSummary } from '@cinewren/shared';
import type { AppEnv } from '../api/context';
import { AppError } from '../api/errors';
import {
  auditStmt,
  insertFirstOperatorStmt,
  insertPasskeyStmt,
  isGuardOrConstraintError,
  operatorExists,
} from '../db/auth';
import { ulid } from '../platform/ids';
import { prepareSession, setSessionCookie } from './sessions';
import { constantTimeEqual } from './tokens';
import { registrationOptions, storeChallenge, takeChallenge, verifyRegistration } from './webauthn';

/** Disabled setup and a wrong token are indistinguishable (LLD-ERR NOT_FOUND). */
const unavailable = () => new AppError('NOT_FOUND', "Setup isn't available.");

export async function setupAvailable(db: D1Database): Promise<boolean> {
  return !(await operatorExists(db));
}

async function assertSetupAllowed(c: Context<AppEnv>, token: string): Promise<void> {
  const secret = c.env.SETUP_TOKEN;
  const tokenOk = secret !== undefined && secret !== '' && (await constantTimeEqual(token, secret));
  if (!tokenOk || (await operatorExists(c.env.DB))) {
    c.get('logger').warn('auth.denied', { reason: tokenOk ? 'setup_done' : 'setup_token' });
    throw unavailable();
  }
}

export async function setupOptions(
  c: Context<AppEnv>,
  body: { setupToken: string; displayName: string },
): Promise<CeremonyOptions> {
  await assertSetupAllowed(c, body.setupToken);
  const config = c.get('config');
  // The challenge handle doubles as the reserved user ID, so the WebAuthn user handle the
  // authenticator stores equals `users.id` once setup completes.
  const userId = ulid();
  const options = await registrationOptions(config, {
    userId,
    displayName: body.displayName,
    excludeCredentialIds: [],
  });
  const challengeId = await storeChallenge(c.env.DB, config, 'setup', options.challenge, { id: userId });
  return { challengeId, options: options as unknown as Record<string, unknown> };
}

export async function setupVerify(
  c: Context<AppEnv>,
  body: { setupToken: string; displayName: string; challengeId: string; response: unknown },
): Promise<UserSummary> {
  await assertSetupAllowed(c, body.setupToken);
  const db = c.env.DB;
  const config = c.get('config');
  const logger = c.get('logger');
  const challenge = await takeChallenge(db, body.challengeId, ['setup']);
  const passkey = await verifyRegistration(config, logger, body.response, challenge.challenge);
  const userId = challenge.id;
  const now = Date.now();
  const passkeyId = ulid();
  const session = await prepareSession(db, config, userId, passkeyId, now, c.req.header('user-agent'));
  try {
    // If another setup won the race, the guarded user insert adds nothing and the passkey insert
    // fails its foreign key, rolling the whole batch back.
    await db.batch([
      insertFirstOperatorStmt(db, userId, body.displayName, now),
      insertPasskeyStmt(db, { ...passkey, id: passkeyId, userId, label: null, now }),
      session.stmt,
      auditStmt(db, {
        id: ulid(),
        now,
        actorUserId: userId,
        action: 'setup.complete',
        targetType: 'user',
        targetId: userId,
        requestId: c.get('requestId'),
      }),
    ]);
  } catch (err) {
    if (isGuardOrConstraintError(err)) throw unavailable();
    throw err;
  }
  setSessionCookie(c, session.cookieValue, config);
  logger.info('auth.setup.complete', { user_id: userId });
  return { id: userId, displayName: body.displayName, role: 'operator' };
}
