import { useState } from 'react';
import type {
  CollectionDetail,
  ItemCard,
  Page,
  PersonCredit,
  PersonDetail,
} from '@cinewren/shared';
import { getCollection, getPerson, listCollections } from '../api-client/catalog';
import {
  Alert,
  CollectionTile,
  EmptyState,
  PageHead,
  PosterCard,
  PosterGrid,
  SkeletonBlock,
  SkeletonGrid,
  initials,
  usePageTitle,
} from '../components/ui';
import { Link } from '../lib/router';
import { errorMessage, useLoad, type Loaded } from '../lib/useLoad';

function NotFound({ what }: { what: string }) {
  return (
    <section className="callout">
      <h1 className="h-display">{what} not found</h1>
      <p className="helper">It may have been removed, or you may not have access to it.</p>
      <Link to="/" className="button button-outline">
        Back to Home
      </Link>
    </section>
  );
}

/** Appends pages to a list: first page from the loader, the rest from `more` (cursor paging). */
function usePaged<T>(first: Page<T>, fetchMore: (cursor: string) => Promise<Page<T>>) {
  const [items, setItems] = useState(first.items);
  const [cursor, setCursor] = useState(first.nextCursor);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const more = async () => {
    if (!cursor) return;
    setBusy(true);
    setError(null);
    try {
      const page = await fetchMore(cursor);
      setItems((cur) => [...cur, ...page.items]);
      setCursor(page.nextCursor);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return { items, cursor, busy, error, more };
}

function LoadMore({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  return (
    <div className="center">
      <button
        type="button"
        className="button button-outline"
        disabled={busy}
        aria-busy={busy}
        onClick={onClick}
      >
        {busy ? 'Loading…' : 'Load more'}
      </button>
    </div>
  );
}

/** Person page: header and the visible titles with the role (FR-CAT-011, ADR-0015). */
export function PersonPage({ id }: { id: string }) {
  const { state, reload } = useLoad(() => getPerson(id), `person:${id}`);
  return (
    <Resolved
      state={state}
      reload={reload}
      what="Person"
      render={(p) => <PersonBody person={p} />}
    />
  );
}

function PersonBody({ person }: { person: PersonDetail }) {
  usePageTitle(person.name);
  const paged = usePaged<PersonCredit>(
    person.credits,
    async (cursor) => (await getPerson(person.id, cursor)).credits,
  );
  const roles = [...new Set(paged.items.map((c) => c.role))].join(', ');
  return (
    <>
      <header className="person-head">
        <span className="avatar" aria-hidden="true">
          {initials(person.name)}
        </span>
        <div>
          <h1 className="h-display">{person.name}</h1>
          {roles && <p className="mono-label">{roles}</p>}
        </div>
      </header>
      {paged.items.length === 0 ? (
        <EmptyState title="No titles to show">
          This person has no visible titles for you.
        </EmptyState>
      ) : (
        <section aria-labelledby="credits-h" className="stack">
          <h2 id="credits-h" className="h-section">
            Titles
          </h2>
          <PosterGrid>
            {paged.items.map((c) => (
              <PosterCard
                key={`${c.item.id}-${c.role}-${c.character ?? ''}`}
                item={c.item}
                extra={c.character ? `as ${c.character}` : c.role}
              />
            ))}
          </PosterGrid>
          <Alert message={paged.error} />
          {paged.cursor && <LoadMore busy={paged.busy} onClick={() => void paged.more()} />}
        </section>
      )}
    </>
  );
}

/** Collections browse (FR-CAT-012). */
export function CollectionsPage() {
  const { state, reload } = useLoad(() => listCollections(), 'collections');
  return (
    <>
      <PageHead title="Collections" />
      {state.status === 'loading' && <SkeletonGrid count={6} label="Loading collections" />}
      {state.status === 'error' && <Alert message={state.message} onRetry={reload} />}
      {state.status === 'ready' && <CollectionList first={state.data} />}
    </>
  );
}

function CollectionList({
  first,
}: {
  first: Page<{ id: string; name: string; artworkUrl: string | null; serverLabel?: string }>;
}) {
  const paged = usePaged(first, (cursor) => listCollections(cursor));
  if (paged.items.length === 0) {
    return (
      <EmptyState title="No collections yet.">
        They appear after a server's library is indexed.
      </EmptyState>
    );
  }
  return (
    <>
      <div className="collection-grid">
        {paged.items.map((c) => (
          <CollectionTile key={c.id} collection={c} />
        ))}
      </div>
      <Alert message={paged.error} />
      {paged.cursor && <LoadMore busy={paged.busy} onClick={() => void paged.more()} />}
    </>
  );
}

/** One collection and its visible members (FR-CAT-012). */
export function CollectionPage({ id }: { id: string }) {
  const { state, reload } = useLoad(() => getCollection(id), `collection:${id}`);
  return (
    <Resolved
      state={state}
      reload={reload}
      what="Collection"
      render={(c) => <CollectionBody collection={c} />}
    />
  );
}

function CollectionBody({ collection }: { collection: CollectionDetail }) {
  usePageTitle(collection.name);
  const paged = usePaged<ItemCard>(
    collection.members,
    async (cursor) => (await getCollection(collection.id, cursor)).members,
  );
  const servers = new Set(paged.items.map((i) => i.bestCopy?.serverName).filter(Boolean)).size;
  return (
    <>
      <header className="stack">
        <p className="mono-label">Collection</p>
        <h1 className="h-display">{collection.name}</h1>
        <p className="meta-line">
          {paged.items.length} {paged.items.length === 1 ? 'title' : 'titles'}
          {servers > 0 ? ` on ${String(servers)} ${servers === 1 ? 'server' : 'servers'}` : ''}
        </p>
        {collection.overview && <p className="overview">{collection.overview}</p>}
      </header>
      {paged.items.length === 0 ? (
        <EmptyState title="No titles to show">
          This collection has no visible titles for you.
        </EmptyState>
      ) : (
        <>
          <PosterGrid>
            {paged.items.map((item) => (
              <PosterCard key={item.id} item={item} />
            ))}
          </PosterGrid>
          <Alert message={paged.error} />
          {paged.cursor && <LoadMore busy={paged.busy} onClick={() => void paged.more()} />}
        </>
      )}
    </>
  );
}

function Resolved<T>({
  state,
  reload,
  what,
  render,
}: {
  state: Loaded<T>;
  reload: () => void;
  what: string;
  render: (data: T) => React.ReactNode;
}) {
  if (state.status === 'loading') return <SkeletonBlock label={`Loading ${what.toLowerCase()}`} />;
  if (state.status === 'error') {
    return state.code === 'NOT_FOUND' ? (
      <NotFound what={what} />
    ) : (
      <Alert message={state.message} onRetry={reload} />
    );
  }
  return <>{render(state.data)}</>;
}
