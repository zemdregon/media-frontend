/**
 * Pagination cursors (LLD-API "Pagination"). A cursor is the last row's sort key, sealed with the
 * vault's current key (the reserved `cursor` purpose), so a client cannot forge or edit one. It is
 * also bound to the caller and to the query it was issued for, so it cannot be replayed against
 * another user or another filter. It carries no total count.
 */
import type { Context } from 'hono';
import type { AppEnv } from '../api/context';
import { AppError } from '../api/errors';
import { currentUser } from '../auth/sessions';
import { decrypt, encrypt, loadKeyring, VaultError } from '../vault/vault';

const invalid = () =>
  new AppError('VALIDATION_FAILED', 'The page cursor is not valid.', { fields: ['cursor'] });

/** `scope` names the route and the filters; both sealing and opening must pass the same one. */
export async function sealCursor(
  c: Context<AppEnv>,
  scope: string,
  key: readonly unknown[],
): Promise<string> {
  try {
    const keyring = await loadKeyring(c.env);
    const { envelope } = await encrypt(
      keyring,
      'cursor',
      `${currentUser(c).userId}|${scope}`,
      JSON.stringify(key),
    );
    return envelope;
  } catch (err) {
    if (!(err instanceof VaultError)) throw err;
    c.get('logger').error('vault.unavailable', { code: err.code });
    throw new AppError(
      'CREDENTIAL_KEY_MISSING',
      'The credential encryption key is not configured.',
    );
  }
}

/** Returns the sort key, or throws `VALIDATION_FAILED` for a forged, foreign or stale cursor. */
export async function openCursor(
  c: Context<AppEnv>,
  scope: string,
  cursor: string | undefined,
): Promise<unknown[] | undefined> {
  if (cursor === undefined) return undefined;
  try {
    const keyring = await loadKeyring(c.env);
    const plain = await decrypt(keyring, 'cursor', `${currentUser(c).userId}|${scope}`, cursor);
    const parsed: unknown = JSON.parse(plain);
    if (!Array.isArray(parsed)) throw invalid();
    return parsed as unknown[];
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err instanceof VaultError && err.code === 'CREDENTIAL_KEYS_INVALID') {
      throw new AppError(
        'CREDENTIAL_KEY_MISSING',
        'The credential encryption key is not configured.',
      );
    }
    throw invalid();
  }
}

/** Narrowing helpers for cursor keys that came back from JSON. */
export const isString = (v: unknown): v is string => typeof v === 'string';
export const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The key must match the expected shape, otherwise the cursor is treated as invalid. */
export function expectKey<T extends unknown[]>(
  key: unknown[] | undefined,
  guards: { [K in keyof T]: (v: unknown) => v is T[K] },
): T | undefined {
  if (key === undefined) return undefined;
  if (key.length !== guards.length || !guards.every((g, i) => g(key[i]))) throw invalid();
  return key as T;
}
