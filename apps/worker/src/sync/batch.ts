/**
 * D1 `batch()` in bounded chunks (LLD-SYNC: "the batch is split into chunks that fit D1 per-batch
 * limits"). Chunks run in order; every statement is idempotent, so a run killed between chunks is
 * simply re-applied. Returns the per-statement results of the final chunk's last statement.
 */
export const BATCH_SIZE = 100;

export async function runBatch(
  db: D1Database,
  stmts: D1PreparedStatement[],
  size = BATCH_SIZE,
): Promise<D1Result[]> {
  const all: D1Result[] = [];
  for (let i = 0; i < stmts.length; i += size) {
    all.push(...(await db.batch(stmts.slice(i, i + size))));
  }
  return all;
}
