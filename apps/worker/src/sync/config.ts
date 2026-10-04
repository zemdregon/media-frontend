/**
 * Sync tuning (FR-SYNC-001: intervals are configuration; LLD-SYNC and LLD-ERR: limits marked
 * *proposed*). Everything has a default so a Worker without the optional vars behaves as designed.
 */
import type { Env } from '../platform/env';

export interface SyncConfig {
  /** FR-SYNC-001 (proposed 60 min). */
  incrementalIntervalMs: number;
  /** FR-SYNC-001 (proposed 24 h). */
  fullIntervalMs: number;
  pageSize: number;
  collectionPageSize: number;
  /** Lease length on a running run (LLD-SYNC: 16 min). */
  leaseMs: number;
  /** A run whose lease expired this long ago is reaped (LLD-SYNC: 15 min). */
  reapAfterMs: number;
  maxReaps: number;
  /** Stop and enqueue a continuation after this much wall time (LLD-SYNC: 12 min). */
  deadlineMs: number;
  /** Stop and continue after this many pages per invocation (keeps D1 subrequests bounded). */
  maxPagesPerInvocation: number;
  /** Incremental `since` is the last good run's start minus this skew (LLD-SYNC: 10 min). */
  incrementalSkewMs: number;
  /** NFR-REL-002 (proposed 5 attempts). */
  retryAttempts: number;
  retryBaseMs: number;
  retryCapMs: number;
  /** BR-4 mass-missing guard (LLD-SYNC): ratio above this with more than `massMissingMin` present. */
  massMissingRatio: number;
  massMissingMin: number;
  /** DR-003. */
  missingRetentionMs: number;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  incrementalIntervalMs: 60 * MIN,
  fullIntervalMs: 24 * HOUR,
  pageSize: 200,
  collectionPageSize: 25,
  leaseMs: 16 * MIN,
  reapAfterMs: 15 * MIN,
  maxReaps: 3,
  deadlineMs: 12 * MIN,
  maxPagesPerInvocation: 10,
  incrementalSkewMs: 10 * MIN,
  retryAttempts: 5,
  retryBaseMs: 500,
  retryCapMs: 30_000,
  massMissingRatio: 0.5,
  massMissingMin: 100,
  missingRetentionMs: 30 * DAY,
};

function positive(value: string | undefined, fallback: number, unitMs: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n * unitMs : fallback;
}

export function getSyncConfig(
  env: Pick<Env, 'SYNC_INCREMENTAL_INTERVAL_MIN' | 'SYNC_FULL_INTERVAL_H'>,
): SyncConfig {
  return {
    ...DEFAULT_SYNC_CONFIG,
    incrementalIntervalMs: positive(
      env.SYNC_INCREMENTAL_INTERVAL_MIN,
      DEFAULT_SYNC_CONFIG.incrementalIntervalMs,
      MIN,
    ),
    fullIntervalMs: positive(env.SYNC_FULL_INTERVAL_H, DEFAULT_SYNC_CONFIG.fullIntervalMs, HOUR),
  };
}
