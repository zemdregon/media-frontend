import type { ContinueItem } from '../api-client/playback-types';
import { getHome } from '../api-client/catalog';
import {
  Alert,
  PageHead,
  PosterCard,
  PosterGrid,
  SkeletonGrid,
  runtimeLabel,
} from '../components/ui';
import { secondsLabel } from '../lib/reasons';
import { Link } from '../lib/router';
import { useLoad } from '../lib/useLoad';

/** Library home: continue watching hero (M3) and recently added (FR-CAT-008). */
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

/** Continue-watching hero cards (UX §6; FR-CAT-008, FR-PROG-001). Not rendered when empty. */
function ContinueWatching({ items }: { items: ContinueItem[] }) {
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="cw-h" className="stack">
      <h2 id="cw-h" className="h-section">
        Continue watching
      </h2>
      <div className="hero-row">
        {items.map((item) => (
          <ContinueHero key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}

function ContinueHero({ item }: { item: ContinueItem }) {
  const pos = item.progress?.positionMs ?? 0;
  const total = item.runtimeMs ?? 0;
  const percent = total > 0 ? Math.min(100, Math.max(0, Math.round((pos / total) * 100))) : null;
  const left = total > 0 ? runtimeLabel(Math.max(0, total - pos)) : null;
  const via = item.resumeSource
    ? `resuming from ${item.resumeSource.serverName}${item.resumeSource.mode ? `, ${item.resumeSource.mode.replace(/_/g, ' ')}` : ''}`
    : `resuming from ${secondsLabel(pos / 1000)}`;
  const label = [item.title, item.year ? String(item.year) : null].filter(Boolean).join(', ');
  const href = encodeURIComponent(item.id);
  return (
    <article className="hero" aria-label={label}>
      <div className="hero-art">
        {item.artworkUrl ? (
          <img src={item.artworkUrl} alt="" loading="lazy" className="hero-img" />
        ) : (
          <span className="hero-art-title" aria-hidden="true">
            {item.title}
          </span>
        )}
        {percent !== null && (
          <div
            className="hero-progress"
            role="progressbar"
            aria-label={`${String(percent)}% watched`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <span style={{ width: `${String(percent)}%` }} />
          </div>
        )}
      </div>
      <div className="hero-body">
        <p className="mono-label">Continue watching</p>
        <h3 className="h-title">{item.title}</h3>
        <p className="meta-line">
          {[item.year ? String(item.year) : null, left ? `${left} left` : null, via]
            .filter(Boolean)
            .join(' · ')}
        </p>
        <div className="actions">
          <Link to={`/watch/${href}?resume=1`} className="button button-primary">
            Resume
          </Link>
          <Link to={`/items/${href}`} className="button button-outline">
            Choose another copy
          </Link>
        </div>
      </div>
    </article>
  );
}
