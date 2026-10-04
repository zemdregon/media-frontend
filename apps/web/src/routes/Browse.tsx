import type { SyntheticEvent } from 'react';
import { listItems, type BrowseFilters, type BrowseSort } from '../api-client/catalog';
import { Alert, PageHead, PosterCard, PosterGrid, SkeletonGrid } from '../components/ui';
import { useRouter } from '../lib/router';
import { usePagedLoad } from '../lib/useLoad';

/** Movies and Shows browse with filters and cursor paging (FR-CAT-002, FR-CAT-003). */

const RESOLUTIONS = [
  { value: '', label: 'Any resolution' },
  { value: '720', label: '720p or better' },
  { value: '1080', label: '1080p or better' },
  { value: '2160', label: '4K' },
];

const SORTS: { value: string; label: string; sort: BrowseSort; order: 'asc' | 'desc' }[] = [
  { value: 'title', label: 'Title', sort: 'title', order: 'asc' },
  { value: 'year', label: 'Year, newest first', sort: 'year', order: 'desc' },
  { value: 'added', label: 'Recently added', sort: 'added', order: 'desc' },
];

const GENRES = [
  'Action',
  'Adventure',
  'Animation',
  'Comedy',
  'Crime',
  'Documentary',
  'Drama',
  'Family',
  'Fantasy',
  'Film-Noir',
  'Horror',
  'Mystery',
  'Romance',
  'Science Fiction',
  'Thriller',
  'War',
  'Western',
];

function num(v: string | null): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function Browse({ type }: { type: 'movie' | 'series' }) {
  const { location, navigate } = useRouter();
  const q = location.search;
  const sortKey = q.get('sort') === 'year' || q.get('sort') === 'added' ? q.get('sort') : 'title';
  const sortDef = SORTS.find((s) => s.value === sortKey) ?? SORTS[0];
  const genre = q.get('genre') ?? '';
  const yearFrom = q.get('yearFrom') ?? '';
  const yearTo = q.get('yearTo') ?? '';
  const minHeight = q.get('minHeight') ?? '';
  const title = type === 'movie' ? 'Movies' : 'Shows';

  const orderParam = q.get('order');
  const filters: BrowseFilters = {
    type,
    sort: sortDef?.sort ?? 'title',
    order: orderParam === 'asc' || orderParam === 'desc' ? orderParam : (sortDef?.order ?? 'asc'),
  };
  if (genre) filters.genre = genre;
  const from = num(yearFrom);
  if (from !== undefined) filters.yearFrom = from;
  const to = num(yearTo);
  if (to !== undefined) filters.yearTo = to;
  const height = num(minHeight);
  if (height !== undefined) filters.minHeight = height;
  const filterKey = JSON.stringify(filters);

  const paged = usePagedLoad(
    (cursor) => listItems(cursor ? { ...filters, cursor } : filters),
    filterKey,
  );
  const items = paged.state.status === 'ready' ? paged.items : null;
  const cursor = paged.cursor;
  const error = paged.state.status === 'error' ? paged.state.message : paged.moreError;
  const loadingMore = paged.busy;

  const apply = (e: SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const next = new URLSearchParams();
    for (const key of ['genre', 'yearFrom', 'yearTo', 'minHeight']) {
      const v = data.get(key);
      if (typeof v === 'string' && v.trim()) next.set(key, v.trim());
    }
    const sort = data.get('sort');
    if (typeof sort === 'string' && sort !== 'title') next.set('sort', sort);
    const qs = next.toString();
    navigate(`${location.path}${qs ? `?${qs}` : ''}`, { replace: true });
  };

  const removeFilter = (...keys: string[]) => {
    const next = new URLSearchParams(q);
    for (const k of keys) next.delete(k);
    const qs = next.toString();
    navigate(`${location.path}${qs ? `?${qs}` : ''}`, { replace: true });
  };

  const chips: { label: string; keys: string[] }[] = [];
  if (genre) chips.push({ label: `Genre: ${genre}`, keys: ['genre'] });
  if (yearFrom) chips.push({ label: `From ${yearFrom}`, keys: ['yearFrom'] });
  if (yearTo) chips.push({ label: `Until ${yearTo}`, keys: ['yearTo'] });
  if (minHeight) {
    const r = RESOLUTIONS.find((x) => x.value === minHeight);
    chips.push({ label: r?.label ?? `${minHeight}p`, keys: ['minHeight'] });
  }

  // Remount the form when the URL filters change so its fields show the applied values.
  const formKey = `${genre}|${yearFrom}|${yearTo}|${minHeight}|${sortKey ?? ''}`;

  return (
    <>
      <PageHead title={title} />
      <form
        key={formKey}
        className="filter-bar"
        onSubmit={apply}
        aria-label={`Filter ${title.toLowerCase()}`}
      >
        <div className="field">
          <label htmlFor="f-genre">Genre</label>
          <input
            id="f-genre"
            name="genre"
            list="f-genres"
            defaultValue={genre}
            autoComplete="off"
          />
          <datalist id="f-genres">
            {GENRES.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
        </div>
        <div className="field field-narrow">
          <label htmlFor="f-from">Year from</label>
          <input
            id="f-from"
            name="yearFrom"
            type="number"
            inputMode="numeric"
            min={1850}
            max={2100}
            defaultValue={yearFrom}
          />
        </div>
        <div className="field field-narrow">
          <label htmlFor="f-to">Year to</label>
          <input
            id="f-to"
            name="yearTo"
            type="number"
            inputMode="numeric"
            min={1850}
            max={2100}
            defaultValue={yearTo}
          />
        </div>
        <div className="field">
          <label htmlFor="f-res">Resolution</label>
          <select id="f-res" name="minHeight" defaultValue={minHeight}>
            {RESOLUTIONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-sort">Sort by</label>
          <select id="f-sort" name="sort" defaultValue={sortKey ?? 'title'}>
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="button button-primary">
          Apply filters
        </button>
      </form>
      {chips.length > 0 && (
        <ul className="chip-row" aria-label="Active filters">
          {chips.map((c) => (
            <li key={c.label}>
              <button
                type="button"
                className="chip-button"
                aria-label={`Remove filter ${c.label}`}
                onClick={() => {
                  removeFilter(...c.keys);
                }}
              >
                {c.label} <span aria-hidden="true">×</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <Alert message={error} onRetry={paged.state.status === 'error' ? paged.reload : undefined} />
      {items === null && !error && <SkeletonGrid label={`Loading ${title.toLowerCase()}`} />}
      {items?.length === 0 && (
        <section className="callout">
          <h2 className="h-card">
            {chips.length > 0 ? 'No titles match these filters.' : `No ${title.toLowerCase()} yet.`}
          </h2>
          {chips.length > 0 ? (
            <button
              type="button"
              className="button button-outline"
              onClick={() => {
                navigate(location.path, { replace: true });
              }}
            >
              Clear filters
            </button>
          ) : (
            <p className="helper">They appear after a server's library is indexed.</p>
          )}
        </section>
      )}
      {items && items.length > 0 && (
        <>
          <p className="sr-only" role="status">
            {items.length} {items.length === 1 ? 'title' : 'titles'} shown
          </p>
          <PosterGrid>
            {items.map((item) => (
              <PosterCard key={item.id} item={item} />
            ))}
          </PosterGrid>
          {cursor && (
            <div className="center">
              <button
                type="button"
                className="button button-outline"
                disabled={loadingMore}
                aria-busy={loadingMore}
                onClick={() => void paged.loadMore()}
              >
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}
