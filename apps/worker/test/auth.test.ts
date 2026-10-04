// T0.5: passkey auth, invites, sessions, CSRF, rate limits and role guard, through the real app,
// local D1 and `@simplewebauthn/server` in the Workers runtime, with a virtual authenticator
// (FR-USR-001 to FR-USR-004, FR-USR-006, IR-006, NFR-SEC-002, NFR-SEC-004, NFR-SEC-007).
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/server';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { PUBLIC_API_ROUTES } from '../src/api/app';
import { guardChangedStmt, redeemInviteStmt, sweepAuth } from '../src/db/auth';
import {
  addPasskey,
  call,
  createInvite,
  errorCode,
  json,
  limiter,
  login,
  loginOptions,
  ORIGIN,
  redeem,
  redeemOptions,
  resetDb,
  SETUP_TOKEN,
  sessionCookie,
  setupOperator,
  sha256Hex,
} from './auth-harness';
import { VirtualAuthenticator } from './virtual-authenticator';

const db = env.DB;

beforeEach(resetDb);

async function viewerSession(operatorCookie: string, displayName = 'Vera') {
  const invite = await createInvite(operatorCookie, { displayName });
  const { res, auth } = await redeem(invite.token);
  expect(res.status).toBe(201);
  return { cookie: sessionCookie(res), auth, invite };
}

describe('FR-USR-001: every non-public API route needs a session', () => {
  it.each([
    ['GET', '/api/v1/me'],
    ['GET', '/api/v1/me/passkeys'],
    ['POST', '/api/v1/me/passkeys/options'],
    ['DELETE', '/api/v1/me/passkeys/x'],
    ['POST', '/api/v1/auth/logout'],
    ['GET', '/api/v1/admin/invites'],
    ['POST', '/api/v1/admin/invites'],
    ['DELETE', '/api/v1/admin/invites/x'],
    ['GET', '/api/v1/admin/status'],
    ['GET', '/api/v1/items'],
    ['GET', '/api/v1/unknown/route'],
    ['GET', '/api/v2/anything'],
  ])('%s %s without a session → 401 AUTH_REQUIRED', async (method, path) => {
    const res = await call(method, path, method === 'GET' ? {} : { body: {} });
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe('AUTH_REQUIRED');
  });

  it('rejects an unknown or forged session cookie', async () => {
    const res = await call('GET', '/api/v1/me', { cookie: '__Host-cw_session=forged-value' });
    expect(res.status).toBe(401);
  });

  it('public routes answer without a session (route table, SDD INV-9)', async () => {
    for (const route of PUBLIC_API_ROUTES) {
      const [method, path] = route.split(' ') as [string, string];
      const res = await call(method, path, method === 'GET' ? {} : { body: {} });
      expect(res.status, route).not.toBe(401);
    }
  });

  it('a signed-in caller gets 404 NOT_FOUND for an unknown API route', async () => {
    const { cookie } = await setupOperator();
    const res = await call('GET', '/api/v1/unknown/route', { cookie });
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('NOT_FOUND');
  });
});

describe('FR-USR-002: /setup bootstrap with SETUP_TOKEN', () => {
  it('is available until the first operator exists, then permanently 404', async () => {
    expect(await json(await call('GET', '/api/v1/setup'))).toEqual({ available: true });

    const { cookie, user } = await setupOperator();
    const me = await json(await call('GET', '/api/v1/me', { cookie }));
    expect(me).toEqual({
      id: user.id,
      displayName: 'Olivia',
      role: 'operator',
      preferences: { theme: 'system' },
    });

    expect(await json(await call('GET', '/api/v1/setup'))).toEqual({ available: false });
    const again = await call('POST', '/api/v1/setup/options', {
      body: { setupToken: SETUP_TOKEN, displayName: 'Mallory' },
    });
    expect(again.status).toBe(404);
    expect(await errorCode(again)).toBe('NOT_FOUND');
    const users = await db
      .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'operator'")
      .first();
    expect(users).toEqual({ n: 1 });
  });

  it('refuses a wrong or missing token with the same 404 as disabled setup', async () => {
    for (const setupToken of ['wrong-token', '', SETUP_TOKEN.slice(0, -1)]) {
      const res = await call('POST', '/api/v1/setup/options', {
        body: { setupToken, displayName: 'X' },
      });
      expect(res.status).toBe(404);
      expect(await errorCode(res)).toBe('NOT_FOUND');
    }
    // SETUP_TOKEN unset (deleted after setup, or never configured).
    const res = await call('POST', '/api/v1/setup/options', {
      body: { setupToken: SETUP_TOKEN, displayName: 'X' },
      env: { SETUP_TOKEN: undefined },
    });
    expect(res.status).toBe(404);
  });

  it('refuses verify with a wrong token even with a valid challenge', async () => {
    const opt = await call('POST', '/api/v1/setup/options', {
      body: { setupToken: SETUP_TOKEN, displayName: 'O' },
    });
    const { challengeId, options } = await json<{
      challengeId: string;
      options: PublicKeyCredentialCreationOptionsJSON;
    }>(opt);
    const response = await new VirtualAuthenticator().register(options, ORIGIN);
    const res = await call('POST', '/api/v1/setup/verify', {
      body: { setupToken: 'nope', displayName: 'O', challengeId, response },
    });
    expect(res.status).toBe(404);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM users').first()).toEqual({ n: 0 });
  });

  it('issues WebAuthn options per TDD §5.1 (RP ID, discoverable, UV required, attestation none)', async () => {
    const res = await call('POST', '/api/v1/setup/options', {
      body: { setupToken: SETUP_TOKEN, displayName: 'O' },
    });
    const { options } = await json<{ options: PublicKeyCredentialCreationOptionsJSON }>(res);
    expect(options.rp).toEqual({ id: 'localhost', name: 'Cinewren' });
    expect(options.authenticatorSelection).toMatchObject({
      residentKey: 'required',
      userVerification: 'required',
    });
    expect(options.attestation).toBe('none');
    expect(options.user.name).toBe('O');
  });

  it('only one of two concurrent setups can win', async () => {
    const begin = async (displayName: string) => {
      const res = await call('POST', '/api/v1/setup/options', {
        body: { setupToken: SETUP_TOKEN, displayName },
      });
      const { challengeId, options } = await json<{
        challengeId: string;
        options: PublicKeyCredentialCreationOptionsJSON;
      }>(res);
      return {
        displayName,
        challengeId,
        response: await new VirtualAuthenticator().register(options, ORIGIN),
      };
    };
    const a = await begin('Alpha');
    const b = await begin('Beta');
    const ra = await call('POST', '/api/v1/setup/verify', {
      body: { setupToken: SETUP_TOKEN, ...a },
    });
    const rb = await call('POST', '/api/v1/setup/verify', {
      body: { setupToken: SETUP_TOKEN, ...b },
    });
    expect(ra.status).toBe(201);
    expect(rb.status).toBe(404);
    expect(await db.prepare('SELECT display_name FROM users').all()).toMatchObject({
      results: [{ display_name: 'Alpha' }],
    });
  });

  it('records an audit row without the token', async () => {
    await setupOperator();
    const row = await db
      .prepare("SELECT action, details FROM audit_log WHERE action = 'setup.complete'")
      .first<{ details: string }>();
    expect(row).not.toBeNull();
    expect(JSON.stringify(row)).not.toContain(SETUP_TOKEN);
  });
});

describe('NFR-SEC-007: session cookie and storage', () => {
  it('sets __Host-cw_session with HttpOnly; Secure; SameSite=Lax; Path=/ and stores only a hash', async () => {
    const { res, cookie } = await setupOperator();
    const header = res.headers.get('set-cookie') ?? '';
    expect(header).toMatch(/^__Host-cw_session=[A-Za-z0-9_-]{43};/);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Path=/');
    expect(header).toContain(`Max-Age=${90 * 86400}`);
    expect(header).not.toMatch(/Domain=/i);

    const value = cookie.split('=')[1] ?? '';
    const rows = await db
      .prepare('SELECT id_hash, idle_expires_at, absolute_expires_at, created_at FROM sessions')
      .all<{
        id_hash: string;
        idle_expires_at: number;
        absolute_expires_at: number;
        created_at: number;
      }>();
    expect(rows.results).toHaveLength(1);
    const s = rows.results[0];
    expect(s?.id_hash).toBe(await sha256Hex(value));
    expect(s?.id_hash).not.toContain(value);
    expect((s?.idle_expires_at ?? 0) - (s?.created_at ?? 0)).toBe(14 * 86_400_000);
    expect((s?.absolute_expires_at ?? 0) - (s?.created_at ?? 0)).toBe(90 * 86_400_000);
  });

  it('expires on idle and on absolute timeouts, and slides idle expiry at most hourly', async () => {
    const { cookie } = await setupOperator();
    const now = Date.now();

    await db
      .prepare('UPDATE sessions SET last_seen_at = ?, idle_expires_at = ?')
      .bind(now - 7_200_000, now + 1000)
      .run();
    expect((await call('GET', '/api/v1/me', { cookie })).status).toBe(200);
    const slid = await db
      .prepare('SELECT idle_expires_at, last_seen_at FROM sessions')
      .first<{ idle_expires_at: number; last_seen_at: number }>();
    expect(slid?.idle_expires_at).toBeGreaterThan(now + 13 * 86_400_000);
    expect(slid?.last_seen_at).toBeGreaterThanOrEqual(now);

    await db
      .prepare('UPDATE sessions SET idle_expires_at = ?')
      .bind(now - 1)
      .run();
    expect((await call('GET', '/api/v1/me', { cookie })).status).toBe(401);

    await db
      .prepare('UPDATE sessions SET idle_expires_at = ?, absolute_expires_at = ?')
      .bind(now + 86_400_000, now - 1)
      .run();
    expect((await call('GET', '/api/v1/me', { cookie })).status).toBe(401);
  });

  it('ends access at once when the user is disabled', async () => {
    const { cookie: opCookie } = await setupOperator();
    const viewer = await viewerSession(opCookie);
    await db.prepare("UPDATE users SET status = 'disabled' WHERE display_name = 'Vera'").run();
    expect((await call('GET', '/api/v1/me', { cookie: viewer.cookie })).status).toBe(401);
  });
});

describe('FR-USR-006: logout revokes the session', () => {
  it('deletes the session row and clears the cookie; the old cookie is refused', async () => {
    const { cookie } = await setupOperator();
    const res = await call('POST', '/api/v1/auth/logout', { cookie });
    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toMatch(/__Host-cw_session=;.*Max-Age=0/);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM sessions').first()).toEqual({ n: 0 });
    expect((await call('GET', '/api/v1/me', { cookie })).status).toBe(401);
  });

  it('revokes only the current session', async () => {
    const { auth, cookie } = await setupOperator();
    const second = sessionCookie(await login(auth));
    await call('POST', '/api/v1/auth/logout', { cookie });
    expect((await call('GET', '/api/v1/me', { cookie: second })).status).toBe(200);
  });
});

describe('NFR-SEC-007: Origin check on state-changing requests', () => {
  it.each([['https://evil.example'], ['http://localhost:8788'], ['null'], [null]])(
    'refuses a mutation with Origin %s (403 CSRF_REJECTED) and keeps the session',
    async (origin) => {
      const { cookie } = await setupOperator();
      const res = await call('POST', '/api/v1/auth/logout', { cookie, origin });
      expect(res.status).toBe(403);
      expect(await errorCode(res)).toBe('CSRF_REJECTED');
      expect((await call('GET', '/api/v1/me', { cookie })).status).toBe(200);
    },
  );

  it('also guards public auth mutations and operator mutations', async () => {
    const res = await call('POST', '/api/v1/setup/options', {
      body: { setupToken: SETUP_TOKEN, displayName: 'O' },
      origin: 'https://evil.example',
    });
    expect(res.status).toBe(403);

    const { cookie } = await setupOperator();
    const inv = await call('POST', '/api/v1/admin/invites', {
      cookie,
      body: { displayName: 'Eve' },
      origin: 'https://evil.example',
    });
    expect(inv.status).toBe(403);
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM users WHERE display_name = 'Eve'").first(),
    ).toEqual({ n: 0 });
  });

  it('allows safe methods without an Origin header', async () => {
    const { cookie } = await setupOperator();
    expect((await call('GET', '/api/v1/me', { cookie, origin: null })).status).toBe(200);
  });

  it('accepts only JSON bodies', async () => {
    const res = await call('POST', '/api/v1/setup/options', {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('VALIDATION_FAILED');
  });
});

describe('FR-USR-003: role guard', () => {
  it('a viewer gets 403 FORBIDDEN on every operator route', async () => {
    const { cookie: opCookie } = await setupOperator();
    const { cookie, invite } = await viewerSession(opCookie);
    for (const [method, path, body] of [
      ['GET', '/api/v1/admin/invites', undefined],
      ['POST', '/api/v1/admin/invites', { displayName: 'Zed' }],
      ['DELETE', `/api/v1/admin/invites/${invite.id}`, undefined],
      ['GET', '/api/v1/admin/status', undefined],
    ] as const) {
      const res = await call(method, path, { cookie, body });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(await errorCode(res)).toBe('FORBIDDEN');
    }
    expect(await json(await call('GET', '/api/v1/me', { cookie }))).toMatchObject({
      role: 'viewer',
      displayName: 'Vera',
    });
  });
});

describe('FR-USR-004 / FR-USR-002: invites', () => {
  it('creates an invited user; the token is only in the link fragment and only its hash is stored', async () => {
    const { cookie } = await setupOperator();
    const invite = await createInvite(cookie, { displayName: '  Vera  ' });
    expect(invite.link).toMatch(new RegExp(`^${ORIGIN}/invite#t=[A-Za-z0-9_-]{43}$`));
    expect(invite.expiresAt - Date.now()).toBeGreaterThan(7 * 86_400_000 - 60_000);

    const user = await db
      .prepare('SELECT display_name, role, status FROM users WHERE id = ?')
      .bind(invite.userId)
      .first();
    expect(user).toEqual({ display_name: 'Vera', role: 'viewer', status: 'invited' });
    const row = await db.prepare('SELECT * FROM invites WHERE id = ?').bind(invite.id).first();
    expect(row?.token_hash).toBe(await sha256Hex(invite.token));
    expect(JSON.stringify(row)).not.toContain(invite.token);
    const audit = await db.prepare("SELECT * FROM audit_log WHERE action = 'invite.create'").all();
    expect(audit.results).toHaveLength(1);
    expect(JSON.stringify(audit.results)).not.toContain(invite.token);

    const list = await json<{ items: Record<string, unknown>[]; nextCursor: null }>(
      await call('GET', '/api/v1/admin/invites?status=open', { cookie }),
    );
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      id: invite.id,
      status: 'open',
      displayName: 'Vera',
      role: 'viewer',
    });
    expect(JSON.stringify(list)).not.toContain(invite.token);
  });

  it('grants all enabled libraries by default, or the listed ones; refuses unknown libraries', async () => {
    const { cookie } = await setupOperator();
    await db.batch([
      db.prepare(
        "INSERT INTO servers (id, type, name, base_url, origin_server_id, status, created_at, updated_at) VALUES ('s1','jellyfin','NAS','https://nas.example','o1','active',1,1)",
      ),
      db.prepare(
        "INSERT INTO libraries (id, server_id, provider_library_id, name, kind, enabled) VALUES ('l1','s1','a','Movies','movies',1)",
      ),
      db.prepare(
        "INSERT INTO libraries (id, server_id, provider_library_id, name, kind, enabled) VALUES ('l2','s1','b','TV','tv',1)",
      ),
      db.prepare(
        "INSERT INTO libraries (id, server_id, provider_library_id, name, kind, enabled) VALUES ('l3','s1','c','Off','movies',0)",
      ),
    ]);
    const grants = async (userId: string) =>
      (
        await db
          .prepare('SELECT library_id FROM library_grants WHERE user_id = ? ORDER BY library_id')
          .bind(userId)
          .all<{ library_id: string }>()
      ).results.map((r) => r.library_id);
    expect(await grants((await createInvite(cookie, { displayName: 'A' })).userId)).toEqual([
      'l1',
      'l2',
    ]);
    expect(
      await grants((await createInvite(cookie, { displayName: 'B', libraryIds: ['l2'] })).userId),
    ).toEqual(['l2']);
    expect(
      await grants((await createInvite(cookie, { displayName: 'C', role: 'operator' })).userId),
    ).toEqual([]);
    const bad = await call('POST', '/api/v1/admin/invites', {
      cookie,
      body: { displayName: 'D', libraryIds: ['l3'] },
    });
    expect(bad.status).toBe(400);
  });

  it('refuses a duplicate display name and invalid input', async () => {
    const { cookie } = await setupOperator();
    await createInvite(cookie, { displayName: 'Vera' });
    const dup = await call('POST', '/api/v1/admin/invites', {
      cookie,
      body: { displayName: 'vera' },
    });
    expect(dup.status).toBe(409);
    expect(await errorCode(dup)).toBe('DISPLAY_NAME_TAKEN');
    const empty = await call('POST', '/api/v1/admin/invites', {
      cookie,
      body: { displayName: '   ' },
    });
    expect(empty.status).toBe(400);
    const role = await call('POST', '/api/v1/admin/invites', {
      cookie,
      body: { displayName: 'R', role: 'admin' },
    });
    expect(role.status).toBe(400);
  });

  it('inspect shows the invite; redeem activates the user with a passkey and a session', async () => {
    const { cookie: opCookie } = await setupOperator();
    const invite = await createInvite(opCookie, { displayName: 'Vera' });
    const inspect = await call('POST', '/api/v1/invites/inspect', {
      body: { token: invite.token },
    });
    expect(await json(inspect)).toEqual({
      kind: 'signup',
      role: 'viewer',
      displayName: 'Vera',
      expiresAt: invite.expiresAt,
    });

    const opts = await redeemOptions(invite.token);
    expect(opts.body?.options.user.name).toBe('Vera');
    const { res, auth } = await redeem(invite.token);
    expect(res.status).toBe(201);
    expect(await json(res)).toEqual({
      user: { id: invite.userId, displayName: 'Vera', role: 'viewer' },
    });
    const cookie = sessionCookie(res);
    expect((await call('GET', '/api/v1/me', { cookie })).status).toBe(200);
    expect(
      await db.prepare('SELECT status FROM users WHERE id = ?').bind(invite.userId).first(),
    ).toEqual({ status: 'active' });

    // The new viewer can now sign in with that passkey.
    expect((await login(auth)).status).toBe(200);
  });

  it('refuses account creation without a valid invite', async () => {
    const { cookie: opCookie } = await setupOperator();
    const usersBefore = await db.prepare('SELECT COUNT(*) AS n FROM users').first();

    // Unknown token.
    const bogus = 'A'.repeat(43);
    for (const path of ['/api/v1/invites/inspect', '/api/v1/invites/redeem/options']) {
      const res = await call('POST', path, { body: { token: bogus } });
      expect(res.status).toBe(404);
      expect(await errorCode(res)).toBe('INVITE_INVALID');
    }

    // A real ceremony bound to a login challenge, with an invented token.
    const { challengeId, options } = await loginOptions();
    const fake = await new VirtualAuthenticator().register(
      {
        ...options,
        rp: { id: 'localhost', name: 'x' },
        user: { id: 'eA', name: 'x', displayName: 'x' },
        pubKeyCredParams: [],
      },
      ORIGIN,
    );
    const res = await call('POST', '/api/v1/invites/redeem/verify', {
      body: { token: bogus, challengeId, response: fake },
    });
    expect(res.status).toBe(400);

    // A signup challenge for invite A cannot be spent with invite B's token.
    const a = await createInvite(opCookie, { displayName: 'A' });
    const b = await createInvite(opCookie, { displayName: 'B' });
    const optsA = await redeemOptions(a.token);
    const responseA = await new VirtualAuthenticator().register(
      optsA.body?.options as PublicKeyCredentialCreationOptionsJSON,
      ORIGIN,
    );
    const crossed = await call('POST', '/api/v1/invites/redeem/verify', {
      body: { token: b.token, challengeId: optsA.body?.challengeId, response: responseA },
    });
    expect(crossed.status).toBe(400);
    expect(await errorCode(crossed)).toBe('WEBAUTHN_VERIFICATION_FAILED');

    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM users WHERE status = 'active'").first(),
    ).toEqual({ n: 1 });
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM users WHERE status = 'invited'").first(),
    ).toEqual({ n: 2 });
    expect(usersBefore).toEqual({ n: 1 });
  });

  it('refuses a used invite', async () => {
    const { cookie } = await setupOperator();
    const invite = await createInvite(cookie, { displayName: 'Vera' });
    expect((await redeem(invite.token)).res.status).toBe(201);
    for (const path of ['/api/v1/invites/inspect', '/api/v1/invites/redeem/options']) {
      const res = await call('POST', path, { body: { token: invite.token } });
      expect(res.status).toBe(404);
      expect(await errorCode(res)).toBe('INVITE_INVALID');
    }
    const list = await json<{ items: { status: string }[] }>(
      await call('GET', '/api/v1/admin/invites', { cookie }),
    );
    expect(list.items[0]?.status).toBe('redeemed');
  });

  it('refuses a used invite even with a challenge issued before it was used', async () => {
    const { cookie } = await setupOperator();
    const invite = await createInvite(cookie, { displayName: 'Vera' });
    const early = await redeemOptions(invite.token);
    expect((await redeem(invite.token)).res.status).toBe(201);
    const response = await new VirtualAuthenticator().register(
      early.body?.options as PublicKeyCredentialCreationOptionsJSON,
      ORIGIN,
    );
    const res = await call('POST', '/api/v1/invites/redeem/verify', {
      body: { token: invite.token, challengeId: early.body?.challengeId, response },
    });
    expect(res.status).toBe(404);
    expect(
      await db
        .prepare('SELECT COUNT(*) AS n FROM passkey_credentials WHERE user_id = ?')
        .bind(invite.userId)
        .first(),
    ).toEqual({ n: 1 });
  });

  it('refuses an expired invite, including one that expires mid-ceremony', async () => {
    const { cookie } = await setupOperator();
    const invite = await createInvite(cookie, { displayName: 'Vera' });
    const opts = await redeemOptions(invite.token);
    await db
      .prepare('UPDATE invites SET expires_at = ? WHERE id = ?')
      .bind(Date.now() - 1, invite.id)
      .run();

    const res = await call('POST', '/api/v1/invites/redeem/options', {
      body: { token: invite.token },
    });
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('INVITE_INVALID');

    const response = await new VirtualAuthenticator().register(
      opts.body?.options as PublicKeyCredentialCreationOptionsJSON,
      ORIGIN,
    );
    const verify = await call('POST', '/api/v1/invites/redeem/verify', {
      body: { token: invite.token, challengeId: opts.body?.challengeId, response },
    });
    expect(verify.status).toBe(404);
    const list = await json<{ items: { status: string }[] }>(
      await call('GET', '/api/v1/admin/invites?status=expired', { cookie }),
    );
    expect(list.items).toHaveLength(1);
  });

  it('revoking deletes the invited user; a revoked invite is refused; a used one cannot be revoked', async () => {
    const { cookie } = await setupOperator();
    const invite = await createInvite(cookie, { displayName: 'Vera' });
    const opts = await redeemOptions(invite.token);
    const res = await call('DELETE', `/api/v1/admin/invites/${invite.id}`, { cookie });
    expect(res.status).toBe(204);
    expect(
      await db.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').bind(invite.userId).first(),
    ).toEqual({ n: 0 });
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'invite.revoke'")
        .first(),
    ).toEqual({ n: 1 });

    const again = await call('POST', '/api/v1/invites/redeem/options', {
      body: { token: invite.token },
    });
    expect(again.status).toBe(404);
    expect(await errorCode(again)).toBe('INVITE_INVALID');
    // The challenge issued before revocation cascaded away with the invite.
    const response = await new VirtualAuthenticator().register(
      opts.body?.options as PublicKeyCredentialCreationOptionsJSON,
      ORIGIN,
    );
    const verify = await call('POST', '/api/v1/invites/redeem/verify', {
      body: { token: invite.token, challengeId: opts.body?.challengeId, response },
    });
    expect(verify.status).toBe(400);

    expect((await call('DELETE', `/api/v1/admin/invites/${invite.id}`, { cookie })).status).toBe(
      404,
    );

    const used = await createInvite(cookie, { displayName: 'Uma' });
    await redeem(used.token);
    const refused = await call('DELETE', `/api/v1/admin/invites/${used.id}`, { cookie });
    expect(refused.status).toBe(409);
    expect(await errorCode(refused)).toBe('INVITE_ALREADY_REDEEMED');
  });

  it('the redeem batch guard rolls back when the invite was consumed concurrently', async () => {
    const { cookie } = await setupOperator();
    const invite = await createInvite(cookie, { displayName: 'Vera' });
    const now = Date.now();
    await redeemInviteStmt(db, invite.id, now).run();
    await expect(
      db.batch([
        redeemInviteStmt(db, invite.id, now + 1),
        guardChangedStmt(db),
        db.prepare("UPDATE users SET status = 'active' WHERE id = ?").bind(invite.userId),
      ]),
    ).rejects.toThrow(/NOT NULL|constraint/i);
    expect(
      await db.prepare('SELECT status FROM users WHERE id = ?').bind(invite.userId).first(),
    ).toEqual({ status: 'invited' });
  });
});

describe('FR-USR-001 / IR-006: passkey login', () => {
  it('login with a registered passkey yields a working session', async () => {
    const { auth, user } = await setupOperator();
    const res = await login(auth);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      user: { id: user.id, displayName: 'Olivia', role: 'operator' },
    });
    const me = await call('GET', '/api/v1/me', { cookie: sessionCookie(res) });
    expect(me.status).toBe(200);
    const pk = await db
      .prepare('SELECT sign_count, last_used_at FROM passkey_credentials')
      .first<{ sign_count: number; last_used_at: number }>();
    expect(pk?.sign_count).toBe(1);
    expect(pk?.last_used_at).toBeGreaterThan(0);
  });

  it('options are discoverable (no allowCredentials) with UV required', async () => {
    const { options } = await loginOptions();
    expect(options.allowCredentials ?? []).toEqual([]);
    expect(options.userVerification).toBe('required');
    expect(options.rpId).toBe('localhost');
  });

  it('refuses an unknown credential, a disabled user and a wrong origin with one 401', async () => {
    const { auth: opAuth } = await setupOperator();

    const stranger = new VirtualAuthenticator();
    await stranger.register(
      {
        challenge: 'x',
        rp: { id: 'localhost', name: 'x' },
        user: { id: 'eA', name: 'x', displayName: 'x' },
        pubKeyCredParams: [],
      },
      ORIGIN,
    );
    const unknown = await login(stranger);
    expect(unknown.status).toBe(401);
    expect(await errorCode(unknown)).toBe('WEBAUTHN_VERIFICATION_FAILED');

    const wrongOrigin = await login(opAuth, 0, 'https://evil.example');
    expect(wrongOrigin.status).toBe(401);

    await db.prepare("UPDATE users SET status = 'disabled'").run();
    const disabled = await login(opAuth);
    expect(disabled.status).toBe(401);
    expect(await errorCode(disabled)).toBe('WEBAUTHN_VERIFICATION_FAILED');
    expect(disabled.headers.get('set-cookie')).toBeNull();
  });

  it('challenges are single-use and expire', async () => {
    const { auth } = await setupOperator();
    const { challengeId, options } = await loginOptions();
    const response = await auth.authenticate(options, ORIGIN);
    const first = await call('POST', '/api/v1/auth/login/verify', {
      body: { challengeId, response },
    });
    expect(first.status).toBe(200);
    const replay = await call('POST', '/api/v1/auth/login/verify', {
      body: { challengeId, response },
    });
    expect(replay.status).toBe(401);

    const fresh = await loginOptions();
    await db
      .prepare('UPDATE webauthn_challenges SET expires_at = ?')
      .bind(Date.now() - 1)
      .run();
    const late = await call('POST', '/api/v1/auth/login/verify', {
      body: {
        challengeId: fresh.challengeId,
        response: await auth.authenticate(fresh.options, ORIGIN),
      },
    });
    expect(late.status).toBe(401);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM webauthn_challenges').first()).toEqual({
      n: 0,
    });
  });

  it('a challenge for one purpose cannot be used for another', async () => {
    const { cookie } = await setupOperator();
    const { challengeId, options } = await loginOptions();
    const reg = await new VirtualAuthenticator().register(
      {
        challenge: options.challenge,
        rp: { id: 'localhost', name: 'x' },
        user: { id: 'eA', name: 'x', displayName: 'x' },
        pubKeyCredParams: [],
      },
      ORIGIN,
    );
    const res = await call('POST', '/api/v1/me/passkeys/verify', {
      cookie,
      body: { challengeId, response: reg },
    });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('WEBAUTHN_VERIFICATION_FAILED');
    expect(await db.prepare('SELECT COUNT(*) AS n FROM passkey_credentials').first()).toEqual({
      n: 1,
    });
  });

  it('rejects a tampered signature and a sign-count regression', async () => {
    const { auth } = await setupOperator();
    const { challengeId, options } = await loginOptions();
    const response = await auth.authenticate(options, ORIGIN);
    const sig = response.response.signature;
    const tampered = {
      ...response,
      response: {
        ...response.response,
        signature: sig.slice(0, -4) + (sig.endsWith('AAAA') ? 'BBBB' : 'AAAA'),
      },
    };
    expect(
      (
        await call('POST', '/api/v1/auth/login/verify', {
          body: { challengeId, response: tampered },
        })
      ).status,
    ).toBe(401);

    await db.prepare('UPDATE passkey_credentials SET sign_count = 1000').run();
    expect((await login(auth)).status).toBe(401);
  });
});

describe('FR-USR-006: own passkeys', () => {
  it('lists, adds and removes passkeys; the last one cannot be removed', async () => {
    const { auth, cookie } = await setupOperator();
    const list = await json<{ id: string }[]>(await call('GET', '/api/v1/me/passkeys', { cookie }));
    expect(list).toHaveLength(1);
    const firstId = list[0]?.id ?? '';

    const last = await call('DELETE', `/api/v1/me/passkeys/${firstId}`, { cookie });
    expect(last.status).toBe(409);
    expect(await errorCode(last)).toBe('LAST_PASSKEY');

    const second = new VirtualAuthenticator();
    const added = await addPasskey(cookie, second);
    expect(added.status).toBe(201);
    const { passkey } = await json<{ passkey: { id: string; label: string } }>(added);
    expect(passkey.label).toBe('Laptop');
    expect(
      await json<unknown[]>(await call('GET', '/api/v1/me/passkeys', { cookie })),
    ).toHaveLength(2);

    // Sign in with the new one, then remove the original: its sessions end, the new one works.
    const newCookie = sessionCookie(await login(second));
    expect(
      (await call('DELETE', `/api/v1/me/passkeys/${firstId}`, { cookie: newCookie })).status,
    ).toBe(204);
    expect((await call('GET', '/api/v1/me', { cookie })).status).toBe(401);
    expect((await call('GET', '/api/v1/me', { cookie: newCookie })).status).toBe(200);
    expect((await login(auth)).status).toBe(401);

    const nowLast = await call('DELETE', `/api/v1/me/passkeys/${passkey.id}`, {
      cookie: newCookie,
    });
    expect(nowLast.status).toBe(409);
  });

  it("cannot see or remove another user's passkey (404)", async () => {
    const { cookie: opCookie } = await setupOperator();
    const viewer = await viewerSession(opCookie);
    await addPasskey(viewer.cookie, new VirtualAuthenticator());
    const opPasskeys = await json<{ id: string }[]>(
      await call('GET', '/api/v1/me/passkeys', { cookie: opCookie }),
    );
    const res = await call('DELETE', `/api/v1/me/passkeys/${opPasskeys[0]?.id ?? ''}`, {
      cookie: viewer.cookie,
    });
    expect(res.status).toBe(404);
  });

  it('an add_passkey challenge is bound to its user', async () => {
    const { cookie: opCookie } = await setupOperator();
    const viewer = await viewerSession(opCookie);
    const optRes = await call('POST', '/api/v1/me/passkeys/options', { cookie: opCookie });
    const { challengeId, options } = await json<{
      challengeId: string;
      options: PublicKeyCredentialCreationOptionsJSON;
    }>(optRes);
    const response = await new VirtualAuthenticator().register(options, ORIGIN);
    const res = await call('POST', '/api/v1/me/passkeys/verify', {
      cookie: viewer.cookie,
      body: { challengeId, response },
    });
    expect(res.status).toBe(400);
  });

  it('rejects a registration for the wrong RP ID or origin', async () => {
    const { cookie } = await setupOperator();
    for (const [rpId, origin] of [
      ['evil.example', ORIGIN],
      [undefined, 'https://evil.example'],
    ] as const) {
      const optRes = await call('POST', '/api/v1/me/passkeys/options', { cookie });
      const { challengeId, options } = await json<{
        challengeId: string;
        options: PublicKeyCredentialCreationOptionsJSON;
      }>(optRes);
      const response = await new VirtualAuthenticator().register(
        options,
        origin,
        rpId ? { rpId } : {},
      );
      const res = await call('POST', '/api/v1/me/passkeys/verify', {
        cookie,
        body: { challengeId, response },
      });
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe('WEBAUTHN_VERIFICATION_FAILED');
    }
  });
});

describe('NFR-SEC-004: per-IP rate limit on setup, redeem and login', () => {
  it.each([
    ['GET', '/api/v1/setup'],
    ['POST', '/api/v1/setup/options'],
    ['POST', '/api/v1/setup/verify'],
    ['POST', '/api/v1/invites/inspect'],
    ['POST', '/api/v1/invites/redeem/options'],
    ['POST', '/api/v1/invites/redeem/verify'],
    ['POST', '/api/v1/auth/login/options'],
    ['POST', '/api/v1/auth/login/verify'],
  ])(
    '%s %s returns 429 RATE_LIMITED with Retry-After when over the limit',
    async (method, path) => {
      limiter.allow = false;
      const res = await call(method, path, {
        ...(method === 'POST' ? { body: {} } : {}),
        headers: { 'cf-connecting-ip': '203.0.113.7' },
      });
      expect(res.status).toBe(429);
      expect(res.headers.get('retry-after')).toBe('60');
      expect(await errorCode(res)).toBe('RATE_LIMITED');
      expect(limiter.keys).toEqual(['auth:203.0.113.7']);
    },
  );

  it('does not limit signed-in routes or health', async () => {
    const { cookie } = await setupOperator();
    limiter.allow = false;
    limiter.keys = [];
    expect((await call('GET', '/api/v1/me', { cookie })).status).toBe(200);
    expect((await call('GET', '/api/v1/health')).status).toBe(200);
    expect(limiter.keys).toEqual([]);
  });

  it('the real RL_AUTH binding is wired (10 per 60 s)', async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) {
      const res = await call('POST', '/api/v1/auth/login/options', {
        headers: { 'cf-connecting-ip': '198.51.100.9' },
        env: { RL_AUTH: env.RL_AUTH },
      });
      last = res.status;
    }
    expect(last).toBe(429);
  });
});

describe('TDD §4: config fails closed', () => {
  it('refuses to serve with a non-https APP_ORIGIN outside local, except health', async () => {
    const prodEnv = {
      ENVIRONMENT: 'production' as const,
      APP_ORIGIN: 'http://cinewren.example.org',
    };
    expect((await call('GET', '/api/v1/me', { env: prodEnv })).status).toBe(500);
    expect((await call('GET', '/api/v1/health', { env: prodEnv })).status).toBe(200);
  });
});

describe('T5.8 SR-03: sweepAuth removes expired auth artefacts (LLD-TOKEN)', () => {
  const count = async (sql: string): Promise<number> =>
    (await db.prepare(`SELECT COUNT(*) AS n FROM ${sql}`).first<{ n: number }>())?.n ?? -1;

  it('deletes expired challenges, sessions and expired unredeemed signup invitees only', async () => {
    const { cookie } = await setupOperator();
    const live = await viewerSession(cookie, 'Vera');
    const open = await createInvite(cookie, { displayName: 'Open', role: 'viewer' });
    const stale = await createInvite(cookie, { displayName: 'Stale', role: 'viewer' });
    await loginOptions(); // one live challenge
    const now = Date.now();
    await db.batch([
      db
        .prepare(
          "INSERT INTO webauthn_challenges (id, challenge, purpose, expires_at) VALUES ('old', 'c', 'login', ?)",
        )
        .bind(now - 1),
      db
        .prepare(
          `INSERT INTO sessions (id_hash, user_id, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
           VALUES ('dead-idle', ?1, 0, 0, ?2, ?3), ('dead-abs', ?1, 0, 0, ?3, ?2)`,
        )
        .bind(live.invite.userId, now - 1, now + 86_400_000),
      db.prepare('UPDATE invites SET expires_at = ? WHERE id = ?').bind(now - 1, stale.id),
    ]);

    const result = await sweepAuth(db, now);
    expect(result.challenges).toBe(1);
    expect(result.sessions).toBe(2);
    expect(result.expiredInvitees).toBeGreaterThanOrEqual(1);
    expect(await count("webauthn_challenges WHERE id = 'old'")).toBe(0);
    expect(await count('webauthn_challenges')).toBe(1);
    expect(await count("sessions WHERE id_hash IN ('dead-idle','dead-abs')")).toBe(0);
    expect((await call('GET', '/api/v1/me', { cookie: live.cookie })).status).toBe(200);
    // The stale invitee and their invite are gone; the open invite and its user are kept.
    expect(await count(`users WHERE id = '${stale.userId}'`)).toBe(0);
    expect(await count(`invites WHERE id = '${stale.id}'`)).toBe(0);
    expect(await count(`users WHERE id = '${open.userId}' AND status = 'invited'`)).toBe(1);
    // A second run finds nothing.
    expect(await sweepAuth(db, now)).toEqual({ challenges: 0, sessions: 0, expiredInvitees: 0 });
  });
});
