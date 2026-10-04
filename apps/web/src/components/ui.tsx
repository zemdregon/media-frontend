/** Shared presentational components (UX §6). Colours come from tokens only (see app.css). */
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type CSSProperties,
} from 'react';
import type { CollectionCard, ItemCard, PersonCard } from '@cinewren/shared';
import { Link } from '../lib/router';

export function runtimeLabel(ms: number | null | undefined): string | null {
  if (!ms || ms <= 0) return null;
  const min = Math.round(ms / 60000);
  if (min <= 0) return null;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${String(h)} h ${String(m)} min` : `${String(m)} min`;
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0] ?? '';
  if (words.length === 1) return first.slice(0, 1).toUpperCase();
  return (first.slice(0, 1) + (words[1] ?? '').slice(0, 1)).toUpperCase();
}

/** Sets the document title (and so the tab title and screen-reader page name). */
export function usePageTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} · Cinewren`;
  }, [title]);
}

function hueOf(text: string): number {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

export function Alert({
  message,
  onRetry,
  tone = 'error',
}: {
  message: string | null;
  onRetry?: (() => void) | undefined;
  tone?: 'error' | 'info';
}) {
  if (!message) return null;
  return (
    <div className={`alert alert-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <p>{message}</p>
      {onRetry && (
        <button type="button" className="button button-outline" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function StatusDot({
  tone,
  label,
}: {
  tone: 'ok' | 'warn' | 'bad' | 'muted';
  label: string;
}) {
  return (
    <span className="status-line">
      <span className={`dot dot-${tone}`} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

export function SkeletonGrid({ count = 8, label = 'Loading' }: { count?: number; label?: string }) {
  return (
    <div className="poster-grid" role="status" aria-label={label} aria-busy="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skeleton-card" aria-hidden="true">
          <div className="skeleton skeleton-poster" />
          <div className="skeleton skeleton-line" />
          <div className="skeleton skeleton-line skeleton-short" />
        </div>
      ))}
    </div>
  );
}

export function SkeletonBlock({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" aria-label={label} aria-busy="true" className="skeleton-stack">
      <div className="skeleton skeleton-title" />
      <div className="skeleton skeleton-line" />
      <div className="skeleton skeleton-line skeleton-short" />
    </div>
  );
}

/** Poster 2:3 with tinted fallback fill and the title; real artwork covers it when it loads. */
export function Poster({
  title,
  year,
  artworkUrl,
  wide,
}: {
  title: string;
  year?: number | null;
  artworkUrl: string | null;
  wide?: boolean;
}) {
  const [broken, setBroken] = useState(false);
  const showImg = artworkUrl !== null && !broken;
  const style = { '--cw-hue': hueOf(title) } as CSSProperties;
  return (
    <div className={`poster${wide ? ' poster-wide' : ''}`} style={style}>
      {showImg ? (
        <img
          src={artworkUrl}
          alt=""
          loading="lazy"
          onError={() => {
            setBroken(true);
          }}
        />
      ) : (
        <span className="poster-title" aria-hidden="true">
          {title}
        </span>
      )}
      {year ? (
        <span className="poster-year" aria-hidden="true">
          {year}
        </span>
      ) : null}
    </div>
  );
}

export function PosterCard({ item, extra }: { item: ItemCard; extra?: string | null }) {
  const label = [item.title, item.year ? String(item.year) : null].filter(Boolean).join(', ');
  return (
    <Link to={`/items/${encodeURIComponent(item.id)}`} className="poster-card" aria-label={label}>
      <Poster title={item.title} year={item.year} artworkUrl={item.artworkUrl} />
      <span className="poster-row" aria-hidden="true">
        <span className="poster-name">{item.title}</span>
      </span>
      {extra && (
        <span className="poster-best" aria-hidden="true">
          {extra}
        </span>
      )}
    </Link>
  );
}

export function PosterGrid({ children }: { children: ReactNode }) {
  return <div className="poster-grid">{children}</div>;
}

export function PersonChip({ person, role }: { person: PersonCard; role?: string | undefined }) {
  return (
    <Link to={`/people/${encodeURIComponent(person.id)}`} className="person-chip">
      <span className="person-initials" aria-hidden="true">
        {initials(person.name)}
      </span>
      <span className="person-name">{person.name}</span>
      {role && <span className="mono-label">{role}</span>}
    </Link>
  );
}

export function CollectionTile({ collection }: { collection: CollectionCard }) {
  const name = collection.serverLabel
    ? `${collection.name} (${collection.serverLabel})`
    : collection.name;
  return (
    <Link
      to={`/collections/${encodeURIComponent(collection.id)}`}
      className="collection-tile"
      aria-label={name}
    >
      <div
        className="collection-art"
        style={{ '--cw-hue': hueOf(collection.name) } as CSSProperties}
      >
        {collection.artworkUrl ? (
          <img src={collection.artworkUrl} alt="" loading="lazy" />
        ) : (
          <span aria-hidden="true">{collection.name}</span>
        )}
      </div>
      <span className="poster-name">{name}</span>
    </Link>
  );
}

/**
 * Segmented selector with radio semantics and arrow-key navigation (UX §6). Also used for the
 * theme choice and season tabs.
 */
export function Segmented<T extends string>({
  legend,
  value,
  options,
  onChange,
  hideLegend,
}: {
  legend: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  hideLegend?: boolean;
}) {
  const name = useId();
  const refs = useRef<Record<string, HTMLInputElement | null>>({});
  const onKey = (e: KeyboardEvent<HTMLInputElement>, idx: number) => {
    const forward = e.key === 'ArrowRight' || e.key === 'ArrowDown';
    const back = e.key === 'ArrowLeft' || e.key === 'ArrowUp';
    if (!forward && !back) return;
    e.preventDefault();
    const next = (idx + (forward ? 1 : -1) + options.length) % options.length;
    const target = options[next];
    if (!target) return;
    onChange(target.value);
    refs.current[target.value]?.focus();
  };
  return (
    <fieldset className="segmented-set">
      <legend className={hideLegend ? 'sr-only' : 'mono-label'}>{legend}</legend>
      <div className="segmented">
        {options.map((o, i) => (
          <label key={o.value} className={`segment${o.value === value ? ' segment-on' : ''}`}>
            <input
              ref={(el) => {
                refs.current[o.value] = el;
              }}
              type="radio"
              name={name}
              value={o.value}
              checked={o.value === value}
              onChange={() => {
                onChange(o.value);
              }}
              onKeyDown={(e) => {
                onKey(e, i);
              }}
              className="sr-only-input"
            />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <section className="callout">
      <h2 className="h-card">{title}</h2>
      {children && <p className="helper">{children}</p>}
    </section>
  );
}

export function PageHead({ title, aside }: { title: string; aside?: ReactNode }) {
  usePageTitle(title);
  return (
    <div className="page-head">
      <h1>{title}</h1>
      {aside}
    </div>
  );
}
