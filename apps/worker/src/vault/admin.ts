/**
 * Operator master-key rotation (SR-07, LLD-TOKEN "Rotation", WF-11): start a rotation and read
 * its progress. Responses carry key version numbers and row counts only, never key material,
 * plaintext or ciphertext (NFR-SEC-001).
 */
import type { Context } from 'hono';
import type { AppEnv } from '../api/context';
import { AppError } from '../api/errors';
import { currentUser } from '../auth/sessions';
import { auditStmt } from '../db/auth';
import { ulid } from '../platform/ids';
import { vaultStatus, type VaultStatus } from './rotation';
import { loadKeyring, VaultError, type Keyring } from './vault';

async function keyringOrThrow(c: Context<AppEnv>): Promise<Keyring> {
  try {
    return await loadKeyring(c.env);
  } catch (err) {
    if (!(err instanceof VaultError)) throw err;
    // The VaultError message names the setting that is wrong, never a key.
    throw new AppError('CREDENTIAL_KEY_MISSING', err.message);
  }
}

export async function status(c: Context<AppEnv>): Promise<VaultStatus> {
  return vaultStatus(c.env.DB, await keyringOrThrow(c));
}

export interface RotateResponse {
  currentKeyVersion: number;
  /** Rows not on the current key when the call was made. */
  pendingRows: number;
  /** False when nothing needed rotating, so no job was queued. */
  enqueued: boolean;
}

/** `POST /admin/vault/rotate`: queue the re-encryption job and write one `vault.rotate` audit row. */
export async function rotate(c: Context<AppEnv>): Promise<RotateResponse> {
  const keyring = await keyringOrThrow(c);
  const before = await vaultStatus(c.env.DB, keyring);
  const enqueued = before.pendingRows > 0;
  if (enqueued) await c.env.JOBS_QUEUE.send({ kind: 'reencrypt' });
  await c.env.DB.batch([
    auditStmt(c.env.DB, {
      id: ulid(),
      now: Date.now(),
      actorUserId: currentUser(c).userId,
      action: 'vault.rotate',
      targetType: 'vault',
      targetId: null,
      details: {
        currentKeyVersion: keyring.current,
        pendingRows: before.pendingRows,
        enqueued,
      },
      requestId: c.get('requestId'),
    }),
  ]);
  return { currentKeyVersion: keyring.current, pendingRows: before.pendingRows, enqueued };
}
