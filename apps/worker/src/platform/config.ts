import type { Env } from './env';

const DAY_MS = 86_400_000;

/** Resolved, validated runtime configuration (TDD §4). */
export interface Config {
  appOrigin: string;
  rpId: string;
  rpName: string;
  sessionIdleMs: number;
  sessionAbsoluteMs: number;
  inviteTtlMs: number;
  challengeTtlMs: number;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

function days(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback * DAY_MS;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new ConfigError('Invalid duration setting.');
  return n * DAY_MS;
}

/**
 * Reads config from the environment. Fails closed: APP_ORIGIN must be an exact origin, and
 * `https:` outside local (TDD §4).
 */
export function getConfig(env: Env): Config {
  let url: URL;
  try {
    url = new URL(env.APP_ORIGIN);
  } catch {
    throw new ConfigError('APP_ORIGIN is unset or invalid.');
  }
  if (url.origin !== env.APP_ORIGIN) throw new ConfigError('APP_ORIGIN must be an exact origin.');
  if (url.protocol !== 'https:' && env.ENVIRONMENT !== 'local') {
    throw new ConfigError('APP_ORIGIN must use https outside local.');
  }
  const rpId = env.RP_ID || url.hostname;
  if (url.hostname !== rpId && !url.hostname.endsWith(`.${rpId}`)) {
    throw new ConfigError('RP_ID must be the APP_ORIGIN host or a parent domain of it.');
  }
  const sessionIdleMs = days(env.SESSION_IDLE_DAYS, 14);
  const sessionAbsoluteMs = days(env.SESSION_ABSOLUTE_DAYS, 90);
  if (sessionIdleMs > sessionAbsoluteMs) throw new ConfigError('Idle expiry exceeds absolute.');
  return {
    appOrigin: url.origin,
    rpId,
    rpName: env.RP_NAME || 'Cinewren',
    sessionIdleMs,
    sessionAbsoluteMs,
    inviteTtlMs: days(env.INVITE_TTL_DAYS, 7),
    challengeTtlMs: 5 * 60_000,
  };
}
