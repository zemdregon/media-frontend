/**
 * Schema-skew guard (TDD §9.3, FR-OPS-008, NFR-MAINT-003). The Worker is released together with
 * its migrations; if a deploy ran without `wrangler d1 migrations apply`, the code would run
 * against an older schema. The guard compares the highest applied migration number with the one
 * this code needs and, when the database is behind, API routes answer 503 `MIGRATIONS_PENDING`
 * and health reports `degraded`.
 */

/**
 * The highest migration number (`NNNN_name.sql` in `apps/worker/migrations`) this code depends
 * on. Raise it in the same change that adds a migration the code needs; a test fails when it
 * differs from the newest migration file.
 */
export const SCHEMA_VERSION_REQUIRED = 3;

/** Highest applied migration number from wrangler's `d1_migrations` table, or 0 if none/absent. */
export async function appliedSchemaVersion(db: D1Database): Promise<number> {
  try {
    const row = await db
      .prepare('SELECT MAX(CAST(substr(name, 1, 4) AS INTEGER)) AS v FROM d1_migrations')
      .first<{ v: number | null }>();
    return typeof row?.v === 'number' ? row.v : 0;
  } catch {
    return 0; // table missing: no migration was ever applied
  }
}

let currentOnce = false;

/**
 * True when the applied schema is at least `SCHEMA_VERSION_REQUIRED`. A positive answer is cached
 * for the life of the isolate (migrations never go backwards); a negative one is re-checked on
 * every call so the Worker recovers as soon as the operator applies the migrations.
 */
export async function schemaIsCurrent(db: D1Database): Promise<boolean> {
  if (currentOnce) return true;
  const ok = (await appliedSchemaVersion(db)) >= SCHEMA_VERSION_REQUIRED;
  if (ok) currentOnce = true;
  return ok;
}

/** Test hook: forget the cached positive answer. */
export function resetSchemaGuardCache(): void {
  currentOnce = false;
}

export const MIGRATIONS_PENDING_MESSAGE =
  'The database schema is older than this version of Cinewren. Apply the pending migrations ' +
  '(wrangler d1 migrations apply) and retry. See docs/operations/self-host.md.';
