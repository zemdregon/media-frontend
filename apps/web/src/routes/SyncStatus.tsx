import { useState } from 'react';
import type { Server, SyncRun, SyncRunStatus } from '@cinewren/shared';
import { listServers, listSyncRuns, startSync } from '../api-client/catalog';
import { ApiError } from '../api-client';
import { Alert, EmptyState, PageHead, SkeletonBlock, StatusDot } from '../components/ui';
import { Link } from '../lib/router';
import { errorMessage, useLoad } from '../lib/useLoad';

/** Operator sync-status page: last run, outcome, next run and recent errors per server (FR-OPS-003). */

const OUTCOME: Record<SyncRunStatus, { tone: 'ok' | 'warn' | 'bad' | 'muted'; text: string }> = {
  queued: { tone: 'muted', text: 'Waiting to start' },
  running: { tone: 'warn', text: 'Running' },
  succeeded: { tone: 'ok', text: 'Succeeded' },
  partial: { tone: 'warn', text: 'Finished with some libraries failing' },
  failed: { tone: 'bad', text: 'Failed' },
};

export function formatTime(ms: number | null): string {
  if (ms === null) return 'Never';
  return new Date(ms).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function SyncStatus() {
  const { state, reload } = useLoad(listServers, 'sync-servers');
  return (
    <>
      <PageHead
        title="Sync status"
        aside={
          <Link to="/servers" className="button button-outline">
            Back to Servers
          </Link>
        }
      />
      {state.status === 'loading' && <SkeletonBlock label="Loading servers" />}
      {state.status === 'error' && <Alert message={state.message} onRetry={reload} />}
      {state.status === 'ready' &&
        (state.data.length === 0 ? (
          <EmptyState title="No servers yet">
            Add a server to start building the catalog.
          </EmptyState>
        ) : (
          <div className="server-list">
            {state.data.map((s) => (
              <SyncCard key={s.id} server={s} />
            ))}
          </div>
        ))}
    </>
  );
}

function SyncCard({ server }: { server: Server }) {
  const { state, reload } = useLoad(() => listSyncRuns(server.id), `sync:${server.id}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trigger = async (type: 'full' | 'incremental') => {
    setBusy(true);
    setError(null);
    try {
      await startSync(server.id, type);
      reload();
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'SYNC_IN_PROGRESS'
          ? 'A sync is already running for this server.'
          : errorMessage(err),
      );
    } finally {
      setBusy(false);
    }
  };

  const last: SyncRun | undefined = state.status === 'ready' ? state.data.items[0] : undefined;
  const failures = state.status === 'ready' ? state.data.items.filter((r) => r.errorSummary) : [];
  const disabled = server.status === 'disabled' || server.status === 'removing';
  return (
    <article className="server-card" aria-labelledby={`sync-${server.id}`}>
      <header>
        <h2 id={`sync-${server.id}`}>{server.name}</h2>
        <span className="type-tag">{server.type}</span>
      </header>
      {state.status === 'loading' && (
        <SkeletonBlock label={`Loading sync runs for ${server.name}`} />
      )}
      {state.status === 'error' && <Alert message={state.message} onRetry={reload} />}
      {state.status === 'ready' && (
        <>
          <p>
            {last ? (
              <StatusDot tone={OUTCOME[last.status].tone} label={OUTCOME[last.status].text} />
            ) : (
              <StatusDot tone="muted" label="Never run" />
            )}
          </p>
          {last?.status === 'running' && (
            <div
              className="progress-track"
              role="progressbar"
              aria-label={`Indexing ${server.name}`}
              aria-valuetext="Indexing in progress"
            >
              <span className="progress-indeterminate" />
            </div>
          )}
          <dl className="stats">
            <div>
              <dt>Last run</dt>
              <dd>
                {last ? formatTime(last.endedAt ?? last.startedAt ?? last.queuedAt) : 'Never'}
              </dd>
            </div>
            <div>
              <dt>Next run</dt>
              <dd>{disabled ? 'Not scheduled' : formatTime(state.data.nextScheduled)}</dd>
            </div>
            <div>
              <dt>Added</dt>
              <dd>{last?.added ?? 0}</dd>
            </div>
            <div>
              <dt>Updated</dt>
              <dd>{last?.updated ?? 0}</dd>
            </div>
            <div>
              <dt>No longer listed</dt>
              <dd>{last?.missing ?? 0}</dd>
            </div>
            <div>
              <dt>Errors</dt>
              <dd>{last?.errors ?? 0}</dd>
            </div>
          </dl>
          {failures.length > 0 && (
            <section aria-label={`Recent errors for ${server.name}`} className="error-list">
              <h3 className="mono-label">Recent errors</h3>
              <ul>
                {failures.map((r) => (
                  <li key={r.id}>
                    <span className="mono-value">{formatTime(r.endedAt ?? r.queuedAt)}</span>{' '}
                    {r.errorSummary}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
      <Alert message={error} />
      <div className="form-actions">
        <button
          type="button"
          className="button button-outline"
          disabled={busy || disabled}
          aria-label={`Sync ${server.name} now`}
          onClick={() => void trigger('incremental')}
        >
          Sync now
        </button>
        <button
          type="button"
          className="button button-outline"
          disabled={busy || disabled}
          aria-label={`Full re-index of ${server.name}`}
          onClick={() => void trigger('full')}
        >
          Full re-index
        </button>
      </div>
    </article>
  );
}
