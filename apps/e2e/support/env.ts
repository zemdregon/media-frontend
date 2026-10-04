/** Ports and test-only secrets shared by the specs and start-worker.mjs. None is a real secret. */
export const WORKER_PORT = Number(process.env.E2E_WORKER_PORT ?? 8788);
export const ORIGIN_PORT = Number(process.env.MOCK_ORIGIN_PORT ?? 8790);
export const BASE_URL = `http://localhost:${String(WORKER_PORT)}`;
export const ORIGIN_URL = `http://127.0.0.1:${String(ORIGIN_PORT)}`;

// Keep in step with start-worker.mjs.
export const SETUP_TOKEN =
  process.env.E2E_SETUP_TOKEN ?? 'e2e-setup-token-0123456789abcdef0123456789abcdef';

/** The worker's wrangler project and the persisted local state, for seeding D1 (seed-catalog.sql). */
export const STATE_DIR = new URL('../.state', import.meta.url).pathname;
export const WORKER_DIR = new URL('../../worker', import.meta.url).pathname;
export const SEED_SQL = new URL('../seed-catalog.sql', import.meta.url).pathname;
