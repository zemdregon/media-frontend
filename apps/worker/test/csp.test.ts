// NFR-SEC-003: the CSP is generated from server configuration. `script-src` stays 'self';
// `media-src` and `connect-src` are 'self' plus the registered, enabled origins; `media-src` also
// has `blob:` for MSE (TDD §6.1).
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app';
import {
  CSP_BASELINE,
  CSP_ORIGINS_TTL_MS,
  buildCsp,
  cspSourceOf,
  invalidateCspCache,
  registeredOrigins,
} from '../src/api/middleware/security-headers';
import { appWith, fakeDb } from './helpers';

const db = env.DB;

async function addServer(id: string, baseUrl: string, status = 'active') {
  await db
    .prepare(
      `INSERT INTO servers (id, type, name, base_url, origin_server_id, status, created_at, updated_at)
       VALUES (?, 'jellyfin', ?, ?, ?, ?, 1, 1)`,
    )
    .bind(id, id, baseUrl, `origin-${id}`, status)
    .run();
}

const directive = (csp: string, name: string) =>
  csp
    .split('; ')
    .find((d) => d.startsWith(`${name} `))
    ?.split(' ')
    .slice(1) ?? [];

/** The CSP of a response; `/` is the SPA document, the only kind that gets the origin list. */
async function cspOf(path = '/', init?: RequestInit): Promise<string> {
  const res = await createApp().request(path, init, env);
  return res.headers.get('content-security-policy') ?? '';
}

beforeEach(async () => {
  await db.prepare('DELETE FROM servers').run();
  invalidateCspCache(db);
});

describe('buildCsp', () => {
  it('has only self (and blob: for media) when no origin is registered', () => {
    expect(CSP_BASELINE).toBe(buildCsp([]));
    expect(directive(CSP_BASELINE, 'media-src')).toEqual(["'self'", 'blob:']);
    expect(directive(CSP_BASELINE, 'connect-src')).toEqual(["'self'"]);
  });

  it('appends the origins to media-src and connect-src only', () => {
    const csp = buildCsp(['https://a.example.net', 'https://b.example.net:8920']);
    expect(directive(csp, 'media-src')).toEqual([
      "'self'",
      'blob:',
      'https://a.example.net',
      'https://b.example.net:8920',
    ]);
    expect(directive(csp, 'connect-src')).toEqual([
      "'self'",
      'https://a.example.net',
      'https://b.example.net:8920',
    ]);
    expect(directive(csp, 'script-src')).toEqual(["'self'"]);
    expect(directive(csp, 'default-src')).toEqual(["'self'"]);
    expect(directive(csp, 'img-src')).toEqual(["'self'", 'data:', 'blob:']);
    expect(directive(csp, 'frame-ancestors')).toEqual(["'none'"]);
  });
});

describe('cspSourceOf', () => {
  it.each([
    ['https://nas.example.net', 'https://nas.example.net'],
    ['https://nas.example.net/jellyfin/?x=1', 'https://nas.example.net'],
    ['https://nas.example.net:8920', 'https://nas.example.net:8920'],
    ['https://nas.example.net:443', 'https://nas.example.net'],
    ['https://user:pw@nas.example.net/', 'https://nas.example.net'],
    ['http://127.0.0.1:9100', 'http://127.0.0.1:9100'],
  ])('%s -> %s', (input, out) => {
    expect(cspSourceOf(input)).toBe(out);
  });

  it.each(['not a url', 'ftp://nas.example.net', "https://x.example; script-src 'unsafe-eval'"])(
    'rejects %s',
    (input) => {
      const out = cspSourceOf(input);
      // Anything that parses must reduce to a bare origin; nothing can inject a directive.
      expect(out === null || /^https?:\/\/[^\s;,']+$/.test(out)).toBe(true);
    },
  );
});

describe('dynamic CSP from the servers table', () => {
  it('is the baseline with no servers', async () => {
    expect(await cspOf()).toBe(CSP_BASELINE);
  });

  it('adds the host of every enabled server, de-duplicated and sorted', async () => {
    await addServer('s1', 'https://media-b.example.net:8920/jf');
    await addServer('s2', 'https://media-a.example.net');
    await addServer('s3', 'https://media-a.example.net/other-path');
    await addServer('s4', 'https://slow.example.net', 'degraded');
    await addServer('s5', 'https://down.example.net', 'unreachable');
    const csp = await cspOf();
    const hosts = [
      'https://down.example.net',
      'https://media-a.example.net',
      'https://media-b.example.net:8920',
      'https://slow.example.net',
    ];
    expect(directive(csp, 'media-src')).toEqual(["'self'", 'blob:', ...hosts]);
    expect(directive(csp, 'connect-src')).toEqual(["'self'", ...hosts]);
    expect(directive(csp, 'script-src')).toEqual(["'self'"]);
  });

  it('leaves out servers that are pending validation, disabled or being removed', async () => {
    await addServer('p', 'https://pending.example.net', 'pending_validation');
    await addServer('d', 'https://disabled.example.net', 'disabled');
    await addServer('r', 'https://removing.example.net', 'removing');
    await addServer('ok', 'https://ok.example.net');
    const csp = await cspOf();
    expect(csp).toContain('https://ok.example.net');
    for (const gone of ['pending', 'disabled', 'removing']) {
      expect(csp).not.toContain(`${gone}.example.net`);
    }
  });

  it('lists the origins on HTML documents only, so API responses never carry hostnames', async () => {
    await addServer('s1', 'https://media-a.example.net');
    for (const path of ['/', '/watch/m1']) {
      expect(directive(await cspOf(path), 'connect-src')).toEqual([
        "'self'",
        'https://media-a.example.net',
      ]);
    }
    for (const path of ['/api/v1/health', '/api/v1/nope']) {
      expect(await cspOf(path)).toBe(CSP_BASELINE);
    }
  });

  it('falls back to self only when D1 fails, and health still answers', async () => {
    const { request } = appWith({ DB: fakeDb(true) });
    const doc = await request('/');
    expect(doc.status).toBe(200);
    expect(doc.headers.get('content-security-policy')).toBe(CSP_BASELINE);
    const health = await request('/api/v1/health');
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'degraded' });
  });
});

describe('cache', () => {
  it('reuses the list within the TTL and reloads after it', async () => {
    await addServer('s1', 'https://one.example.net');
    const t0 = 1_000_000;
    expect(await registeredOrigins(db, t0)).toEqual(['https://one.example.net']);
    await addServer('s2', 'https://two.example.net');
    expect(await registeredOrigins(db, t0 + CSP_ORIGINS_TTL_MS - 1)).toEqual([
      'https://one.example.net',
    ]);
    expect(await registeredOrigins(db, t0 + CSP_ORIGINS_TTL_MS)).toEqual([
      'https://one.example.net',
      'https://two.example.net',
    ]);
  });

  it('is dropped when this isolate sees a server change', async () => {
    await addServer('s1', 'https://one.example.net');
    expect(await cspOf()).toContain('https://one.example.net');
    await addServer('s2', 'https://two.example.net');
    // Still inside the TTL: the stale list is served.
    expect(await cspOf()).not.toContain('two.example.net');
    // A write to /admin/servers invalidates the cache (even a rejected one is harmless).
    await cspOf('/api/v1/admin/servers', { method: 'POST' });
    expect(await cspOf()).toContain('https://two.example.net');
  });
});
