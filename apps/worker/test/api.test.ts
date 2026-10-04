import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app';
import { appWith, fakeDb } from './helpers';

describe('GET /api/v1/health', () => {
  it('returns only {status:"ok"} when D1 answers', async () => {
    const res = await appWith().request('/api/v1/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('returns degraded when D1 fails, without leaking the error', async () => {
    const res = await appWith({ DB: fakeDb(true) }).request('/api/v1/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'degraded' });
  });
});

describe('error envelope', () => {
  // Unknown API routes need a session first (FR-USR-001); the signed-in 404 is in auth.test.ts.
  it('returns AUTH_REQUIRED in the LLD-API envelope for API routes without a session', async () => {
    const res = await appWith().request('/api/v1/nope');
    expect(res.status).toBe(401);
    const body = await res.json<{ error: Record<string, unknown> }>();
    expect(Object.keys(body)).toEqual(['error']);
    expect(body.error).toEqual({
      code: 'AUTH_REQUIRED',
      message: expect.any(String) as string,
      requestId: res.headers.get('x-request-id'),
    });
  });
});

describe('x-request-id', () => {
  it('is generated when absent', async () => {
    const res = await appWith().request('/api/v1/health');
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('reuses a valid inbound id', async () => {
    const res = await appWith().request('/api/v1/health', {
      headers: { 'x-request-id': 'client-req-12345' },
    });
    expect(res.headers.get('x-request-id')).toBe('client-req-12345');
  });

  it('replaces a malformed inbound id', async () => {
    const res = await appWith().request('/api/v1/health', {
      headers: { 'x-request-id': 'bad id\twith spaces' },
    });
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});

describe('security headers', () => {
  it.each(['/api/v1/health', '/api/v1/nope', '/'])('are set on %s', async (path) => {
    const res = await appWith().request(path);
    expect(res.headers.get('strict-transport-security')).toContain('max-age=31536000');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });
});

describe('SPA fallthrough', () => {
  it('serves non-API paths from static assets', async () => {
    const res = await appWith().request('/some/spa/route');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<html>');
  });
});

describe('error handling', () => {
  it('maps unexpected errors to INTERNAL with a generic message', async () => {
    const ASSETS = {
      fetch: () => Promise.reject(new Error('leaky detail: secret-value')),
    } as unknown as Fetcher;
    const res = await appWith({ ASSETS }).request('/boom');
    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('INTERNAL');
    expect(JSON.stringify(body)).not.toContain('secret-value');
  });
});

describe('health against the real local D1 binding', () => {
  it('returns ok', async () => {
    const res = await createApp().request('/api/v1/health', {}, env);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});
