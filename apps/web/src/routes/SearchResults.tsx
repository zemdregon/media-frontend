import { useState } from 'react';
import type { CollectionCard, ItemCard, Page, PersonCard, SearchResponse } from '@cinewren/shared';
import { search, type SearchKind } from '../api-client/catalog';
import {
  Alert,
  CollectionTile,
  PersonChip,
  PosterCard,
  PosterGrid,
  SkeletonGrid,
  usePageTitle,
} from '../components/ui';
import { useRouter } from '../lib/router';
import { errorMessage, useLoad } from '../lib/useLoad';

/** Grouped search results: titles, people, collections (FR-CAT-004, FR-CAT-011, FR-CAT-012). */
export function SearchResults() {
  const { location } = useRouter();
  const q = (location.search.get('q') ?? '').trim();
  usePageTitle(q ? `Results for ${q}` : 'Search');
  const { state, reload } = useLoad(() => search(q), `search:${q}`);
  const data = q && state.status === 'ready' ? state.data : null;
  const error = state.status === 'error' ? state.message : null;

  if (!q) {
    return (
      <>
        <h1 className="h-display">Search</h1>
        <p className="helper">Type a title, a person or a collection in the search field.</p>
      </>
    );
  }

  const total = data
    ? data.titles.items.length + data.people.items.length + data.collections.items.length
    : 0;
  const more =
    data?.titles.nextCursor || data?.people.nextCursor || data?.collections.nextCursor ? '+' : '';

  return (
    <>
      <h1 className="h-display">Results for “{q}”</h1>
      <p className="sr-only" role="status" aria-live="polite">
        {data ? `${String(total)}${more} results` : 'Searching'}
      </p>
      <Alert message={error} onRetry={reload} />
      {!data && !error && <SkeletonGrid label="Searching" />}
      {data && total === 0 && (
        <section className="callout">
          <h2 className="h-card">Nothing matches “{q}”.</h2>
          <p className="helper">Try fewer letters or another spelling.</p>
        </section>
      )}
      {data && data.titles.items.length > 0 && (
        <Group<ItemCard>
          heading="Titles"
          q={q}
          kind="title"
          initial={data.titles}
          pick={(r) => r.titles}
          render={(items) => (
            <PosterGrid>
              {items.map((item) => (
                <PosterCard key={item.id} item={item} />
              ))}
            </PosterGrid>
          )}
        />
      )}
      {data && data.people.items.length > 0 && (
        <Group<PersonCard>
          heading="People"
          q={q}
          kind="person"
          initial={data.people}
          pick={(r) => r.people}
          render={(items) => (
            <ul className="chip-row">
              {items.map((p) => (
                <li key={p.id}>
                  <PersonChip person={p} />
                </li>
              ))}
            </ul>
          )}
        />
      )}
      {data && data.collections.items.length > 0 && (
        <Group<CollectionCard>
          heading="Collections"
          q={q}
          kind="collection"
          initial={data.collections}
          pick={(r) => r.collections}
          render={(items) => (
            <div className="collection-grid">
              {items.map((c) => (
                <CollectionTile key={c.id} collection={c} />
              ))}
            </div>
          )}
        />
      )}
    </>
  );
}

function Group<T>({
  heading,
  q,
  kind,
  initial,
  pick,
  render,
}: {
  heading: string;
  q: string;
  kind: SearchKind;
  initial: Page<T>;
  pick: (r: SearchResponse) => Page<T>;
  render: (items: T[]) => React.ReactNode;
}) {
  const [items, setItems] = useState(initial.items);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = `grp-${kind}`;

  const more = async () => {
    setBusy(true);
    setError(null);
    try {
      const page = pick(await search(q, kind, cursor));
      setItems((cur) => [...cur, ...page.items]);
      setCursor(page.nextCursor);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby={id} className="stack">
      <h2 id={id} className="mono-label mono-heading">
        {heading}{' '}
        <span className="count">
          {items.length}
          {cursor ? '+' : ''}
        </span>
      </h2>
      {render(items)}
      <Alert message={error} />
      {cursor && (
        <div>
          <button
            type="button"
            className="button button-outline"
            disabled={busy}
            aria-busy={busy}
            onClick={() => void more()}
          >
            {busy ? 'Loading…' : `See all ${heading.toLowerCase()}`}
          </button>
        </div>
      )}
    </section>
  );
}
