/**
 * End of a library pass (LLD-SYNC `finishLibrary`, FR-SYNC-005, BR-4): adopt orphaned children,
 * and for a full run mark the sources this run did not see as `missing`. Only ever called for a
 * library that completed without page errors; incremental runs never mark anything missing.
 */
import { listOrphanSources, recomputeItemStmts } from '../db/catalog-write';
import { reparentOrphans } from './items';
import type { PlaceContext } from './place';
import { runBatch } from './batch';

export interface FinishOutcome {
  marked: number;
  /** True when the mass-missing guard refused to mark anything (LLD-SYNC). */
  guarded: boolean;
  orphansPlaced: number;
}

export async function finishLibrary(
  pc: PlaceContext,
  runId: string,
  options: { full: boolean; force: boolean },
): Promise<FinishOutcome> {
  const { deps } = pc;
  const { db } = deps;
  const libraryId = pc.library.id;
  const orphansPlaced = await reparentOrphans(pc, await listOrphanSources(db, libraryId));
  if (!options.full) return { marked: 0, guarded: false, orphansPlaced };

  const counts = await db
    .prepare(
      `SELECT COUNT(*) AS present,
              COALESCE(SUM(CASE WHEN last_seen_sync_id IS NULL OR last_seen_sync_id <> ?2 THEN 1 ELSE 0 END), 0) AS unseen
         FROM sources WHERE library_id = ?1 AND status = 'present'`,
    )
    .bind(libraryId, runId)
    .first<{ present: number; unseen: number }>();
  const present = counts?.present ?? 0;
  const unseen = counts?.unseen ?? 0;
  if (
    !options.force &&
    present > deps.config.massMissingMin &&
    unseen / present > deps.config.massMissingRatio
  ) {
    return { marked: 0, guarded: true, orphansPlaced };
  }

  const now = deps.now();
  const affected = await db
    .prepare(
      `SELECT DISTINCT media_item_id FROM sources
        WHERE library_id = ? AND status = 'present' AND (last_seen_sync_id IS NULL OR last_seen_sync_id <> ?)`,
    )
    .bind(libraryId, runId)
    .all<{ media_item_id: string }>();
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE sources SET status = 'missing', missing_since = ?
          WHERE library_id = ? AND status = 'present' AND (last_seen_sync_id IS NULL OR last_seen_sync_id <> ?)`,
      )
      .bind(now, libraryId, runId),
    db
      .prepare(
        `DELETE FROM item_availability WHERE library_id = ?1 AND media_item_id NOT IN
           (SELECT media_item_id FROM sources WHERE library_id = ?1 AND status = 'present')`,
      )
      .bind(libraryId),
    db.prepare('UPDATE libraries SET last_full_sync_id = ? WHERE id = ?').bind(runId, libraryId),
  ];
  // Items that still have another present source must not keep showing a missing source's data.
  for (const row of affected.results) stmts.push(...recomputeItemStmts(db, row.media_item_id, now));
  await runBatch(db, stmts, 500);
  return { marked: unseen, guarded: false, orphansPlaced };
}
