/**
 * Sessions, the one session middleware, the CSRF Origin check and the role guard
 * (FR-USR-001, FR-USR-003, NFR-SEC-007, LLD-TOKEN, SDD INV-9).
 */
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import type { AppEnv, AuthContext } from '../api/context';
import { AppError } from '../api/errors';
import { deleteSession, findLiveSession, insertSessionStmt, slideSession } from '../db/auth';
import type { Config } from '../platform/config';
import { randomToken, sha256Hex } from './tokens';

/** `__Host-` pins the cookie to this host, `Path=/` and `Secure` (TDD §5.1). */
export const SESSION_COOKIE = '__Host-cw_session';
const SLIDE_INTERVAL_MS = 3_600_000;
/** How long a fresh authentication allows adding a passkey (SR-04; 5 min, proposed). */
export const REAUTH_WINDOW_MS = 300_000;

export function reauthRequired(): AppError {
  return new AppError('REAUTH_REQUIRED', "Confirm it's you with a passkey you already have.");
}

/** True when the session completed a passkey ceremony within `REAUTH_WINDOW_MS` of `now`. */
export function isFresh(reauthAt: number | null, now: number): boolean {
  return reauthAt !== null && reauthAt <= now && now - reauthAt <= REAUTH_WINDOW_MS;
}

/** Coarse "Firefox on macOS" label for the user's own session list; never the raw UA. */
export function userAgentHint(ua: string | undefined): string | null {
  if (!ua) return null;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser';
  const os = /iPhone|iPad/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'unknown OS';
  return `${browser} on ${os}`;
}

/**
 * Prepares a new session. The statement is returned so callers put it in the same `batch()` as
 * the user or passkey change; the cookie value is the only copy of the plaintext ID.
 */
export async function prepareSession(
  db: D1Database,
  config: Config,
  userId: string,
  passkeyId: string | null,
  now: number,
  ua: string | undefined,
): Promise<{ cookieValue: string; stmt: D1PreparedStatement }> {
  const cookieValue = randomToken(32);
  const stmt = insertSessionStmt(db, {
    idHash: await sha256Hex(cookieValue),
    userId,
    passkeyId,
    now,
    idleExpiresAt: now + config.sessionIdleMs,
    absoluteExpiresAt: now + config.sessionAbsoluteMs,
    userAgentHint: userAgentHint(ua),
  });
  return { cookieValue, stmt };
}

export function setSessionCookie(c: Context<AppEnv>, value: string, config: Config): void {
  setCookie(c, SESSION_COOKIE, value, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: Math.floor(config.sessionAbsoluteMs / 1000),
  });
}

export function clearSessionCookie(c: Context<AppEnv>): void {
  deleteCookie(c, SESSION_COOKIE, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
}

export function currentUser(c: Context<AppEnv>): AuthContext {
  const auth = c.get('auth');
  if (!auth) throw new AppError('AUTH_REQUIRED', 'Sign in to continue.');
  return auth;
}

/** Revokes the current session (FR-USR-006). */
export async function endSession(c: Context<AppEnv>): Promise<void> {
  await deleteSession(c.env.DB, currentUser(c).sessionIdHash);
  clearSessionCookie(c);
}

/**
 * The single session check (SDD INV-9). Validates the hashed cookie against `sessions` for an
 * active user within idle and absolute expiry, and slides idle expiry at most hourly.
 */
export const requireSession = createMiddleware<AppEnv>(async (c, next) => {
  const cookie = getCookie(c, SESSION_COOKIE);
  if (!cookie) throw new AppError('AUTH_REQUIRED', 'Sign in to continue.');
  const config = c.get('config');
  const now = Date.now();
  const idHash = await sha256Hex(cookie);
  const session = await findLiveSession(c.env.DB, idHash, now);
  if (!session) {
    clearSessionCookie(c);
    c.get('logger').info('auth.denied', { reason: 'no_session' });
    throw new AppError('AUTH_REQUIRED', 'Sign in to continue.');
  }
  if (now - session.last_seen_at >= SLIDE_INTERVAL_MS) {
    const idle = Math.min(now + config.sessionIdleMs, session.absolute_expires_at);
    await slideSession(c.env.DB, idHash, session.user_id, now, idle);
  }
  c.set('auth', {
    userId: session.user_id,
    displayName: session.display_name,
    role: session.role,
    theme: session.theme_preference,
    sessionIdHash: idHash,
    passkeyId: session.passkey_id,
    reauthAt: session.reauth_at,
  });
  c.set('logger', c.get('logger').child({ user_id: session.user_id }));
  await next();
});

/** Operator-only routes refuse viewers with 403 on every request (FR-USR-003). */
export const requireOperator = createMiddleware<AppEnv>(async (c, next) => {
  if (currentUser(c).role !== 'operator') {
    c.get('logger').info('auth.denied', { reason: 'not_operator' });
    throw new AppError('FORBIDDEN', 'This needs an operator.');
  }
  await next();
});

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** State-changing requests must carry `Origin: APP_ORIGIN` (NFR-SEC-007, TDD §5.1). */
export const originCheck = createMiddleware<AppEnv>(async (c, next) => {
  if (!SAFE_METHODS.has(c.req.method) && c.req.header('origin') !== c.get('config').appOrigin) {
    c.get('logger').warn('auth.denied', { reason: 'csrf_origin' });
    throw new AppError('CSRF_REJECTED', 'This request came from another site and was refused.');
  }
  await next();
});
