// T2.1 / T2.7: operator sync API (FR-SYNC-002, FR-SYNC-006, FR-OPS-003) through the real app and
// local D1: trigger refuses while a run is active, run history pages, next scheduled run.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SyncRunsPage } from '@cinewren/shared';
import { createApp } from '../src/api/app';
import { call, errorCode, json, resetDb, setupOperator } from './auth-harness';
import { seedServer } from './sync/harness';

const db = env.DB;
const app = createApp();
let cookie = '';
const api = (method: string, path: string, body?: unknown) =>
  call(method, path, { cookie, app, ...(body !== undefined ? { body } : {}) });

const runs = async (serverId: string) =>
  (
    await db
      .prepare('SELECT id, type, trigger, status FROM sync_runs WHERE server_id = ? ORDER BY id')
      .bind(serverId)
      .all<{ id: string; type: string; trigger: string; status: string }>()
  ).results;

beforeEach(async () => {
  await resetDb();
  ({ cookie } = await setupOperator());
  await seedServer({ id: 'srv1' });
});

describe('POST /admin/servers/{id}/sync (FR-SYNC-002)', () => {
  it('requires an operator session', async () => {
    const post = await call('POST', '/api/v1/admin/servers/srv1/sync', {
      app,
      body: { type: 'full' },
    });
    expect(post.status).toBe(401);
    const get = await call('GET', '/api/v1/admin/servers/srv1/sync-runs', { app });
    expect(get.status).toBe(401);
  });

  it('queues a manual full run and audits it', async () => {
    const res = await api('POST', '/api/v1/admin/servers/srv1/sync', { type: 'full' });
    expect(res.status).toBe(202);
    const { runId } = await json<{ runId: string }>(res);
    expect(await runs('srv1')).toEqual([
      { id: runId, type: 'full', trigger: 'manual', status: 'queued' },
    ]);
    const audit = await db
      .prepare(`SELECT target_id FROM audit_log WHERE action = 'sync.trigger'`)
      .first<{ target_id: string }>();
    expect(audit?.target_id).toBe('srv1');
  });

  it('turns an incremental request into a full one when nothing has succeeded yet', async () => {
    await api('POST', '/api/v1/admin/servers/srv1/sync', { type: 'incremental' });
    expect((await runs('srv1'))[0]?.type).toBe('full');
  });

  it('refuses with 409 SYNC_IN_PROGRESS while a run is queued or running', async () => {
    await api('POST', '/api/v1/admin/servers/srv1/sync', { type: 'full' });
    const second = await api('POST', '/api/v1/admin/servers/srv1/sync', { type: 'full' });
    expect(second.status).toBe(409);
    expect(await errorCode(second)).toBe('SYNC_IN_PROGRESS');
    await db.prepare(`UPDATE sync_runs SET status = 'running'`).run();
    const third = await api('POST', '/api/v1/admin/servers/srv1/sync', { type: 'incremental' });
    expect(third.status).toBe(409);
    expect(await runs('srv1')).toHaveLength(1);
  });

  it('allows a new run once the previous one finished', async () => {
    await api('POST', '/api/v1/admin/servers/srv1/sync', { type: 'full' });
    await db.prepare(`UPDATE sync_runs SET status = 'succeeded'`).run();
    const res = await api('POST', '/api/v1/admin/servers/srv1/sync', { type: 'full' });
    expect(res.status).toBe(202);
  });

  it('refuses a disabled server with 409 SERVER_DISABLED', async () => {
    await db.prepare(`UPDATE servers SET status = 'disabled'`).run();
    const res = await api('POST', '/api/v1/admin/servers/srv1/sync', { type: 'full' });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('SERVER_DISABLED');
    expect(await runs('srv1')).toHaveLength(0);
  });

  it('answers 404 for an unknown server and 400 for a bad type', async () => {
    const missing = await api('POST', '/api/v1/admin/servers/nope/sync', { type: 'full' });
    expect(missing.status).toBe(404);
    const bad = await api('POST', '/api/v1/admin/servers/srv1/sync', { type: 'sideways' });
    expect(bad.status).toBe(400);
    expect(await errorCode(bad)).toBe('VALIDATION_FAILED');
  });
});

describe('GET /admin/servers/{id}/sync-runs (FR-SYNC-006, FR-OPS-003)', () => {
  const insert = (id: string, queuedAt: number, status: string, summary: string | null = null) =>
    db
      .prepare(
        `INSERT INTO sync_runs (id, server_id, type, trigger, status, added, errors, error_summary, queued_at, started_at, ended_at)
         VALUES (?, 'srv1', 'full', 'schedule', ?, 3, ?, ?, ?, ?, ?)`,
      )
      .bind(id, status, summary ? 1 : 0, summary, queuedAt, queuedAt + 1, queuedAt + 2)
      .run();

  it('lists newest first and pages with a sealed cursor', async () => {
    await insert('r1', 1000, 'succeeded');
    await insert('r2', 2000, 'failed', 'The origin refused the credentials.');
    await insert('r3', 3000, 'succeeded');
    const first = await json<SyncRunsPage>(
      await api('GET', '/api/v1/admin/servers/srv1/sync-runs?limit=2'),
    );
    expect(first.items.map((r) => r.id)).toEqual(['r3', 'r2']);
    expect(first.items[1]).toMatchObject({
      status: 'failed',
      errors: 1,
      errorSummary: 'The origin refused the credentials.',
      trigger: 'schedule',
    });
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await json<SyncRunsPage>(
      await api(
        'GET',
        `/api/v1/admin/servers/srv1/sync-runs?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
      ),
    );
    expect(second.items.map((r) => r.id)).toEqual(['r1']);
    expect(second.nextCursor).toBeNull();
  });

  it('rejects a forged cursor and an unknown server', async () => {
    const forged = await api('GET', '/api/v1/admin/servers/srv1/sync-runs?cursor=forged');
    expect(forged.status).toBe(400);
    const missing = await api('GET', '/api/v1/admin/servers/nope/sync-runs');
    expect(missing.status).toBe(404);
  });

  it('reports the next scheduled run, and none for a disabled server', async () => {
    const page = await json<SyncRunsPage>(await api('GET', '/api/v1/admin/servers/srv1/sync-runs'));
    expect(page.items).toEqual([]);
    expect(page.nextScheduled).toBeGreaterThanOrEqual(Date.now() - 1000);
    expect(page.nextScheduled).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
    await db.prepare(`UPDATE servers SET status = 'disabled'`).run();
    const off = await json<SyncRunsPage>(await api('GET', '/api/v1/admin/servers/srv1/sync-runs'));
    expect(off.nextScheduled).toBeNull();
  });
});
