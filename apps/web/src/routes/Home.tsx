import type { ItemCard } from '@cinewren/shared';
import { getHome } from '../api-client/catalog';
import { Alert, PageHead, PosterCard, PosterGrid, SkeletonGrid } from '../components/ui';
import { Link } from '../lib/router';
import { useLoad } from '../lib/useLoad';

/** Library home: continue watching (placeholder until M3) and recently added (FR-CAT-008). */
export function Home() {
  const { state, reload } = useLoad(getHome, 'home');
  return (
    <>
      <PageHead title="Home" />
      {state.status === 'loading' && <SkeletonGrid label="Loading your library" />}
      {state.status === 'error' && <Alert message={state.message} onRetry={reload} />}
      {state.status === 'ready' && (
        <>
          <ContinueWatching items={state.data.continueWatching} />
          <section aria-labelledby="recent-h" className="stack">
            <div className="section-head">
              <h2 id="recent-h" className="h-section">
                Recently added, across every server
              </h2>
              <Link to="/movies?sort=added&order=desc" className="link-strong">
                See all
              </Link>
            </div>
            {state.data.recentlyAdded.length === 0 ? (
              <p className="helper">
                No titles yet. They appear after an operator adds a server and its library is
                indexed.
              </p>
            ) : (
              <PosterGrid>
                {state.data.recentlyAdded.map((item) => (
                  <PosterCard key={item.id} item={item} />
                ))}
              </PosterGrid>
            )}
          </section>
        </>
      )}
    </>
  );
}

/**
 * Continue-watching row (UX §6). Playback and progress arrive in M3, so the API returns an empty
 * list until then and this is a quiet placeholder. Nothing is invented from missing progress.
 */
function ContinueWatching({ items }: { items: ItemCard[] }) {
  if (items.length === 0) {
    return (
      <section aria-labelledby="cw-h" className="callout">
        <h2 id="cw-h" className="mono-label">
          Continue watching
        </h2>
        <p className="helper">
          Titles you start will appear here. Playback arrives in a later release.
        </p>
      </section>
    );
  }
  return (
    <section aria-labelledby="cw-h" className="stack">
      <h2 id="cw-h" className="h-section">
        Continue watching
      </h2>
      <PosterGrid>
        {items.map((item) => (
          <PosterCard key={item.id} item={item} />
        ))}
      </PosterGrid>
    </section>
  );
}
