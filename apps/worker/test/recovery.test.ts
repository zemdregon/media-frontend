/**
 * Last-operator CLI recovery (FR-USR-007, ADR-0014 §4): the SQL that `scripts/recover-operator.mjs`
 * sends to `wrangler d1 execute`, run against local D1 and redeemed through the real API.
 */
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ACTIVE_OPERATORS_SQL,
  findOperatorSql,
  planRecovery,
  REENROLL_TTL_MS,
} from '@cinewren/shared';
import { call, errorCode, json, login, redeem, resetDb, setupOperator } from './auth-harness';
import { VirtualAuthenticator } from './virtual-authenticator';

const db = env.DB;
const ORIGIN = 'https://cinewren.example.workers.dev';

/** Runs the plan exactly as the CLI does: the rendered SQL, statement by statement. */
async function run(sql: string[]) {
  for (const s of sql) await db.exec(s);
}
const tokenOf = (link: string) => new URL(link).hash.replace(/^#t=/, '');

async function count(where: string, ...binds: unknown[]): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM ${where}`)
    .bind(...binds)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

beforeEach(resetDb);

describe('operator recovery link (FR-USR-007)', () => {
  it('lists and finds active operators', async () => {
    const op = await setupOperator(new VirtualAuthenticator(), 'Olivia');
    const all = await db.prepare(ACTIVE_OPERATORS_SQL).all<{ id: string }>();
    expect(all.results.map((r) => r.id)).toEqual([op.user.id]);
    for (const q of [op.user.id, 'olivia', "x' OR '1'='1"]) {
      const hit = await db.prepare(findOperatorSql(q)).all<{ id: string }>();
      expect(hit.results.map((r) => r.id)).toEqual(q.includes("'") ? [] : [op.user.id]);
    }
  });

  it('adds a passkey to the operator through the real redeem API, once, and audits it', async () => {
    const op = await setupOperator(new VirtualAuthenticator(), 'Olivia');
    const plan = await planRecovery({ userId: op.user.id, appOrigin: `${ORIGIN}/` });
    await run(plan.sql);

    expect(plan.link).toMatch(
      /^https:\/\/cinewren\.example\.workers\.dev\/invite#t=[A-Za-z0-9_-]{43}$/,
    );
    expect(plan.expiresAt - Date.now()).toBeGreaterThan(REENROLL_TTL_MS - 5_000);
    const token = tokenOf(plan.link);

    const inspect = await call('POST', '/api/v1/invites/inspect', { body: { token } });
    expect(await json(inspect)).toMatchObject({
      kind: 'reenroll',
      displayName: 'Olivia',
      role: 'operator',
    });

    const fresh = new VirtualAuthenticator();
    const done = await redeem(token, fresh);
    expect(done.res.status).toBe(201);
    expect(await count('passkey_credentials WHERE user_id = ?', op.user.id)).toBe(2);
    expect((await login(fresh)).status).toBe(200);
    expect((await login(op.auth)).status).toBe(200);

    // Single use.
    const again = await call('POST', '/api/v1/invites/redeem/options', { body: { token } });
    expect(again.status).toBe(404);
    expect(await errorCode(again)).toBe('INVITE_INVALID');

    // Audit row: actor "cli" (no user), and neither the token nor anything secret is stored.
    const audit = await db
      .prepare(
        "SELECT actor_user_id, target_id, details FROM audit_log WHERE action = 'user.recovery_link'",
      )
      .all<{ actor_user_id: string | null; target_id: string; details: string }>();
    expect(audit.results).toHaveLength(1);
    expect(audit.results[0]).toMatchObject({ actor_user_id: null, target_id: op.user.id });
    expect(JSON.parse(audit.results[0]?.details ?? '')).toEqual({
      actor: 'cli',
      inviteId: plan.inviteId,
    });
    const invite = await db
      .prepare('SELECT kind, created_by, token_hash FROM invites WHERE id = ?')
      .bind(plan.inviteId)
      .first<{ kind: string; created_by: string | null; token_hash: string }>();
    expect(invite).toMatchObject({ kind: 'reenroll', created_by: null });
    expect(invite?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    const dump =
      JSON.stringify(await db.prepare('SELECT * FROM invites').all()) +
      JSON.stringify(await db.prepare('SELECT * FROM audit_log').all()) +
      plan.sql.join('\n');
    expect(dump).not.toContain(token);
  });

  it('expires after 24 hours and the newest link replaces earlier ones', async () => {
    const op = await setupOperator(new VirtualAuthenticator(), 'Olivia');
    const first = await planRecovery({ userId: op.user.id, appOrigin: ORIGIN });
    await run(first.sql);
    const second = await planRecovery({ userId: op.user.id, appOrigin: ORIGIN });
    await run(second.sql);
    const opts = (t: string) =>
      call('POST', '/api/v1/invites/redeem/options', { body: { token: t } });
    expect((await opts(tokenOf(first.link))).status).toBe(404);

    await db
      .prepare('UPDATE invites SET expires_at = ? WHERE id = ?')
      .bind(Date.now() - 1, second.inviteId)
      .run();
    const res = await opts(tokenOf(second.link));
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('INVITE_INVALID');
    expect(await count('passkey_credentials WHERE user_id = ?', op.user.id)).toBe(1);
  });
});
