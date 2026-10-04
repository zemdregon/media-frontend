/**
 * The sync run consumer (LLD-SYNC "Consumer: sync run", FR-SYNC-001 to FR-SYNC-008, ADR-0009).
 *
 * One queue message is one run of one server, so a failing server cannot touch another's run
 * (FR-SYNC-007). The run is claimed with a compare-and-set lease; progress is a `{libraryIdx,
 * cursor}` checkpoint written after every page, so a redelivered or continued message resumes
 * where it stopped, and re-applying a page is safe because every write is idempotent.
 */
import {
  bumpCatalogVersionStmt,
  claimRun,
  finishRun,
  getRun,
  getSyncServer,
  listEnabledLibraries,
  releaseLease,
  saveProgressStmt,
  type RunRow,
  type SyncLibraryRow,
} from '../db/sync';
import { ProviderError } from '../providers/errors';
import type { MediaProvider, NormalizedCollection, ProviderContext } from '../providers/types';
import { removeUnseenCollections, processCollections } from './collections';
import { CredentialsUnavailableError, type SyncDeps } from './deps';
import { finishLibrary } from './finish';
import { processPage } from './items';
import type { PlaceContext } from './place';
import { withRetry } from './retry';

export interface Checkpoint {
  libraryIdx: number;
  cursor: string | null;
  /** Times the reaper re-queued this run. */
  reaps?: number;
  /** Operator override of the mass-missing guard (LLD-SYNC). */
  force?: boolean;
}

export function parseCheckpoint(raw: string | null): Checkpoint {
  if (raw) {
    try {
      const v = JSON.parse(raw) as Partial<Checkpoint> | null;
      if (v && typeof v.libraryIdx === 'number') {
        return {
          libraryIdx: v.libraryIdx,
          cursor: typeof v.cursor === 'string' ? v.cursor : null,
          ...(typeof v.reaps === 'number' ? { reaps: v.reaps } : {}),
          ...(v.force === true ? { force: true } : {}),
        };
      }
    } catch {
      // fall through to a fresh checkpoint
    }
  }
  return { libraryIdx: 0, cursor: null };
}

export type RunResult = 'skipped' | 'continued' | 'succeeded' | 'partial' | 'failed';

const MAX_SUMMARY = 4000;

function appendSummary(summary: string | null, line: string): string {
  const next = summary ? `${summary}\n${line}` : line;
  return next.length > MAX_SUMMARY ? next.slice(0, MAX_SUMMARY) : next;
}

const safeJsonArray = (raw: string): string[] => {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

/**
 * Handles one `{kind:'sync'}` message. Origin failures end the run and are not thrown. An
 * unexpected error (for example D1 being down) releases the lease and rethrows, so the queue's
 * own retry can claim the run again at once instead of waiting for the reaper.
 */
export async function handleSyncMessage(
  deps: SyncDeps,
  message: { runId: string; leaseToken?: string },
): Promise<RunResult> {
  const { db } = deps;
  const run = await getRun(db, message.runId);
  if (!run || run.status === 'succeeded' || run.status === 'partial' || run.status === 'failed') {
    return 'skipped'; // redelivery of a finished run
  }
  const token = deps.newId();
  const claimed = await claimRun(
    db,
    run.id,
    message.leaseToken ?? null,
    token,
    deps.now(),
    deps.config.leaseMs,
  );
  if (!claimed) return 'skipped'; // someone else holds the lease
  try {
    return await executeRun(deps, run, token);
  } catch (err) {
    await releaseLease(db, run.id, token).catch(() => undefined);
    throw err;
  }
}

/**
 * The per-server sync counter event (NFR-OBS-002): duration, errors and outcome of a finished
 * run. The same figures are queryable from D1 (`GET /admin/metrics`, TDD-D4).
 */
async function logRunMetric(deps: SyncDeps, runId: string, status: string): Promise<void> {
  const row = await getRun(deps.db, runId);
  deps.logger.info('sync.run_finished', {
    run_id: runId,
    server_id: row?.server_id ?? null,
    status,
    metric: 'sync.run',
    duration_ms: row
      ? Math.max(0, (row.ended_at ?? deps.now()) - (row.started_at ?? row.queued_at))
      : null,
    errors: row?.errors ?? 0,
    added: row?.added ?? 0,
    updated: row?.updated ?? 0,
    missing: row?.missing ?? 0,
  });
}

async function executeRun(deps: SyncDeps, run: RunRow, token: string): Promise<RunResult> {
  const { db } = deps;

  const log = deps.logger.child({ run_id: run.id, server_id: run.server_id });
  const server = await getSyncServer(db, run.server_id);
  if (!server || (server.status !== 'active' && server.status !== 'degraded')) {
    await finishRun(
      db,
      run.id,
      token,
      'failed',
      'The server is not active; the run was not started.',
      deps.now(),
    );
    return 'failed';
  }

  let provider: MediaProvider;
  let ctx: ProviderContext;
  try {
    ({ provider, ctx } = await deps.openServer(server));
  } catch (err) {
    if (!(err instanceof CredentialsUnavailableError)) throw err;
    log.error('sync.credentials_unavailable', { reason: err.message });
    await finishRun(
      db,
      run.id,
      token,
      'failed',
      `Credentials unavailable: ${err.message}`,
      deps.now(),
    );
    await logRunMetric(deps, run.id, 'failed');
    return 'failed';
  }

  const retry = <T>(fn: () => Promise<T>) =>
    withRetry(fn, {
      attempts: deps.config.retryAttempts,
      baseMs: deps.config.retryBaseMs,
      capMs: deps.config.retryCapMs,
      sleep: (ms) => deps.sleep(ms),
      random: () => deps.random(),
      onRetry: (attempt, delayMs, e) => {
        log.warn('sync.retry', { attempt, delay_ms: delayMs, code: e.code });
      },
    });

  const libs = await listEnabledLibraries(db, server.id);
  let cp = parseCheckpoint(run.checkpoint);
  let ok = safeJsonArray(run.libraries_ok);
  let failed = safeJsonArray(run.libraries_failed);
  let summary = run.error_summary;
  const full = run.type === 'full';
  const pc: PlaceContext = {
    deps,
    server: { id: server.id, priority: server.priority },
    library: { id: '' },
    itemOfSource: new Map(),
  };
  const deadline = deps.now() + deps.config.deadlineMs;
  let pages = 0;
  let aborted: string | null = null;

  // The counters of this invocation, committed with the checkpoint after every page.
  const delta = { added: 0, updated: 0, missing: 0, errors: 0 };
  const persist = async (extra: D1PreparedStatement[] = []): Promise<boolean> => {
    const stmt = saveProgressStmt(db, run.id, token, {
      checkpoint: JSON.stringify(cp),
      ...delta,
      librariesOk: JSON.stringify(ok),
      librariesFailed: JSON.stringify(failed),
      errorSummary: summary,
      leaseExpiresAt: deps.now() + deps.config.leaseMs,
    });
    delta.added = delta.updated = delta.missing = delta.errors = 0;
    const results = await db.batch([...extra, stmt]);
    return (results[results.length - 1]?.meta.changes ?? 0) > 0; // false: the lease was lost
  };
  const fail = (lib: SyncLibraryRow | null, line: string): void => {
    failed = [...new Set([...failed, lib?.id ?? 'collections'])];
    delta.errors++;
    summary = appendSummary(summary, `${lib ? lib.name : 'collections'}: ${line}`);
  };

  const continuation = async (): Promise<RunResult> => {
    await deps.queue.send({ kind: 'sync', runId: run.id, leaseToken: token });
    return 'continued';
  };

  while (cp.libraryIdx < libs.length) {
    const lib = libs[cp.libraryIdx];
    if (!lib) break;
    pc.library = { id: lib.id };
    // A library that was never fully synced lists everything even in an incremental run.
    const since = !full && lib.last_full_sync_id !== null ? (run.since_ms ?? undefined) : undefined;
    let page: Awaited<ReturnType<MediaProvider['listItems']>>;
    try {
      page = await retry(() =>
        provider.listItems(ctx, {
          libraryId: lib.provider_library_id,
          pageSize: deps.config.pageSize,
          ...(cp.cursor === null ? {} : { cursor: cp.cursor }),
          ...(since === undefined ? {} : { since }),
        }),
      );
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      log.warn('sync.library_failed', { library_id: lib.id, code: err.code });
      if (err.code === 'AUTH') {
        aborted = 'The origin rejected the credentials. Re-enter them (WF-11).';
        break;
      }
      fail(lib, `${err.code}: ${err.message}`);
      cp = { ...cp, libraryIdx: cp.libraryIdx + 1, cursor: null };
      if (!(await persist())) return 'skipped';
      continue;
    }

    const outcome = await processPage({ ...pc, runId: run.id }, page.items);
    // Sources seen but unchanged are marked seen before the library can finish, or a full
    // run would mark them missing.
    if (outcome.seenStmts.length > 0) await db.batch(outcome.seenStmts);
    delta.added += outcome.added;
    delta.updated += outcome.updated;
    if (outcome.failure) {
      fail(lib, outcome.failure);
      cp = { ...cp, libraryIdx: cp.libraryIdx + 1, cursor: null };
      if (!(await persist())) return 'skipped';
      continue;
    }
    const lastPage = page.nextCursor === null;
    if (lastPage) {
      const fin = await finishLibrary(pc, run.id, { full, force: cp.force === true });
      delta.missing += fin.marked;
      if (fin.guarded) {
        fail(
          lib,
          'MASS_MISSING_GUARD: the origin listed far fewer items than before; nothing was marked missing.',
        );
      } else {
        ok = [...new Set([...ok, lib.id])];
      }
    }
    cp = lastPage
      ? { ...cp, libraryIdx: cp.libraryIdx + 1, cursor: null }
      : { ...cp, cursor: page.nextCursor };
    if (!(await persist())) return 'skipped';
    pages++;
    if (deps.now() > deadline || pages >= deps.config.maxPagesPerInvocation) return continuation();
  }

  // Collections run once per run, after the libraries (Jellyfin and Emby box sets are not
  // inside a movie library, so a per-library listing would not find them).
  if (aborted === null && ok.length > 0 && !failed.includes('collections')) {
    const stage = await syncCollections(deps, provider, ctx, retry, {
      run,
      serverId: server.id,
      priority: server.priority,
      full,
      librariesFailed: failed.some((id) => id !== 'collections'),
      cursor: cp.libraryIdx > libs.length ? cp.cursor : null,
      onPage: async (cursor) => {
        cp = { ...cp, libraryIdx: libs.length + 1, cursor };
        return persist();
      },
    });
    if (stage.kind === 'lost') return 'skipped';
    if (stage.kind === 'error') fail(null, stage.message);
  }

  if (aborted !== null) {
    summary = appendSummary(summary, aborted);
    cp = { ...cp, libraryIdx: libs.length, cursor: null };
    if (!(await persist())) return 'skipped';
    const done = await finishRun(db, run.id, token, 'failed', summary, deps.now());
    if (done) {
      await db.batch([bumpCatalogVersionStmt(db)]);
      await logRunMetric(deps, run.id, 'failed');
    }
    return 'failed';
  }
  const status = failed.length === 0 ? 'succeeded' : ok.length === 0 ? 'failed' : 'partial';
  cp = { ...cp, libraryIdx: libs.length + 2, cursor: null };
  if (!(await persist())) return 'skipped';
  if (await finishRun(db, run.id, token, status, summary, deps.now())) {
    await db.batch([bumpCatalogVersionStmt(db)]);
    await logRunMetric(deps, run.id, status);
  }
  return status;
}

type CollectionsStage = { kind: 'ok' } | { kind: 'error'; message: string } | { kind: 'lost' };

async function syncCollections(
  deps: SyncDeps,
  provider: MediaProvider,
  ctx: ProviderContext,
  retry: <T>(fn: () => Promise<T>) => Promise<T>,
  o: {
    run: RunRow;
    serverId: string;
    priority: number;
    full: boolean;
    librariesFailed: boolean;
    cursor: string | null;
    onPage: (cursor: string | null) => Promise<boolean>;
  },
): Promise<CollectionsStage> {
  let cursor = o.cursor;
  const server = { id: o.serverId, priority: o.priority };
  for (;;) {
    let page: { collections: NormalizedCollection[]; nextCursor: string | null };
    try {
      page = await retry(() =>
        provider.listCollections(ctx, {
          pageSize: deps.config.collectionPageSize,
          ...(cursor === null ? {} : { cursor }),
        }),
      );
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      if (err.code === 'UNSUPPORTED') return { kind: 'ok' }; // the adapter has no collections yet
      return { kind: 'error', message: `${err.code}: ${err.message}` };
    }
    try {
      await processCollections(deps, server, o.run.id, page.collections);
    } catch (err) {
      deps.logger.error('sync.collections_failed', {
        server_id: o.serverId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { kind: 'error', message: 'Collections could not be written.' };
    }
    cursor = page.nextCursor;
    if (cursor === null) break;
    if (!(await o.onPage(cursor))) return { kind: 'lost' };
  }
  // A completed full pass of every library drops links the origin no longer lists (FR-SYNC-008).
  if (o.full && !o.librariesFailed) await removeUnseenCollections(deps, o.serverId, o.run.id);
  return { kind: 'ok' };
}
