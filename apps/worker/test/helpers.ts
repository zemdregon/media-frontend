import { createApp } from '../src/api/app';
import type { Env } from '../src/platform/env';

/** Minimal fake D1: only `prepare(sql).first()` is used by health. */
export function fakeDb(fail = false): D1Database {
  return {
    prepare: () => ({
      first: () =>
        fail ? Promise.reject(new Error('D1_ERROR: unavailable')) : Promise.resolve({ '1': 1 }),
    }),
  } as unknown as D1Database;
}

export function appWith(overrides: Partial<Env> = {}) {
  const env = {
    DB: fakeDb(),
    ASSETS: {
      fetch: async () =>
        new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
    },
    ENVIRONMENT: 'local',
    APP_ORIGIN: 'http://localhost:8787',
    ...overrides,
  } as unknown as Env;
  const app = createApp();
  return { request: (path: string, init?: RequestInit) => app.request(path, init, env), env };
}
