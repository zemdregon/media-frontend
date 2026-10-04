/** Playback, progress and next-episode calls (LLD-API; FR-PLAY-001, FR-PROG-001 to FR-PROG-004). */
import type { ItemCard } from '@cinewren/shared';
import { api } from './index';
import type { PlayEvent, PlayRequest, PlaybackDescriptor, ProgressResult } from './playback-types';

const enc = encodeURIComponent;

function idempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${String(Date.now())}-${Math.random().toString(36).slice(2)}`;
}

/** `POST /play`; the Idempotency-Key is required (LLD-API). */
export const play = (req: PlayRequest) =>
  api<PlaybackDescriptor>('POST', '/play', req, {
    headers: { 'Idempotency-Key': idempotencyKey() },
  });

export const sendPlayEvent = (sessionId: string, ev: PlayEvent) =>
  api<undefined>('POST', `/play/${enc(sessionId)}/events`, ev);

/**
 * Reports an event while the page is going away (FR-PROG-001): `sendBeacon` first, then `fetch`
 * with `keepalive`. Never throws.
 */
export function sendPlayEventOnHide(sessionId: string, ev: PlayEvent): void {
  const url = `/api/v1/play/${enc(sessionId)}/events`;
  const json = JSON.stringify(ev);
  try {
    if (
      typeof navigator !== 'undefined' &&
      typeof navigator.sendBeacon === 'function' &&
      navigator.sendBeacon(url, new Blob([json], { type: 'application/json' }))
    ) {
      return;
    }
  } catch {
    // fall through to fetch
  }
  void api('POST', `/play/${enc(sessionId)}/events`, ev, { keepalive: true }).catch(
    () => undefined,
  );
}

export const setWatched = (itemId: string, watched: boolean) =>
  api<ProgressResult>('PUT', `/progress/${enc(itemId)}`, { watched });

export const getNextEpisode = (itemId: string) =>
  api<ItemCard | null>('GET', `/items/${enc(itemId)}/next-episode`);
