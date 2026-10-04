// T5.5: schema-skew guard (TDD §9.3, FR-OPS-008, NFR-MAINT-003). When D1 is behind the code's
// expected migration, API routes answer 503 MIGRATIONS_PENDING and health reports degraded.
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appliedSchemaVersion,
  resetSchemaGuardCache,
  SCHEMA_VERSION_REQUIRED,
} from '../src/platform/schema-version';
import { appWith } from './helpers';

const num = (name: string) => Number(name.slice(0, 4));

/** A D1 stand-in that reports a given highest applied migration (or a missing table). */
function dbAt(applied: number | 'no-table'): D1Database {
  return {
    prepare: (sql: string) => ({
      first: () => {
        if (sql.includes('d1_migrations')) {
          return applied === 'no-table'
            ? Promise.reject(new Error('D1_ERROR: no such table: d1_migrations'))
            : Promise.resolve({ v: applied });
        }
        return Promise.resolve({ '1': 1 });
      },
    }),
  } as unknown as D1Database;
}

beforeEach(resetSchemaGuardCache);
afterEach(resetSchemaGuardCache);

describe('SCHEMA_VERSION_REQUIRED', () => {
  it('equals the newest migration file, and the files are numbered without gaps', () => {
    const numbers = env.TEST_MIGRATIONS.map((m) => num(m.name)).sort((a, b) => a - b);
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
    expect(SCHEMA_VERSION_REQUIRED).toBe(numbers.at(-1));
  });

  it('matches what the real migrated D1 reports', async () => {
    expect(await appliedSchemaVersion(env.DB)).toBe(SCHEMA_VERSION_REQUIRED);
  });
});

describe('MIGRATIONS_PENDING guard', () => {
  it.each([SCHEMA_VERSION_REQUIRED - 1, 0, 'no-table' as const])(
    'API routes return 503 MIGRATIONS_PENDING when the schema is at %s',
    async (applied) => {
      const res = await appWith({ DB: dbAt(applied) }).request('/api/v1/me');
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('60');
      const body = await res.json<{
        error: { code: string; message: string; requestId: string };
      }>();
      expect(body.error.code).toBe('MIGRATIONS_PENDING');
      expect(body.error.message).toContain('migrations');
      expect(body.error.requestId).toBe(res.headers.get('x-request-id'));
    },
  );

  it('also blocks the public setup routes, which would fail on a missing schema', async () => {
    const res = await appWith({ DB: dbAt(0) }).request('/api/v1/setup');
    expect(res.status).toBe(503);
  });

  it('health reports degraded (200) while migrations are pending', async () => {
    const res = await appWith({ DB: dbAt(SCHEMA_VERSION_REQUIRED - 1) }).request('/api/v1/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'degraded' });
  });

  it('does not block the SPA shell', async () => {
    const res = await appWith({ DB: dbAt(0) }).request('/');
    expect(res.status).toBe(200);
  });

  it('lets requests through when the schema is current, and health is ok', async () => {
    const current = appWith({ DB: dbAt(SCHEMA_VERSION_REQUIRED) });
    expect((await current.request('/api/v1/me')).status).toBe(401); // reaches the session check
    const health = await current.request('/api/v1/health');
    expect(await health.json()).toEqual({ status: 'ok' });
  });

  it('is satisfied by a newer schema (a rollback to an older Worker stays usable)', async () => {
    const res = await appWith({ DB: dbAt(SCHEMA_VERSION_REQUIRED + 5) }).request('/api/v1/me');
    expect(res.status).toBe(401);
  });
});
