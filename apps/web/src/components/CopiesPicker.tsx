/** Source picker radiogroup and the "why this copy" callout (UX §6; FR-CAT-013, FR-PLAY-005, FR-PLAY-010). */
import { useRef, type KeyboardEvent } from 'react';
import type { CopyRow } from '../api-client/playback-types';
import {
  audioLabel,
  copyHeadline,
  hdrLabel,
  playabilityLabel,
  reasonSentences,
  sizeLabel,
} from '../lib/reasons';

export const copyKey = (c: Pick<CopyRow, 'sourceId' | 'versionId'>) =>
  `${c.sourceId}:${c.versionId}`;

function serverLine(c: CopyRow): string {
  const type = c.serverType ? c.serverType.toUpperCase() : 'SERVER';
  const state =
    c.serverStatus === 'active'
      ? 'Online'
      : c.serverStatus === 'unreachable'
        ? 'Offline'
        : c.serverStatus === 'degraded'
          ? 'Degraded'
          : c.serverStatus;
  return `${type} · ${state}`;
}

export function CopiesPicker({
  copies,
  value,
  onChange,
  labelledBy,
}: {
  copies: CopyRow[];
  value: string | null;
  onChange: (key: string) => void;
  /** id of the heading that names the group. */
  labelledBy: string;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const current = copies.find((c) => copyKey(c) === value) ?? copies[0];
  const currentKey = current ? copyKey(current) : null;

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, idx: number) => {
    const forward = e.key === 'ArrowDown' || e.key === 'ArrowRight';
    const back = e.key === 'ArrowUp' || e.key === 'ArrowLeft';
    if (!forward && !back) return;
    e.preventDefault();
    const next = copies[(idx + (forward ? 1 : -1) + copies.length) % copies.length];
    if (!next) return;
    onChange(copyKey(next));
    refs.current[copyKey(next)]?.focus();
  };

  return (
    <>
      <div className="table-wrap">
        <div role="radiogroup" aria-labelledby={labelledBy} className="copy-group">
          <div className="copy-row copy-head" aria-hidden="true">
            <span />
            <span>Server</span>
            <span>Video</span>
            <span>HDR</span>
            <span>Audio</span>
            <span>Size</span>
            <span>On this device</span>
          </div>
          {copies.map((c, i) => {
            const key = copyKey(c);
            const on = key === currentKey;
            const status = playabilityLabel(c.expectedPlayability);
            return (
              <button
                key={key}
                ref={(el) => {
                  refs.current[key] = el;
                }}
                type="button"
                role="radio"
                aria-checked={on}
                tabIndex={on ? 0 : -1}
                className={`copy-row copy-option${on ? ' copy-on' : ''}`}
                onClick={() => {
                  onChange(key);
                }}
                onKeyDown={(e) => {
                  onKey(e, i);
                }}
              >
                <span className="radio-ring" aria-hidden="true">
                  <span className="radio-dot" />
                </span>
                <span className="copy-cell">
                  <span className="copy-server">
                    {c.serverName}
                    {c.selected && <span className="best-badge">BEST</span>}
                    {c.selected && <span className="sr-only"> (Best copy)</span>}
                  </span>
                  <span className="mono-small">{serverLine(c)}</span>
                </span>
                <span className="mono-value">
                  <span className="sr-only">Video </span>
                  {c.resolution?.label ?? 'Unknown'}
                </span>
                <span className="mono-value copy-muted">
                  <span className="sr-only">HDR </span>
                  {hdrLabel(c.hdr)}
                </span>
                <span className="mono-value copy-muted">
                  <span className="sr-only">Audio </span>
                  {audioLabel(c.audio)}
                </span>
                <span className="mono-value copy-muted">
                  <span className="sr-only">Size </span>
                  {sizeLabel(c.sizeBytes)}
                </span>
                <span className={`copy-status copy-status-${status.tone}`}>
                  <span className="dot" aria-hidden="true" />
                  <span className="sr-only">On this device </span>
                  {status.text}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      {current && <WhyCallout copy={current} />}
    </>
  );
}

/** "Why this copy": updates politely when the selection changes (FR-PLAY-010). */
export function WhyCallout({ copy }: { copy: CopyRow }) {
  const sentences = reasonSentences(copy.reasons);
  const bad = copy.expectedPlayability === 'unavailable';
  return (
    <div className="why" aria-live="polite" aria-atomic="true" data-tone={bad ? 'bad' : 'info'}>
      <InfoIcon />
      <div className="why-text">
        <strong>{copyHeadline(copy)}</strong>
        <p>
          {sentences.length > 0
            ? sentences.join(' ')
            : 'Cinewren checks this against your device when you press Play.'}
        </p>
      </div>
    </div>
  );
}

function InfoIcon() {
  return (
    <svg
      className="why-icon"
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="10" cy="10" r="7.5" />
      <path d="M10 9 V14 M10 6.2 V6.21" />
    </svg>
  );
}
