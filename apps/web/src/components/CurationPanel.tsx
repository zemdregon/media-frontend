import { useId, useState, type SyntheticEvent } from 'react';
import type { EntityKind } from '@cinewren/shared';
import { search } from '../api-client/catalog';
import { getCurationEntity, mergeEntities, splitEntity } from '../api-client/curation';
import { useRouter } from '../lib/router';
import { errorMessage, useLoad } from '../lib/useLoad';
import { Alert, SkeletonBlock } from './ui';

/**
 * Operator merge and split on a detail page (WF-9, FR-CAT-007; UX §5 "Operator: curation").
 * The page's own title, person or collection survives a merge; the one picked from search folds
 * into it. A split detaches one provider record into an entry of its own. Both are kept across
 * future indexing (BR-3).
 */

const WORDS: Record<
  EntityKind,
  { one: string; record: string; path: string; search: 'title' | 'person' | 'collection' }
> = {
  item: { one: 'title', record: 'source', path: 'items', search: 'title' },
  person: { one: 'person', record: 'provider record', path: 'people', search: 'person' },
  collection: {
    one: 'collection',
    record: 'provider record',
    path: 'collections',
    search: 'collection',
  },
};

interface Pick {
  id: string;
  name: string;
}

export function CurationPanel({
  kind,
  id,
  onChanged,
}: {
  kind: EntityKind;
  id: string;
  /** Called after a merge, so the page reloads what the merge changed. */
  onChanged: () => void;
}) {
  const w = WORDS[kind];
  const { navigate } = useRouter();
  const { state, reload } = useLoad(() => getCurationEntity(kind, id), `curation:${kind}:${id}`);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Pick[] | null>(null);
  const [picked, setPicked] = useState<Pick | null>(null);
  const searchId = useId();
  const headingId = useId();

  const find = async (e: SyntheticEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    setError(null);
    setPicked(null);
    try {
      const r = await search(q, w.search);
      const hits =
        kind === 'item'
          ? r.titles.items.map((t) => ({
              id: t.id,
              name: t.title + (t.year ? ` (${String(t.year)})` : ''),
            }))
          : kind === 'person'
            ? r.people.items.map((p) => ({ id: p.id, name: p.name }))
            : r.collections.items.map((c) => ({ id: c.id, name: c.name }));
      setResults(hits.filter((h) => h.id !== id));
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const merge = async () => {
    if (!picked || state.status !== 'ready') return;
    setBusy(true);
    setError(null);
    try {
      await mergeEntities(kind, id, picked.id);
      setNotice(`Merged ${picked.name} into ${state.data.name}.`);
      setPicked(null);
      setResults(null);
      setQuery('');
      reload();
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const split = async (recordId: string, label: string) => {
    setBusy(true);
    setError(null);
    try {
      const { newId } = await splitEntity(kind, id, recordId);
      setNotice(`Split ${label} out into its own ${w.one}.`);
      reload();
      onChanged();
      navigate(`/${w.path}/${encodeURIComponent(newId)}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby={headingId} className="stack curation-panel">
      <h2 id={headingId} className="h-section">
        Curation
      </h2>
      <p className="helper">This choice is kept across future indexing.</p>
      <Alert tone="info" message={notice} />
      <Alert message={error} />
      {state.status === 'loading' && <SkeletonBlock label="Loading provider records" />}
      {state.status === 'error' && <Alert message={state.message} onRetry={reload} />}
      {state.status === 'ready' && (
        <>
          <div className="table-wrap">
            <table className="copies">
              <caption className="sr-only">Provider records of {state.data.name}</caption>
              <thead>
                <tr>
                  <th scope="col">Server</th>
                  <th scope="col">Its name for it</th>
                  <th scope="col">State</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {state.data.records.map((r) => {
                  const label = `${r.name} from ${r.serverName}`;
                  const only = state.data.records.length < 2;
                  return (
                    <tr key={r.id}>
                      <th scope="row">
                        {r.serverName} <span className="type-tag">{r.serverType}</span>
                      </th>
                      <td>{r.name + (r.year ? ` (${String(r.year)})` : '')}</td>
                      <td>
                        {r.status === 'missing' ? 'No longer listed' : 'Listed'}
                        {r.manual ? ', set by hand' : ''}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="button button-outline"
                          disabled={busy || only}
                          aria-label={`Split out ${label}`}
                          title={
                            only ? `The only ${w.record}, so there is nothing to split` : undefined
                          }
                          onClick={() => void split(r.id, label)}
                        >
                          Split out
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {state.data.records.length < 2 && (
            <p className="helper">
              With one {w.record} there is nothing to split. Merge another {w.one} in to add more.
            </p>
          )}

          <form role="search" className="stack" onSubmit={(e) => void find(e)}>
            <div className="field">
              <label htmlFor={searchId}>Merge another {w.one} into this one</label>
              <input
                id={searchId}
                type="search"
                value={query}
                maxLength={100}
                placeholder={`Search for the ${w.one} that should disappear`}
                onChange={(e) => {
                  setQuery(e.target.value);
                }}
              />
            </div>
            <div className="form-actions">
              <button type="submit" className="button button-outline" disabled={busy}>
                Find
              </button>
            </div>
          </form>
          {results !== null &&
            (results.length === 0 ? (
              <p className="helper">Nothing matches that. Try fewer letters or another spelling.</p>
            ) : (
              <ul className="chip-row" aria-label="Search results">
                {results.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      className="button button-outline"
                      aria-pressed={picked?.id === r.id}
                      onClick={() => {
                        setPicked(r);
                      }}
                    >
                      {r.name}
                    </button>
                  </li>
                ))}
              </ul>
            ))}
          {picked && (
            <div className="callout" role="group" aria-label="Merge preview">
              <p>
                <strong>{picked.name}</strong> will be merged into{' '}
                <strong>{state.data.name}</strong>. Its {w.record}s will join this {w.one} and the
                other entry will disappear.
              </p>
              <div className="form-actions">
                <button
                  type="button"
                  className="button button-primary-inline"
                  disabled={busy}
                  onClick={() => void merge()}
                >
                  Merge
                </button>
                <button
                  type="button"
                  className="button button-outline"
                  onClick={() => {
                    setPicked(null);
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
