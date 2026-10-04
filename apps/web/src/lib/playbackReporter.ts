/**
 * Session events and progress reporting (FR-PROG-001, FR-PLAY-009): start, a progress tick every
 * 15 s while playing, and events on pause, seek-end, stop, error and page hide.
 */
import { ApiError } from '../api-client';
import { sendPlayEvent, sendPlayEventOnHide } from '../api-client/playback';
import type { PlayEventType } from '../api-client/playback-types';

export const PROGRESS_INTERVAL_MS = 15_000;

export interface Reporter {
  send: (type: PlayEventType, errorCode?: string) => void;
  /** Page hide: uses sendBeacon, or fetch keepalive. */
  hide: () => void;
  startTicker: () => void;
  stopTicker: () => void;
  /** Stops everything; later calls are ignored. */
  close: () => void;
}

export function createReporter(opts: {
  sessionId: string;
  getPositionMs: () => number;
  /** Called when the origin session is gone (410), so the player can start a replacement. */
  onExpired?: () => void;
}): Reporter {
  let seq = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const event = (type: PlayEventType, errorCode?: string) => ({
    seq: ++seq,
    type,
    positionMs: Math.max(0, Math.round(opts.getPositionMs())),
    ...(errorCode ? { errorCode } : {}),
  });

  const stopTicker = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };

  const send = (type: PlayEventType, errorCode?: string) => {
    if (closed) return;
    sendPlayEvent(opts.sessionId, event(type, errorCode)).catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 410 && !closed) {
        closed = true;
        stopTicker();
        opts.onExpired?.();
      }
      // Other failures are dropped: the next tick carries the position again.
    });
  };

  return {
    send,
    hide: () => {
      if (closed) return;
      sendPlayEventOnHide(opts.sessionId, event('progress'));
    },
    startTicker: () => {
      if (timer !== null || closed) return;
      timer = setInterval(() => {
        send('progress');
      }, PROGRESS_INTERVAL_MS);
    },
    stopTicker,
    close: () => {
      closed = true;
      stopTicker();
    },
  };
}
