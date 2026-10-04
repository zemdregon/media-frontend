import { useState } from 'react';
import type { ItemCopy, ItemDetail as Detail } from '@cinewren/shared';
import { getChildren, getItem } from '../api-client/catalog';
import {
  Alert,
  PersonChip,
  Poster,
  Segmented,
  SkeletonBlock,
  StatusDot,
  copiesLabel,
  runtimeLabel,
  usePageTitle,
} from '../components/ui';
import { Link } from '../lib/router';
import { useLoad } from '../lib/useLoad';

/** Title detail for movies and episodes, and series detail with seasons (FR-CAT-005, FR-CAT-013). */
export function ItemDetail({ id }: { id: string }) {
  const { state, reload } = useLoad(() => getItem(id), `item:${id}`);
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
          <Poster title={item.title} year={item.year} artworkUrl={item.artworkUrl} />
        </div>
        <div className="detail-text">
          <p className="mono-label">{kindLabel(item)}</p>
          <h1 className="h-title">{item.title}</h1>
          <p className="meta-line">
            {[
              item.year ? String(item.year) : null,
              runtimeLabel(item.runtimeMinutes),
              item.genres.join(', ') || null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
          <VersionsLine item={item} />
          {item.overview && <p className="overview">{item.overview}</p>}
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
      {item.kind === 'series' && <Seasons seriesId={item.id} />}
      {item.kind !== 'series' && item.kind !== 'season' && <CopiesTable copies={item.copies} />}
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

function kindLabel(item: Detail): string {
  switch (item.kind) {
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
function VersionsLine({ item }: { item: Detail }) {
  const servers = `Available from ${String(item.serverCount)} ${item.serverCount === 1 ? 'server' : 'servers'}`;
  return (
    <div className="badge-row">
      {item.versionsSummary.length > 0 && (
        <span className="badge" aria-label={`Versions: ${item.versionsSummary.join(', ')}`}>
          {item.versionsSummary.join(' · ')}
        </span>
      )}
      <span className="chip">{copiesLabel(item.copyCount)}</span>
      <span className="server-count">{servers}</span>
    </div>
  );
}

const PLAYABILITY: Record<string, string> = {
  direct_play: 'Plays as-is in this browser',
  transcode: 'Server converts it for this browser',
  unavailable: 'Unavailable',
};

function mb(bytes: number | null): string {
  if (bytes === null) return 'Unknown';
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

function CopiesTable({ copies }: { copies: ItemCopy[] }) {
  return (
    <section aria-labelledby="copies-h" className="stack">
      <h2 id="copies-h" className="h-section">
        Copies
      </h2>
      {copies.length === 0 ? (
        <p className="helper">No playable copy right now.</p>
      ) : (
        <div className="table-wrap" tabIndex={0} role="region" aria-labelledby="copies-h">
          <table className="copies">
            <thead>
              <tr>
                <th scope="col">Server</th>
                <th scope="col">Video</th>
                <th scope="col">HDR</th>
                <th scope="col">Audio</th>
                <th scope="col">Size</th>
                <th scope="col">On this device</th>
              </tr>
            </thead>
            <tbody>
              {copies.map((c) => {
                const online = c.serverStatus === 'active';
                return (
                  <tr
                    key={`${c.sourceId}-${c.versionId}`}
                    className={c.selected ? 'row-selected' : ''}
                  >
                    <th scope="row">
                      <span className="copy-server">
                        {c.serverName}
                        {c.selected && <span className="best-badge">BEST</span>}
                      </span>
                      {!online && <StatusDot tone="bad" label="Offline" />}
                    </th>
                    <td>
                      {c.resolution?.label ?? 'Unknown'} · {c.videoCodec.toUpperCase()}
                    </td>
                    <td>{c.hdr === 'none' ? 'None' : c.hdr}</td>
                    <td>
                      {c.audio
                        .map((a) => `${a.codec.toUpperCase()} ${String(a.channels)}ch`)
                        .join(', ') || 'Unknown'}
                    </td>
                    <td>{mb(c.sizeBytes)}</td>
                    <td>
                      {c.expectedPlayability
                        ? (PLAYABILITY[c.expectedPlayability] ?? c.expectedPlayability)
                        : 'Checked when you play'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="helper">Playback arrives in a later release.</p>
    </section>
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
      {items.map((ep) => {
        const offline = ep.bestCopy !== null && ep.bestCopy.serverStatus !== 'active';
        const watched = ep.progress?.watched === true;
        return (
          <li key={ep.id} className={offline ? 'episode episode-offline' : 'episode'}>
            <Link to={`/items/${encodeURIComponent(ep.id)}`} className="episode-link">
              <span className="mono-value">
                {ep.episodeNumber !== null && ep.episodeNumber !== undefined
                  ? `E${String(ep.episodeNumber).padStart(2, '0')}`
                  : '·'}
              </span>
              <span className="episode-title">{ep.title}</span>
              <span className="meta-line">{runtimeLabel(ep.runtimeMinutes) ?? ''}</span>
              {watched && <span className="chip">Watched</span>}
              {offline && <StatusDot tone="bad" label="Offline" />}
              <span className="chip">{copiesLabel(ep.copyCount)}</span>
            </Link>
          </li>
        );
      })}
    </ol>
  );
}
