import { useState } from 'react';
import type { AuditEntry } from '@cinewren/shared';
import { listAuditLog } from '../api-client/ops';
import { Alert, EmptyState, PageHead, SkeletonBlock } from '../components/ui';
import { Link } from '../lib/router';
import { usePagedLoad } from '../lib/useLoad';

/** Operator audit log (FR-OPS-005): who changed what and when, newest first, with an export link. */

const FILTERS: { value: string; label: string }[] = [
  { value: '', label: 'All actions' },
  { value: 'server.*', label: 'Servers' },
  { value: 'library.*', label: 'Libraries' },
  { value: 'user.*', label: 'Users' },
  { value: 'invite.*', label: 'Invites' },
  { value: 'sync.*', label: 'Sync' },
  { value: 'curation.*', label: 'Curation' },
];

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
}

/** Details are IDs and flags only (never secrets), shown as compact `key: value` text. */
function detailText(details: Record<string, unknown>): string {
  return Object.entries(details)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(', ');
}

export function AuditLog() {
  const [action, setAction] = useState('');
  const paged = usePagedLoad(
    (cursor) => listAuditLog({ ...(action ? { action } : {}), cursor, limit: 50 }),
    `audit:${action}`,
  );
  return (
    <>
      <PageHead
        title="Audit log"
        aside={
          <div className="actions">
            <a className="button button-outline" href="/api/v1/admin/export" download>
              Export data
            </a>
            <Link to="/servers" className="button button-outline">
              Back to Servers
            </Link>
          </div>
        }
      />
      <div className="field">
        <label htmlFor="audit-filter">Show</label>
        <select
          id="audit-filter"
          value={action}
          onChange={(e) => {
            setAction(e.target.value);
          }}
        >
          {FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </div>
      {paged.state.status === 'loading' && <SkeletonBlock label="Loading the audit log" />}
      {paged.state.status === 'error' && (
        <Alert message={paged.state.message} onRetry={paged.reload} />
      )}
      {paged.state.status === 'ready' &&
        (paged.items.length === 0 ? (
          <EmptyState title="Nothing recorded yet">
            Changes made by operators appear here.
          </EmptyState>
        ) : (
          <>
            <div className="table-wrap">
              <table className="copies audit-table">
                <caption className="sr-only">Operator actions, newest first</caption>
                <thead>
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col">Action</th>
                    <th scope="col">Target</th>
                    <th scope="col">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {paged.items.map((e: AuditEntry) => (
                    <tr key={e.id}>
                      <th scope="row">{formatTime(e.at)}</th>
                      <td className="mono-value">{e.action}</td>
                      <td>
                        {e.targetType}
                        {e.targetId ? <span className="helper"> {e.targetId}</span> : null}
                      </td>
                      <td className="helper">{detailText(e.details)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {paged.moreError && <Alert message={paged.moreError} />}
            {paged.cursor && (
              <button
                type="button"
                className="button button-outline"
                disabled={paged.busy}
                onClick={() => void paged.loadMore()}
              >
                {paged.busy ? 'Loading…' : 'Load more'}
              </button>
            )}
          </>
        ))}
    </>
  );
}
