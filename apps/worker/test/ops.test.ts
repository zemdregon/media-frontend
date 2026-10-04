// T5.3 and T5.4: credential replacement (FR-SRV-005, WF-11), the audit log (FR-OPS-005), the
// export (FR-OPS-006, NFR-SEC-001), per-user rate limits (NFR-SEC-008), operational retention
// (DR-003) and metrics (NFR-OBS-002), through the real app and local D1. The origin is the
// recorded Jellyfin 12.1 exchanges behind a fake `fetch`.
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEntry, ExportDocument, MetricsSummary, Page } from '@cinewren/shared';
import { createApp } from '../src/api/app';
import { createLogger } from '../src/platform/logger';
import { runRetention } from '../src/sync/retention';
import { decrypt, loadKeyring } from '../src/vault/vault';
import {
  call,
  createInvite,
  errorCode,
  json,
  redeem,
  resetDb,
  sessionCookie,
  setupOperator,
  userLimiter,
  type CallOptions,
} from './auth-harness';
import { createFakeOrigin, type FakeOrigin, type Route } from './providers/fixture-fetch';
import {
  BASE,
  happy,
  otherServerAuth,
  otherServerInfo,
  publicInfo,
  rejectedSignIn,
  views,
} from './providers/jellyfin-routes';
import { makeHarness, one, rows, seedServer } from './sync/harness';

const db = env.DB;
const PASSWORD = 'first-test-only-password';
const NEW_PASSWORD = 'second-test-only-password';
const BODY = {
  type: 'jellyfin',
  name: 'Basement NAS',
  baseUrl: BASE,
  credentials: { username: 'cinewren-svc', password: PASSWORD },
};
const DAY = 86_400_000;

const current: { origin: FakeOrigin } = { origin: createFakeOrigin('jellyfin', []) };
const app = createApp({ originFetch: (input, init) => current.origin.fetch(input, init) });
function useOrigin(routes: Route[]) {
  current.origin = createFakeOrigin('jellyfin', routes);
}

let cookie = '';
let operatorId = '';
const api = (method: string, path: string, opts: CallOptions = {}) =>
  call(method, path, { cookie, app, ...opts });

const count = async (table: string, where = '1=1'): Promise<number> =>
  (await one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`))?.n ?? -1;
const auditActions = async () =>
  (await rows<{ action: string }>('SELECT action FROM audit_log ORDER BY at, id')).map(
    (r) => r.action,
  );

beforeEach(async () => {
  await resetDb();
  await db.batch(
    [
      'DELETE FROM media_items',
      'DELETE FROM watch_progress',
      'DELETE FROM playback_sessions',
      'DELETE FROM sync_runs',
      'DELETE FROM idempotency_keys',
    ].map((s) => db.prepare(s)),
  );
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const op = await setupOperator();
  cookie = op.cookie;
  operatorId = op.user.id;
  useOrigin(happy);
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function registerServer() {
  const res = await api('POST', '/api/v1/admin/servers', { body: BODY });
  expect(res.status, await res.clone().text()).toBe(201);
  return json<{ id: string; libraries: { id: string }[] }>(res);
}

async function seedCatalogRow(serverId: string, libraryId: string) {
  await db.batch([
    db.prepare(
      `INSERT INTO media_items (id, type, title, sort_title, date_added, created_at, updated_at)
       VALUES ('item1', 'movie', 'Metropolis', 'metropolis', 1, 1, 1)`,
    ),
    db
      .prepare(
        `INSERT INTO sources (id, server_id, library_id, provider_item_id, media_item_id, item_type, title,
           match_method, content_hash, status, updated_at)
         VALUES ('src1', ?, ?, 'p1', 'item1', 'movie', 'Metropolis', 'new', 'h', 'present', 1)`,
      )
      .bind(serverId, libraryId),
  ]);
}

async function viewer(name = 'Vera') {
  const inv = await createInvite(cookie, { displayName: name, role: 'viewer' });
  const { res } = await redeem(inv.token);
  expect(res.status).toBe(201);
  return { id: inv.userId, cookie: sessionCookie(res), inviteId: inv.id };
}

describe('PUT /admin/servers/{id}/credentials (FR-SRV-005, WF-11)', () => {
  it('re-validates, re-encrypts under the current key and keeps every catalog row', async () => {
    const server = await registerServer();
    await seedCatalogRow(server.id, server.libraries[0]?.id ?? '');
    const before = await one<{ secret_envelope: string }>(
      'SELECT secret_envelope FROM server_credentials',
    );
    await db
      .prepare('UPDATE server_credentials SET service_token_envelope = ?')
      .bind('cached-token-envelope')
      .run();
    const libs = await count('libraries');

    useOrigin(happy);
    const res = await api('PUT', `/api/v1/admin/servers/${server.id}/credentials`, {
      body: { username: 'cinewren-svc', password: NEW_PASSWORD },
      env: { CREDENTIAL_KEY_CURRENT: '2' },
    });
    expect(res.status).toBe(204);

    const after = await one<{
      key_version: number;
      secret_envelope: string;
      service_token_envelope: string | null;
    }>('SELECT key_version, secret_envelope, service_token_envelope FROM server_credentials');
    expect(after?.key_version).toBe(2);
    expect(after?.secret_envelope).not.toBe(before?.secret_envelope);
    expect(after?.secret_envelope).not.toContain(NEW_PASSWORD);
    expect(after?.service_token_envelope).toBeNull(); // the cached token belonged to the old credential
    const keyring = await loadKeyring({ ...env, CREDENTIAL_KEY_CURRENT: '2' });
    expect(
      JSON.parse(await decrypt(keyring, 'server_secret', server.id, after?.secret_envelope ?? '')),
    ).toEqual({ kind: 'password', username: 'cinewren-svc', password: NEW_PASSWORD });

    // Catalog data is untouched (FR-SRV-005).
    expect(await count('media_items')).toBe(1);
    expect(await count('sources', "id = 'src1'")).toBe(1);
    expect(await count('libraries')).toBe(libs);
    // The audit row names the action and never a secret.
    const audit = await rows<{ action: string; details: string }>(
      "SELECT action, details FROM audit_log WHERE action = 'server.credentials.replace'",
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.details).toBe('{"keyVersion":2}');
  });

  it('refuses credentials the origin rejects, and changes nothing', async () => {
    const server = await registerServer();
    const before = await one('SELECT * FROM server_credentials');
    useOrigin([publicInfo, rejectedSignIn]);
    const res = await api('PUT', `/api/v1/admin/servers/${server.id}/credentials`, {
      body: { username: 'cinewren-svc', password: 'wrong' },
    });
    expect(res.status).toBe(422);
    const err = await json<{ error: { code: string; details: { check: string } } }>(res);
    expect(err.error.code).toBe('SERVER_VALIDATION_FAILED');
    expect(err.error.details.check).toBe('credentials');
    expect(await one('SELECT * FROM server_credentials')).toEqual(before);
    expect(await auditActions()).not.toContain('server.credentials.replace');
  });

  it('refuses credentials that belong to a different server (identity stays pinned)', async () => {
    const server = await registerServer();
    useOrigin([otherServerInfo, otherServerAuth, views]);
    const res = await api('PUT', `/api/v1/admin/servers/${server.id}/credentials`, {
      body: { username: 'someone', password: 'pw' },
    });
    expect(res.status).toBe(422);
    expect((await json<{ error: { details: { check: string } } }>(res)).error.details.check).toBe(
      'identity',
    );
  });

  it('404s an unknown server, 400s a malformed body, and needs the operator', async () => {
    const server = await registerServer();
    expect(
      await errorCode(
        await api('PUT', '/api/v1/admin/servers/nope/credentials', {
          body: { username: 'u', password: 'p' },
        }),
      ),
    ).toBe('NOT_FOUND');
    expect(
      await errorCode(
        await api('PUT', `/api/v1/admin/servers/${server.id}/credentials`, {
          body: { username: 'u' },
        }),
      ),
    ).toBe('VALIDATION_FAILED');
    const v = await viewer();
    expect(
      (
        await api('PUT', `/api/v1/admin/servers/${server.id}/credentials`, {
          cookie: v.cookie,
          body: { username: 'u', password: 'p' },
        })
      ).status,
    ).toBe(403);
  });
});

describe('every operator mutation writes exactly one audit row (FR-OPS-005)', () => {
  it('covers each mutating admin route', async () => {
    const steps: [string, string, string, unknown, string][] = [];
    const run = async (
      label: string,
      method: string,
      path: string,
      body: unknown,
      action: string,
      expectStatus: number | number[],
      opts: CallOptions = {},
    ) => {
      const before = await count('audit_log');
      const res = await api(method, path, { ...(body === undefined ? {} : { body }), ...opts });
      const statuses = Array.isArray(expectStatus) ? expectStatus : [expectStatus];
      expect(statuses, `${label}: ${String(res.status)} ${await res.clone().text()}`).toContain(
        res.status,
      );
      expect(await count('audit_log'), label).toBe(before + 1);
      const last = await one<{ action: string }>(
        'SELECT action FROM audit_log ORDER BY at DESC, rowid DESC LIMIT 1',
      );
      expect(last?.action, label).toBe(action);
      steps.push([label, method, path, body, action]);
      return res;
    };

    const before = await count('audit_log');
    const server = await registerServer();
    expect(await count('audit_log')).toBe(before + 1); // server.register
    const sid = server.id;
    const lib = server.libraries[0]?.id ?? '';

    await run(
      'validate',
      'POST',
      `/api/v1/admin/servers/${sid}/validate`,
      undefined,
      'server.validate',
      200,
    );
    await run(
      'rotate',
      'PUT',
      `/api/v1/admin/servers/${sid}/credentials`,
      { username: 'u', password: 'p' },
      'server.credentials.replace',
      204,
    );
    await run(
      'rename',
      'PATCH',
      `/api/v1/admin/servers/${sid}`,
      { name: 'Renamed' },
      'server.update',
      200,
    );
    await run(
      'library',
      'PATCH',
      `/api/v1/admin/libraries/${lib}`,
      { enabled: true },
      'library.enable',
      200,
    );
    await db.prepare('DELETE FROM sync_runs').run(); // the first sync was queued at registration
    await run(
      'sync',
      'POST',
      `/api/v1/admin/servers/${sid}/sync`,
      { type: 'full' },
      'sync.trigger',
      202,
    );

    const v = await viewer();
    expect(await auditActions()).toContain('invite.create');
    await run(
      'user update',
      'PATCH',
      `/api/v1/admin/users/${v.id}`,
      { displayName: 'Vera L' },
      'user.update',
      200,
    );
    await run(
      'user disable',
      'PATCH',
      `/api/v1/admin/users/${v.id}`,
      { status: 'disabled' },
      'user.disable',
      200,
    );
    await run(
      'user enable',
      'PATCH',
      `/api/v1/admin/users/${v.id}`,
      { status: 'active' },
      'user.enable',
      200,
    );
    await run(
      'grants',
      'PUT',
      `/api/v1/admin/users/${v.id}/grants`,
      { libraryIds: [lib] },
      'user.grants',
      200,
    );
    await run(
      'reenroll',
      'POST',
      `/api/v1/admin/users/${v.id}/reenroll`,
      undefined,
      'user.reenroll',
      201,
    );
    const second = await createInvite(cookie, { displayName: 'Tmp', role: 'viewer' });
    await run(
      'invite revoke',
      'DELETE',
      `/api/v1/admin/invites/${second.id}`,
      undefined,
      'invite.revoke',
      204,
    );
    await run(
      'user delete',
      'DELETE',
      `/api/v1/admin/users/${v.id}`,
      undefined,
      'user.delete',
      204,
    );
    await run(
      'server remove',
      'DELETE',
      `/api/v1/admin/servers/${sid}`,
      undefined,
      'server.remove',
      202,
    );

    // Idempotent no-ops are not audited; reads never are.
    const quiet = await count('audit_log');
    await api('GET', '/api/v1/admin/servers');
    await api('GET', '/api/v1/admin/audit-log');
    await api('GET', '/api/v1/admin/export');
    expect(await count('audit_log')).toBe(quiet);
    expect(steps.length).toBeGreaterThanOrEqual(12);
    // Every row names the acting operator and carries the request ID.
    const rowsAll = await rows<{
      actor_user_id: string | null;
      request_id: string | null;
      action: string;
    }>("SELECT actor_user_id, request_id, action FROM audit_log WHERE action <> 'setup.complete'");
    for (const r of rowsAll) {
      expect(r.actor_user_id, r.action).not.toBeNull();
      expect(r.request_id, r.action).toBeTruthy();
    }
    expect(operatorId).toBeTruthy();
  });
});

describe('GET /admin/audit-log (FR-OPS-005)', () => {
  async function seedAudit() {
    const stmts = [];
    for (let i = 1; i <= 5; i++) {
      stmts.push(
        db
          .prepare(
            `INSERT INTO audit_log (id, at, actor_user_id, action, target_type, target_id, details, request_id)
             VALUES (?, ?, ?, ?, 'server', ?, ?, ?)`,
          )
          .bind(
            `a${i}`,
            i * 1000,
            operatorId,
            i % 2 ? 'server.update' : 'user.grants',
            `t${i}`,
            '{"n":' + String(i) + '}',
            `req${i}`,
          ),
      );
    }
    await db.batch(stmts);
  }
  const list = async (query = '') => {
    const res = await api('GET', `/api/v1/admin/audit-log${query}`);
    expect(res.status).toBe(200);
    return json<Page<AuditEntry>>(res);
  };

  it('lists newest first with the actor, target, details and request ID', async () => {
    await seedAudit();
    const page = await list('?from=1000&to=6000');
    expect(page.items.map((e) => e.id)).toEqual(['a5', 'a4', 'a3', 'a2', 'a1']);
    expect(page.items[0]).toEqual({
      id: 'a5',
      at: 5000,
      actorUserId: operatorId,
      action: 'server.update',
      targetType: 'server',
      targetId: 't5',
      details: { n: 5 },
      requestId: 'req5',
    });
    expect(page.nextCursor).toBeNull();
  });

  it('pages with a sealed cursor, and filters by action, prefix and time range', async () => {
    await seedAudit();
    const p1 = await list('?from=1000&to=6000&limit=2');
    expect(p1.items.map((e) => e.id)).toEqual(['a5', 'a4']);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = await list(
      `?from=1000&to=6000&limit=2&cursor=${encodeURIComponent(p1.nextCursor ?? '')}`,
    );
    expect(p2.items.map((e) => e.id)).toEqual(['a3', 'a2']);
    // A cursor is bound to its filters: replaying it on another query is refused.
    expect(
      await errorCode(
        await api(
          'GET',
          `/api/v1/admin/audit-log?action=x&cursor=${encodeURIComponent(p1.nextCursor ?? '')}`,
        ),
      ),
    ).toBe('VALIDATION_FAILED');

    expect((await list('?action=user.grants&from=1000&to=6000')).items.map((e) => e.id)).toEqual([
      'a4',
      'a2',
    ]);
    expect((await list('?action=user.*&from=1000&to=6000')).items).toHaveLength(2);
    expect((await list('?from=2000&to=4000')).items.map((e) => e.id)).toEqual(['a3', 'a2']);
  });

  it('is operator-only and never exposes a secret', async () => {
    const server = await registerServer();
    await api('PUT', `/api/v1/admin/servers/${server.id}/credentials`, {
      body: { username: 'cinewren-svc', password: NEW_PASSWORD },
    });
    const v = await viewer();
    expect((await api('GET', '/api/v1/admin/audit-log', { cookie: v.cookie })).status).toBe(403);
    expect((await call('GET', '/api/v1/admin/audit-log', { app })).status).toBe(401);
    const text = JSON.stringify(await list());
    for (const secret of [PASSWORD, NEW_PASSWORD, 'cw1.']) expect(text).not.toContain(secret);
  });
});

describe('GET /admin/export (FR-OPS-006, NFR-SEC-001)', () => {
  const FORBIDDEN_KEY =
    /secret|envelope|credential|password|token|hash|cookie|passkey|apikey|key_?version/i;

  function allKeys(value: unknown, out: string[] = []): string[] {
    if (Array.isArray(value)) for (const v of value) allKeys(v, out);
    else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        out.push(k);
        allKeys(v, out);
      }
    }
    return out;
  }

  it('exports primary data as a JSON attachment', async () => {
    const server = await registerServer();
    const lib = server.libraries[0]?.id ?? '';
    await seedCatalogRow(server.id, lib);
    await api('PATCH', `/api/v1/admin/libraries/${lib}`, { body: { enabled: true } });
    const v = await viewer();
    await api('PUT', `/api/v1/admin/users/${v.id}/grants`, { body: { libraryIds: [lib] } });
    await db.batch([
      db
        .prepare(
          "INSERT INTO watch_progress (user_id, media_item_id, position_ms, watched, updated_at) VALUES (?, 'item1', 5000, 0, 9)",
        )
        .bind(v.id),
      db
        .prepare(
          `INSERT INTO curation_overrides (id, kind, entity_kind, media_item_id, server_id, provider_item_id, created_by, created_at)
         VALUES ('ov1', 'pin', 'item', 'item1', ?, 'p1', ?, 7)`,
        )
        .bind(server.id, operatorId),
    ]);

    const res = await api('GET', '/api/v1/admin/export');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="cinewren-export-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    expect(res.headers.get('cache-control')).toBe('no-store');
    const doc = await json<ExportDocument>(res);
    expect(doc.schemaVersion).toBe(1);
    expect(doc.users.map((u) => u.displayName).sort()).toEqual(['Olivia', 'Vera']);
    expect(doc.grants).toEqual([
      { userId: v.id, libraryId: lib, grantedAt: expect.any(Number) as number },
    ]);
    expect(doc.progress).toEqual([
      { userId: v.id, mediaItemId: 'item1', positionMs: 5000, watched: false, updatedAt: 9 },
    ]);
    expect(doc.curationOverrides[0]).toMatchObject({
      id: 'ov1',
      kind: 'pin',
      mediaItemId: 'item1',
    });
    expect(doc.servers).toHaveLength(1);
    expect(doc.servers[0]).toMatchObject({
      id: server.id,
      type: 'jellyfin',
      name: 'Basement NAS',
      baseUrl: BASE,
    });
    expect(doc.servers[0]?.libraries.length).toBeGreaterThan(0);
  });

  it('contains no secret, envelope or credential field anywhere (asserted)', async () => {
    const server = await registerServer();
    await seedCatalogRow(server.id, server.libraries[0]?.id ?? '');
    // Cached service token and a live session and invite: none may appear.
    await db
      .prepare('UPDATE server_credentials SET service_token_envelope = ?')
      .bind('cw1.1.cached.token')
      .run();
    await viewer();
    await createInvite(cookie, { displayName: 'Pending', role: 'viewer' });

    const res = await api('GET', '/api/v1/admin/export');
    const text = await res.text();
    const doc = JSON.parse(text) as ExportDocument;

    // Field names: nothing credential-shaped, at any depth.
    const bad = allKeys(doc).filter((k) => FORBIDDEN_KEY.test(k));
    expect(bad).toEqual([]);
    // Values: neither plaintext credentials, nor any envelope, nor session or invite material.
    const envelopes = await rows<{
      secret_envelope: string;
      service_token_envelope: string | null;
    }>('SELECT secret_envelope, service_token_envelope FROM server_credentials');
    for (const e of envelopes) {
      expect(text).not.toContain(e.secret_envelope);
      if (e.service_token_envelope) expect(text).not.toContain(e.service_token_envelope);
    }
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain('cw1.');
    for (const h of await rows<{ id_hash: string }>('SELECT id_hash FROM sessions')) {
      expect(text).not.toContain(h.id_hash);
    }
    for (const h of await rows<{ token_hash: string }>('SELECT token_hash FROM invites')) {
      expect(text).not.toContain(h.token_hash);
    }
    // The shape is exactly the documented one.
    expect(Object.keys(doc).sort()).toEqual(
      [
        'curationOverrides',
        'exportedAt',
        'grants',
        'progress',
        'schemaVersion',
        'servers',
        'users',
      ].sort(),
    );
    expect(Object.keys(doc.servers[0] ?? {}).sort()).toEqual(
      ['baseUrl', 'id', 'libraries', 'name', 'priority', 'type'].sort(),
    );
  });

  it('is operator-only', async () => {
    const v = await viewer();
    expect((await api('GET', '/api/v1/admin/export', { cookie: v.cookie })).status).toBe(403);
    expect((await call('GET', '/api/v1/admin/export', { app })).status).toBe(401);
  });
});

describe('per-user rate limits (NFR-SEC-008, TDD-D5)', () => {
  const playBody = {
    itemId: 'x',
    capabilities: {
      containers: [],
      video: [],
      audio: [],
      maxHeight: 1080,
      hdr: [],
      textSubtitles: [],
      nativeHls: false,
      mse: false,
    },
  };

  it('POST /play above the limit is 429 with Retry-After, keyed by user', async () => {
    const v = await viewer();
    userLimiter.keys = [];
    userLimiter.allow = []; // nothing passes
    const res = await api('POST', '/api/v1/play', {
      cookie: v.cookie,
      body: playBody,
      headers: { 'idempotency-key': 'k-rate-limit-1' },
    });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    const body = await json<{ error: { code: string; requestId: string } }>(res);
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(userLimiter.keys).toEqual([`play:${v.id}`]);
  });

  it('progress events and progress writes use the mutation budget', async () => {
    const v = await viewer();
    userLimiter.keys = [];
    userLimiter.denyAll = true;
    const ev = await api('POST', '/api/v1/play/some-session/events', {
      cookie: v.cookie,
      body: { seq: 1, type: 'progress', positionMs: 1 },
    });
    const put = await api('PUT', '/api/v1/progress/item1', {
      cookie: v.cookie,
      body: { watched: true },
    });
    expect([ev.status, put.status]).toEqual([429, 429]);
    expect(userLimiter.keys).toEqual([`mutation:${v.id}`, `mutation:${v.id}`]);
  });

  it('operator mutations are limited, operator reads and viewer reads are not', async () => {
    userLimiter.keys = [];
    userLimiter.denyAll = true;
    const patch = await api('PATCH', '/api/v1/admin/libraries/x', { body: { enabled: true } });
    expect(patch.status).toBe(429);
    expect(userLimiter.keys).toEqual([`mutation:${operatorId}`]);
    userLimiter.keys = [];
    for (const path of [
      '/api/v1/admin/servers',
      '/api/v1/admin/audit-log',
      '/api/v1/me',
      '/api/v1/home',
    ]) {
      expect((await api('GET', path)).status, path).toBe(200);
    }
    expect(userLimiter.keys).toEqual([]);
  });

  it('own-account writes use the mutation budget (T5.8 SR-08)', async () => {
    const v = await viewer();
    userLimiter.keys = [];
    userLimiter.denyAll = true;
    const options = await api('POST', '/api/v1/me/passkeys/options', { cookie: v.cookie });
    const prefs = await api('PATCH', '/api/v1/me/preferences', {
      cookie: v.cookie,
      body: { theme: 'dark' },
    });
    expect([options.status, prefs.status]).toEqual([429, 429]);
    expect(userLimiter.keys).toEqual([`mutation:${v.id}`, `mutation:${v.id}`]);
    expect(await count('webauthn_challenges', "purpose = 'add_passkey'")).toBe(0);
  });

  it("one user's exhausted budget does not limit another user", async () => {
    const v = await viewer();
    userLimiter.allow = [`mutation:${operatorId}`]; // only the operator's key passes
    expect(
      (await api('PATCH', '/api/v1/admin/libraries/x', { body: { enabled: true } })).status,
    ).toBe(404);
    const blocked = await api('PUT', '/api/v1/progress/item1', {
      cookie: v.cookie,
      body: { watched: true },
    });
    expect(blocked.status).toBe(429);
  });

  it('requests under the limit are served normally', async () => {
    userLimiter.keys = [];
    expect(
      (await api('PATCH', '/api/v1/admin/libraries/x', { body: { enabled: true } })).status,
    ).toBe(404);
    expect(userLimiter.keys).toHaveLength(1);
  });

  it('the real RL_PLAY binding is wired (60 per 60 s)', async () => {
    const v = await viewer();
    let last = 0;
    let passed = 0;
    for (let i = 0; i < 62; i++) {
      const res = await api('POST', '/api/v1/play', {
        cookie: v.cookie,
        body: playBody,
        env: { RL_PLAY: env.RL_PLAY },
        headers: { 'idempotency-key': `k-real-${String(i)}-abcdef` },
      });
      last = res.status;
      if (res.status !== 429) passed++;
    }
    expect(last).toBe(429);
    expect(passed).toBeLessThanOrEqual(60);
  });
});

describe('operational retention (DR-003)', () => {
  it('purges per DR-003 spans: runs 90 d, terminal sessions 30 d, probes 7 d, audit 365 d', async () => {
    await seedServer({ id: 'A' });
    await seedServer({ id: 'B' });
    await seedServer({ id: 'C' });
    const h = makeHarness();
    const now = h.clock.now;
    const ago = (days: number, extraMs = 0) => now - days * DAY - extraMs;
    await db
      .prepare(
        "INSERT INTO users (id, display_name, role, status, created_at) VALUES ('ru', 'Retention', 'viewer', 'active', 1)",
      )
      .run();
    const run = (id: string, server: string, at: number, status = 'succeeded') =>
      db
        .prepare(
          "INSERT INTO sync_runs (id, server_id, type, trigger, status, queued_at) VALUES (?, ?, 'full', 'schedule', ?, ?)",
        )
        .bind(id, server, status, at);
    const session = (id: string, status: string, at: number) =>
      db
        .prepare(
          `INSERT INTO playback_sessions (id, user_id, mode, status, authorized_at, auth_expires_at)
           VALUES (?, 'ru', 'direct_play', ?, ?, ?)`,
        )
        .bind(id, status, at, at + 1);
    const probe = (id: string, at: number) =>
      db
        .prepare("INSERT INTO health_probes (id, server_id, probed_at, ok) VALUES (?, 'A', ?, 1)")
        .bind(id, at);
    const audit = (id: string, at: number) =>
      db
        .prepare(
          "INSERT INTO audit_log (id, at, action, target_type) VALUES (?, ?, 'x.y', 'server')",
        )
        .bind(id, at);
    await db.batch([
      run('run-old', 'A', ago(91)),
      run('run-new', 'A', ago(89)),
      run('run-latest-ancient', 'C', ago(400)), // the latest run per server is never pruned
      run('run-active-old', 'B', ago(95), 'running'),
      session('s-old-ended', 'ended', ago(31)),
      session('s-old-failed', 'failed', ago(31)),
      session('s-old-started', 'started', ago(31)), // not terminal: kept
      session('s-new-ended', 'ended', ago(29)),
      probe('p-old', ago(7, 1000)),
      probe('p-new', ago(6)),
      audit('au-old', ago(366)),
      audit('au-new', ago(364)),
    ]);

    await runRetention(h.deps);

    const ids = async (sql: string) => (await rows<{ id: string }>(sql)).map((r) => r.id).sort();
    expect(await ids('SELECT id FROM sync_runs')).toEqual([
      'run-active-old',
      'run-latest-ancient',
      'run-new',
    ]);
    expect(await ids('SELECT id FROM playback_sessions')).toEqual(['s-new-ended', 's-old-started']);
    expect(await ids('SELECT id FROM health_probes')).toEqual(['p-new']);
    expect(await ids("SELECT id FROM audit_log WHERE id LIKE 'au-%'")).toEqual(['au-new']);
  });
});

describe('metrics (NFR-OBS-002)', () => {
  it('summarises sync, play outcomes, mode distribution and probes from D1', async () => {
    await seedServer({ id: 'A' });
    await seedServer({ id: 'B' });
    await db
      .prepare(
        "INSERT INTO users (id, display_name, role, status, created_at) VALUES ('mu', 'Metric', 'viewer', 'active', 1)",
      )
      .run();
    const now = Date.now();
    const run = (
      id: string,
      server: string,
      status: string,
      errors: number,
      dur: number,
      queued: number,
    ) =>
      db
        .prepare(
          `INSERT INTO sync_runs (id, server_id, type, trigger, status, errors, queued_at, started_at, ended_at)
           VALUES (?, ?, 'full', 'schedule', ?, ?, ?, ?, ?)`,
        )
        .bind(id, server, status, errors, queued, queued, queued + dur);
    const session = (id: string, mode: string, status: string, at: number) =>
      db
        .prepare(
          `INSERT INTO playback_sessions (id, user_id, mode, status, authorized_at, auth_expires_at)
           VALUES (?, 'mu', ?, ?, ?, ?)`,
        )
        .bind(id, mode, status, at, at + 1);
    const probe = (id: string, server: string, ok: number, at: number) =>
      db
        .prepare('INSERT INTO health_probes (id, server_id, probed_at, ok) VALUES (?, ?, ?, ?)')
        .bind(id, server, at, ok);
    await db.batch([
      run('r1', 'A', 'succeeded', 0, 10_000, now - 3_600_000),
      run('r2', 'A', 'failed', 3, 30_000, now - 7_200_000),
      run('r3', 'B', 'partial', 1, 5_000, now - 3 * DAY), // 7 d window only
      session('p1', 'direct_play', 'ended', now - 1000),
      session('p2', 'direct_play', 'started', now - 2000),
      session('p3', 'transcode', 'failed', now - 3000),
      session('p4', 'direct_stream', 'expired', now - 3 * DAY),
      probe('h1', 'A', 1, now - 1000),
      probe('h2', 'A', 0, now - 2000),
      probe('h3', 'B', 1, now - 3 * DAY),
    ]);

    const day = await json<MetricsSummary>(await api('GET', '/api/v1/admin/metrics'));
    expect(day.window).toBe('24h');
    expect(day.sync).toEqual([
      {
        serverId: 'A',
        serverName: 'Server A',
        runs: 2,
        failed: 1,
        partial: 0,
        errors: 3,
        avgDurationMs: 20_000,
        maxDurationMs: 30_000,
      },
    ]);
    expect(day.play).toEqual({ total: 3, outcomes: { ended: 1, started: 1, failed: 1 } });
    expect(day.modes).toEqual({ direct_play: 2, direct_stream: 0, transcode: 1 });
    expect(day.health).toEqual([{ serverId: 'A', serverName: 'Server A', probes: 2, failed: 1 }]);

    const week = await json<MetricsSummary>(await api('GET', '/api/v1/admin/metrics?window=7d'));
    expect(week.sync.map((s) => s.serverId)).toEqual(['A', 'B']);
    expect(week.sync[1]).toMatchObject({ partial: 1, errors: 1, avgDurationMs: 5000 });
    expect(week.play.total).toBe(4);
    expect(week.modes).toEqual({ direct_play: 2, direct_stream: 1, transcode: 1 });
  });

  it('rejects an unknown window and non-operators', async () => {
    expect(await errorCode(await api('GET', '/api/v1/admin/metrics?window=1y'))).toBe(
      'VALIDATION_FAILED',
    );
    const v = await viewer();
    expect((await api('GET', '/api/v1/admin/metrics', { cookie: v.cookie })).status).toBe(403);
  });

  it('emits structured counter events for sync runs, without secrets', async () => {
    const { FakeOrigin: Fake, movie, syncOnce } = await import('./sync/harness');
    await seedServer({ id: 'A', libraries: [{ id: 'A-lib', providerId: 'A-plib' }] });
    const origin = new Fake('A');
    origin.setItems('A-plib', [movie('m1', 'Interstellar', { tmdb: '1' })]);
    const lines: string[] = [];
    const h = makeHarness({ origins: [origin] });
    h.deps.logger = createLogger({}, (l) => lines.push(l));
    await syncOnce(h, 'A');
    const events = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const done = events.find((e) => e.event === 'sync.run_finished');
    expect(done).toMatchObject({
      level: 'info',
      metric: 'sync.run',
      server_id: 'A',
      status: 'succeeded',
      errors: 0,
    });
    expect(typeof done?.duration_ms).toBe('number');
  });
});
