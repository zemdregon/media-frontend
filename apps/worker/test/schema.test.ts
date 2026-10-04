// T0.4: schema v1 applies to an empty local D1; tables, key indexes, FTS5 and FK cascades
// (LLD-SCHEMA, DR-001, DR-004, DR-005).
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const db = env.DB;
const now = Date.now();

const EXPECTED_TABLES = [
  'audit_log',
  'collection_members',
  'collection_provider_links',
  'collections',
  'credits',
  'curation_overrides',
  'external_ids',
  'health_probes',
  'idempotency_keys',
  'invites',
  'item_availability',
  'libraries',
  'library_grants',
  'match_conflicts',
  'media_items',
  'media_versions',
  'meta',
  'passkey_credentials',
  'people',
  'person_provider_links',
  'playback_sessions',
  'search_fts',
  'server_credentials',
  'servers',
  'sessions',
  'sources',
  'sync_runs',
  'users',
  'watch_progress',
  'webauthn_challenges',
];

async function count(sql: string, ...params: unknown[]): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM ${sql}`)
    .bind(...params)
    .first<{ n: number }>();
  return row?.n ?? -1;
}

async function seedUser(id: string, role: 'operator' | 'viewer' = 'viewer') {
  await db
    .prepare(
      "INSERT INTO users (id, display_name, role, status, created_at) VALUES (?, ?, ?, 'active', ?)",
    )
    .bind(id, `name-${id}`, role, now)
    .run();
}

async function seedServerAndItem() {
  await db.batch([
    db
      .prepare(
        `INSERT INTO servers (id, type, name, base_url, origin_server_id, status, created_at, updated_at)
       VALUES ('s1', 'jellyfin', 'NAS', 'https://nas.example', 'origin-1', 'active', ?1, ?1)`,
      )
      .bind(now),
    db.prepare(
      `INSERT INTO libraries (id, server_id, provider_library_id, name, kind, enabled)
       VALUES ('l1', 's1', 'pl1', 'Movies', 'movies', 1)`,
    ),
    db
      .prepare(
        `INSERT INTO media_items (id, type, title, sort_title, date_added, created_at, updated_at)
       VALUES ('m1', 'movie', 'Heat', 'heat', ?1, ?1, ?1)`,
      )
      .bind(now),
    db
      .prepare(
        `INSERT INTO sources (id, server_id, library_id, provider_item_id, media_item_id, item_type, title,
         match_method, content_hash, status, updated_at)
       VALUES ('src1', 's1', 'l1', 'p-1', 'm1', 'movie', 'Heat', 'new', 'h', 'present', ?1)`,
      )
      .bind(now),
    db.prepare(
      `INSERT INTO media_versions (id, source_id, provider_version_id) VALUES ('v1', 'src1', 'pv1')`,
    ),
    db.prepare(`INSERT INTO item_availability (media_item_id, library_id) VALUES ('m1', 'l1')`),
  ]);
}

describe('schema v1 (migration 0001_init)', () => {
  it('records the migration and creates every LLD-SCHEMA table', async () => {
    const applied = await db.prepare('SELECT name FROM d1_migrations').all<{ name: string }>();
    expect(applied.results.map((r) => r.name)).toContain('0001_init.sql');

    const { results } = await db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
           AND name NOT LIKE 'search_fts_%' AND name <> 'd1_migrations'
         ORDER BY name`,
      )
      .all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(EXPECTED_TABLES);
  });

  it('creates the key indexes, including partial unique ones', async () => {
    const { results } = await db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL")
      .all<{ name: string; sql: string }>();
    const byName = new Map(results.map((r) => [r.name, r.sql]));
    for (const name of [
      'pk_user',
      'inv_open',
      'inv_user',
      'sess_user',
      'sess_expiry',
      'wc_expiry',
      'mi_browse',
      'mi_added',
      'ext_lookup',
      'src_item',
      'src_lib_seen',
      'ia_lib',
      'ppl_name',
      'ppl_link_tmdb',
      'cr_person',
      'col_link_tmdb',
      'sync_one_active',
      'hp_server',
      'ps_revoke',
      'wp_continue',
      'mc_source',
      'al_at',
    ]) {
      expect(byName.has(name), name).toBe(true);
    }
    expect(byName.get('sync_one_active')).toMatch(/UNIQUE INDEX[\s\S]*WHERE status IN/);
  });

  it('enforces foreign keys', async () => {
    await expect(
      db
        .prepare(
          `INSERT INTO sessions (id_hash, user_id, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
           VALUES ('h', 'no-such-user', 1, 1, 2, 2)`,
        )
        .run(),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });

  it('enforces CHECK constraints and the one-active-sync partial unique index', async () => {
    await expect(
      db
        .prepare(
          "INSERT INTO users (id, display_name, role, status, created_at) VALUES ('x', 'x', 'admin', 'active', 1)",
        )
        .run(),
    ).rejects.toThrow(/CHECK/i);

    await db
      .prepare(
        `INSERT INTO servers (id, type, name, base_url, origin_server_id, status, created_at, updated_at)
         VALUES ('s9', 'plex', 'P', 'https://p.example', 'o9', 'active', 1, 1)`,
      )
      .run();
    const run = (id: string, status: string) =>
      db
        .prepare(
          `INSERT INTO sync_runs (id, server_id, type, trigger, status, queued_at)
           VALUES (?, 's9', 'full', 'manual', ?, 1)`,
        )
        .bind(id, status)
        .run();
    await run('r1', 'running');
    await run('r2', 'succeeded');
    await expect(run('r3', 'queued')).rejects.toThrow(/UNIQUE/i);
  });

  it('runs FTS5 prefix, diacritic-insensitive and column-filtered queries', async () => {
    await db.batch(
      [
        ['title', 'm1', 'Amélie', 'Le Fabuleux Destin'],
        ['title', 'm2', 'Interstellar', null],
        ['person', 'p1', 'Christopher Nolan', null],
        ['person', 'p2', 'Chris Evans', null],
        ['collection', 'c1', 'Nolan Collection', null],
      ].map((r) =>
        db
          .prepare('INSERT INTO search_fts (kind, entity_id, name, alt_name) VALUES (?, ?, ?, ?)')
          .bind(...r),
      ),
    );
    const match = async (q: string) =>
      (
        await db
          .prepare(
            'SELECT entity_id FROM search_fts WHERE search_fts MATCH ? ORDER BY bm25(search_fts), entity_id',
          )
          .bind(q)
          .all<{ entity_id: string }>()
      ).results.map((r) => r.entity_id);

    expect(await match('"amel"*')).toEqual(['m1']);
    expect(await match('"fabuleux"*')).toEqual(['m1']);
    // The LLD-SCHEMA query shape: kind column filter AND name/alt_name prefix tokens.
    expect(await match('kind:person AND {name alt_name}:("chr"* "nol"*)')).toEqual(['p1']);
    expect(await match('kind:collection AND {name alt_name}:("nol"*)')).toEqual(['c1']);
  });

  it('cascades a user delete to passkeys, sessions, invites, grants, progress and playback (DR-005)', async () => {
    await seedServerAndItem();
    await seedUser('op', 'operator');
    await seedUser('u1');
    await db.batch([
      db.prepare(
        `INSERT INTO passkey_credentials (id, user_id, credential_id, public_key, created_at)
         VALUES ('pk1', 'u1', 'cred-1', x'00', 1)`,
      ),
      db.prepare(
        `INSERT INTO sessions (id_hash, user_id, passkey_id, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
         VALUES ('sh1', 'u1', 'pk1', 1, 1, 9e12, 9e12)`,
      ),
      db.prepare(
        `INSERT INTO invites (id, kind, token_hash, user_id, created_by, created_at, expires_at)
         VALUES ('i1', 'reenroll', 'th1', 'u1', 'op', 1, 9e12)`,
      ),
      // An invite issued BY u1 for someone else keeps existing, with created_by set to NULL.
      db.prepare(
        "INSERT INTO users (id, display_name, role, status, created_at) VALUES ('u2', 'u2', 'viewer', 'invited', 1)",
      ),
      db.prepare(
        `INSERT INTO invites (id, kind, token_hash, user_id, created_by, created_at, expires_at)
         VALUES ('i2', 'signup', 'th2', 'u2', 'u1', 1, 9e12)`,
      ),
      db.prepare(
        "INSERT INTO webauthn_challenges (id, challenge, purpose, user_id, expires_at) VALUES ('c1', 'x', 'add_passkey', 'u1', 9e12)",
      ),
      db.prepare(
        "INSERT INTO library_grants (user_id, library_id, granted_at) VALUES ('u1', 'l1', 1)",
      ),
      db.prepare(
        "INSERT INTO watch_progress (user_id, media_item_id, position_ms, updated_at) VALUES ('u1', 'm1', 5, 1)",
      ),
      db.prepare(
        `INSERT INTO playback_sessions (id, user_id, media_item_id, mode, status, authorized_at, auth_expires_at)
         VALUES ('ps1', 'u1', 'm1', 'direct_play', 'ended', 1, 2)`,
      ),
      db.prepare(
        "INSERT INTO audit_log (id, at, actor_user_id, action, target_type, target_id) VALUES ('a1', 1, 'u1', 'x', 'user', 'u1')",
      ),
    ]);

    // LLD-SCHEMA "Delete user": anonymize audit target, then delete the row.
    await db.batch([
      db
        .prepare(
          "UPDATE audit_log SET target_id = NULL WHERE target_type = 'user' AND target_id = ?",
        )
        .bind('u1'),
      db.prepare('DELETE FROM users WHERE id = ?').bind('u1'),
    ]);

    expect(await count("passkey_credentials WHERE user_id = 'u1'")).toBe(0);
    expect(await count("sessions WHERE user_id = 'u1'")).toBe(0);
    expect(await count("invites WHERE id = 'i1'")).toBe(0);
    expect(await count("webauthn_challenges WHERE id = 'c1'")).toBe(0);
    expect(await count("library_grants WHERE user_id = 'u1'")).toBe(0);
    expect(await count("watch_progress WHERE user_id = 'u1'")).toBe(0);
    expect(await count("playback_sessions WHERE user_id = 'u1'")).toBe(0);
    const i2 = await db.prepare("SELECT created_by FROM invites WHERE id = 'i2'").first();
    expect(i2).toEqual({ created_by: null });
    const audit = await db
      .prepare("SELECT actor_user_id, target_id FROM audit_log WHERE id = 'a1'")
      .first();
    expect(audit).toEqual({ actor_user_id: null, target_id: null });
    // Unrelated rows survive.
    expect(await count("users WHERE id = 'op'")).toBe(1);
    expect(await count("media_items WHERE id = 'm1'")).toBe(1);
  });

  it('removing a passkey ends the sessions created with it', async () => {
    await seedUser('u3');
    await db.batch([
      db.prepare(
        `INSERT INTO passkey_credentials (id, user_id, credential_id, public_key, created_at)
         VALUES ('pk3', 'u3', 'cred-3', x'00', 1)`,
      ),
      db.prepare(
        `INSERT INTO sessions (id_hash, user_id, passkey_id, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
         VALUES ('sh3', 'u3', 'pk3', 1, 1, 9e12, 9e12)`,
      ),
    ]);
    await db.prepare("DELETE FROM passkey_credentials WHERE id = 'pk3'").run();
    expect(await count("sessions WHERE id_hash = 'sh3'")).toBe(0);
  });

  it('cascades a server delete to libraries, sources, versions and availability; items stay', async () => {
    await db
      .prepare("DELETE FROM servers WHERE id = 's1'")
      .run()
      .catch(() => undefined);
    await db.prepare("DELETE FROM media_items WHERE id = 'm1'").run();
    await seedServerAndItem();
    await db.prepare("DELETE FROM servers WHERE id = 's1'").run();
    expect(await count("libraries WHERE id = 'l1'")).toBe(0);
    expect(await count("sources WHERE id = 'src1'")).toBe(0);
    expect(await count("media_versions WHERE id = 'v1'")).toBe(0);
    expect(await count("item_availability WHERE media_item_id = 'm1'")).toBe(0);
    // Items are deleted only when sourceless, by the orphan job, not by cascade.
    expect(await count("media_items WHERE id = 'm1'")).toBe(1);
  });
});
