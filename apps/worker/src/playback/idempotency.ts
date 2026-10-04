/**
 * `Idempotency-Key` handling (LLD-ERR "Idempotency"): the first request claims
 * `(user_id, key)` with the route and a hash of the request, and stores the response once
 * complete. A retry with the same key and hash gets the stored response without repeating the
 * work (for `POST /play`: without minting a second origin credential); a different hash is
 * `IDEMPOTENCY_KEY_REUSED`. A request that fails releases its claim so the client may retry.
 *
 * A stored play descriptor carries a session-scoped stream credential, so it is sealed with the
 * vault (purpose `session_cred`, bound to the user and key) rather than stored in clear.
 */
import { sha256Hex } from '../auth/tokens';
import { AppError } from '../api/errors';
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  getIdempotencyKey,
  releaseIdempotencyKey,
  retakeIdempotencyKey,
} from '../db/playback';
import { decrypt, encrypt, loadKeyring, type KeyringEnv } from '../vault/vault';

const KEY = /^[A-Za-z0-9._:-]{8,128}$/;
/** A claim with no response after this long belongs to a request that died. */
const STALE_CLAIM_MS = 30_000;

export function parseIdempotencyKey(raw: string | undefined, required: boolean): string | null {
  if (raw === undefined || raw === '') {
    if (required) {
      throw new AppError('VALIDATION_FAILED', 'An Idempotency-Key header is required.', {
        fields: ['Idempotency-Key'],
      });
    }
    return null;
  }
  if (!KEY.test(raw)) {
    throw new AppError('VALIDATION_FAILED', 'The Idempotency-Key header is invalid.', {
      fields: ['Idempotency-Key'],
    });
  }
  return raw;
}

export interface IdempotentCall {
  db: D1Database;
  env: KeyringEnv;
  userId: string;
  key: string;
  route: string;
  /** Canonical request content; its hash detects a key reused for another request. */
  request: unknown;
  /** Seal the stored response (it holds a credential). */
  seal: boolean;
  now: number;
}

export interface StoredResponse {
  status: number;
  body: unknown;
}

const rowIdOf = (userId: string, key: string) => `idem|${userId}|${key}`;

/**
 * Runs `work` at most once per key. Returns the stored response on a replay.
 */
export async function idempotent(
  call: IdempotentCall,
  work: () => Promise<StoredResponse>,
): Promise<StoredResponse> {
  const { db, userId, key } = call;
  const hash = await sha256Hex(`${call.route}\n${JSON.stringify(call.request)}`);
  if (!(await claimIdempotencyKey(db, userId, key, call.route, hash, call.now))) {
    const row = await getIdempotencyKey(db, userId, key);
    if (row && (row.route !== call.route || row.request_hash !== hash)) {
      throw new AppError(
        'IDEMPOTENCY_KEY_REUSED',
        'This Idempotency-Key was already used for a different request.',
      );
    }
    if (row?.response != null && row.status_code != null) {
      const text = call.seal
        ? await decrypt(
            await loadKeyring(call.env),
            'session_cred',
            rowIdOf(userId, key),
            row.response,
          )
        : row.response;
      return { status: row.status_code, body: JSON.parse(text) as unknown };
    }
    const retaken =
      row !== null &&
      (await retakeIdempotencyKey(db, userId, key, hash, call.now - STALE_CLAIM_MS, call.now));
    if (!retaken) {
      // The first request with this key is still running.
      throw new AppError('RATE_LIMITED', 'This request is already being processed.', {
        retryAfterS: 1,
      });
    }
  }
  let result: StoredResponse;
  try {
    result = await work();
  } catch (err) {
    await releaseIdempotencyKey(db, userId, key);
    throw err;
  }
  const text = JSON.stringify(result.body);
  const stored = call.seal
    ? (await encrypt(await loadKeyring(call.env), 'session_cred', rowIdOf(userId, key), text))
        .envelope
    : text;
  await completeIdempotencyKey(db, userId, key, result.status, stored);
  return result;
}
