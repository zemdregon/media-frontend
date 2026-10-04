/**
 * UI-only catalog types. The catalog read API contract (cards, details, search) lives in
 * `catalog.ts` and is implemented by the Worker; this file holds only what the API does not
 * define. Types only; no secrets.
 */
import type { Page } from './auth';

export type SyncRunStatus = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed';

/** An entry of `GET /api/v1/admin/servers/{id}/sync-runs` (FR-SYNC-006). */
export interface SyncRun {
  id: string;
  type: 'full' | 'incremental';
  trigger: 'schedule' | 'manual';
  status: SyncRunStatus;
  added: number;
  updated: number;
  missing: number;
  errors: number;
  errorSummary: string | null;
  queuedAt: number;
  startedAt: number | null;
  endedAt: number | null;
}

export interface SyncRunsPage extends Page<SyncRun> {
  nextScheduled: number | null;
}
