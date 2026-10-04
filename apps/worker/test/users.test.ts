// T2.6: user lifecycle and grants (FR-USR-005, FR-USR-007, FR-USR-008, DR-005, BR-8), the
// per-user theme preference (NFR-UX-001) and server disable and removal (FR-SRV-004, WF-10).
import type { AdminUser, Page, ReenrollLink } from '@cinewren/shared';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { purgeServer } from '../src/servers/purge';
import {
  call,
  createInvite,
  errorCode,
  json,
  login,
  redeem,
  sessionCookie,
  setupOperator,
} from './auth-harness';
import {
  resetAll,
  seedLibrary,
  seedServer,
  seedUser,
  seedWorld,
  T0,
  type World,
} from './catalog-seed';
import { VirtualAuthenticator } from './virtual-authenticator';

const db = env.DB;

const count = async (sql: string, ...params: unknown[]): Promise<number> =>
  (
    await db
      .prepare(`SELECT COUNT(*) AS n FROM ${sql}`)
      .bind(...params)
      .first<{ n: number }>()
  )?.n ?? -1;

const api = (cookie: string, method: string, path: string, body?: unknown) =>
  call(method, `/api/v1${path}`, { cookie, ...(body === undefined ? {} : { body }) });

beforeEach(resetAll);

describe('PATCH /me/preferences (NFR-UX-001)', () => {
  it('stores the theme for the caller, returns it, and /me reflects it', async () => {
    const u = await seedUser('u1', 'viewer');
    expect(await json(await api(u.cookie, 'GET', '/me'))).toMatchObject({
      preferences: { theme: 'system' },
    });
    for (const theme of ['dark', 'light', 'system', 'dark']) {
      const res = await api(u.cookie, 'PATCH', '/me/preferences', { theme });
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual({ theme });
    }
    expect(await json(await api(u.cookie, 'GET', '/me'))).toMatchObject({
      preferences: { theme: 'dark' },
    });
    // Per user: another account is untouched, and nothing is written to the audit log.
    const other = await seedUser('u2', 'viewer');
    expect(await json(await api(other.cookie, 'GET', '/me'))).toMatchObject({
      preferences: { theme: 'system' },
    });
    expect(await count('audit_log')).toBe(0);
  });

  it('validates the body and requires a session and the Origin header', async () => {
    const u = await seedUser('u1', 'viewer');
    for (const body of [{ theme: 'blue' }, {}, { theme: 1 }]) {
      const res = await api(u.cookie, 'PATCH', '/me/preferences', body);
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe('VALIDATION_FAILED');
    }
    expect(
      (await call('PATCH', '/api/v1/me/preferences', { body: { theme: 'dark' } })).status,
    ).toBe(401);
    const noOrigin = await call('PATCH', '/api/v1/me/preferences', {
      cookie: u.cookie,
      body: { theme: 'dark' },
      origin: null,
    });
    expect(noOrigin.status).toBe(403);
    expect(await errorCode(noOrigin)).toBe('CSRF_REJECTED');
  });
});

describe('operator-only', () => {
  it('refuses viewers on every user route with 403', async () => {
    const op = await seedUser('op', 'operator');
    const v = await seedUser('v', 'viewer');
    for (const [method, path, body] of [
      ['GET', '/admin/users', undefined],
      ['PATCH', `/admin/users/${op.id}`, { status: 'disabled' }],
      ['DELETE', `/admin/users/${op.id}`, undefined],
      ['PUT', `/admin/users/${v.id}/grants`, { libraryIds: [] }],
      ['POST', `/admin/users/${v.id}/reenroll`, undefined],
      ['DELETE', '/admin/servers/x', undefined],
    ] as const) {
      const res = await api(v.cookie, method, path, body);
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    expect(await count('users')).toBe(2);
  });

  it('lists users with passkey counts, grants and last sign-in, paged', async () => {
    const op = await seedUser('op', 'operator');
    await seedServer({ id: 's' });
    await seedLibrary({ id: 'LA', serverId: 's' });
    await seedUser('ann', 'viewer', ['LA']);
    await seedUser('bea', 'viewer');
    await db
      .prepare(
        `INSERT INTO passkey_credentials (id, user_id, credential_id, public_key, created_at)
         VALUES ('pk1', 'ann', 'cred1', x'00', 1)`,
      )
      .run();
    const first = await json<Page<AdminUser>>(await api(op.cookie, 'GET', '/admin/users?limit=2'));
    expect(first.items.map((u) => u.id)).toEqual(['ann', 'bea']);
    expect(first.items[0]).toMatchObject({
      displayName: 'User ann',
      role: 'viewer',
      status: 'active',
      passkeyCount: 1,
      libraryIds: ['LA'],
    });
    const rest = await json<Page<AdminUser>>(
      await api(
        op.cookie,
        'GET',
        `/admin/users?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
      ),
    );
    expect(rest.items.map((u) => u.id)).toEqual(['op']);
    expect(rest.nextCursor).toBeNull();
    expect(JSON.stringify(first)).not.toMatch(/public_key|token|credential_id/i);
  });
});

describe('disable and re-enable (FR-USR-008)', () => {
  it('revokes sessions immediately and refuses login; re-enabling restores the previous grants', async () => {
    await seedServer({ id: 's' });
    await seedLibrary({ id: 'LA', serverId: 's' });
    const { cookie: opCookie } = await setupOperator();
    const invite = await createInvite(opCookie, {
      displayName: 'Vera',
      role: 'viewer',
      libraryIds: ['LA'],
    });
    const viewerAuth = new VirtualAuthenticator();
    const redeemed = await redeem(invite.token, viewerAuth);
    expect(redeemed.res.status).toBe(201);
    const viewerCookie = sessionCookie(redeemed.res);
    expect((await api(viewerCookie, 'GET', '/me')).status).toBe(200);

    const off = await api(opCookie, 'PATCH', `/admin/users/${invite.userId}`, {
      status: 'disabled',
    });
    expect(off.status).toBe(200);
    expect(await json(off)).toMatchObject({ status: 'disabled', libraryIds: ['LA'] });
    // The very next request is refused: the session row is gone.
    const refused = await api(viewerCookie, 'GET', '/me');
    expect(refused.status).toBe(401);
    expect(await count('sessions')).toBeGreaterThan(0); // the operator's session remains
    expect(await count('sessions WHERE user_id = ?', invite.userId)).toBe(0);
    // The passkey no longer signs in, and the failure looks like any other (no oracle).
    const denied = await login(viewerAuth);
    expect(denied.status).toBe(401);
    expect(await errorCode(denied)).toBe('WEBAUTHN_VERIFICATION_FAILED');

    const on = await api(opCookie, 'PATCH', `/admin/users/${invite.userId}`, { status: 'active' });
    expect(await json(on)).toMatchObject({ status: 'active', libraryIds: ['LA'] });
    const back = await login(viewerAuth);
    expect(back.status).toBe(200);
    expect((await api(sessionCookie(back), 'GET', '/items')).status).toBe(200);

    const audit = await db
      .prepare("SELECT action, target_id FROM audit_log WHERE action LIKE 'user.%' ORDER BY at, id")
      .all<{ action: string; target_id: string }>();
    expect(audit.results.map((r) => r.action).sort()).toEqual(['user.disable', 'user.enable']);
    expect(audit.results.every((r) => r.target_id === invite.userId)).toBe(true);
  });

  it('is idempotent, changes role and name, and rejects clashes and invited users', async () => {
    const op = await seedUser('op', 'operator');
    await seedUser('ann', 'viewer');
    await seedUser('bea', 'viewer');
    expect(await count('audit_log')).toBe(0);
    await api(op.cookie, 'PATCH', '/admin/users/ann', { status: 'active' });
    expect(await count('audit_log')).toBe(0); // nothing changed, nothing audited
    const named = await api(op.cookie, 'PATCH', '/admin/users/ann', { displayName: 'Anna' });
    expect(await json(named)).toMatchObject({ displayName: 'Anna' });
    const clash = await api(op.cookie, 'PATCH', '/admin/users/bea', { displayName: 'anna' });
    expect(clash.status).toBe(409);
    expect(await errorCode(clash)).toBe('DISPLAY_NAME_TAKEN');
    const promoted = await api(op.cookie, 'PATCH', '/admin/users/ann', { role: 'operator' });
    expect(await json(promoted)).toMatchObject({ role: 'operator', libraryIds: [] });
    expect(
      (await api(op.cookie, 'PATCH', '/admin/users/nope', { status: 'disabled' })).status,
    ).toBe(404);
    expect((await api(op.cookie, 'PATCH', '/admin/users/ann', {})).status).toBe(400);
    expect((await api(op.cookie, 'PATCH', '/admin/users/ann', { status: 'invited' })).status).toBe(
      400,
    );

    await db
      .prepare(
        "INSERT INTO users (id, display_name, role, status, created_at) VALUES ('inv', 'Inv', 'viewer', 'invited', ?)",
      )
      .bind(T0)
      .run();
    const invited = await api(op.cookie, 'PATCH', '/admin/users/inv', { status: 'disabled' });
    expect(invited.status).toBe(400);
  });
});

describe('the last operator is protected (BR-8)', () => {
  const state = async () =>
    await db
      .prepare("SELECT role, status FROM users WHERE id = 'op'")
      .first<{ role: string; status: string }>();

  it('cannot be disabled, demoted or deleted, even by itself', async () => {
    const op = await seedUser('op', 'operator');
    await seedUser('v', 'viewer');
    for (const [method, path, body] of [
      ['PATCH', '/admin/users/op', { status: 'disabled' }],
      ['PATCH', '/admin/users/op', { role: 'viewer' }],
      ['PATCH', '/admin/users/op', { role: 'viewer', status: 'disabled' }],
      ['DELETE', '/admin/users/op', undefined],
    ] as const) {
      const res = await api(op.cookie, method, path, body);
      expect(res.status, `${method} ${JSON.stringify(body)}`).toBe(409);
      expect(await errorCode(res)).toBe('LAST_OPERATOR');
    }
    expect(await state()).toEqual({ role: 'operator', status: 'active' });
    expect(await count('sessions WHERE user_id = ?', 'op')).toBe(1); // the failed disable kept it
    expect(await count("audit_log WHERE action LIKE 'user.%'")).toBe(0);
    // A non-operator can still be disabled and deleted.
    expect((await api(op.cookie, 'PATCH', '/admin/users/v', { status: 'disabled' })).status).toBe(
      200,
    );
    expect((await api(op.cookie, 'DELETE', '/admin/users/v')).status).toBe(204);
  });

  it('allows removing an operator while another active one remains, then protects the survivor', async () => {
    const a = await seedUser('op', 'operator');
    const b = await seedUser('op2', 'operator');
    expect((await api(a.cookie, 'PATCH', '/admin/users/op2', { role: 'viewer' })).status).toBe(200);
    expect((await api(a.cookie, 'PATCH', '/admin/users/op2', { role: 'operator' })).status).toBe(
      200,
    );
    expect((await api(b.cookie, 'PATCH', '/admin/users/op', { status: 'disabled' })).status).toBe(
      200,
    );
    // op is now disabled, so op2 is the last active operator.
    const res = await api(b.cookie, 'DELETE', '/admin/users/op2');
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('LAST_OPERATOR');
    // A disabled operator does not count: re-enabling the other one is fine, deleting op2 is not.
    expect((await api(b.cookie, 'PATCH', '/admin/users/op', { status: 'active' })).status).toBe(
      200,
    );
    expect((await api(b.cookie, 'DELETE', '/admin/users/op2')).status).toBe(204);
    expect(await count('users WHERE role = ?', 'operator')).toBe(1);
  });
});

describe('delete with cascades (DR-005)', () => {
  it('removes the user’s personal data and anonymizes audit references', async () => {
    const w = await seedWorld();
    const ann = w.alice.id;
    await db.batch([
      db
        .prepare(
          `INSERT INTO passkey_credentials (id, user_id, credential_id, public_key, created_at)
                  VALUES ('pk-a', ?, 'cred-a', x'00', 1)`,
        )
        .bind(ann),
      db
        .prepare(
          `INSERT INTO watch_progress (user_id, media_item_id, position_ms, watched, updated_at)
                  VALUES (?, 'm-amelie', 5, 0, 1)`,
        )
        .bind(ann),
      db
        .prepare(
          `INSERT INTO playback_sessions (id, user_id, media_item_id, mode, status, authorized_at, auth_expires_at)
                  VALUES ('ps1', ?, 'm-amelie', 'direct_play', 'ended', 1, 2)`,
        )
        .bind(ann),
      db
        .prepare(
          "INSERT INTO idempotency_keys (user_id, key, route, request_hash, created_at) VALUES (?, 'k', 'r', 'h', 1)",
        )
        .bind(ann),
      // An invite Alice issued, and an audit row she acted in.
      db.prepare(
        "INSERT INTO users (id, display_name, role, status, created_at) VALUES ('zed', 'Zed', 'viewer', 'invited', 1)",
      ),
      db
        .prepare(
          `INSERT INTO invites (id, kind, token_hash, user_id, created_by, created_at, expires_at)
                  VALUES ('inv1', 'signup', 'hash1', 'zed', ?, 1, 99999999999999)`,
        )
        .bind(ann),
      db
        .prepare(
          `INSERT INTO audit_log (id, at, actor_user_id, action, target_type, target_id)
                  VALUES ('au1', 1, ?, 'invite.create', 'invite', 'inv1')`,
        )
        .bind(ann),
    ]);
    // An operator action that targets Alice is on record before the delete.
    await api(w.op.cookie, 'PATCH', `/admin/users/${ann}`, { status: 'disabled' });
    expect(await count('audit_log WHERE target_id = ?', ann)).toBe(1);

    const res = await api(w.op.cookie, 'DELETE', `/admin/users/${ann}`);
    expect(res.status).toBe(204);

    for (const table of [
      'users',
      'sessions',
      'passkey_credentials',
      'library_grants',
      'watch_progress',
      'playback_sessions',
      'idempotency_keys',
    ]) {
      const column = table === 'users' ? 'id' : 'user_id';
      expect(await count(`${table} WHERE ${column} = ?`, ann), table).toBe(0);
    }
    expect(await count('audit_log WHERE target_id = ?', ann)).toBe(0); // anonymized, not removed
    expect(await count("audit_log WHERE action = 'user.disable' AND target_id IS NULL")).toBe(1);
    expect(
      await db.prepare("SELECT actor_user_id FROM audit_log WHERE id = 'au1'").first(),
    ).toEqual({ actor_user_id: null });
    expect(await db.prepare("SELECT created_by FROM invites WHERE id = 'inv1'").first()).toEqual({
      created_by: null,
    });
    const deleteRow = await db
      .prepare(
        "SELECT actor_user_id, target_id, details FROM audit_log WHERE action = 'user.delete'",
      )
      .first<{ actor_user_id: string; target_id: string | null; details: string }>();
    expect(deleteRow).toMatchObject({ actor_user_id: 'op', target_id: null });
    expect(deleteRow?.details).not.toContain('Alice');
    // Catalog data is untouched; her old cookie is dead; a repeat is 404.
    expect(await count('media_items')).toBeGreaterThan(0);
    expect((await api(w.alice.cookie, 'GET', '/items')).status).toBe(401);
    expect((await api(w.op.cookie, 'DELETE', `/admin/users/${ann}`)).status).toBe(404);
  });

  it('lets an operator delete themselves when another remains, with a null actor', async () => {
    const a = await seedUser('op', 'operator');
    await seedUser('op2', 'operator');
    expect((await api(a.cookie, 'DELETE', '/admin/users/op')).status).toBe(204);
    expect(
      await db.prepare("SELECT actor_user_id FROM audit_log WHERE action = 'user.delete'").first(),
    ).toEqual({
      actor_user_id: null,
    });
  });

  it('deletes an invited user together with their invite', async () => {
    const { cookie } = await setupOperator();
    const invite = await createInvite(cookie, { displayName: 'Pending', role: 'viewer' });
    expect((await api(cookie, 'DELETE', `/admin/users/${invite.userId}`)).status).toBe(204);
    expect(await count('invites WHERE user_id = ?', invite.userId)).toBe(0);
  });
});

describe('library grants (FR-USR-005)', () => {
  it('replaces a viewer’s grants, which take effect on the next request', async () => {
    const w = await seedWorld();
    expect(
      (await json<Page<{ id: string }>>(await api(w.bob.cookie, 'GET', '/items'))).items,
    ).toEqual([]);
    const set = await api(w.op.cookie, 'PUT', `/admin/users/${w.bob.id}/grants`, {
      libraryIds: ['L1', 'L1', 'L3'],
    });
    expect(set.status).toBe(200);
    expect(await json(set)).toEqual({ libraryIds: ['L1', 'L3'] });
    const seen = await json<Page<{ id: string }>>(
      await api(w.bob.cookie, 'GET', '/items?type=movie'),
    );
    expect(seen.items.map((i) => i.id).sort()).toEqual(['m-amelie', 'm-inter']);
    await api(w.op.cookie, 'PUT', `/admin/users/${w.bob.id}/grants`, { libraryIds: ['L2'] });
    expect(
      (await json<Page<{ id: string }>>(await api(w.bob.cookie, 'GET', '/items'))).items.map(
        (i) => i.id,
      ),
    ).toEqual(['s-sev']);
    await api(w.op.cookie, 'PUT', `/admin/users/${w.bob.id}/grants`, { libraryIds: [] });
    expect((await json<Page<unknown>>(await api(w.bob.cookie, 'GET', '/items'))).items).toEqual([]);
    expect(await count("audit_log WHERE action = 'user.grants'")).toBe(3);
  });

  it('refuses operators, disabled or unknown libraries, unknown users and bad bodies', async () => {
    const w = await seedWorld();
    const op = await api(w.op.cookie, 'PUT', `/admin/users/${w.op.id}/grants`, {
      libraryIds: ['L1'],
    });
    expect(op.status).toBe(409);
    expect(await errorCode(op)).toBe('GRANTS_NOT_APPLICABLE');
    for (const ids of [['L5'], ['nope'], ['L1', 'nope']]) {
      const res = await api(w.op.cookie, 'PUT', `/admin/users/${w.bob.id}/grants`, {
        libraryIds: ids,
      });
      expect(res.status, ids.join()).toBe(400);
    }
    expect(
      (await api(w.op.cookie, 'PUT', '/admin/users/nope/grants', { libraryIds: [] })).status,
    ).toBe(404);
    expect(
      (await api(w.op.cookie, 'PUT', `/admin/users/${w.bob.id}/grants`, { libraryIds: 'L1' }))
        .status,
    ).toBe(400);
    expect(await count('library_grants WHERE user_id = ?', w.bob.id)).toBe(0);
  });
});

describe('re-enrollment link (FR-USR-007, WF-7 flow F)', () => {
  async function viewerWithPasskey() {
    await seedServer({ id: 's' });
    await seedLibrary({ id: 'LA', serverId: 's' });
    const { cookie: opCookie } = await setupOperator();
    const invite = await createInvite(opCookie, {
      displayName: 'Vera',
      role: 'viewer',
      libraryIds: ['LA'],
    });
    const original = new VirtualAuthenticator();
    expect((await redeem(invite.token, original)).res.status).toBe(201);
    return { opCookie, userId: invite.userId, original };
  }
  const tokenOf = (link: string) => new URL(link).hash.replace(/^#t=/, '');

  it('adds a passkey exactly once, then the link is dead; role, grants and old passkeys are kept', async () => {
    const { opCookie, userId, original } = await viewerWithPasskey();
    const res = await api(opCookie, 'POST', `/admin/users/${userId}/reenroll`);
    expect(res.status).toBe(201);
    const link = await json<ReenrollLink>(res);
    expect(link.link).toMatch(/^http:\/\/localhost:8787\/invite#t=[A-Za-z0-9_-]{43}$/);
    expect(link.expiresAt - Date.now()).toBeGreaterThan(23.9 * 3_600_000);
    expect(link.expiresAt - Date.now()).toBeLessThanOrEqual(24 * 3_600_000);
    const token = tokenOf(link.link);

    const inspect = await call('POST', '/api/v1/invites/inspect', { body: { token } });
    expect(await json(inspect)).toMatchObject({
      kind: 'reenroll',
      displayName: 'Vera',
      role: 'viewer',
    });

    const fresh = new VirtualAuthenticator();
    const done = await redeem(token, fresh);
    expect(done.res.status).toBe(201);
    expect((await api(sessionCookie(done.res), 'GET', '/me')).status).toBe(200);
    expect(await count('passkey_credentials WHERE user_id = ?', userId)).toBe(2);
    expect(await count('library_grants WHERE user_id = ?', userId)).toBe(1);

    // Single use: the same link is now indistinguishable from an unknown one.
    const second = await call('POST', '/api/v1/invites/redeem/options', { body: { token } });
    expect(second.status).toBe(404);
    expect(await errorCode(second)).toBe('INVITE_INVALID');
    expect((await call('POST', '/api/v1/invites/inspect', { body: { token } })).status).toBe(404);
    expect(await count('passkey_credentials WHERE user_id = ?', userId)).toBe(2);

    // Both the old and the new passkey sign in.
    expect((await login(original)).status).toBe(200);
    expect((await login(fresh)).status).toBe(200);
  });

  it('expires after 24 hours', async () => {
    const { opCookie, userId } = await viewerWithPasskey();
    const link = await json<ReenrollLink>(
      await api(opCookie, 'POST', `/admin/users/${userId}/reenroll`),
    );
    const token = tokenOf(link.link);
    await db
      .prepare('UPDATE invites SET expires_at = ? WHERE id = ?')
      .bind(Date.now() - 1, link.id)
      .run();
    const res = await call('POST', '/api/v1/invites/redeem/options', { body: { token } });
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('INVITE_INVALID');
    expect(await count('passkey_credentials WHERE user_id = ?', userId)).toBe(1);
  });

  it('keeps only the newest open link, stores only a hash, and audits without the token', async () => {
    const { opCookie, userId } = await viewerWithPasskey();
    const first = await json<ReenrollLink>(
      await api(opCookie, 'POST', `/admin/users/${userId}/reenroll`),
    );
    const second = await json<ReenrollLink>(
      await api(opCookie, 'POST', `/admin/users/${userId}/reenroll`),
    );
    expect(
      (await call('POST', '/api/v1/invites/inspect', { body: { token: tokenOf(first.link) } }))
        .status,
    ).toBe(404);
    expect(
      (await call('POST', '/api/v1/invites/inspect', { body: { token: tokenOf(second.link) } }))
        .status,
    ).toBe(200);
    const stored = await db
      .prepare('SELECT token_hash FROM invites WHERE id = ?')
      .bind(second.id)
      .first<{ token_hash: string }>();
    expect(stored?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    const dump =
      JSON.stringify(await db.prepare('SELECT * FROM audit_log').all()) +
      JSON.stringify(await db.prepare('SELECT * FROM invites').all());
    expect(dump).not.toContain(tokenOf(second.link));
    expect(await count("audit_log WHERE action = 'user.reenroll'")).toBe(2);
    expect(
      (await call('GET', '/api/v1/admin/invites?status=revoked', { cookie: opCookie })).status,
    ).toBe(200);
  });

  it('is refused for unknown, disabled and not-yet-invited users', async () => {
    const { opCookie, userId } = await viewerWithPasskey();
    expect((await api(opCookie, 'POST', '/admin/users/nope/reenroll')).status).toBe(404);
    await api(opCookie, 'PATCH', `/admin/users/${userId}`, { status: 'disabled' });
    expect((await api(opCookie, 'POST', `/admin/users/${userId}/reenroll`)).status).toBe(400);
    const pending = await createInvite(opCookie, { displayName: 'Pending', role: 'viewer' });
    expect((await api(opCookie, 'POST', `/admin/users/${pending.userId}/reenroll`)).status).toBe(
      400,
    );
  });

  it('does not work for a user disabled after the link was issued', async () => {
    const { opCookie, userId } = await viewerWithPasskey();
    const link = await json<ReenrollLink>(
      await api(opCookie, 'POST', `/admin/users/${userId}/reenroll`),
    );
    await api(opCookie, 'PATCH', `/admin/users/${userId}`, { status: 'disabled' });
    const res = await call('POST', '/api/v1/invites/redeem/options', {
      body: { token: tokenOf(link.link) },
    });
    expect(res.status).toBe(404);
  });
});

describe('server disable (FR-SRV-004, WF-10)', () => {
  it('hides a disabled server’s sources from browse and detail at once, keeping others', async () => {
    const w = await seedWorld();
    expect((await api(w.alice.cookie, 'GET', '/items/m-amelie')).status).toBe(200);
    const off = await api(w.op.cookie, 'PATCH', '/admin/servers/alpha', { enabled: false });
    expect(off.status).toBe(200);
    expect(await json(off)).toMatchObject({ status: 'disabled' });
    expect((await api(w.alice.cookie, 'GET', '/items/m-amelie')).status).toBe(404);
    expect((await json<Page<unknown>>(await api(w.alice.cookie, 'GET', '/items'))).items).toEqual(
      [],
    );
    // Carol reaches the Bravo copy of Amélie, and no longer counts the Alpha server.
    const carol = await json<{ serverCount: number }>(
      await api(w.carol.cookie, 'GET', '/items/m-amelie'),
    );
    expect(carol.serverCount).toBe(1);
    expect((await api(w.op.cookie, 'GET', '/items/m-amelie')).status).toBe(200);
  });
});

describe('server removal with chunked deletion (FR-SRV-004, DR-005, WF-10)', () => {
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  it('deletes the server, its sources and everything left orphaned, and audits it', async () => {
    const res = await api(w.op.cookie, 'DELETE', '/admin/servers/bravo');
    expect(res.status).toBe(202);
    expect(await json(res)).toEqual({ status: 'removed' });

    expect(await count('servers WHERE id = ?', 'bravo')).toBe(0);
    for (const table of ['server_credentials', 'libraries', 'sources']) {
      expect(await count(`${table} WHERE server_id = ?`, 'bravo'), table).toBe(0);
    }
    expect(await count('library_grants WHERE library_id = ?', 'L3')).toBe(0);
    expect(await count('item_availability WHERE library_id = ?', 'L3')).toBe(0);
    // Items left with no source are gone, with their search rows; shared items keep their other source.
    expect(await count("media_items WHERE id = 'm-inter'")).toBe(0);
    expect(await count("search_fts WHERE kind = 'title' AND entity_id = 'm-inter'")).toBe(0);
    expect(await count("media_items WHERE id = 'm-amelie'")).toBe(1);
    expect(await count("sources WHERE media_item_id = 'm-amelie'")).toBe(1);
    expect(await count("media_versions WHERE source_id LIKE '%bravo'")).toBe(0);
    // People and collections with no link left are removed with their search rows.
    expect(await count("people WHERE id = 'p-hidden'")).toBe(0);
    expect(await count("search_fts WHERE entity_id = 'p-hidden'")).toBe(0);
    expect(await count("people WHERE id = 'p-evans'")).toBe(1);
    expect(await count("person_provider_links WHERE server_id = 'bravo'")).toBe(0);
    expect(await count("credits WHERE person_id = 'p-evans'")).toBe(1);
    for (const id of ['c-duo', 'c-hidden', 'c-fav-b']) {
      expect(await count('collections WHERE id = ?', id), id).toBe(0);
      expect(await count('search_fts WHERE entity_id = ?', id), id).toBe(0);
    }
    expect(await count("collections WHERE id = 'c-fav-a'")).toBe(1);
    // Others are untouched; the removal is audited once.
    expect(await count('servers')).toBe(2);
    expect(await count('media_items')).toBe(8 - 1); // m-inter only
    expect(await count("audit_log WHERE action = 'server.remove' AND target_id = 'bravo'")).toBe(1);

    expect((await api(w.carol.cookie, 'GET', '/items/m-inter')).status).toBe(404);
    expect((await api(w.op.cookie, 'GET', '/admin/servers/bravo')).status).toBe(404);
    expect((await api(w.op.cookie, 'DELETE', '/admin/servers/bravo')).status).toBe(404);
  });

  it('removes a series with its seasons and episodes, children first', async () => {
    await api(w.op.cookie, 'DELETE', '/admin/servers/alpha');
    for (const id of ['s-sev', 'se-1', 'ep-1', 'ep-2']) {
      expect(await count('media_items WHERE id = ?', id), id).toBe(0);
    }
    expect(await count("media_items WHERE id = 'm-amelie'")).toBe(1); // still on Bravo
    expect(await count("search_fts WHERE entity_id = 's-sev'")).toBe(0);
    expect(await count('sources WHERE server_id = ?', 'alpha')).toBe(0);
  });

  it('hides the server at once and purges in chunks that can resume', async () => {
    // Phase 1 by hand: `removing` hides everything before a single source is deleted.
    await db.prepare("UPDATE servers SET status = 'removing' WHERE id = 'bravo'").run();
    expect((await api(w.carol.cookie, 'GET', '/items')).status).toBe(200);
    expect((await json<Page<unknown>>(await api(w.carol.cookie, 'GET', '/items'))).items).toEqual(
      [],
    );
    expect(await count('sources WHERE server_id = ?', 'bravo')).toBeGreaterThan(0);

    let passes = 0;
    let outcome = await purgeServer(db, 'bravo', { chunk: 1, maxChunks: 1 });
    while (outcome === 'more' && passes < 100) {
      passes++;
      expect(await count('servers WHERE id = ?', 'bravo')).toBe(1); // still removing mid-way
      outcome = await purgeServer(db, 'bravo', { chunk: 1, maxChunks: 1 });
    }
    expect(outcome).toBe('done');
    expect(passes).toBeGreaterThan(3); // several chunks of one row each
    expect(await count('servers WHERE id = ?', 'bravo')).toBe(0);
    expect(await count('sources WHERE server_id = ?', 'bravo')).toBe(0);
    expect(await count("media_items WHERE id = 'm-inter'")).toBe(0);
    expect(await purgeServer(db, 'bravo')).toBe('done'); // idempotent
  });

  it('continues a removal that was already started, and never touches a live server', async () => {
    expect(await purgeServer(db, 'alpha')).toBe('done'); // active: nothing happens
    expect(await count('sources WHERE server_id = ?', 'alpha')).toBeGreaterThan(0);
    await db.prepare("UPDATE servers SET status = 'removing' WHERE id = 'bravo'").run();
    const res = await api(w.op.cookie, 'DELETE', '/admin/servers/bravo');
    expect(res.status).toBe(202);
    expect(await count('servers WHERE id = ?', 'bravo')).toBe(0);
  });

  it('ends open playback sessions of the server before its credentials go (T5.8 SR-02)', async () => {
    // The origin-side revocation itself is covered against a mock origin in playback/play.test.ts;
    // this unreadable envelope cannot be revoked, so the session is ended and its credential
    // forgotten with an operator-visible error rather than left looking live.
    await db
      .prepare(
        `INSERT INTO playback_sessions (id, user_id, server_id, mode, status, credential_envelope, authorized_at, auth_expires_at)
         VALUES ('ps-b', ?, 'bravo', 'direct_play', 'started', 'cw1.1.x.y', 1, 2)`,
      )
      .bind(w.carol.id)
      .run();
    await api(w.op.cookie, 'DELETE', '/admin/servers/bravo');
    expect(
      await db
        .prepare("SELECT status, end_reason, server_id FROM playback_sessions WHERE id = 'ps-b'")
        .first(),
    ).toEqual({
      status: 'ended',
      end_reason: 'server_removed',
      server_id: null, // the server row is gone; the session record stays (DR-003 retention)
    });
  });
});
