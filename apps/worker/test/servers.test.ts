// T1.5: server registration API (FR-SRV-001 to FR-SRV-003, FR-SRV-007, WF-1, DR-002, NFR-SEC-001,
// NFR-SEC-005), through the real app and local D1. The origin is the recorded Jellyfin 12.1
// exchanges behind a fixture-backed fake `fetch`; no test touches the network.
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/api/app';
import { decrypt, loadKeyring } from '../src/vault/vault';
import {
  call,
  createInvite,
  errorCode,
  json,
  ORIGIN,
  redeem,
  resetDb,
  sessionCookie,
  setupOperator,
  type CallOptions,
} from './auth-harness';
import {
  createFakeOrigin,
  type FakeOrigin,
  type FakeOriginOptions,
  type Route,
} from './providers/fixture-fetch';
import {
  BASE,
  adminAuth,
  auth,
  happy,
  logout,
  notJellyfinInfo,
  oldVersionInfo,
  otherServerAuth,
  otherServerInfo,
  publicInfo,
  rejectedSignIn,
  views,
  viewsDown,
} from './providers/jellyfin-routes';

const db = env.DB;
const PASSWORD = 'Sup3r-s3cret-pw-9f2';
const BODY = {
  type: 'jellyfin',
  name: 'Basement NAS',
  baseUrl: BASE,
  credentials: { username: 'cinewren-svc', password: PASSWORD },
};
const ORIGIN_SERVER_ID = 'e8a0c84738be4ea3a75540d3c5ea8225';

const current: { origin: FakeOrigin } = { origin: createFakeOrigin('jellyfin', []) };
const app = createApp({ originFetch: (input, init) => current.origin.fetch(input, init) });

function useOrigin(routes: Route[], options?: FakeOriginOptions): FakeOrigin {
  current.origin = createFakeOrigin('jellyfin', routes, options);
  return current.origin;
}

let cookie = '';
const api = (method: string, path: string, opts: CallOptions = {}) =>
  call(method, path, { cookie, app, ...opts });

// A deployed (non-local) configuration: the blocked-host rules apply and http:// is refused.
const STAGING: CallOptions = {
  env: {
    ENVIRONMENT: 'staging',
    APP_ORIGIN: 'https://app.example.test',
    RP_ID: 'app.example.test',
  },
  origin: 'https://app.example.test',
};

const count = async (table: string): Promise<number> =>
  (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? -1;
const audits = async (action?: string) =>
  (
    await db
      // Setup and invite rows belong to other tasks; this file asserts the server and library rows.
      .prepare(
        `SELECT * FROM audit_log WHERE action NOT LIKE 'setup.%' AND action NOT LIKE 'invite.%'
            AND (? IS NULL OR action = ?) ORDER BY at, id`,
      )
      .bind(action ?? null, action ?? null)
      .all<{
        actor_user_id: string;
        action: string;
        target_type: string;
        target_id: string;
        details: string;
        request_id: string;
      }>()
  ).results;

let logs: string[] = [];

beforeEach(async () => {
  await resetDb();
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    logs.push(String(line));
  });
  ({ cookie } = await setupOperator());
  useOrigin(happy);
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function register(body: Record<string, unknown> = BODY, opts: CallOptions = {}) {
  return api('POST', '/api/v1/admin/servers', { body, ...opts });
}

async function expectRefused(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  const body = await json<{
    error: { code: string; message: string; requestId: string; details?: Record<string, unknown> };
  }>(res);
  expect(body.error.code).toBe(code);
  expect(body.error.requestId).toBe(res.headers.get('x-request-id'));
  return body.error;
}

describe('access: operator only (FR-USR-003, NFR-SEC-007)', () => {
  const routes: [string, string, unknown][] = [
    ['GET', '/api/v1/admin/servers', undefined],
    ['POST', '/api/v1/admin/servers', BODY],
    ['GET', '/api/v1/admin/servers/x', undefined],
    ['PATCH', '/api/v1/admin/servers/x', { name: 'n' }],
    ['POST', '/api/v1/admin/servers/x/validate', undefined],
    ['GET', '/api/v1/admin/servers/x/libraries', undefined],
    ['PATCH', '/api/v1/admin/libraries/x', { enabled: true }],
  ];

  it('refuses requests without a session', async () => {
    for (const [method, path, body] of routes) {
      const res = await call(method, path, { app, ...(body ? { body } : {}) });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it('refuses a viewer on every route, and contacts no origin', async () => {
    const invite = await createInvite(cookie, { displayName: 'Vera' });
    const viewer = sessionCookie((await redeem(invite.token)).res);
    for (const [method, path, body] of routes) {
      const res = await api(method, path, { cookie: viewer, ...(body ? { body } : {}) });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    expect(current.origin.calls).toHaveLength(0);
    expect(await count('servers')).toBe(0);
  });

  it('refuses a cross-origin write (CSRF)', async () => {
    const res = await register(BODY, { origin: 'https://evil.example' });
    await expectRefused(res, 403, 'CSRF_REJECTED');
    expect(current.origin.calls).toHaveLength(0);
  });
});

describe('WF-1: register a server (FR-SRV-001, FR-SRV-002, FR-SRV-003)', () => {
  it('validates, stores encrypted credentials, discovers libraries and returns the active server', async () => {
    const res = await register();
    expect(res.status).toBe(201);
    const server = await json<Record<string, unknown> & { libraries: Record<string, unknown>[] }>(
      res,
    );
    expect(server).toMatchObject({
      type: 'jellyfin',
      name: 'Basement NAS',
      baseUrl: BASE,
      status: 'active',
      version: '12.1.0',
      priority: 0,
      keyVersion: 1,
      libraryCount: 2,
      enabledLibraryCount: 0,
    });
    // Movie and TV libraries only; box sets and other views are not offered. All start disabled.
    expect(server.libraries.map((l) => [l.name, l.kind, l.enabled])).toEqual([
      ['Movies', 'movies', false],
      ['Shows', 'tv', false],
    ]);

    const row = await db.prepare('SELECT * FROM servers').first();
    expect(row).toMatchObject({
      origin_server_id: ORIGIN_SERVER_ID,
      status: 'active',
      base_url: BASE,
    });
    const cred = await db.prepare('SELECT * FROM server_credentials').first<{
      server_id: string;
      key_version: number;
      secret_envelope: string;
      service_token_envelope: string | null;
    }>();
    expect(cred?.server_id).toBe(row?.id);
    expect(cred?.secret_envelope).toMatch(/^cw1\.1\./);
    // Only the username and password are stored; tokens are derived at runtime (owner decision).
    expect(cred?.service_token_envelope).toBeNull();
    const plain = await decrypt(
      await loadKeyring(env),
      'server_secret',
      String(row?.id),
      cred?.secret_envelope ?? '',
    );
    expect(JSON.parse(plain)).toEqual({
      kind: 'password',
      username: 'cinewren-svc',
      password: PASSWORD,
    });

    expect(current.origin.unmatched).toEqual([]);
    expect(current.origin.calls.every((c) => c.url.host === new URL(BASE).host)).toBe(true);
  });

  it('writes one audit row in the same batch, naming the operator and request but no secret', async () => {
    const res = await register();
    const { id } = await json<{ id: string }>(res);
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'server.register',
      target_type: 'server',
      target_id: id,
      request_id: res.headers.get('x-request-id'),
    });
    expect(rows[0]?.actor_user_id).toBeTruthy();
    expect(rows[0]?.details).not.toContain(PASSWORD);
    expect(rows[0]?.details).not.toContain('cinewren-svc');
  });

  it('accepts a priority and trims the name', async () => {
    const res = await register({ ...BODY, name: '  Basement NAS  ', priority: 7 });
    expect(await json(res)).toMatchObject({ name: 'Basement NAS', priority: 7 });
  });

  it('stores the address without a trailing slash', async () => {
    const res = await register({ ...BODY, baseUrl: `${BASE}/` });
    expect(res.status).toBe(201);
    expect(await json(res)).toMatchObject({ baseUrl: BASE });
  });

  describe('request validation', () => {
    it.each([
      ['a missing name', { ...BODY, name: undefined }, 'name'],
      ['an empty name', { ...BODY, name: '   ' }, 'name'],
      ['an unknown type', { ...BODY, type: 'kodi' }, 'type'],
      [
        'an empty password',
        { ...BODY, credentials: { username: 'u', password: '' } },
        'credentials',
      ],
      [
        'extra credential fields',
        { ...BODY, credentials: { username: 'u', password: 'p', apiKey: 'k' } },
        'credentials',
      ],
      ['a negative priority', { ...BODY, priority: -1 }, 'priority'],
    ])('rejects %s with VALIDATION_FAILED naming the field', async (_n, body, field) => {
      const err = await expectRefused(await register(body), 400, 'VALIDATION_FAILED');
      expect(JSON.stringify(err.details)).toContain(field);
      expect(current.origin.calls).toHaveLength(0);
    });

    it('rejects a body that is not JSON', async () => {
      const res = await call('POST', '/api/v1/admin/servers', {
        app,
        cookie,
        headers: { 'content-type': 'text/plain' },
      });
      await expectRefused(res, 400, 'VALIDATION_FAILED');
    });

    it('rejects a provider that has no adapter yet, without contacting it', async () => {
      const err = await expectRefused(
        await register({ ...BODY, type: 'emby' }),
        400,
        'VALIDATION_FAILED',
      );
      expect(err.details).toEqual({ fields: ['type'] });
      await expectRefused(
        await register({ ...BODY, type: 'plex', credentials: { token: 'x' } }),
        400,
        'VALIDATION_FAILED',
      );
      expect(current.origin.calls).toHaveLength(0);
    });

    it('rejects a token credential for Jellyfin: it needs a username and password', async () => {
      const err = await expectRefused(
        await register({ ...BODY, credentials: { token: 'an-admin-api-key' } }),
        400,
        'VALIDATION_FAILED',
      );
      expect(err.details).toEqual({ fields: ['credentials'] });
      expect(current.origin.calls).toHaveLength(0);
    });
  });

  describe('failure paths: nothing is saved and the error names the failed check (FR-SRV-002)', () => {
    async function expectNothingSaved() {
      expect(await count('servers')).toBe(0);
      expect(await count('server_credentials')).toBe(0);
      expect(await count('libraries')).toBe(0);
      expect(await audits()).toEqual([]);
    }

    it('tls: unreachable host', async () => {
      useOrigin(happy, { unreachable: true });
      const err = await expectRefused(await register(), 422, 'SERVER_VALIDATION_FAILED');
      expect(err.details).toEqual({ check: 'tls', reason: 'unreachable' });
      await expectNothingSaved();
    });

    it('tls: a redirect to another host is refused and that host is never contacted (NFR-SEC-005)', async () => {
      const origin = useOrigin(happy, { redirectTo: 'https://evil.example/login' });
      const err = await expectRefused(await register(), 422, 'SERVER_VALIDATION_FAILED');
      expect(err.details).toEqual({ check: 'tls', reason: 'redirect_refused' });
      expect(origin.calls.map((c) => c.url.host)).toEqual([new URL(BASE).host]);
      await expectNothingSaved();
    });

    it('credentials: rejected username or password', async () => {
      useOrigin([publicInfo, rejectedSignIn]);
      const err = await expectRefused(await register(), 422, 'SERVER_VALIDATION_FAILED');
      expect(err.details).toEqual({ check: 'credentials', reason: 'invalid_credentials' });
      expect(err.message).not.toContain(PASSWORD);
      await expectNothingSaved();
    });

    it('credentials: an administrator account is refused (ADR-0008, A-2) and its session is signed out', async () => {
      const origin = useOrigin([publicInfo, adminAuth, logout]);
      const err = await expectRefused(await register(), 422, 'SERVER_VALIDATION_FAILED');
      expect(err.details).toEqual({ check: 'credentials', reason: 'admin_account' });
      expect(err.message).toMatch(/administrator/i);
      expect(origin.calls.at(-1)?.url.pathname).toBe('/Sessions/Logout');
      await expectNothingSaved();
    });

    it('identity: the address is not a Jellyfin server', async () => {
      useOrigin([notJellyfinInfo]);
      const err = await expectRefused(await register(), 422, 'SERVER_VALIDATION_FAILED');
      expect(err.details).toEqual({ check: 'identity', reason: 'not_a_server' });
      // The password is never sent to a host that does not identify as the right server.
      expect(current.origin.calls.some((c) => c.url.pathname === '/Users/AuthenticateByName')).toBe(
        false,
      );
      await expectNothingSaved();
    });

    it('version: older than the Jellyfin 12.1 minimum (IR-003)', async () => {
      useOrigin([oldVersionInfo, auth, logout]);
      const err = await expectRefused(await register(), 422, 'SERVER_VALIDATION_FAILED');
      expect(err.details).toEqual({
        check: 'version',
        reason: 'version_too_old',
        minimumVersion: '12.1',
      });
      await expectNothingSaved();
    });

    it('duplicate: the origin server ID is already registered, naming the existing entry', async () => {
      expect((await register()).status).toBe(201);
      useOrigin(happy);
      const err = await expectRefused(
        await register({
          ...BODY,
          name: 'Same server again',
          baseUrl: 'https://other-name.example.test',
        }),
        409,
        'SERVER_ALREADY_REGISTERED',
      );
      expect(err.message).toContain('Basement NAS');
      expect(err.details).toMatchObject({ existing: { name: 'Basement NAS' } });
      expect(await count('servers')).toBe(1);
      expect(await audits()).toHaveLength(1);
    });

    it('vault: a missing key is reported before any credential is sent to the origin', async () => {
      const err = await expectRefused(
        await register(BODY, { env: { CREDENTIAL_KEYS: undefined } }),
        500,
        'CREDENTIAL_KEY_MISSING',
      );
      expect(err.message).not.toContain(PASSWORD);
      expect(current.origin.calls).toHaveLength(0);
      await expectNothingSaved();
    });

    it('library discovery: an origin failure keeps the server pending_validation, and validate completes it', async () => {
      useOrigin([publicInfo, auth, viewsDown]);
      const err = await expectRefused(await register(), 502, 'ORIGIN_UNAVAILABLE');
      expect(err.details).toHaveProperty('serverId');
      const saved = await db
        .prepare('SELECT id, status FROM servers')
        .first<{ id: string; status: string }>();
      expect(saved?.status).toBe('pending_validation');
      expect(await count('libraries')).toBe(0);

      useOrigin(happy);
      const res = await api('POST', `/api/v1/admin/servers/${saved?.id}/validate`);
      expect(res.status).toBe(200);
      expect(
        (await db.prepare('SELECT status FROM servers').first<{ status: string }>())?.status,
      ).toBe('active');
      expect(await count('libraries')).toBe(2);
    });
  });

  describe('FR-SRV-007: https only, and the blocked-host policy (LLD-PROV)', () => {
    it('rejects http:// with INSECURE_ORIGIN_URL and contacts nothing', async () => {
      const err = await expectRefused(
        await register({ ...BODY, baseUrl: 'http://jellyfin.example.test' }, STAGING),
        400,
        'INSECURE_ORIGIN_URL',
      );
      expect(err.message).toMatch(/https/);
      expect(current.origin.calls).toHaveLength(0);
      expect(await count('servers')).toBe(0);
    });

    it('also rejects http:// in local mode unless ALLOW_INSECURE_ORIGINS is set', async () => {
      const http = { ...BODY, baseUrl: 'http://jellyfin.example.test' };
      await expectRefused(await register(http), 400, 'INSECURE_ORIGIN_URL');
      expect((await register(http, { env: { ALLOW_INSECURE_ORIGINS: 'true' } })).status).toBe(201);
    });

    it('ignores ALLOW_INSECURE_ORIGINS outside local mode and logs an error', async () => {
      await expectRefused(
        await register(
          { ...BODY, baseUrl: 'http://jellyfin.example.test' },
          {
            ...STAGING,
            env: { ...STAGING.env, ALLOW_INSECURE_ORIGINS: 'true' },
          },
        ),
        400,
        'INSECURE_ORIGIN_URL',
      );
      expect(logs.some((l) => l.includes('config.insecure_origins_ignored'))).toBe(true);
    });

    it.each([
      ['an IPv4 literal', 'https://203.0.113.9:8096', 'ip_literal'],
      ['a private IPv4 literal', 'https://192.168.1.20', 'ip_literal'],
      ['an IPv6 literal', 'https://[::1]:8096', 'ip_literal'],
      ['localhost', 'https://localhost:8096', 'internal_hostname'],
      ['a .local host', 'https://nas.local', 'internal_hostname'],
      ['a .internal host', 'https://media.internal', 'internal_hostname'],
      ['userinfo', 'https://user:pass@jellyfin.example.test', 'userinfo'],
      ['a query string', 'https://jellyfin.example.test/?token=1', 'query_or_fragment'],
    ])('rejects %s with BLOCKED_ORIGIN_URL outside local mode', async (_n, baseUrl, reason) => {
      const err = await expectRefused(
        await register({ ...BODY, baseUrl }, STAGING),
        400,
        'BLOCKED_ORIGIN_URL',
      );
      expect(err.details).toEqual({ reason });
      expect(current.origin.calls).toHaveLength(0);
      expect(await count('servers')).toBe(0);
    });

    it('allows a LAN address in local mode', async () => {
      expect((await register({ ...BODY, baseUrl: 'https://192.168.1.20:8920' })).status).toBe(201);
    });

    it('rejects something that is not a URL', async () => {
      const err = await expectRefused(
        await register({ ...BODY, baseUrl: 'jellyfin' }),
        400,
        'VALIDATION_FAILED',
      );
      expect(err.details).toEqual({ fields: ['baseUrl'] });
    });
  });
});

describe('list, get and libraries (FR-SRV-003)', () => {
  it('returns an empty list before any registration', async () => {
    const res = await api('GET', '/api/v1/admin/servers');
    expect(await json(res)).toEqual([]);
  });

  it('lists and gets servers without any secret, and shows the credential key version', async () => {
    const { id } = await json<{ id: string }>(await register());
    const list = await json<Record<string, unknown>[]>(await api('GET', '/api/v1/admin/servers'));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, name: 'Basement NAS', keyVersion: 1, libraryCount: 2 });
    const one = await json<{ libraries: unknown[] }>(
      await api('GET', `/api/v1/admin/servers/${id}`),
    );
    expect(one).toMatchObject({ id, status: 'active' });
    expect(one.libraries).toHaveLength(2);
    for (const body of [list, one]) {
      const text = JSON.stringify(body);
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain('cw1.');
      expect(text).not.toMatch(/secret|envelope|password/i);
    }
  });

  it('returns NOT_FOUND for an unknown server', async () => {
    await expectRefused(await api('GET', '/api/v1/admin/servers/nope'), 404, 'NOT_FOUND');
    await expectRefused(await api('GET', '/api/v1/admin/servers/nope/libraries'), 404, 'NOT_FOUND');
    await expectRefused(await api('POST', '/api/v1/admin/servers/nope/validate'), 404, 'NOT_FOUND');
    await expectRefused(
      await api('PATCH', '/api/v1/admin/servers/nope', { body: { name: 'x' } }),
      404,
      'NOT_FOUND',
    );
  });

  it('enables and disables libraries, with an audit row for each change and none for a no-op', async () => {
    const { id } = await json<{ id: string }>(await register());
    const libs = await json<{ id: string; name: string; enabled: boolean }[]>(
      await api('GET', `/api/v1/admin/servers/${id}/libraries`),
    );
    const movies = libs.find((l) => l.name === 'Movies');
    expect(movies?.enabled).toBe(false);

    const on = await api('PATCH', `/api/v1/admin/libraries/${movies?.id}`, {
      body: { enabled: true },
    });
    expect(await json(on)).toMatchObject({ id: movies?.id, enabled: true, serverId: id });
    expect(await json(await api('GET', `/api/v1/admin/servers/${id}`))).toMatchObject({
      enabledLibraryCount: 1,
    });
    await api('PATCH', `/api/v1/admin/libraries/${movies?.id}`, { body: { enabled: true } }); // no-op
    expect(await audits('library.enable')).toHaveLength(1);

    const off = await api('PATCH', `/api/v1/admin/libraries/${movies?.id}`, {
      body: { enabled: false },
    });
    expect(await json(off)).toMatchObject({ enabled: false });
    const rows = await audits();
    expect(rows.map((r) => r.action)).toEqual([
      'server.register',
      'library.enable',
      'library.disable',
    ]);
    expect(rows[1]).toMatchObject({ target_type: 'library', target_id: movies?.id });
  });

  it('validates the library request and 404s an unknown library', async () => {
    await expectRefused(
      await api('PATCH', '/api/v1/admin/libraries/nope', { body: { enabled: true } }),
      404,
      'NOT_FOUND',
    );
    await expectRefused(
      await api('PATCH', '/api/v1/admin/libraries/nope', { body: { enabled: 'yes' } }),
      400,
      'VALIDATION_FAILED',
    );
  });

  it('never syncs or exposes a library the operator has not enabled: all start disabled', async () => {
    await register();
    expect(await count('libraries')).toBe(2);
    expect(
      (
        await db
          .prepare('SELECT COUNT(*) AS n FROM libraries WHERE enabled = 1')
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
  });
});

describe('validate (FR-SRV-002 on re-validation)', () => {
  it('re-runs the four checks, refreshes libraries and the validation time', async () => {
    const { id } = await json<{ id: string }>(await register());
    await db.prepare('UPDATE servers SET last_validated_at = 1, version = ?').bind('12.0.0').run();
    useOrigin(happy);
    const res = await api('POST', `/api/v1/admin/servers/${id}/validate`);
    expect(await json(res)).toEqual({
      ok: true,
      checks: { tls: 'passed', credentials: 'passed', identity: 'passed', version: 'passed' },
      version: '12.1.0',
    });
    const row = await db
      .prepare('SELECT version, last_validated_at FROM servers')
      .first<{ version: string; last_validated_at: number }>();
    expect(row?.version).toBe('12.1.0');
    expect(row?.last_validated_at).toBeGreaterThan(1);
    expect(await count('libraries')).toBe(2); // refreshed, not duplicated
    expect(await audits('server.validate')).toHaveLength(1);
  });

  it('fails the identity check when the address now answers as a different server', async () => {
    const { id } = await json<{ id: string }>(await register());
    useOrigin([otherServerInfo, otherServerAuth, views]);
    const err = await expectRefused(
      await api('POST', `/api/v1/admin/servers/${id}/validate`),
      422,
      'SERVER_VALIDATION_FAILED',
    );
    expect(err.details).toEqual({ check: 'identity', reason: 'server_id_mismatch' });
  });

  it('fails the credentials check once the account is promoted to administrator', async () => {
    const { id } = await json<{ id: string }>(await register());
    useOrigin([publicInfo, adminAuth, logout]);
    const err = await expectRefused(
      await api('POST', `/api/v1/admin/servers/${id}/validate`),
      422,
      'SERVER_VALIDATION_FAILED',
    );
    expect(err.details).toEqual({ check: 'credentials', reason: 'admin_account' });
  });

  it('reports CREDENTIAL_KEY_MISSING when the key that protects the credentials is gone (DR-002)', async () => {
    const { id } = await json<{ id: string }>(await register());
    useOrigin(happy); // forget the registration's calls
    // Only key version 2 is configured now; the credentials were written under version 1.
    const key2 = JSON.parse(env.CREDENTIAL_KEYS ?? '{}') as Record<string, string>;
    const res = await api('POST', `/api/v1/admin/servers/${id}/validate`, {
      env: { CREDENTIAL_KEYS: JSON.stringify({ '2': key2['2'] }), CREDENTIAL_KEY_CURRENT: '2' },
    });
    const err = await expectRefused(res, 500, 'CREDENTIAL_KEY_MISSING');
    expect(err.message).toMatch(/re-enter/i);
    expect(current.origin.calls).toHaveLength(0);
  });
});

describe('edit and disable (FR-SRV-004 subset: PATCH)', () => {
  let id = '';
  beforeEach(async () => {
    id = (await json<{ id: string }>(await register())).id;
    useOrigin(happy);
  });
  const patch = (body: Record<string, unknown>, opts: CallOptions = {}) =>
    api('PATCH', `/api/v1/admin/servers/${id}`, { body, ...opts });

  it('renames and re-prioritises without re-validating, with one audit row', async () => {
    const res = await patch({ name: 'Attic NAS', priority: 5 });
    expect(await json(res)).toMatchObject({ name: 'Attic NAS', priority: 5, status: 'active' });
    expect(current.origin.calls).toHaveLength(0);
    const rows = await audits('server.update');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.details ?? '{}')).toEqual({ fields: ['name', 'priority'] });
  });

  it('treats an unchanged request as a no-op: no audit row', async () => {
    await patch({ name: 'Basement NAS', priority: 0 });
    expect(await audits('server.update')).toHaveLength(0);
  });

  it('rejects an empty or invalid edit', async () => {
    await expectRefused(await patch({}), 400, 'VALIDATION_FAILED');
    await expectRefused(await patch({ name: '' }), 400, 'VALIDATION_FAILED');
    await expectRefused(await patch({ priority: 1.5 }), 400, 'VALIDATION_FAILED');
  });

  it('disables a server without contacting the origin, and audits it', async () => {
    const res = await patch({ enabled: false });
    expect(await json(res)).toMatchObject({ status: 'disabled' });
    expect(current.origin.calls).toHaveLength(0);
    expect(await audits('server.disable')).toHaveLength(1);
    // Disabling twice changes nothing.
    await patch({ enabled: false });
    expect(await audits('server.disable')).toHaveLength(1);
  });

  it('re-validates on re-enable: a failing origin keeps the server disabled', async () => {
    await patch({ enabled: false });
    useOrigin([publicInfo, rejectedSignIn]);
    const err = await expectRefused(
      await patch({ enabled: true }),
      422,
      'SERVER_VALIDATION_FAILED',
    );
    expect(err.details).toMatchObject({ check: 'credentials' });
    expect(
      (await db.prepare('SELECT status FROM servers').first<{ status: string }>())?.status,
    ).toBe('disabled');
    expect(await audits('server.enable')).toHaveLength(0);

    useOrigin(happy);
    expect(await json(await patch({ enabled: true }))).toMatchObject({ status: 'active' });
    expect(await audits('server.enable')).toHaveLength(1);
  });

  it('re-validates on a base URL change, and the identity must still match', async () => {
    const moved = 'https://moved.example.test';
    useOrigin([otherServerInfo, otherServerAuth]);
    const err = await expectRefused(
      await patch({ baseUrl: moved }),
      422,
      'SERVER_VALIDATION_FAILED',
    );
    expect(err.details).toEqual({ check: 'identity', reason: 'server_id_mismatch' });
    expect(
      (await db.prepare('SELECT base_url FROM servers').first<{ base_url: string }>())?.base_url,
    ).toBe(BASE);

    const origin = useOrigin(happy);
    expect(await json(await patch({ baseUrl: `${moved}/` }))).toMatchObject({ baseUrl: moved });
    expect(origin.calls.length).toBeGreaterThan(0);
  });

  it('applies the URL policy to edits too (FR-SRV-007, LLD-PROV)', async () => {
    await expectRefused(
      await patch({ baseUrl: 'http://jellyfin.example.test' }, STAGING),
      400,
      'INSECURE_ORIGIN_URL',
    );
    await expectRefused(
      await patch({ baseUrl: 'https://10.0.0.5' }, STAGING),
      400,
      'BLOCKED_ORIGIN_URL',
    );
    expect(current.origin.calls).toHaveLength(0);
    expect(
      (await db.prepare('SELECT base_url FROM servers').first<{ base_url: string }>())?.base_url,
    ).toBe(BASE);
  });
});

describe('NFR-SEC-001 / DR-002: secrets never reach responses, logs or the audit trail', () => {
  it('keeps the password, its ciphertext and the origin token out of every response and log line', async () => {
    const responses: string[] = [];
    const keep = async (res: Response) => {
      const text = await res.text();
      responses.push(text);
      return text;
    };
    const created = JSON.parse(await keep(await register())) as { id: string };
    await keep(await api('GET', '/api/v1/admin/servers'));
    await keep(await api('GET', `/api/v1/admin/servers/${created.id}`));
    await keep(await api('POST', `/api/v1/admin/servers/${created.id}/validate`));
    await keep(
      await api('PATCH', `/api/v1/admin/servers/${created.id}`, { body: { name: 'Renamed' } }),
    );
    // Failure paths echo no secret either.
    useOrigin([publicInfo, rejectedSignIn]);
    await keep(await register({ ...BODY, name: 'Other' }));
    useOrigin([publicInfo, adminAuth, logout]);
    await keep(await register({ ...BODY, name: 'Other' }));
    useOrigin(happy, { unreachable: true });
    await keep(await register({ ...BODY, name: 'Other' }));

    const envelope =
      (
        await db
          .prepare('SELECT secret_envelope FROM server_credentials')
          .first<{ secret_envelope: string }>()
      )?.secret_envelope ?? '';
    expect(envelope).toMatch(/^cw1\./);
    const everything = [...responses, ...logs, JSON.stringify(await audits())].join('\n');
    for (const forbidden of [
      PASSWORD,
      btoa(PASSWORD),
      envelope,
      envelope.split('.')[3] ?? 'x',
      '<SERVICE_TOKEN>',
    ]) {
      expect(everything).not.toContain(forbidden);
    }
    expect(logs.length).toBeGreaterThan(0); // the spy really captured request logs
  });

  it('stores no plaintext anywhere in D1', async () => {
    await register();
    for (const table of ['servers', 'server_credentials', 'libraries', 'audit_log']) {
      const dump = JSON.stringify((await db.prepare(`SELECT * FROM ${table}`).all()).results);
      expect(dump, table).not.toContain(PASSWORD);
      expect(dump, table).not.toContain('cinewren-svc');
    }
  });

  it('keeps credentials out of the error from an unexpected failure', async () => {
    // A broken origin response (HTML instead of JSON) surfaces as a generic origin error.
    useOrigin([
      { method: 'GET', url: '/System/Info/Public', status: 200, body: '<html>nope</html>' },
    ]);
    const res = await register();
    const text = await res.text();
    expect(text).not.toContain(PASSWORD);
    expect(res.status).toBe(422);
  });
});

describe('the origin is only ever reached on the registered host (NFR-SEC-005)', () => {
  it('sends every request of a full register + validate + edit cycle to the registered host', async () => {
    const { id } = await json<{ id: string }>(await register());
    await api('POST', `/api/v1/admin/servers/${id}/validate`);
    await api('PATCH', `/api/v1/admin/servers/${id}`, {
      body: { baseUrl: 'https://moved.example.test' },
    });
    // `ORIGIN` here is the Cinewren app origin used for CSRF, not an origin server.
    expect(ORIGIN).toBe('http://localhost:8787');
    const hosts = new Set(current.origin.calls.map((c) => c.url.host));
    expect(
      [...hosts].every((h) => h === 'jellyfin.example.test' || h === 'moved.example.test'),
    ).toBe(true);
  });

  it('refuses an off-host redirect while discovering libraries too', async () => {
    useOrigin([
      publicInfo,
      auth,
      {
        method: 'GET',
        url: '/UserViews?userId=148dded263c74cb885d9819605d68044',
        status: 302,
        headers: { location: 'https://evil.example/' },
      },
    ]);
    const err = await expectRefused(await register(), 502, 'ORIGIN_REDIRECT_REFUSED');
    expect(err.message).toMatch(/not allowed/);
    expect(current.origin.calls.every((c) => c.url.host === 'jellyfin.example.test')).toBe(true);
  });
});

describe('errorCode helper sanity', () => {
  it('uses the shared envelope', async () => {
    expect(await errorCode(await api('GET', '/api/v1/admin/servers/nope'))).toBe('NOT_FOUND');
  });
});
