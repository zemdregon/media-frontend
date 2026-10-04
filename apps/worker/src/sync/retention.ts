/**
 * Retention job (LLD-SYNC "Retention job", DR-003, DR-005, BR-4). Runs daily. Every step deletes
 * in bounded chunks and the whole job stops after `budgetMs`; whatever is left continues the next
 * day. Watch progress is never touched here: it is removed only with its user, or through the
 * cascade when its item is purged (DR-003).
 */
import type { SyncDeps } from './deps';

const CHUNK = 500;

export interface RetentionResult {
  sourcesPurged: number;
  itemsPurged: number;
  linksPurged: number;
  peoplePurged: number;
  collectionsPurged: number;
  rowsPruned: number;
  /** True when the time budget ran out before every step finished. */
  truncated: boolean;
}

const DAY = 86_400_000;

export async function runRetention(
  deps: SyncDeps,
  options: { budgetMs?: number } = {},
): Promise<RetentionResult> {
  const { db } = deps;
  const started = deps.now();
  const budget = options.budgetMs ?? 10 * 60_000;
  const out: RetentionResult = {
    sourcesPurged: 0,
    itemsPurged: 0,
    linksPurged: 0,
    peoplePurged: 0,
    collectionsPurged: 0,
    rowsPruned: 0,
    truncated: false,
  };
  const tally = async (table: string): Promise<number> =>
    (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? 0;
  const timeUp = () => {
    if (deps.now() - started > budget) out.truncated = true;
    return out.truncated;
  };
  /** Runs `sql` repeatedly until it deletes fewer rows than the chunk. */
  const loop = async (sql: string, binds: unknown[], table: string): Promise<number> => {
    const before = await tally(table);
    for (;;) {
      if (timeUp()) break;
      // D1's `changes` also counts rows removed by foreign-key cascades, so it only decides
      // whether to go on; the reported number is the table's own row count difference.
      const res = await db
        .prepare(sql)
        .bind(...binds, CHUNK)
        .run();
      if (res.meta.changes === 0) break;
    }
    return before - (await tally(table));
  };

  // 1. Sources missing for longer than the retention window, with versions, credits, memberships
  //    and conflicts (all cascade). Their availability rows were removed when they went missing.
  const cutoff = deps.now() - deps.config.missingRetentionMs;
  out.sourcesPurged = await loop(
    `DELETE FROM sources WHERE rowid IN (
       SELECT rowid FROM sources WHERE status = 'missing' AND missing_since < ? LIMIT ?)`,
    [cutoff],
    'sources',
  );

  // 2. Sourceless canonical items, children first (DR-005). The search row goes first, by rowid.
  for (const type of ['episode', 'season', 'series', 'movie'] as const) {
    const pick = `SELECT rowid FROM media_items WHERE type = ?1
         AND NOT EXISTS (SELECT 1 FROM sources s WHERE s.media_item_id = media_items.id)
         AND NOT EXISTS (SELECT 1 FROM media_items c WHERE c.parent_id = media_items.id)
       ORDER BY rowid LIMIT ?2`;
    for (;;) {
      if (timeUp()) break;
      const before = await tally('media_items');
      await db.batch([
        db
          .prepare(
            `DELETE FROM search_fts WHERE rowid IN (SELECT rowid * 3 FROM media_items WHERE rowid IN (${pick}))`,
          )
          .bind(type, CHUNK),
        db.prepare(`DELETE FROM media_items WHERE rowid IN (${pick})`).bind(type, CHUNK),
      ]);
      const n = before - (await tally('media_items'));
      out.itemsPurged += n;
      if (n === 0) break;
    }
  }

  // 3. Orphan people and collections (LLD-SCHEMA "Orphan people and collections"): person links
  //    that no credit references, then people and collections with no links left, and their
  //    search rows. A person who merely has no visible credits is hidden by BR-1, not deleted.
  out.linksPurged = await loop(
    `DELETE FROM person_provider_links WHERE rowid IN (
       SELECT rowid FROM person_provider_links l
        WHERE NOT EXISTS (SELECT 1 FROM credits c WHERE c.link_id = l.id) LIMIT ?)`,
    [],
    'person_provider_links',
  );
  for (const [table, offset, kind] of [
    ['people', 1, 'peoplePurged'],
    ['collections', 2, 'collectionsPurged'],
  ] as const) {
    const linkTable = table === 'people' ? 'person_provider_links' : 'collection_provider_links';
    const fk = table === 'people' ? 'person_id' : 'collection_id';
    const pick = `SELECT rowid FROM ${table} t WHERE NOT EXISTS (SELECT 1 FROM ${linkTable} l WHERE l.${fk} = t.id) ORDER BY rowid LIMIT ?1`;
    for (;;) {
      if (timeUp()) break;
      const before = await tally(table);
      await db.batch([
        db
          .prepare(
            `DELETE FROM search_fts WHERE rowid IN (SELECT rowid * 3 + ${offset} FROM ${table} WHERE rowid IN (${pick}))`,
          )
          .bind(CHUNK),
        db.prepare(`DELETE FROM ${table} WHERE rowid IN (${pick})`).bind(CHUNK),
      ]);
      const n = before - (await tally(table));
      out[kind] += n;
      if (n === 0) break;
    }
  }

  // 4. Operational history (DR-003): runs 90 d (never the latest per server), probes 7 d,
  //    terminal playback sessions 30 d, audit 365 d, idempotency keys 24 h.
  const now = deps.now();
  const prune: [string, unknown[], string][] = [
    [
      `DELETE FROM sync_runs WHERE rowid IN (SELECT rowid FROM sync_runs r WHERE r.queued_at < ?
         AND r.status NOT IN ('queued','running')
         AND r.id <> (SELECT x.id FROM sync_runs x WHERE x.server_id = r.server_id ORDER BY x.queued_at DESC, x.id DESC LIMIT 1) LIMIT ?)`,
      [now - 90 * DAY],
      'sync_runs',
    ],
    [
      'DELETE FROM health_probes WHERE rowid IN (SELECT rowid FROM health_probes WHERE probed_at < ? LIMIT ?)',
      [now - 7 * DAY],
      'health_probes',
    ],
    [
      `DELETE FROM playback_sessions WHERE rowid IN (SELECT rowid FROM playback_sessions
         WHERE status IN ('ended','expired','failed') AND authorized_at < ? LIMIT ?)`,
      [now - 30 * DAY],
      'playback_sessions',
    ],
    [
      'DELETE FROM audit_log WHERE rowid IN (SELECT rowid FROM audit_log WHERE at < ? LIMIT ?)',
      [now - 365 * DAY],
      'audit_log',
    ],
    [
      'DELETE FROM idempotency_keys WHERE rowid IN (SELECT rowid FROM idempotency_keys WHERE created_at < ? LIMIT ?)',
      [now - DAY],
      'idempotency_keys',
    ],
  ];
  for (const [sql, binds, table] of prune) out.rowsPruned += await loop(sql, binds, table);

  if (out.sourcesPurged + out.itemsPurged > 0) {
    await db.batch([
      db.prepare(
        `INSERT INTO meta (k, v) VALUES ('catalog_version', '1')
           ON CONFLICT (k) DO UPDATE SET v = CAST(CAST(v AS INTEGER) + 1 AS TEXT)`,
      ),
    ]);
  }
  return out;
}
