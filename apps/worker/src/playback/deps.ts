/**
 * What the playback module needs from the outside world, injected so tests can drive the clock
 * and the origin (SDD: injected clock; TDD 6.4: one host-pinned origin fetch).
 *
 * Settings (BR-9 values are *(proposed)* in the FRD; they are configurable vars, not secrets):
 * - `PLAYBACK_AUTH_TTL_S`: seconds an authorized session may wait for its first event (300).
 * - `PLAYBACK_IDLE_TIMEOUT_MIN`: minutes without a progress report before expiry (240).
 * - `STREAM_DEVICE_POOL_SIZE`: DeviceId pool slots per pooled (Emby) server (32).
 */
import type { Env } from '../platform/env';
import { createLogger, type Logger } from '../platform/logger';
import { ulid } from '../platform/ids';

export interface PlaybackVars {
  PLAYBACK_AUTH_TTL_S?: string | undefined;
  PLAYBACK_IDLE_TIMEOUT_MIN?: string | undefined;
  STREAM_DEVICE_POOL_SIZE?: string | undefined;
}

export type PlaybackEnv = Pick<Env, 'DB' | 'CREDENTIAL_KEYS' | 'CREDENTIAL_KEY_CURRENT'> &
  PlaybackVars;

export interface PlaybackConfig {
  /** BR-9: an authorized session must start within this window (5 min, proposed). */
  authTtlMs: number;
  /** BR-9: a started session expires after this long without progress (4 h, proposed). */
  idleTimeoutMs: number;
  /** ADR-0013 Emby amendment: at least the peak number of concurrent sessions per server. */
  devicePoolSize: number;
  /** BR-7: resume is offered above this position (60 s, proposed). */
  resumeFloorMs: number;
  /** LLD-SEL: at most this many candidates are negotiated per request (NFR-PERF-002). */
  maxAttempts: number;
  /** TDD 6.4: the play path's per-call origin timeout. */
  originTimeoutMs: number;
  /** LLD-TOKEN: a failing revocation is retried for this long, then abandoned and logged. */
  revokeGiveUpMs: number;
  /** A pool lease without a session row older than this is an orphan the sweep recovers. */
  orphanLeaseMs: number;
}

function positive(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= max ? n : fallback;
}

export function getPlaybackConfig(env: PlaybackVars): PlaybackConfig {
  return {
    authTtlMs: positive(env.PLAYBACK_AUTH_TTL_S, 300, 3600) * 1000,
    idleTimeoutMs: positive(env.PLAYBACK_IDLE_TIMEOUT_MIN, 240, 24 * 60) * 60_000,
    devicePoolSize: Math.floor(positive(env.STREAM_DEVICE_POOL_SIZE, 32, 99)),
    resumeFloorMs: 60_000,
    maxAttempts: 2,
    originTimeoutMs: 5_000,
    revokeGiveUpMs: 24 * 3_600_000,
    orphanLeaseMs: 10 * 60_000,
  };
}

export interface PlaybackDeps {
  env: PlaybackEnv;
  db: D1Database;
  /** The raw `fetch` behind the host-pinned origin wrapper. */
  fetchImpl: typeof fetch;
  now(): number;
  newId(): string;
  logger: Logger;
  config: PlaybackConfig;
}

export function createPlaybackDeps(
  env: PlaybackEnv,
  options: { fetchImpl?: typeof fetch; logger?: Logger; now?: () => number } = {},
): PlaybackDeps {
  return {
    env,
    db: env.DB,
    fetchImpl: options.fetchImpl ?? ((input, init) => fetch(input, init)),
    now: options.now ?? (() => Date.now()),
    newId: () => ulid(),
    logger: options.logger ?? createLogger(),
    config: getPlaybackConfig(env),
  };
}
