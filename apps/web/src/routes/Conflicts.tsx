import { useId, useState } from 'react';
import type { ConflictReason, EntityKind, MatchConflict } from '@cinewren/shared';
import { listConflicts, resolveConflict } from '../api-client/curation';
import { Alert, EmptyState, PageHead, SkeletonBlock } from '../components/ui';
import { Link } from '../lib/router';
import { errorMessage, usePagedLoad } from '../lib/useLoad';

/**
 * Operator "Match conflicts" (FR-CAT-010, WF-9; UX §5): each flagged source or link beside the
 * candidates it was kept apart from, with "Merge into this one", "Keep separate" and "Dismiss".
 * Resolving clears the flag, and the choice is kept across future indexing (BR-3).
 */

const REASON: Record<ConflictReason, string> = {
  conflicting_ids: 'Looks like the same one, but the IDs disagree',
  multiple_candidates: 'Matches more than one existing entry',
  type_mismatch: 'A movie and a series share an ID',
  ambiguous_name: 'Several entries share this name',
};

const KIND_LABEL: Record<EntityKind, string> = {
  item: 'Title',
  person: 'Person',
  collection: 'Collection',
};

const FILTERS: { value: '' | EntityKind; label: string }[] = [
  { value: '', label: 'Everything' },
  { value: 'item', label: 'Titles' },
  { value: 'person', label: 'People' },
  { value: 'collection', label: 'Collections' },
];

const idLine = (ids: Record<string, string | string[]>): string =>
  Object.entries(ids)
    .flatMap(([scheme, v]) => (Array.isArray(v) ? v : [v]).map((x) => `${scheme}:${x}`))
    .join('  ') || 'no IDs';

export function Conflicts() {
  const [kind, setKind] = useState<'' | EntityKind>('');
  const [notice, setNotice] = useState<string | null>(null);
  const filterId = useId();
  const paged = usePagedLoad(
    (cursor) => listConflicts({ entityKind: kind, cursor }),
    `conflicts:${kind}`,
  );

  return (
    <>
      <PageHead
        title="Match conflicts"
        aside={
          <Link to="/servers" className="button button-outline">
            Back to Servers
          </Link>
        }
      />
      <p className="helper">
        These were kept apart because their IDs or names left the match unclear. Whatever you choose
        is kept across future indexing.
      </p>
      <div className="field">
        <label htmlFor={filterId}>Show</label>
        <select
          id={filterId}
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as '' | EntityKind);
          }}
        >
          {FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </div>
      <Alert tone="info" message={notice} />
      {paged.state.status === 'loading' && <SkeletonBlock label="Loading match conflicts" />}
      {paged.state.status === 'error' && (
        <Alert message={paged.state.message} onRetry={paged.reload} />
      )}
      {paged.state.status === 'ready' &&
        (paged.items.length === 0 ? (
          <EmptyState title="No conflicts to review">
            Flagged matches appear here after a server is indexed.
          </EmptyState>
        ) : (
          <>
            <div className="server-list">
              {paged.items.map((c) => (
                <ConflictCard
                  key={c.id}
                  conflict={c}
                  onResolved={(message) => {
                    setNotice(message);
                    paged.reload();
                  }}
                />
              ))}
            </div>
            <Alert message={paged.moreError} />
            {paged.cursor && (
              <div className="center">
                <button
                  type="button"
                  className="button button-outline"
                  disabled={paged.busy}
                  aria-busy={paged.busy}
                  onClick={() => void paged.loadMore()}
                >
                  {paged.busy ? 'Loading…' : 'Load more'}
                </button>
              </div>
            )}
          </>
        ))}
    </>
  );
}

function ConflictCard({
  conflict: c,
  onResolved,
}: {
  conflict: MatchConflict;
  onResolved: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const headingId = useId();
  const subject = c.source.title + (c.source.year ? ` (${String(c.source.year)})` : '');

  const run = async (body: Parameters<typeof resolveConflict>[1], done: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await resolveConflict(c.id, body);
      onResolved(done);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <article className="server-card conflict-card" aria-labelledby={headingId}>
      <header>
        <h2 id={headingId}>{subject}</h2>
        <span className="type-tag">{KIND_LABEL[c.entityKind]}</span>
      </header>
      <p className="helper">{REASON[c.reason]}</p>
      <div className="conflict-pair">
        <section aria-label={`Flagged: ${subject}`} className="conflict-side">
          <p className="mono-label">Flagged on {c.source.serverName}</p>
          <p className="conflict-name">{subject}</p>
          <p className="mono-value">{idLine(c.source.externalIds)}</p>
        </section>
        {c.candidates.length === 0 && (
          <p className="helper">The entries it was compared with are gone.</p>
        )}
        {c.candidates.map((cand) => {
          const name = cand.title + (cand.year ? ` (${String(cand.year)})` : '');
          return (
            <section key={cand.id} aria-label={`Candidate: ${name}`} className="conflict-side">
              <p className="mono-label">Could be</p>
              <p className="conflict-name">{name}</p>
              <p className="mono-value">{idLine(cand.externalIds)}</p>
              {cand.sharedIds.length > 0 && (
                <p className="helper">Shared: {cand.sharedIds.join(', ')}</p>
              )}
              {cand.conflictingIds.length > 0 && (
                <p className="helper">Different: {cand.conflictingIds.join(', ')}</p>
              )}
              <button
                type="button"
                className={`button ${c.candidates.length === 1 ? 'button-primary-inline' : 'button-outline'}`}
                disabled={busy}
                aria-label={`Merge ${subject} into ${name}`}
                onClick={() =>
                  void run({ action: 'merge', intoId: cand.id }, `Merged ${subject} into ${name}.`)
                }
              >
                Merge into this one
              </button>
            </section>
          );
        })}
      </div>
      <Alert message={error} />
      <div className="form-actions">
        <button
          type="button"
          className="button button-outline"
          disabled={busy}
          aria-label={`Keep ${subject} separate`}
          onClick={() => void run({ action: 'keep_separate' }, `Kept ${subject} separate.`)}
        >
          Keep separate
        </button>
        <button
          type="button"
          className="button button-outline"
          disabled={busy}
          aria-label={`Dismiss the flag on ${subject}`}
          onClick={() => void run({ action: 'dismiss' }, `Dismissed the flag on ${subject}.`)}
        >
          Dismiss
        </button>
      </div>
    </article>
  );
}
