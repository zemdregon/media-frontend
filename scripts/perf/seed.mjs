// Seeds a local D1 (the SQLite file Miniflare keeps under --persist-to) to the NFR-SCALE-001
// design envelope: 20 servers, 200,000 source items over 120,000 canonical items, people,
// collections and 50 users with library grants. Rows are written straight into the tables in the
// shape sync and matching produce (LLD-SCHEMA); the heavy tables are generated inside SQLite with
// recursive CTEs, so seeding takes seconds and the script stays small.
//
// Two phases, because the registered mock server needs the Worker's vault to hold its credential:
//   seedUsers   before the Worker starts: 1 operator, 49 viewers, one session cookie each
//   seedCatalog after the real mock server is registered: everything else, with that server and
//               its two libraries standing in as server 0 of the 20
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const ENVELOPE = {
  servers: 20,
  users: 50,
  movies: 60_000,
  series: 6_000,
  seasons: 14_000,
  episodes: 40_000, // 120,000 canonical items in all
  // 120,000 primary + 80,000 extra copies = 200,000 source items. One movie in 20 (the ones whose
  // primary copy is on the mock origin) is kept single-copy so play has a target that cannot fail
  // over to a synthetic server, so n is raised by 20/19 to land on 80,000 extra copies.
  extraMovieSources: 84_211,
  people: 40_000,
  creditsPerTitle: 5,
  collections: 2_000,
  membersPerCollection: 10,
};

const WORDS = `night living dead plan outer space his girl friday dragnet spike horror collection
  river storm silent harbor golden winter shadow paper garden iron velvet crimson hollow
  lantern midnight orchard copper falcon meadow ember cobalt thunder marble willow anchor
  bridge canyon desert island jungle kingdom legend mirror ocean palace quartz raven
  signal temple valley whisper zenith arctic beacon cipher delta echo frontier glacier horizon
  ivory jasper kestrel lagoon mosaic nebula oasis prairie quiver ridge summit tundra umbra
  vista wander xenon yonder zephyr alpine boulder cedar dune eclipse fjord grove haven inlet
  juniper knoll larch moor nomad onyx pine quarry reef sage thicket upland vale wharf yew
  amber basalt cinder dusk ember flint garnet heron indigo jade kelp lotus mist nectar opal
  pearl quill rust slate topaz umber viper wren yarrow zinc apple birch clover daisy elm fern
  gorse hazel iris jonquil kale lilac maple nettle oak poppy rose sorrel thistle violet`
  .split(/\s+/)
  .filter(Boolean);

const GENRES = ['Drama', 'Comedy', 'Horror', 'Western', 'Sci-Fi', 'Thriller', 'Romance', 'Crime'];

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 10000');
  return db;
}

/** One operator and 49 viewers, each with a live session. Returns [{ userId, role, cookie }]. */
export function seedUsers(db, now = Date.now()) {
  const users = [];
  db.exec('BEGIN');
  for (let i = 0; i < ENVELOPE.users; i++) {
    const id = `PU${String(i).padStart(3, '0')}`;
    const role = i === 0 ? 'operator' : 'viewer';
    const cookie = randomBytes(32).toString('base64url');
    db.prepare(
      `INSERT INTO users (id, display_name, role, status, created_at) VALUES (?, ?, ?, 'active', ?)`,
    ).run(id, i === 0 ? 'Perf Operator' : `Perf Viewer ${i}`, role, now);
    db.prepare(
      `INSERT INTO sessions (id_hash, user_id, created_at, last_seen_at, idle_expires_at,
         absolute_expires_at, user_agent_hint) VALUES (?, ?, ?, ?, ?, ?, 'perf')`,
    ).run(sha256(cookie), id, now, now, now + 30 * 86_400_000, now + 90 * 86_400_000);
    users.push({ userId: id, role, cookie });
  }
  db.exec('COMMIT');
  return users;
}

/**
 * Everything else. `real` is the registered mock server: `{ serverId, moviesLib, tvLib }`; it is
 * server index 0. Servers 1..19 are synthetic, active, with one movies and one TV library each.
 */
export function seedCatalog(db, real, now = Date.now()) {
  const E = ENVELOPE;
  const W = WORDS.length;
  db.exec('PRAGMA foreign_keys = OFF; PRAGMA synchronous = OFF;');
  db.exec('BEGIN');
  db.exec('DROP TABLE IF EXISTS perf_words; DROP TABLE IF EXISTS perf_servers;');
  db.exec('CREATE TABLE perf_words (i INTEGER PRIMARY KEY, w TEXT)');
  const w = db.prepare('INSERT INTO perf_words (i, w) VALUES (?, ?)');
  WORDS.forEach((word, i) => w.run(i + 1, word));
  db.exec(
    'CREATE TABLE perf_servers (idx INTEGER PRIMARY KEY, server_id TEXT, movies_lib TEXT, tv_lib TEXT)',
  );

  const ins = db.prepare('INSERT INTO perf_servers VALUES (?, ?, ?, ?)');
  ins.run(0, real.serverId, real.moviesLib, real.tvLib);
  for (let i = 1; i < E.servers; i++) {
    const id = `PS${String(i).padStart(2, '0')}`;
    db.prepare(
      `INSERT INTO servers (id, type, name, base_url, origin_server_id, priority, status, created_at, updated_at)
       VALUES (?, 'jellyfin', ?, ?, ?, ?, 'active', ?, ?)`,
    ).run(
      id,
      `Perf Server ${i}`,
      `https://${id.toLowerCase()}.example.test`,
      `origin-${id}`,
      i % 5,
      now,
      now,
    );
    for (const [kind, suffix] of [
      ['movies', 'M'],
      ['tv', 'T'],
    ]) {
      db.prepare(
        `INSERT INTO libraries (id, server_id, provider_library_id, name, kind, enabled)
         VALUES (?, ?, ?, ?, ?, 1)`,
      ).run(`PL${id}${suffix}`, id, `p-${suffix}`, `${kind} ${i}`, kind);
    }
    ins.run(i, id, `PL${id}M`, `PL${id}T`);
  }

  // Viewers see about half of the libraries (the operator sees all, FR-USR-005).
  db.exec(`
    INSERT INTO library_grants (user_id, library_id, granted_at)
    SELECT u.id, l.id, ${now} FROM users u, libraries l
     WHERE u.role = 'viewer' AND u.id LIKE 'PU%'
       AND (CAST(substr(u.id, 3) AS INTEGER) + (SELECT count(*) FROM libraries x WHERE x.id < l.id)) % 2 = 0`);

  const title = (n) =>
    `(SELECT w FROM perf_words WHERE i = 1 + (${n} * 7) % ${W}) || ' ' ||
     (SELECT w FROM perf_words WHERE i = 1 + (${n} * 13 + 3) % ${W}) || ' ' || (${n} % 1000)`;
  const genres = (n) =>
    `'["' || (CASE ${n} % 8 ${GENRES.map((g, i) => `WHEN ${i} THEN '${g}'`).join(' ')} END) || '"]'`;
  const rec = (name, count) =>
    `WITH RECURSIVE ${name}(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM ${name} WHERE n < ${count})`;
  const item = (type, prefix, count, parent) => `
    INSERT INTO media_items (id, type, parent_id, title, sort_title, original_title, year, overview,
        genres, runtime_ms, season_number, episode_number, metadata_source_id, best_height, has_hdr,
        date_added, created_at, updated_at)
    ${rec('s', count)}
    SELECT printf('${prefix}%06d', n), '${type}', ${parent ? `printf('${parent.prefix}%06d', 1 + (n - 1) % ${parent.count})` : 'NULL'},
        ${title('n')}, lower(${title('n')}), NULL, 1940 + (n * 7) % 85,
        'Synthetic overview text for performance seeding.', ${genres('n')}, 5400000,
        ${type === 'season' ? '1 + (n - 1) / ' + parent.count : type === 'episode' ? '1 + (n - 1) / ' + parent.count : 'NULL'},
        ${type === 'episode' ? '1 + (n - 1) % 20' : 'NULL'},
        'p' || printf('${prefix}%06d', n), (CASE n % 4 WHEN 0 THEN 480 WHEN 1 THEN 720 WHEN 2 THEN 1080 ELSE 2160 END),
        n % 5 = 0, ${now} - n * 60000, ${now}, ${now}
      FROM s`;
  db.exec(item('movie', 'm', E.movies));
  db.exec(item('series', 's', E.series));
  db.exec(item('season', 'n', E.seasons, { prefix: 's', count: E.series }));
  db.exec(item('episode', 'e', E.episodes, { prefix: 'n', count: E.seasons }));

  // One primary source per canonical item, plus extra copies of movies on other servers.
  const primary = (type, prefix, count, lib) => `
    INSERT INTO sources (id, server_id, library_id, provider_item_id, media_item_id, item_type, title,
        year, match_method, artwork, content_hash, status, date_added, updated_at, meta)
    ${rec('s', count)}
    SELECT 'p' || printf('${prefix}%06d', n), ps.server_id, ps.${lib}, printf('${prefix}%06d', n),
        printf('${prefix}%06d', n), '${type}', ${title('n')}, NULL, 'new',
        '{"poster":{"tag":"t"},"backdrop":{"tag":"b"}}', 'h', 'present', ${now} - n * 60000, ${now}, '{}'
      FROM s JOIN perf_servers ps ON ps.idx = n % ${E.servers}`;
  db.exec(primary('movie', 'm', E.movies, 'movies_lib'));
  db.exec(primary('series', 's', E.series, 'tv_lib'));
  db.exec(primary('season', 'n', E.seasons, 'tv_lib'));
  db.exec(primary('episode', 'e', E.episodes, 'tv_lib'));
  db.exec(`
    INSERT INTO sources (id, server_id, library_id, provider_item_id, media_item_id, item_type, title,
        year, match_method, artwork, content_hash, status, date_added, updated_at, meta)
    ${rec('s', E.extraMovieSources)}
    SELECT 'd' || n, ps.server_id, ps.movies_lib, 'd' || n, m.id, 'movie', m.title, NULL, 'external_id',
        '{"poster":{"tag":"t"}}', 'h', 'present', ${now}, ${now}, '{}'
      FROM s
      JOIN media_items m ON m.id = printf('m%06d', 1 + (n * 7) % ${E.movies}) AND (1 + (n * 7) % ${E.movies}) % ${E.servers} <> 0
      JOIN perf_servers ps ON ps.idx = (1 + (n * 7) % ${E.movies} + 1 + n % ${E.servers - 1}) % ${E.servers}`);

  db.exec(`
    INSERT INTO media_versions (id, source_id, provider_version_id, container, video_codec, width, height,
        hdr, bitrate, runtime_ms, size_bytes, audio_tracks, subtitle_tracks)
    SELECT 'v' || id, id, id, 'mkv', 'h264', 1920,
        (CASE rowid % 4 WHEN 0 THEN 480 WHEN 1 THEN 720 WHEN 2 THEN 1080 ELSE 2160 END),
        (CASE rowid % 7 WHEN 0 THEN 'hdr10' ELSE 'none' END), 8000000, 5400000, 4000000000,
        '[{"index":1,"codec":"aac","channels":2,"language":"eng","default":true}]', '[]'
      FROM sources`);
  db.exec(`INSERT OR IGNORE INTO item_availability (media_item_id, library_id)
           SELECT media_item_id, library_id FROM sources WHERE status = 'present'`);

  // People: one provider link each, credited on movies and series (5 credits per title).
  db.exec(`
    INSERT INTO people (id, name, sort_name, name_key, metadata_link_id, created_at, updated_at)
    ${rec('s', E.people)}
    SELECT printf('P%06d', n), (SELECT w FROM perf_words WHERE i = 1 + (n * 11) % ${W}) || ' ' ||
           (SELECT w FROM perf_words WHERE i = 1 + (n * 17 + 5) % ${W}) || ' ' || (n % 500),
        '', '', printf('L%06d', n), ${now}, ${now}
      FROM s;
    UPDATE people SET name = upper(substr(name, 1, 1)) || substr(name, 2),
        sort_name = lower(name), name_key = lower(name);
    INSERT INTO person_provider_links (id, person_id, server_id, provider_person_id, name, artwork,
        match_method, updated_at)
    SELECT printf('L%06d', n), printf('P%06d', n), ps.server_id, printf('pp%06d', n), '', '{"poster":{"tag":"t"}}',
        'new', ${now} FROM (${rec('s', E.people)} SELECT n FROM s) q
      JOIN perf_servers ps ON ps.idx = n % ${E.servers}`);
  db.exec(`
    INSERT INTO credits (source_id, link_id, role, person_id, media_item_id, character, sort_order)
    SELECT 'p' || m.id, printf('L%06d', 1 + (CAST(substr(m.id, 2) AS INTEGER) * 5 + k.k) % ${E.people}),
        (CASE k.k WHEN 4 THEN 'director' ELSE 'actor' END),
        printf('P%06d', 1 + (CAST(substr(m.id, 2) AS INTEGER) * 5 + k.k) % ${E.people}), m.id, 'Role', k.k
      FROM media_items m, (SELECT 0 AS k UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4) k
     WHERE m.type IN ('movie', 'series') AND m.id LIKE 'm%'`);
  db.exec(`
    INSERT OR IGNORE INTO credits (source_id, link_id, role, person_id, media_item_id, character, sort_order)
    SELECT 'p' || m.id, printf('L%06d', 1 + (CAST(substr(m.id, 2) AS INTEGER) * 3 + k.k) % ${E.people}),
        'actor', printf('P%06d', 1 + (CAST(substr(m.id, 2) AS INTEGER) * 3 + k.k) % ${E.people}), m.id, 'Role', k.k
      FROM media_items m, (SELECT 0 AS k UNION SELECT 1 UNION SELECT 2) k
     WHERE m.type = 'series'`);

  // Collections with 10 member movies each.
  db.exec(`
    INSERT INTO collections (id, name, sort_name, overview, metadata_link_id, created_at, updated_at)
    ${rec('s', E.collections)}
    SELECT printf('C%05d', n), (SELECT w FROM perf_words WHERE i = 1 + (n * 5) % ${W}) || ' Collection ' || n,
        lower((SELECT w FROM perf_words WHERE i = 1 + (n * 5) % ${W}) || ' Collection ' || n), NULL,
        printf('CL%05d', n), ${now}, ${now}
      FROM s;
    INSERT INTO collection_provider_links (id, collection_id, server_id, provider_collection_id, name,
        artwork, match_method, updated_at)
    SELECT printf('CL%05d', n), printf('C%05d', n), ps.server_id, printf('pc%05d', n), 'c',
        '{"poster":{"tag":"t"}}', 'new', ${now}
      FROM (${rec('s', E.collections)} SELECT n FROM s) q JOIN perf_servers ps ON ps.idx = n % ${E.servers};
    INSERT INTO collection_members (link_id, source_id, media_item_id)
    SELECT printf('CL%05d', c.n), 'p' || printf('m%06d', 1 + (c.n * ${E.membersPerCollection} + k.k) % ${E.movies}),
        printf('m%06d', 1 + (c.n * ${E.membersPerCollection} + k.k) % ${E.movies})
      FROM (${rec('s', E.collections)} SELECT n FROM s) c,
           (${rec('t', E.membersPerCollection)} SELECT n - 1 AS k FROM t) k`);

  // The FTS index: titles of movies and series, people, collections.
  db.exec(`
    INSERT INTO search_fts (kind, entity_id, name, alt_name)
    SELECT 'title', id, title, '' FROM media_items WHERE type IN ('movie', 'series');
    INSERT INTO search_fts (kind, entity_id, name, alt_name) SELECT 'person', id, name, '' FROM people;
    INSERT INTO search_fts (kind, entity_id, name, alt_name) SELECT 'collection', id, name, '' FROM collections`);

  // Some watch progress for every user.
  db.exec(`
    INSERT INTO watch_progress (user_id, media_item_id, position_ms, runtime_ms, watched, updated_at)
    SELECT u.id, printf('m%06d', 1 + (CAST(substr(u.id, 3) AS INTEGER) * 997 + k.n) % ${E.movies}),
        600000 + k.n * 1000, 5400000, 0, ${now} - k.n * 1000
      FROM users u, (${rec('s', 40)} SELECT n FROM s) k WHERE u.id LIKE 'PU%'`);

  db.exec('DROP TABLE perf_words; DROP TABLE perf_servers; COMMIT');
  db.exec('PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;');
  return counts(db);
}

export function counts(db) {
  const n = (t) => db.prepare(`SELECT count(*) AS c FROM ${t}`).get().c;
  return Object.fromEntries(
    [
      'servers',
      'libraries',
      'library_grants',
      'users',
      'media_items',
      'sources',
      'media_versions',
      'item_availability',
      'people',
      'credits',
      'collections',
      'collection_members',
      'search_fts',
      'watch_progress',
    ].map((t) => [t, n(t)]),
  );
}
