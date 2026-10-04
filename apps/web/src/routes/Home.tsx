import type { ItemCard } from '@cinewren/shared';
import { getHome } from '../api-client/catalog';
import {
  Alert,
  PageHead,
  PosterCard,
  PosterGrid,
  SkeletonGrid,
  copiesLabel,
} from '../components/ui';
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

function percent(item: ItemCard): number {
  const p = item.progress;
  if (!p || p.durationMs <= 0) return 0;
  return Math.min(100, Math.round((p.positionMs / p.durationMs) * 100));
}

/**
 * Continue-watching hero row (UX §6). Playback and progress arrive in M3, so until the API sends
 * items this is a quiet placeholder rather than an empty hero.
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
    <div className="hero-row">
      {items.map((item) => {
        const pct = percent(item);
        const left = item.progress
          ? Math.max(0, Math.round((item.progress.durationMs - item.progress.positionMs) / 60000))
          : null;
        return (
          <section key={item.id} aria-labelledby={`cw-${item.id}`} className="hero">
            <div className="hero-art">
              <span className="hero-art-title" aria-hidden="true">
                {item.title}
              </span>
              <div
                className="hero-progress"
                role="progressbar"
                aria-label={`${String(pct)}% watched`}
                aria-valuenow={pct}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <span style={{ width: `${String(pct)}%` }} />
              </div>
            </div>
            <div className="hero-body">
              <h2 id={`cw-${item.id}`} className="mono-label">
                Continue watching
              </h2>
              <p className="h-hero">
                {item.title}
                {item.year ? <span className="muted"> ({item.year})</span> : null}
              </p>
              <p>
                {left !== null ? `${String(left)} min left · ` : ''}
                {item.bestCopy ? `from ${item.bestCopy.serverName}` : copiesLabel(item.copyCount)}
              </p>
              <div className="actions">
                <Link
                  to={`/items/${encodeURIComponent(item.id)}`}
                  className="button button-primary"
                >
                  Open
                </Link>
              </div>
            </div>
          </section>
        );
      })}
    </div>
  );
}
