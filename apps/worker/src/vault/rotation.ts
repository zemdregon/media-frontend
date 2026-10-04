/**
 * Master-key rotation for every vault-sealed column (LLD-TOKEN "Rotation", WF-11, SR-07).
 *
 * Rows written under an older key version are decrypted with that key and sealed again under the
 * current one, in batches, with a compare-and-set so a concurrent run, a replay or an operator
 * credential replacement is never overwritten (LLD-ERR "D1 concurrency"). Three tables hold
 * sealed data:
 *
 *   - `server_credentials` (`secret_envelope`, `service_token_envelope`), versioned by the
 *     `key_version` column; the compare-and-set is on that column.
 *   - `playback_sessions.credential_envelope` and `idempotency_keys.response` (sealed play
 *     descriptors), which have no version column. The version is the one inside the envelope and
 *     the compare-and-set is on the envelope text itself.
 *
 * Catalog cursors are sealed with the vault too, but they live minutes and carry no secret, so
 * they are not rewritten: an old-key cursor stops decrypting once its key is removed and the
 * client simply restarts the listing.
 *
 * Everything here is idempotent and resumable: a batch is selected by "not on the current key",
 * so a rerun after an interruption picks up exactly what is left. Nothing here returns or logs
 * key material, plaintext or ciphertext.
 */
import { decrypt, encrypt, VaultError, type Keyring } from './vault';

export type RotationTable = 'server_credentials' | 'playback_sessions' | 'idempotency_keys';

/** The order a rotation walks the tables in. */
export const ROTATION_TABLES: readonly RotationTable[] = [
  'server_credentials',
  'playback_sessions',
  'idempotency_keys',
];

export interface RotationResult {
  /** Rows rewritten under the current key. */
  reencrypted: number;
  /** Rows that could not be processed (key lost or data unreadable); the operator re-enters them. */
  failed: number;
  /** Rows still on an older key version after this batch. */
  remaining: number;
}

interface BatchResult extends RotationResult {
  /** The largest rowid scanned, or null when the batch found nothing to do. */
  last: number | null;
}

const BATCH_SIZE = 100;

/** SQL for the key version named by an envelope column: `cw1.<version>.<iv>.<data>`. */
const envelopeVersion = (col: string) =>
  `CAST(substr(${col}, 5, instr(substr(${col}, 5), '.') - 1) AS INTEGER)`;

interface CredentialRow {
  rid: number;
  server_id: string;
  key_version: number;
  secret_envelope: string;
  service_token_envelope: string | null;
}

async function rotateServerCredentials(
  db: D1Database,
  keyring: Keyring,
  batchSize: number,
  after: number,
): Promise<BatchResult> {
  const { results } = await db
    .prepare(
      `SELECT rowid AS rid, server_id, key_version, secret_envelope, service_token_envelope
         FROM server_credentials WHERE key_version <> ? AND rowid > ? ORDER BY rowid LIMIT ?`,
    )
    .bind(keyring.current, after, batchSize)
    .all<CredentialRow>();

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
    .prepare('SELECT COUNT(*) AS n FROM server_credentials WHERE key_version <> ?')
    .bind(keyring.current)
    .first<{ n: number }>();
  return {
    reencrypted,
    failed,
    remaining: left?.n ?? 0,
    last: results.length > 0 ? (results[results.length - 1]?.rid ?? null) : null,
  };
}

/** How a table with a sealed envelope column but no version column is addressed. */
interface EnvelopeTable {
  table: 'playback_sessions' | 'idempotency_keys';
  column: 'credential_envelope' | 'response';
  /** Columns that identify the row. */
  keys: readonly string[];
  /** The row ID the writer sealed it with (the AAD). */
  rowId(row: Record<string, string>): string;
}

// Both are sealed with the `session_cred` purpose by their writers.
const ENVELOPE_TABLES: Record<'playback_sessions' | 'idempotency_keys', EnvelopeTable> = {
  playback_sessions: {
    table: 'playback_sessions',
    column: 'credential_envelope',
    keys: ['id'],
    rowId: (r) => r.id ?? '',
  },
  idempotency_keys: {
    table: 'idempotency_keys',
    column: 'response',
    keys: ['user_id', 'key'],
    // Mirrors `rowIdOf` in playback/idempotency.ts.
    rowId: (r) => `idem|${r.user_id ?? ''}|${r.key ?? ''}`,
  },
};

async function rotateEnvelopeTable(
  spec: EnvelopeTable,
  db: D1Database,
  keyring: Keyring,
  batchSize: number,
  after: number,
): Promise<BatchResult> {
  const { table, column, keys } = spec;
  // Rows that are not envelopes at all (an unsealed idempotency response) never match `cw1.%`.
  const stale = `${column} LIKE 'cw1.%' AND ${envelopeVersion(column)} <> ?`;
  const { results } = await db
    .prepare(
      `SELECT rowid AS rid, ${keys.map((k) => `"${k}"`).join(', ')}, ${column} AS envelope
         FROM ${table} WHERE ${stale} AND rowid > ? ORDER BY rowid LIMIT ?`,
    )
    .bind(keyring.current, after, batchSize)
    .all<Record<string, string | number> & { rid: number; envelope: string }>();

  const updates: D1PreparedStatement[] = [];
  let failed = 0;
  for (const row of results) {
    const keyValues = Object.fromEntries(keys.map((k) => [k, String(row[k])]));
    try {
      const rowId = spec.rowId(keyValues);
      const plain = await decrypt(keyring, 'session_cred', rowId, row.envelope);
      const sealed = await encrypt(keyring, 'session_cred', rowId, plain);
      updates.push(
        db
          .prepare(
            `UPDATE ${table} SET ${column} = ?
              WHERE ${keys.map((k) => `"${k}" = ?`).join(' AND ')} AND ${column} = ?`,
          )
          .bind(sealed.envelope, ...keys.map((k) => keyValues[k]), row.envelope),
      );
    } catch (err) {
      if (!(err instanceof VaultError)) throw err;
      failed++;
    }
  }
  const outcomes = updates.length > 0 ? await db.batch(updates) : [];
  const reencrypted = outcomes.reduce((n, r) => n + r.meta.changes, 0);
  const left = await db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${stale}`)
    .bind(keyring.current)
    .first<{ n: number }>();
  return {
    reencrypted,
    failed,
    remaining: left?.n ?? 0,
    last: results.length > 0 ? (results[results.length - 1]?.rid ?? null) : null,
  };
}

function rotateBatch(
  table: RotationTable,
  db: D1Database,
  keyring: Keyring,
  batchSize: number,
  after: number,
): Promise<BatchResult> {
  return table === 'server_credentials'
    ? rotateServerCredentials(db, keyring, batchSize, after)
    : rotateEnvelopeTable(ENVELOPE_TABLES[table], db, keyring, batchSize, after);
}

/** One batch over the server credentials. A rerun starts from the beginning of what is left. */
export async function reencryptServerCredentials(
  db: D1Database,
  keyring: Keyring,
  batchSize = BATCH_SIZE,
): Promise<RotationResult> {
  const { reencrypted, failed, remaining } = await rotateServerCredentials(
    db,
    keyring,
    batchSize,
    0,
  );
  return { reencrypted, failed, remaining };
}

/** Where a rotation job stands: the table being walked and the last rowid it scanned. */
export interface RotationCursor {
  table: RotationTable;
  after: number;
}

export interface RotationStep {
  reencrypted: number;
  failed: number;
  /** The cursor the next message continues from, or null when every table has been walked. */
  next: RotationCursor | null;
}

/**
 * Runs up to `maxBatches` batches from `cursor` (the first table when omitted). The cursor only
 * moves forward, so a row that cannot be rotated (its key is gone) is reported once and skipped
 * instead of being retried forever; status keeps counting it until the operator re-enters it.
 */
export async function runRotationStep(
  db: D1Database,
  keyring: Keyring,
  cursor: RotationCursor = { table: 'server_credentials', after: 0 },
  options: { batchSize?: number; maxBatches?: number } = {},
): Promise<RotationStep> {
  const batchSize = options.batchSize ?? BATCH_SIZE;
  const maxBatches = options.maxBatches ?? 10;
  let index = Math.max(0, ROTATION_TABLES.indexOf(cursor.table));
  let after = cursor.after;
  let reencrypted = 0;
  let failed = 0;
  for (let batches = 0; batches < maxBatches;) {
    const table = ROTATION_TABLES[index];
    if (!table) return { reencrypted, failed, next: null };
    const r = await rotateBatch(table, db, keyring, batchSize, after);
    batches++;
    reencrypted += r.reencrypted;
    failed += r.failed;
    if (r.last === null) {
      index++;
      after = 0;
    } else {
      after = r.last;
    }
  }
  const table = ROTATION_TABLES[index];
  return { reencrypted, failed, next: table ? { table, after } : null };
}

export interface KeyVersionRows {
  keyVersion: number;
  /** Sealed rows (servers, play sessions, replayable responses) on this version. */
  rows: number;
  /** False when the version is no longer in `CREDENTIAL_KEYS`: those rows cannot be read. */
  keyConfigured: boolean;
}

export interface VaultStatus {
  currentKeyVersion: number;
  /** Versions present in `CREDENTIAL_KEYS` (numbers only, never key material). */
  configuredKeyVersions: number[];
  rowsByKeyVersion: KeyVersionRows[];
  /** Rows not on the current version. */
  pendingRows: number;
  /** True when every sealed row is on the current version. */
  complete: boolean;
  /** Versions with rows that no configured key can read (the old key was removed too early). */
  missingKeyVersions: number[];
  /** Configured, non-current versions that no row uses: safe to remove from `CREDENTIAL_KEYS`. */
  removableKeyVersions: number[];
}

/** Rows per key version across every sealed column, for the operator's "safe to remove" check. */
export async function vaultStatus(db: D1Database, keyring: Keyring): Promise<VaultStatus> {
  const { results } = await db
    .prepare(
      `SELECT v, SUM(n) AS n FROM (
         SELECT key_version AS v, COUNT(*) AS n FROM server_credentials GROUP BY key_version
         UNION ALL
         SELECT ${envelopeVersion('credential_envelope')} AS v, COUNT(*) AS n
           FROM playback_sessions WHERE credential_envelope LIKE 'cw1.%' GROUP BY v
         UNION ALL
         SELECT ${envelopeVersion('response')} AS v, COUNT(*) AS n
           FROM idempotency_keys WHERE response LIKE 'cw1.%' GROUP BY v
       ) GROUP BY v ORDER BY v`,
    )
    .all<{ v: number; n: number }>();
  const configured = [...keyring.keys.keys()].sort((a, b) => a - b);
  const rowsByKeyVersion = results.map((r) => ({
    keyVersion: r.v,
    rows: r.n,
    keyConfigured: keyring.keys.has(r.v),
  }));
  const pendingRows = rowsByKeyVersion
    .filter((r) => r.keyVersion !== keyring.current)
    .reduce((sum, r) => sum + r.rows, 0);
  const used = new Set(rowsByKeyVersion.map((r) => r.keyVersion));
  return {
    currentKeyVersion: keyring.current,
    configuredKeyVersions: configured,
    rowsByKeyVersion,
    pendingRows,
    complete: pendingRows === 0,
    missingKeyVersions: rowsByKeyVersion.filter((r) => !r.keyConfigured).map((r) => r.keyVersion),
    removableKeyVersions: configured.filter((v) => v !== keyring.current && !used.has(v)),
  };
}

/** Distinct key versions in use. */
export async function keyVersionsInUse(db: D1Database, keyring: Keyring): Promise<number[]> {
  return (await vaultStatus(db, keyring)).rowsByKeyVersion.map((r) => r.keyVersion);
}
