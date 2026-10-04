/**
 * Bounded retry with exponential backoff and full jitter for sync origin calls (NFR-REL-002,
 * LLD-ERR "Retry policy"): delay_n = random() * min(cap, base * 2^n), attempts <= `attempts`.
 * Only retryable `ProviderError`s are retried; 4xx other than 408 and 429 never are, and an
 * `AUTH` error is not retried here (the adapter already refreshed the token once).
 */
import { ProviderError } from '../providers/errors';

export interface RetryOptions {
  attempts: number;
  baseMs: number;
  capMs: number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  onRetry?: (attempt: number, delayMs: number, err: ProviderError) => void;
}

export function backoffDelayMs(
  attempt: number,
  o: Pick<RetryOptions, 'baseMs' | 'capMs' | 'random'>,
): number {
  return Math.floor(o.random() * Math.min(o.capMs, o.baseMs * 2 ** attempt));
}

export async function withRetry<T>(fn: () => Promise<T>, o: RetryOptions): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof ProviderError) || !err.retryable || attempt >= o.attempts - 1) throw err;
      const delay = backoffDelayMs(attempt, o);
      o.onRetry?.(attempt + 1, delay, err);
      await o.sleep(delay);
    }
  }
}
