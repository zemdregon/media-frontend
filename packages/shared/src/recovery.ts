/**
 * Last-operator recovery link (FR-USR-007, ADR-0014 §4). Builds the SQL that
 * `scripts/recover-operator.mjs` runs through `wrangler d1 execute`. It mirrors the Worker's
 * re-enrollment issue (`users/service.ts`): same token format, hash, lifetime and invite row.
 * The plaintext token exists only in the returned link; the SQL carries its hash.
 */
import { randomToken, sha256Hex, ulid } from './tokens.ts';

/** Re-enrollment link lifetime (FR-USR-007, proposed 24 h). */
export const REENROLL_TTL_MS = 24 * 3_600_000;

export const RECOVERY_AUDIT_ACTION = 'user.recovery_link';
export const RECOVERY_ACTOR = 'cli';

export interface RecoveryPlan {
  inviteId: string;
  link: string;
  expiresAt: number;
  /** One statement per entry, each on a single line, to run in order. */
  sql: string[];
}

/** SQL literal. IDs and hashes are generated; the user ID comes from the database. */
function lit(v: string | number): string {
  return typeof v === 'number' ? String(Math.trunc(v)) : `'${v.replace(/'/g, "''")}'`;
}

export async function planRecovery(input: {
  userId: string;
  appOrigin: string;
  now?: number;
}): Promise<RecoveryPlan> {
  const now = input.now ?? Date.now();
  const origin = input.appOrigin.replace(/\/+$/, '');
  const inviteId = ulid(now);
  const token = randomToken(32);
  const expiresAt = now + REENROLL_TTL_MS;
  const u = lit(input.userId);
  const details = JSON.stringify({ actor: RECOVERY_ACTOR, inviteId });
  return {
    inviteId,
    link: `${origin}/invite#t=${token}`,
    expiresAt,
    sql: [
      // Only the newest open link works, as for operator-issued links.
      `UPDATE invites SET revoked_at = ${lit(now)} WHERE user_id = ${u} AND kind = 'reenroll' AND redeemed_at IS NULL AND revoked_at IS NULL`,
      `INSERT INTO invites (id, kind, token_hash, user_id, created_by, created_at, expires_at) VALUES (${lit(inviteId)}, 'reenroll', ${lit(await sha256Hex(token))}, ${u}, NULL, ${lit(now)}, ${lit(expiresAt)})`,
      `INSERT INTO audit_log (id, at, actor_user_id, action, target_type, target_id, details, request_id) VALUES (${lit(ulid(now))}, ${lit(now)}, NULL, ${lit(RECOVERY_AUDIT_ACTION)}, 'user', ${u}, ${lit(details)}, NULL)`,
    ],
  };
}

export const ACTIVE_OPERATORS_SQL =
  "SELECT id, display_name FROM users WHERE role = 'operator' AND status = 'active' ORDER BY display_name";

export function findOperatorSql(userOrId: string): string {
  return `SELECT id, display_name FROM users WHERE role = 'operator' AND status = 'active' AND (id = ${lit(userOrId)} OR display_name = ${lit(userOrId)} COLLATE NOCASE)`;
}
