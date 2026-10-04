/**
 * Master-key rotation for stored origin credentials (LLD-TOKEN "Rotation", WF-11).
 * Rows written under an older key version are decrypted with that key and sealed again under the
 * current one, in batches, with a compare-and-set on `key_version` so a concurrent run or an
 * operator credential replacement is never overwritten (LLD-ERR "D1 concurrency").
 */
import { decrypt, encrypt, VaultError, type Keyring } from './vault';

export interface RotationResult {
  /** Rows rewritten under the current key. */
  reencrypted: number;
  /** Rows that could not be processed (key lost or data unreadable); the operator re-enters them. */
  failed: number;
  /** Rows still on an older key version after this batch. */
  remaining: number;
}

interface Row {
  server_id: string;
  key_version: number;
  secret_envelope: string;
  service_token_envelope: string | null;
}

export async function reencryptServerCredentials(
  db: D1Database,
  keyring: Keyring,
  batchSize = 100,
): Promise<RotationResult> {
  const { results } = await db
    .prepare(
      `SELECT server_id, key_version, secret_envelope, service_token_envelope
         FROM server_credentials WHERE key_version < ? ORDER BY server_id LIMIT ?`,
    )
    .bind(keyring.current, batchSize)
    .all<Row>();

  const updates: D1PreparedStatement[] = [];
  let failed = 0;
  const now = Date.now();
  for (const row of results) {
    try {
      const secret = await decrypt(keyring, 'server_secret', row.server_id, row.secret_envelope);
      const token =
        row.service_token_envelope === null
          ? null
          : await decrypt(keyring, 'service_token', row.server_id, row.service_token_envelope);
      const sealedSecret = await encrypt(keyring, 'server_secret', row.server_id, secret);
      const sealedToken =
        token === null ? null : await encrypt(keyring, 'service_token', row.server_id, token);
      updates.push(
        db
          .prepare(
            `UPDATE server_credentials
                SET key_version = ?, secret_envelope = ?, service_token_envelope = ?, updated_at = ?
              WHERE server_id = ? AND key_version = ?`,
          )
          .bind(
            keyring.current,
            sealedSecret.envelope,
            sealedToken?.envelope ?? null,
            now,
            row.server_id,
            row.key_version,
          ),
      );
    } catch (err) {
      if (!(err instanceof VaultError)) throw err;
      failed++;
    }
  }
  const outcomes = updates.length > 0 ? await db.batch(updates) : [];
  const reencrypted = outcomes.reduce((n, r) => n + r.meta.changes, 0);
  const left = await db
    .prepare('SELECT COUNT(*) AS n FROM server_credentials WHERE key_version < ?')
    .bind(keyring.current)
    .first<{ n: number }>();
  return { reencrypted, failed, remaining: left?.n ?? 0 };
}

/** Distinct key versions in use, for `GET /admin/status` and the operator's "safe to remove" check. */
export async function keyVersionsInUse(db: D1Database): Promise<number[]> {
  const { results } = await db
    .prepare('SELECT DISTINCT key_version AS v FROM server_credentials ORDER BY v')
    .all<{ v: number }>();
  return results.map((r) => r.v);
}
