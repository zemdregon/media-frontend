/** Ports and test-only secrets shared by the specs and start-worker.mjs. None is a real secret. */
export const WORKER_PORT = Number(process.env.E2E_WORKER_PORT ?? 8788);
export const ORIGIN_PORT = Number(process.env.MOCK_ORIGIN_PORT ?? 8790);
export const BASE_URL = `http://localhost:${String(WORKER_PORT)}`;
export const ORIGIN_URL = `http://127.0.0.1:${String(ORIGIN_PORT)}`;

// Keep in step with start-worker.mjs.
export const SETUP_TOKEN =
  process.env.E2E_SETUP_TOKEN ?? 'e2e-setup-token-0123456789abcdef0123456789abcdef';

/**
 * The catalog read API (T2.4) and sync-runs API (T2.2) are built by other workstreams. Until they
 * are merged, the specs answer those calls with Playwright route mocks (support/catalog-mocks.ts).
 * Set E2E_REAL_CATALOG=1 to skip the mocks and hit the real Worker routes.
 */
export const MOCK_CATALOG = process.env.E2E_REAL_CATALOG !== '1';
