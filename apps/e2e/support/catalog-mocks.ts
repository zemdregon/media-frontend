/**
 * MOCKED BACKEND PARTS. Only what the Worker genuinely does not serve yet is mocked here: the
 * operator sync API (`GET /admin/servers/{id}/sync-runs`, `POST .../sync`), which workstream A
 * builds. Remove this file when that merges.
 *
 * The catalog read API and `PATCH /me/preferences` are real and are NOT mocked; the journey
 * seeds catalog rows directly into local D1 (seed-catalog.sql) until sync can index the mock
 * origin.
 */
import type { Page, Route } from '@playwright/test';
import type { SyncRunsPage } from '@cinewren/shared';

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

export interface MockState {
  syncCalls: unknown[];
}

export async function mockSyncApi(page: Page): Promise<MockState> {
  const state: MockState = { syncCalls: [] };
  await page.route(/\/api\/v1\/admin\/servers\/[^/]+\/sync(-runs)?(\?.*)?$/, (route) => {
    if (route.request().method() === 'POST') {
      state.syncCalls.push(route.request().postDataJSON() as unknown);
      return json(route, { runId: 'run-2' }, 202);
    }
    const body: SyncRunsPage = {
      items: [
        {
          id: 'run-1',
          type: 'full',
          trigger: 'manual',
          status: 'succeeded',
          added: 4,
          updated: 0,
          missing: 0,
          errors: 0,
          errorSummary: null,
          queuedAt: Date.now() - 120_000,
          startedAt: Date.now() - 110_000,
          endedAt: Date.now() - 60_000,
        },
      ],
      nextCursor: null,
      nextScheduled: Date.now() + 300_000,
    };
    return json(route, body);
  });
  return state;
}
