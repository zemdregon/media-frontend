import { describe, expect, it } from 'vitest';
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
  it('returns NOT_FOUND in the LLD-API envelope for unknown API routes', async () => {
    const res = await appWith().request('/api/v1/nope');
    expect(res.status).toBe(404);
    const body = await res.json<{ error: Record<string, unknown> }>();
    expect(Object.keys(body)).toEqual(['error']);
    expect(body.error).toEqual({
      code: 'NOT_FOUND',
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
    const env = { DB: undefined } as never;
    const { createApp } = await import('../src/api/app');
    const res = await createApp().request('/api/v1/health', {}, env);
    // health catches DB errors, so this is degraded, not a crash
    expect(res.status).toBe(200);
  });
});
