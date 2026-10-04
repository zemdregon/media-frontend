import { useState } from 'react';
import type { ItemDetailWithCopies } from '@cinewren/shared';
import { getChildren, getItem } from '../api-client/catalog';
import { getNextEpisode, setWatched } from '../api-client/playback';
import { CopiesPicker, copyKey } from '../components/CopiesPicker';
import { capsHeaders } from '../lib/capabilities';
import { playabilityLabel, secondsLabel } from '../lib/reasons';
import {
  Alert,
  PersonChip,
  Poster,
  Segmented,
  SkeletonBlock,
  StatusDot,
  runtimeLabel,
  usePageTitle,
} from '../components/ui';
import { Link } from '../lib/router';
import { useLoad } from '../lib/useLoad';

/** Title detail for movies and episodes, and series detail with seasons (FR-CAT-005, FR-CAT-013). */
export function ItemDetail({ id }: { id: string }) {
  // The device capabilities ride along as X-Device-Caps so the copy table is per device (FR-PLAY-002).
  const { state, reload } = useLoad(async () => getItem(id, await capsHeaders()), `item:${id}`);
  usePageTitle(state.status === 'ready' ? state.data.title : 'Title');

  if (state.status === 'loading') return <SkeletonBlock label="Loading title" />;
  if (state.status === 'error') {
    return state.code === 'NOT_FOUND' ? (
      <section className="callout">
        <h1 className="h-display">Title not found</h1>
        <p className="helper">It may have been removed, or you may not have access to it.</p>
        <Link to="/" className="button button-outline">
          Back to Home
        </Link>
      </section>
    ) : (
      <Alert message={state.message} onRetry={reload} />
    );
  }
  const item = state.data;
  return (
    <article className="detail">
      <div className="detail-head">
        <div className="detail-poster">
          <Poster title={item.title} year={item.year} artworkUrl={item.artwork.poster} />
        </div>
        <div className="detail-text">
          <p className="mono-label">{kindLabel(item)}</p>
          <h1 className="h-title">{item.title}</h1>
          <p className="meta-line">
            {[
              item.year ? String(item.year) : null,
              runtimeLabel(item.runtimeMs),
              item.genres.join(', ') || null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
          <VersionsLine item={item} />
          {item.overview && <p className="overview">{item.overview}</p>}
          {item.type === 'series' && <NextEpisode seriesId={item.id} />}
          {item.collections.length > 0 && (
            <p className="meta-line">
              Part of{' '}
              {item.collections.map((c, i) => (
                <span key={c.id}>
                  {i > 0 && ', '}
                  <Link to={`/collections/${encodeURIComponent(c.id)}`}>{c.name}</Link>
                </span>
              ))}
            </p>
          )}
        </div>
      </div>
      {item.type === 'series' && <Seasons seriesId={item.id} />}
      {item.type !== 'series' && item.type !== 'season' && <Playable item={item} />}
      {item.cast.length > 0 && (
        <section aria-labelledby="cast-h" className="stack">
          <h2 id="cast-h" className="h-section">
            Cast
          </h2>
          <ul className="chip-row">
            {item.cast.map((c) => (
              <li key={`${c.person.id}-${c.role}-${c.character ?? ''}`}>
                <PersonChip person={c.person} role={c.character ?? c.role} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}

function kindLabel(item: ItemDetailWithCopies): string {
  switch (item.type) {
    case 'series':
      return 'Series';
    case 'season':
      return 'Season';
    case 'episode':
      return 'Episode';
    default:
      return 'Movie';
  }
}

/** Versions badge and "Available from N servers" (FR-CAT-005). */
function VersionsLine({ item }: { item: ItemDetailWithCopies }) {
  const servers = `Available from ${String(item.serverCount)} ${item.serverCount === 1 ? 'server' : 'servers'}`;
  return (
    <div className="badge-row">
      {item.versionsSummary.length > 0 && (
        <span className="badge" aria-label={`Versions: ${item.versionsSummary.join(', ')}`}>
          {item.versionsSummary.join(' · ')}
        </span>
      )}
      <span className="server-count">{servers}</span>
    </div>
  );
}

/**
 * Play controls and the copies radiogroup for a movie or episode (FR-CAT-013, FR-PLAY-005).
 * `copies` comes with the item (`ItemDetailWithCopies`), one row per visible copy.
 */
function Playable({ item }: { item: ItemDetailWithCopies }) {
  const [picked, setPicked] = useState<string | null>(null);
  const [watched, setWatchedState] = useState(item.progress?.watched ?? false);
  const [busy, setBusy] = useState(false);
  const [markError, setMarkError] = useState<string | null>(null);

  const copies = item.copies;
  const auto = copies.find((c) => c.selected) ?? copies[0];
  const current = copies.find((c) => copyKey(c) === picked) ?? auto;
  const overridden = current && auto && copyKey(current) !== copyKey(auto);
  const playable = current !== undefined && current.expectedPlayability !== 'unavailable';

  const playHref =
    `/watch/${encodeURIComponent(item.id)}` +
    (overridden
      ? `?sourceId=${encodeURIComponent(current.sourceId)}&versionId=${encodeURIComponent(current.versionId)}`
      : '');
  const mode = current ? playabilityLabel(current.expectedPlayability).text : '';
  const resumeFrom =
    item.progress && !item.progress.watched && item.progress.positionMs > 60_000
      ? item.progress.positionMs
      : null;

  const mark = async () => {
    setBusy(true);
    setMarkError(null);
    try {
      const r = await setWatched(item.id, !watched);
      setWatchedState(r.watched);
    } catch (e) {
      setMarkError(e instanceof Error ? e.message : 'Could not update watched state.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="actions" role="group" aria-label="Playback">
        {playable ? (
          <Link to={playHref} className="button button-primary">
            <PlayGlyph />
            Play from {current.serverName}
          </Link>
        ) : (
          <button type="button" className="button button-primary" disabled>
            <PlayGlyph />
            {current ? 'Unavailable right now' : 'No playable copy'}
          </button>
        )}
        {current && playable && <span className="helper">{mode}</span>}
        <button
          type="button"
          className="button button-outline"
          aria-pressed={watched}
          disabled={busy}
          onClick={() => void mark()}
        >
          {watched ? 'Mark as unwatched' : 'Mark as watched'}
        </button>
        {watched && <StatusDot tone="ok" label="Watched" />}
        {resumeFrom !== null && !watched && (
          <span className="helper">Resume from {secondsLabel(resumeFrom / 1000)}</span>
        )}
      </div>
      {markError && <Alert message={markError} />}
      <section aria-labelledby="copies-h" className="stack">
        <h2 id="copies-h" className="h-section">
          Copies
        </h2>
        {copies.length === 0 ? (
          <p className="helper">No playable copy right now.</p>
        ) : (
          <CopiesPicker
            copies={copies}
            value={current ? copyKey(current) : null}
            onChange={setPicked}
            labelledBy="copies-h"
          />
        )}
      </section>
    </>
  );
}

function PlayGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
      <path d="M3 1.5 L12.5 7 L3 12.5 Z" fill="currentColor" />
    </svg>
  );
}

/** "Play next episode" for a series: the first unwatched episode after the last watched (FR-PROG-004). */
function NextEpisode({ seriesId }: { seriesId: string }) {
  const { state } = useLoad(() => getNextEpisode(seriesId), `next:${seriesId}`);
  if (state.status !== 'ready' || !state.data) return null;
  const ep = state.data;
  const code =
    ep.seasonNumber !== null && ep.episodeNumber !== null
      ? `S${String(ep.seasonNumber)} E${String(ep.episodeNumber)}`
      : null;
  return (
    <div className="actions">
      <Link to={`/watch/${encodeURIComponent(ep.id)}`} className="button button-primary">
        <PlayGlyph />
        {code ? `Play ${code}` : 'Play next episode'}
      </Link>
      <span className="helper">{ep.title}</span>
    </div>
  );
}

/** Seasons as a segmented selector and the selected season's episodes (UX §5 "Series detail"). */
function Seasons({ seriesId }: { seriesId: string }) {
  const { state, reload } = useLoad(() => getChildren(seriesId), `seasons:${seriesId}`);
  const [season, setSeason] = useState<string | null>(null);

  if (state.status === 'loading') return <SkeletonBlock label="Loading seasons" />;
  if (state.status === 'error') return <Alert message={state.message} onRetry={reload} />;
  const seasons = state.data.items;
  if (seasons.length === 0) {
    return <p className="helper">No episodes are available yet.</p>;
  }
  const current = seasons.find((s) => s.id === season) ?? seasons[0];
  if (!current) return null;
  return (
    <section aria-labelledby="eps-h" className="stack">
      <h2 id="eps-h" className="h-section">
        Seasons and episodes
      </h2>
      <Segmented
        legend="Season"
        hideLegend
        value={current.id}
        options={seasons.map((s) => ({
          value: s.id,
          label: s.seasonNumber ? `Season ${String(s.seasonNumber)}` : s.title,
        }))}
        onChange={setSeason}
      />
      <Episodes key={current.id} seasonId={current.id} />
    </section>
  );
}

function Episodes({ seasonId }: { seasonId: string }) {
  const { state, reload } = useLoad(() => getChildren(seasonId), `episodes:${seasonId}`);
  const error = state.status === 'error' ? state.message : null;
  const items = state.status === 'ready' ? state.data.items : null;

  if (error) {
    return <Alert message={error} onRetry={reload} />;
  }
  if (!items) return <SkeletonBlock label="Loading episodes" />;
  if (items.length === 0) return <p className="helper">No episodes in this season.</p>;
  return (
    <ol className="episodes">
      {items.map((ep) => (
        <li key={ep.id} className="episode">
          <Link to={`/items/${encodeURIComponent(ep.id)}`} className="episode-link">
            <span className="mono-value">
              {ep.episodeNumber !== null ? `E${String(ep.episodeNumber).padStart(2, '0')}` : '·'}
            </span>
            <span className="episode-title">{ep.title}</span>
          </Link>
        </li>
      ))}
    </ol>
  );
}
