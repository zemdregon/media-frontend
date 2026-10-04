import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../context';

/**
 * CSP baseline (NFR-SEC-003, TDD §6.1). The registered origin hosts are appended to
 * `media-src` and `connect-src` later (M3); until then both are 'self' only.
 */
export const CSP_BASELINE = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

export const SECURITY_HEADERS: Record<string, string> = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'fullscreen=(self), picture-in-picture=(self)',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Content-Security-Policy': CSP_BASELINE,
};

export const securityHeaders = createMiddleware<AppEnv>(async (c, next) => {
  await next();
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.header(name, value);
});
