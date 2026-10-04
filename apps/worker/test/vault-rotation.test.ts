// SR-07: master-key rotation (DR-002, LLD-TOKEN "Rotation", WF-11): the operator endpoints, the
// `reencrypt` queue job, and the status that says when an old key is safe to remove.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import type { JobMessage } from '../src/sync/deps';
import { handleJob } from '../src/sync/jobs';
import { createLogger } from '../src/platform/logger';
import { runRotationStep, vaultStatus } from '../src/vault/rotation';
import { decrypt, encrypt, loadKeyring, type Keyring } from '../src/vault/vault';
import { createApp } from '../src/api/app';
import {
  call,
  createInvite,
  errorCode,
  json,
  redeem,
  resetDb,
  sessionCookie,
  setupOperator,
} from './auth-harness';
import { makeHarness } from './sync/harness';

const db = env.DB;
const app = createApp();
const key = (byte: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)));
const keysJson = (versions: number[]) =>
  JSON.stringify(Object.fromEntries(versions.map((v) => [String(v), key(v)])));
const ring = (versions: number[], current: number): Promise<Keyring> =>
  loadKeyring({ CREDENTIAL_KEYS: keysJson(versions), CREDENTIAL_KEY_CURRENT: String(current) });

const SECRET = JSON.stringify({ kind: 'password', username: 'svc', password: 'hunter2-plain' });
const TOKEN = 'cached-service-token-plain';
const SESSION_CRED = JSON.stringify({ token: 'session-token-plain' });
const IDEM_BODY = JSON.stringify({ streamUrl: 'https://o.example/s?ApiKey=idem-plain' });

let cookie = '';
let userId = '';
const queue: JobMessage[] = [];
const send = (m: JobMessage) => {
  queue.push(m);
  return Promise.resolve();
};
const fakeQueue = { send } as unknown as Queue;
const api = (method: string, path: string, overrides: Partial<typeof env> = {}) =>
  call(method, path, {
    cookie,
    app,
    env: { JOBS_QUEUE: fakeQueue, CREDENTIAL_KEY_CURRENT: '2', ...overrides },
  });

async function seedServer(id: string, keyring: Keyring, withToken = false) {
  const now = Date.now();
  const secret = await encrypt(keyring, 'server_secret', id, SECRET);
  const token = withToken ? await encrypt(keyring, 'service_token', id, TOKEN) : null;
  await db.batch([
    db
      .prepare(
        `INSERT INTO servers (id, type, name, base_url, origin_server_id, status, created_at, updated_at)
         VALUES (?, 'jellyfin', ?, ?, ?, 'active', ?, ?)`,
      )
      .bind(id, id, `https://${id}.example.test`, `origin-${id}`, now, now),
    db
      .prepare(
        `INSERT INTO server_credentials (server_id, key_version, secret_envelope, service_token_envelope, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(id, secret.keyVersion, secret.envelope, token?.envelope ?? null, now),
  ]);
}

async function seedSession(id: string, keyring: Keyring) {
  const sealed = await encrypt(keyring, 'session_cred', id, SESSION_CRED);
  await db
    .prepare(
      `INSERT INTO playback_sessions (id, user_id, mode, status, credential_envelope, authorized_at, auth_expires_at)
       VALUES (?, ?, 'direct_play', 'started', ?, 1, 2)`,
    )
    .bind(id, userId, sealed.envelope)
    .run();
}

async function seedIdempotency(key: string, keyring: Keyring) {
  const sealed = await encrypt(keyring, 'session_cred', `idem|${userId}|${key}`, IDEM_BODY);
  await db
    .prepare(
      `INSERT INTO idempotency_keys (user_id, key, route, request_hash, status_code, response, created_at)
       VALUES (?, ?, 'POST /play', 'h', 201, ?, 1)`,
    )
    .bind(userId, key, sealed.envelope)
    .run();
}

const column = async (sql: string) =>
  (await db.prepare(sql).all<{ v: string | null }>()).results.map((r) => r.v);

/** Runs queued `reencrypt` messages like the real consumer, with the given keys. */
async function drain(keyring: Keyring, lines: string[] = []) {
  const h = makeHarness();
  h.deps.keyring = () => Promise.resolve(keyring);
  h.deps.logger = createLogger({}, (l) => lines.push(l));
  let handled = 0;
  while (queue.length > 0) {
    if (++handled > 50) throw new Error('queue did not drain');
    const job = queue.shift() as JobMessage;
    h.deps.queue = { send };
    await handleJob(h.deps, job, h.deps.logger);
  }
  return handled;
}

beforeEach(async () => {
  await resetDb();
  await db.batch([db.prepare('DELETE FROM idempotency_keys')]);
  queue.length = 0;
  ({
    cookie,
    user: { id: userId },
  } = await setupOperator());
});

describe('POST /admin/vault/rotate and the reencrypt job (SR-07)', () => {
  it('re-encrypts every sealed column and status reports complete', async () => {
    const v1 = await ring([1, 2], 1);
    await seedServer('a', v1, true);
    await seedServer('b', v1);
    await seedSession('ps1', v1);
    await seedIdempotency('k1', v1);
    // An unsealed idempotency response is not an envelope and must be left alone.
    await db
      .prepare(
        `INSERT INTO idempotency_keys (user_id, key, route, request_hash, status_code, response, created_at)
         VALUES (?, 'plain', 'POST /x', 'h', 200, '{"ok":true}', 1)`,
      )
      .bind(userId)
      .run();

    const before = await api('GET', '/api/v1/admin/vault/status');
    expect(await json(before)).toMatchObject({ complete: false, pendingRows: 4 });

    const res = await api('POST', '/api/v1/admin/vault/rotate');
    expect(res.status).toBe(202);
    expect(await json(res)).toEqual({ currentKeyVersion: 2, pendingRows: 4, enqueued: true });
    await drain(await ring([1, 2], 2));

    const only2 = await ring([2], 2);
    const servers = await db
      .prepare(
        'SELECT server_id, key_version, secret_envelope, service_token_envelope FROM server_credentials',
      )
      .all<{
        server_id: string;
        key_version: number;
        secret_envelope: string;
        service_token_envelope: string | null;
      }>();
    expect(servers.results).toHaveLength(2);
    for (const r of servers.results) {
      expect(r.key_version).toBe(2);
      expect(await decrypt(only2, 'server_secret', r.server_id, r.secret_envelope)).toBe(SECRET);
      if (r.server_id === 'a') {
        expect(await decrypt(only2, 'service_token', 'a', r.service_token_envelope ?? '')).toBe(
          TOKEN,
        );
      }
    }
    const [sessionEnv] = await column('SELECT credential_envelope AS v FROM playback_sessions');
    expect(await decrypt(only2, 'session_cred', 'ps1', sessionEnv ?? '')).toBe(SESSION_CRED);
    const [idemEnv] = await column("SELECT response AS v FROM idempotency_keys WHERE key = 'k1'");
    expect(await decrypt(only2, 'session_cred', `idem|${userId}|k1`, idemEnv ?? '')).toBe(
      IDEM_BODY,
    );
    expect(await column("SELECT response AS v FROM idempotency_keys WHERE key = 'plain'")).toEqual([
      '{"ok":true}',
    ]);

    const status = await json(await api('GET', '/api/v1/admin/vault/status'));
    expect(status).toMatchObject({
      currentKeyVersion: 2,
      complete: true,
      pendingRows: 0,
      missingKeyVersions: [],
      removableKeyVersions: [1],
      rowsByKeyVersion: [{ keyVersion: 2, rows: 4, keyConfigured: true }],
    });
  });

  it('is resumable: an interrupted job leaves the rest for the next run', async () => {
    const v1 = await ring([1, 2], 1);
    for (const id of ['a', 'b', 'c']) await seedServer(id, v1);
    await seedSession('ps1', v1);
    const v2 = await ring([1, 2], 2);

    // One row per batch, one batch per message: the job stops after the first and is "lost".
    const first = await runRotationStep(db, v2, undefined, { batchSize: 1, maxBatches: 1 });
    expect(first.reencrypted).toBe(1);
    expect(first.next?.table).toBe('server_credentials');
    expect(first.next?.after).toBeGreaterThan(0);
    expect((await vaultStatus(db, v2)).pendingRows).toBe(3);

    // A fresh job from the beginning (the continuation never arrived) finishes the work.
    const rest = await runRotationStep(db, v2);
    expect(rest.reencrypted).toBe(3);
    expect(rest.next).toBeNull();
    expect((await vaultStatus(db, v2)).complete).toBe(true);
  });

  it('continues across queue messages through the handler', async () => {
    const v1 = await ring([1, 2], 1);
    for (let i = 0; i < 3; i++) await seedServer(`s${i}`, v1);
    await seedSession('ps1', v1);
    await seedIdempotency('k1', v1);
    await api('POST', '/api/v1/admin/vault/rotate');
    expect(queue).toEqual([{ kind: 'reencrypt' }]);
    // The handler schedules its own continuation until every table is walked.
    const handled = await drain(await ring([1, 2], 2));
    expect(handled).toBeGreaterThanOrEqual(1);
    expect((await vaultStatus(db, await ring([1, 2], 2))).complete).toBe(true);
  });

  it('is idempotent: a second run changes nothing and queues nothing', async () => {
    const v1 = await ring([1, 2], 1);
    await seedServer('a', v1, true);
    await seedSession('ps1', v1);
    await api('POST', '/api/v1/admin/vault/rotate');
    await drain(await ring([1, 2], 2));
    const snapshot = await column(
      `SELECT secret_envelope AS v FROM server_credentials UNION ALL
       SELECT credential_envelope FROM playback_sessions`,
    );

    const again = await api('POST', '/api/v1/admin/vault/rotate');
    expect(await json(again)).toEqual({ currentKeyVersion: 2, pendingRows: 0, enqueued: false });
    expect(queue).toEqual([]);
    // Even a stray job re-run is a no-op.
    queue.push({ kind: 'reencrypt' });
    await drain(await ring([1, 2], 2));
    expect(
      await column(
        `SELECT secret_envelope AS v FROM server_credentials UNION ALL
         SELECT credential_envelope FROM playback_sessions`,
      ),
    ).toEqual(snapshot);
  });

  it('keeps reads working mid-rotation with the old and the new key present', async () => {
    const v1 = await ring([1, 2], 1);
    for (const id of ['a', 'b', 'c']) await seedServer(id, v1);
    const v2 = await ring([1, 2], 2);
    await runRotationStep(db, v2, undefined, { batchSize: 1, maxBatches: 1 }); // partly rotated
    const rows = await db
      .prepare('SELECT server_id, key_version, secret_envelope FROM server_credentials')
      .all<{ server_id: string; key_version: number; secret_envelope: string }>();
    expect(new Set(rows.results.map((r) => r.key_version))).toEqual(new Set([1, 2]));
    for (const r of rows.results) {
      expect(await decrypt(v2, 'server_secret', r.server_id, r.secret_envelope)).toBe(SECRET);
    }
    expect(await json(await api('GET', '/api/v1/admin/vault/status'))).toMatchObject({
      complete: false,
      pendingRows: 2,
      missingKeyVersions: [],
    });
  });

  it('status detects an old key removed before rotation completed', async () => {
    const v1 = await ring([1, 2], 1);
    await seedServer('a', v1);
    await seedSession('ps1', v1);
    const res = await api('GET', '/api/v1/admin/vault/status', {
      CREDENTIAL_KEYS: JSON.stringify({ '2': key(2) }),
    });
    expect(await json(res)).toMatchObject({
      complete: false,
      pendingRows: 2,
      missingKeyVersions: [1],
      removableKeyVersions: [],
      configuredKeyVersions: [2],
      rowsByKeyVersion: [{ keyVersion: 1, rows: 2, keyConfigured: false }],
    });

    // The job cannot rotate those rows, reports them as failed once and does not loop.
    const only2 = await ring([2], 2);
    const step = await runRotationStep(db, only2);
    expect(step).toMatchObject({ reencrypted: 0, failed: 2, next: null });
    expect((await vaultStatus(db, only2)).pendingRows).toBe(2);
  });

  it('refuses when CREDENTIAL_KEY_CURRENT is not in CREDENTIAL_KEYS', async () => {
    await seedServer('a', await ring([1, 2], 1));
    const res = await api('POST', '/api/v1/admin/vault/rotate', { CREDENTIAL_KEY_CURRENT: '9' });
    expect(res.status).toBe(500);
    expect(await errorCode(res)).toBe('CREDENTIAL_KEY_MISSING');
    expect(queue).toEqual([]);
    expect(await column("SELECT action AS v FROM audit_log WHERE action = 'vault.rotate'")).toEqual(
      [],
    );
  });

  it('returns and logs no key material, plaintext or ciphertext', async () => {
    const v1 = await ring([1, 2], 1);
    await seedServer('a', v1, true);
    await seedSession('ps1', v1);
    await seedIdempotency('k1', v1);
    const lines: string[] = [];
    const bodies = [
      await (await api('GET', '/api/v1/admin/vault/status')).text(),
      await (await api('POST', '/api/v1/admin/vault/rotate')).text(),
    ];
    await drain(await ring([1, 2], 2), lines);
    bodies.push(await (await api('GET', '/api/v1/admin/vault/status')).text());
    const audit = await column("SELECT details AS v FROM audit_log WHERE action = 'vault.rotate'");
    const everything = [...bodies, ...lines, ...audit].join('\n');
    expect(lines.length).toBeGreaterThan(0);
    for (const secret of [
      key(1),
      key(2),
      'hunter2-plain',
      TOKEN,
      'session-token-plain',
      'idem-plain',
      'cw1.',
    ]) {
      expect(everything).not.toContain(secret);
    }
  });

  it('is operator-only', async () => {
    const invite = await createInvite(cookie, { displayName: 'Vera' });
    const { res } = await redeem(invite.token);
    const viewer = sessionCookie(res);
    for (const [method, path] of [
      ['GET', '/api/v1/admin/vault/status'],
      ['POST', '/api/v1/admin/vault/rotate'],
    ] as const) {
      const asViewer = await call(method, path, { cookie: viewer, app });
      expect(asViewer.status, `${method} ${path}`).toBe(403);
      expect(await errorCode(asViewer)).toBe('FORBIDDEN');
      expect((await call(method, path, { app })).status).toBe(401);
    }
    expect(queue).toEqual([]);
  });

  it('writes exactly one vault.rotate audit row per call, with counts only', async () => {
    await seedServer('a', await ring([1, 2], 1));
    await api('POST', '/api/v1/admin/vault/rotate');
    const rows = await db
      .prepare(
        "SELECT actor_user_id, target_type, details FROM audit_log WHERE action = 'vault.rotate'",
      )
      .all<{ actor_user_id: string; target_type: string; details: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]?.actor_user_id).toBe(userId);
    expect(JSON.parse(rows.results[0]?.details ?? '{}')).toEqual({
      currentKeyVersion: 2,
      pendingRows: 1,
      enqueued: true,
    });
  });
});
