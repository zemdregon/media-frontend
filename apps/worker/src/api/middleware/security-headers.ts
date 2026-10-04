import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../context';

/**
 * Security headers and the dynamic CSP (NFR-SEC-003, TDD §6.1).
 *
 * `script-src` stays `'self'`. `media-src` and `connect-src` are `'self'` plus the origins of every
 * registered, enabled server, so the browser can load streams, subtitles and HLS segments directly
 * from them (FR-PLAY-008) and nowhere else. `media-src` also has `blob:` for MSE (hls.js).
 *
 * The origin list is generated from the `servers` table, cached per isolate for a short TTL and
 * dropped at once when this isolate handles a server change. If the lookup fails the CSP falls back
 * to `'self'` only (fail closed): playback is blocked by the browser, nothing is loosened.
 *
 * Only HTML documents get the list: a CSP is enforced from the document that loads the SPA, and
 * the SPA stays loaded across sign-in, so the list cannot depend on the session. JSON, images and
 * errors carry the `'self'`-only policy, which keeps origin hostnames out of API responses and
 * saves the lookup on every API call. (Anyone who can load the app can read the hosts from the
 * HTML response's CSP; the hostnames are not secrets, the credentials are, NFR-SEC-001.)
 */

/** How long an isolate reuses the origin list. Other isolates catch up within this time. */
export const CSP_ORIGINS_TTL_MS = 15_000;

/** Servers whose origin the browser may talk to: not pending validation, disabled or removing. */
const ORIGINS_SQL =
  "SELECT base_url FROM servers WHERE status IN ('active','degraded','unreachable')";

/** The CSP source for a base URL: `scheme://host[:port]`, or null if it is not a plain http(s) URL. */
export function cspSourceOf(baseUrl: string): string | null {
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    // `URL.origin` drops the default port and the path, userinfo and query; none belong in a CSP.
    return u.origin;
  } catch {
    return null;
  }
}

/** Builds the policy for the given origin sources (already `scheme://host[:port]`). */
export function buildCsp(origins: readonly string[] = []): string {
  const hosts = origins.length > 0 ? ` ${origins.join(' ')}` : '';
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `media-src 'self' blob:${hosts}`,
    `connect-src 'self'${hosts}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
}

/** The policy with no registered origins. */
export const CSP_BASELINE = buildCsp();

interface Entry {
  at: number;
  origins: string[];
}

// Keyed by binding so that two databases (tests, or a binding swap) never share a list.
const cache = new WeakMap<D1Database, Entry>();

export function invalidateCspCache(db: D1Database): void {
  cache.delete(db);
}

/** Registered, enabled origins, sorted and de-duplicated. Throws if D1 fails. */
export async function registeredOrigins(db: D1Database, now = Date.now()): Promise<string[]> {
  const hit = cache.get(db);
  if (hit && now - hit.at < CSP_ORIGINS_TTL_MS && now >= hit.at) return hit.origins;
  const { results } = await db.prepare(ORIGINS_SQL).all<{ base_url: string }>();
  const origins = [
    ...new Set(results.map((r) => cspSourceOf(r.base_url)).filter((o): o is string => o !== null)),
  ].sort();
  cache.set(db, { at: now, origins });
  return origins;
}

export const SECURITY_HEADERS: Record<string, string> = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'fullscreen=(self), picture-in-picture=(self)',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

const isServerChange = (method: string, path: string) =>
  method !== 'GET' && method !== 'HEAD' && path.startsWith('/api/v1/admin/servers');

export const securityHeaders = createMiddleware<AppEnv>(async (c, next) => {
  await next();
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.header(name, value);
  let csp = CSP_BASELINE;
  try {
    if (isServerChange(c.req.method, c.req.path)) invalidateCspCache(c.env.DB);
    if (c.res.headers.get('content-type')?.toLowerCase().startsWith('text/html')) {
      csp = buildCsp(await registeredOrigins(c.env.DB));
    }
  } catch {
    // Fail closed: 'self' only. Health must keep answering when D1 is down.
  }
  c.header('Content-Security-Policy', csp);
});
