// T4.2: registering a Plex server (FR-SRV-002, ADR-0008, owner decision 2026-10-04) through the
// real app and local D1. The origin is the recorded Plex 1.43.4 exchanges behind a fixture-backed
// fake `fetch`. The credential is the token of a restricted managed user; an owner-level token is
// refused, and nothing is stored for a refused registration.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app';
import { decrypt, loadKeyring } from '../src/vault/vault';
import { call, errorCode, json, resetDb, setupOperator, type CallOptions } from './auth-harness';
import { createFakeOrigin, type FakeOrigin, type Route } from './providers/fixture-fetch';
import {
  BASE,
  TOKEN,
  happy,
  identity,
  prefsAllowed,
  prefsRefused,
  rejectedToken,
  sections,
} from './providers/plex-routes';

const db = env.DB;
const BODY = {
  type: 'plex',
  name: 'Den Plex',
  baseUrl: BASE,
  credentials: { token: TOKEN },
};

const current: { origin: FakeOrigin } = { origin: createFakeOrigin('plex', []) };
const app = createApp({ originFetch: (input, init) => current.origin.fetch(input, init) });
const useOrigin = (routes: Route[]) => {
  current.origin = createFakeOrigin('plex', routes);
};

let cookie = '';
const register = (body: Record<string, unknown> = BODY) =>
  call('POST', '/api/v1/admin/servers', { cookie, app, body } satisfies CallOptions & {
    body: unknown;
  });

const count = async (table: string): Promise<number> =>
  (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? -1;

beforeEach(async () => {
  await resetDb();
  ({ cookie } = await setupOperator());
  useOrigin(happy);
});

describe('registering a Plex server', () => {
  it('validates the managed-user token, stores it encrypted and discovers libraries', async () => {
    const res = await register();
    expect(res.status).toBe(201);
    const server = await json<Record<string, unknown> & { libraries: Record<string, unknown>[] }>(
      res,
    );
    expect(server).toMatchObject({
      type: 'plex',
      status: 'active',
      version: '1.43.4.10903',
      libraryCount: 2,
    });
    expect(server.libraries.map((l) => [l.name, l.kind])).toEqual([
      ['Movies', 'movies'],
      ['Shows', 'tv'],
    ]);
    expect(JSON.stringify(server)).not.toContain(TOKEN);

    const row = await db.prepare('SELECT * FROM servers').first<{ id: string }>();
    expect(row).toMatchObject({ type: 'plex', origin_server_id: '<PLEX_MACHINE_ID>' });
    const cred = await db
      .prepare('SELECT * FROM server_credentials')
      .first<{ server_id: string; secret_envelope: string }>();
    expect(cred?.secret_envelope).not.toContain(TOKEN);
    const plain = await decrypt(
      await loadKeyring(env),
      'server_secret',
      cred?.server_id ?? '',
      cred?.secret_envelope ?? '',
    );
    expect(JSON.parse(plain)).toEqual({ kind: 'token', token: TOKEN });
  });

  it('refuses an owner-level token (it is accepted on an admin-only endpoint) and stores nothing', async () => {
    useOrigin([identity, sections, prefsAllowed]);
    const res = await register();
    expect(res.status).toBe(422);
    const body = await json<{
      error: { code: string; message: string; details: Record<string, unknown> };
    }>(res);
    expect(body.error.code).toBe('SERVER_VALIDATION_FAILED');
    expect(body.error.details).toEqual({ check: 'credentials', reason: 'admin_account' });
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect(await count('servers')).toBe(0);
    expect(await count('server_credentials')).toBe(0);
  });

  it('refuses a token the server rejects', async () => {
    useOrigin([identity, rejectedToken]);
    const res = await register();
    expect(await errorCode(res)).toBe('SERVER_VALIDATION_FAILED');
    expect(await count('servers')).toBe(0);
  });

  it('needs a token: a username and password is a validation error and contacts no origin', async () => {
    const res = await register({
      ...BODY,
      credentials: { username: 'cinewren', password: 'secret' },
    });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('VALIDATION_FAILED');
    expect(current.origin.calls).toHaveLength(0);
  });

  it('refuses a duplicate of an already registered Plex server', async () => {
    expect((await register()).status).toBe(201);
    useOrigin([identity, sections, prefsRefused]);
    const again = await register({ ...BODY, name: 'Same server' });
    expect(again.status).toBe(409);
    expect(await count('servers')).toBe(1);
  });
});
