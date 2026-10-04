/**
 * Seeded catalog data for the M2 read-API tests. Rows are written straight into D1 in the shape
 * the sync and matching code produces (LLD-SCHEMA), so these tests do not depend on sync.
 */
import { env } from 'cloudflare:workers';
import { encrypt, loadKeyring } from '../src/vault/vault';
import { resetDb, sha256Hex } from './auth-harness';

const db = env.DB;
export const T0 = 1_700_000_000_000;

export async function resetAll(): Promise<void> {
  await resetDb(); // users, servers (cascades libraries, sources, links), audit, meta
  await db.batch(
    [
      'DELETE FROM media_items',
      'DELETE FROM people',
      'DELETE FROM collections',
      'DELETE FROM search_fts',
      'DELETE FROM idempotency_keys',
    ].map((sql) => db.prepare(sql)),
  );
}

export async function seedServer(s: {
  id: string;
  name?: string;
  status?: string;
  priority?: number;
  baseUrl?: string;
  /** Store a real encrypted credential (needed by artwork). */
  credentials?: boolean;
}): Promise<void> {
  await db
    .prepare(
      `INSERT INTO servers (id, type, name, base_url, origin_server_id, priority, status, created_at, updated_at)
       VALUES (?, 'jellyfin', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      s.id,
      s.name ?? s.id,
      s.baseUrl ?? `https://${s.id}.example.test`,
      `origin-${s.id}`,
      s.priority ?? 0,
      s.status ?? 'active',
      T0,
      T0,
    )
    .run();
  if (s.credentials !== false) {
    const keyring = await loadKeyring(env);
    const sealed = await encrypt(
      keyring,
      'server_secret',
      s.id,
      JSON.stringify({ kind: 'password', username: 'svc', password: 'pw-secret-value' }),
    );
    await db
      .prepare(
        'INSERT INTO server_credentials (server_id, key_version, secret_envelope, updated_at) VALUES (?, ?, ?, ?)',
      )
      .bind(s.id, sealed.keyVersion, sealed.envelope, T0)
      .run();
  }
}

export async function seedLibrary(l: {
  id: string;
  serverId: string;
  enabled?: boolean;
  kind?: 'movies' | 'tv';
}): Promise<void> {
  await db
    .prepare(
      'INSERT INTO libraries (id, server_id, provider_library_id, name, kind, enabled) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(l.id, l.serverId, `p-${l.id}`, l.id, l.kind ?? 'movies', l.enabled === false ? 0 : 1)
    .run();
}

export interface SeedVersion {
  height?: number;
  hdr?: string;
  codec?: string;
}

export interface SeedSource {
  library: string;
  server: string;
  /** Artwork tags by slot; the provider item ID is `prov-<itemId>-<server>`. */
  art?: Partial<Record<'poster' | 'backdrop' | 'thumb', string>>;
  status?: 'present' | 'missing';
  versions?: SeedVersion[];
}

export async function seedItem(i: {
  id: string;
  type?: 'movie' | 'series' | 'season' | 'episode';
  title: string;
  year?: number;
  parent?: string;
  season?: number;
  episode?: number;
  genres?: string[];
  added?: number;
  alt?: string;
  sources: SeedSource[];
}): Promise<void> {
  const type = i.type ?? 'movie';
  const statements: D1PreparedStatement[] = [];
  const first = i.sources[0];
  statements.push(
    db
      .prepare(
        `INSERT INTO media_items (id, type, parent_id, title, sort_title, year, overview, genres,
           season_number, episode_number, metadata_source_id, date_added, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'An overview.', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        i.id,
        type,
        i.parent ?? null,
        i.title,
        i.title.toLowerCase(),
        i.year ?? null,
        JSON.stringify(i.genres ?? []),
        i.season ?? null,
        i.episode ?? null,
        first ? `src-${i.id}-${first.server}` : null,
        i.added ?? T0,
        T0,
        T0,
      ),
  );
  for (const s of i.sources) {
    const sid = `src-${i.id}-${s.server}`;
    statements.push(
      db
        .prepare(
          `INSERT INTO sources (id, server_id, library_id, provider_item_id, media_item_id, item_type, title,
             match_method, artwork, content_hash, status, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?, 'h', ?, ?)`,
        )
        .bind(
          sid,
          s.server,
          s.library,
          `prov-${i.id}-${s.server}`,
          i.id,
          type,
          i.title,
          JSON.stringify(
            Object.fromEntries(Object.entries(s.art ?? {}).map(([k, tag]) => [k, { tag }])),
          ),
          s.status ?? 'present',
          T0,
        ),
    );
    if ((s.status ?? 'present') === 'present') {
      statements.push(
        db
          .prepare(
            'INSERT OR IGNORE INTO item_availability (media_item_id, library_id) VALUES (?, ?)',
          )
          .bind(i.id, s.library),
      );
    }
    (s.versions ?? []).forEach((v, n) => {
      statements.push(
        db
          .prepare(
            `INSERT INTO media_versions (id, source_id, provider_version_id, video_codec, height, hdr)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            `ver-${sid}-${n}`,
            sid,
            `pv-${n}`,
            v.codec ?? 'h264',
            v.height ?? 1080,
            v.hdr ?? 'none',
          ),
      );
    });
  }
  if (type === 'movie' || type === 'series') {
    statements.push(
      db
        .prepare('INSERT INTO search_fts (kind, entity_id, name, alt_name) VALUES (?, ?, ?, ?)')
        .bind('title', i.id, i.title, i.alt ?? null),
    );
  }
  await db.batch(statements);
}

export async function seedPerson(p: {
  id: string;
  name: string;
  server: string;
  portrait?: string;
  credits: { item: string; role?: string; character?: string; order?: number }[];
}): Promise<void> {
  const link = `plink-${p.id}-${p.server}`;
  const statements = [
    db
      .prepare(
        `INSERT INTO people (id, name, sort_name, name_key, metadata_link_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(p.id, p.name, p.name.toLowerCase(), p.name.toLowerCase(), link, T0, T0),
    db
      .prepare(
        `INSERT INTO person_provider_links (id, person_id, server_id, provider_person_id, name, artwork,
           match_method, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'new', ?)`,
      )
      .bind(
        link,
        p.id,
        p.server,
        `pp-${p.id}`,
        p.name,
        JSON.stringify(p.portrait ? { poster: { tag: p.portrait } } : {}),
        T0,
      ),
    db
      .prepare('INSERT INTO search_fts (kind, entity_id, name, alt_name) VALUES (?, ?, ?, NULL)')
      .bind('person', p.id, p.name),
  ];
  for (const [n, cr] of p.credits.entries()) {
    statements.push(
      db
        .prepare(
          `INSERT INTO credits (source_id, link_id, role, person_id, media_item_id, character, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          `src-${cr.item}-${p.server}`,
          link,
          cr.role ?? 'actor',
          p.id,
          cr.item,
          cr.character ?? null,
          cr.order ?? n,
        ),
    );
  }
  await db.batch(statements);
}

export async function seedCollection(c: {
  id: string;
  name: string;
  server: string;
  art?: string;
  members: string[];
}): Promise<void> {
  const link = `clink-${c.id}`;
  const statements = [
    db
      .prepare(
        `INSERT INTO collections (id, name, sort_name, overview, metadata_link_id, created_at, updated_at)
         VALUES (?, ?, ?, 'About it.', ?, ?, ?)`,
      )
      .bind(c.id, c.name, c.name.toLowerCase(), link, T0, T0),
    db
      .prepare(
        `INSERT INTO collection_provider_links (id, collection_id, server_id, provider_collection_id, name,
           artwork, match_method, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'new', ?)`,
      )
      .bind(
        link,
        c.id,
        c.server,
        `pc-${c.id}`,
        c.name,
        JSON.stringify(c.art ? { poster: { tag: c.art } } : {}),
        T0,
      ),
    db
      .prepare('INSERT INTO search_fts (kind, entity_id, name, alt_name) VALUES (?, ?, ?, NULL)')
      .bind('collection', c.id, c.name),
  ];
  for (const m of c.members) {
    statements.push(
      db
        .prepare(
          'INSERT INTO collection_members (link_id, source_id, media_item_id) VALUES (?, ?, ?)',
        )
        .bind(link, `src-${m}-${c.server}`, m),
    );
  }
  await db.batch(statements);
}

/** A user plus a live session; returns the Cookie header value. */
export async function seedUser(
  id: string,
  role: 'operator' | 'viewer',
  grants: string[] = [],
): Promise<{ id: string; cookie: string }> {
  const value = `cookie-${id}-0123456789abcdefghijklmnopqrstuvwxyz`;
  await db.batch([
    db
      .prepare(
        "INSERT INTO users (id, display_name, role, status, created_at) VALUES (?, ?, ?, 'active', ?)",
      )
      .bind(id, `User ${id}`, role, T0),
    db
      .prepare(
        `INSERT INTO sessions (id_hash, user_id, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        await sha256Hex(value),
        id,
        Date.now(),
        Date.now(),
        Date.now() + 86_400_000,
        Date.now() + 86_400_000,
      ),
    ...grants.map((g) =>
      db
        .prepare('INSERT INTO library_grants (user_id, library_id, granted_at) VALUES (?, ?, ?)')
        .bind(id, g, T0),
    ),
  ]);
  return { id, cookie: `__Host-cw_session=${value}` };
}

export interface World {
  op: { id: string; cookie: string };
  /** Granted L1 and L2 (Alpha). */
  alice: { id: string; cookie: string };
  /** A viewer with no grants at all. */
  bob: { id: string; cookie: string };
  /** Granted L3 only (Bravo, unreachable). */
  carol: { id: string; cookie: string };
}

/**
 * Servers: Alpha active (L1 movies, L2 tv, L5 movies *disabled*), Bravo unreachable (L3),
 * Gone disabled (L4). Items:
 *  m-amelie     L1 (1080p) + L3 (2160 HDR10): two servers
 *  m-inter      L3 only: hidden from Alice and Bob
 *  m-secret     L5 only (disabled library): hidden from everyone
 *  m-gone       L4 only (disabled server): hidden from everyone
 *  s-sev > se-1 > ep-1, ep-2   L2
 * People: Evans (credits m-amelie, m-inter), Hidden Actor (m-inter only).
 * Collections: Duology (m-amelie, m-inter), Hidden Coll (m-inter), and two named "Favourites"
 * (one on each of Alpha and Bravo, each with one member).
 */
export async function seedWorld(): Promise<World> {
  await seedServer({ id: 'alpha', name: 'Alpha', priority: 5 });
  await seedServer({ id: 'bravo', name: 'Bravo', status: 'unreachable' });
  await seedServer({ id: 'gone', name: 'Gone', status: 'disabled' });
  await seedLibrary({ id: 'L1', serverId: 'alpha' });
  await seedLibrary({ id: 'L2', serverId: 'alpha', kind: 'tv' });
  await seedLibrary({ id: 'L5', serverId: 'alpha', enabled: false });
  await seedLibrary({ id: 'L3', serverId: 'bravo' });
  await seedLibrary({ id: 'L4', serverId: 'gone' });

  await seedItem({
    id: 'm-amelie',
    title: 'Amélie',
    alt: 'Le Fabuleux Destin',
    year: 2001,
    genres: ['Comedy', 'Romance'],
    added: T0 + 3000,
    sources: [
      {
        library: 'L1',
        server: 'alpha',
        art: { poster: 'tagA', backdrop: 'bdA' },
        versions: [{ height: 1080 }],
      },
      {
        library: 'L3',
        server: 'bravo',
        art: { poster: 'tagB' },
        versions: [{ height: 2160, hdr: 'hdr10' }],
      },
    ],
  });
  await seedItem({
    id: 'm-inter',
    title: 'Interstellar',
    year: 2014,
    genres: ['Sci-Fi'],
    added: T0 + 2000,
    sources: [
      { library: 'L3', server: 'bravo', art: { poster: 'tagI' }, versions: [{ height: 2160 }] },
    ],
  });
  await seedItem({
    id: 'm-secret',
    title: 'Secret Movie',
    year: 2020,
    added: T0 + 5000,
    sources: [{ library: 'L5', server: 'alpha', art: { poster: 'tagS' } }],
  });
  await seedItem({
    id: 'm-gone',
    title: 'Gone Movie',
    year: 2019,
    added: T0 + 6000,
    sources: [{ library: 'L4', server: 'gone', art: { poster: 'tagG' } }],
  });
  await seedItem({
    id: 's-sev',
    type: 'series',
    title: 'Severance',
    year: 2022,
    genres: ['Drama'],
    added: T0 + 1000,
    sources: [{ library: 'L2', server: 'alpha', art: { poster: 'tagSev' } }],
  });
  await seedItem({
    id: 'se-1',
    type: 'season',
    title: 'Season 1',
    parent: 's-sev',
    season: 1,
    sources: [{ library: 'L2', server: 'alpha' }],
  });
  await seedItem({
    id: 'ep-1',
    type: 'episode',
    title: 'Good News About Hell',
    parent: 'se-1',
    season: 1,
    episode: 1,
    sources: [{ library: 'L2', server: 'alpha', versions: [{ height: 1080 }] }],
  });
  await seedItem({
    id: 'ep-2',
    type: 'episode',
    title: 'Half Loop',
    parent: 'se-1',
    season: 1,
    episode: 2,
    sources: [
      { library: 'L2', server: 'alpha', versions: [{ height: 2160, hdr: 'dolby_vision' }] },
    ],
  });

  await seedPerson({
    id: 'p-evans',
    name: 'Chris Evans',
    server: 'alpha',
    portrait: 'face1',
    credits: [{ item: 'm-amelie', character: 'Nino' }],
  });
  // Evans' second credit comes from Bravo's copy of Interstellar, on the same canonical person.
  await db.batch([
    db
      .prepare(
        `INSERT INTO person_provider_links (id, person_id, server_id, provider_person_id, name, artwork,
           match_method, updated_at) VALUES ('plink-evans-bravo', 'p-evans', 'bravo', 'pp-evans-b', 'Chris Evans', '{}', 'external_id', ?)`,
      )
      .bind(T0),
    db.prepare(
      `INSERT INTO credits (source_id, link_id, role, person_id, media_item_id, character, sort_order)
         VALUES ('src-m-inter-bravo', 'plink-evans-bravo', 'actor', 'p-evans', 'm-inter', 'Cooper', 0)`,
    ),
  ]);
  await seedPerson({
    id: 'p-hidden',
    name: 'Hidden Actor',
    server: 'bravo',
    portrait: 'face2',
    credits: [{ item: 'm-inter' }],
  });
  await seedCollection({
    id: 'c-duo',
    name: 'Duology',
    server: 'bravo',
    art: 'cover1',
    members: ['m-amelie', 'm-inter'],
  });
  await seedCollection({
    id: 'c-hidden',
    name: 'Hidden Coll',
    server: 'bravo',
    members: ['m-inter'],
  });
  await seedCollection({
    id: 'c-fav-a',
    name: 'Favourites',
    server: 'alpha',
    members: ['m-amelie'],
  });
  await seedCollection({
    id: 'c-fav-b',
    name: 'Favourites',
    server: 'bravo',
    members: ['m-inter'],
  });

  return {
    op: await seedUser('op', 'operator'),
    alice: await seedUser('alice', 'viewer', ['L1', 'L2']),
    bob: await seedUser('bob', 'viewer'),
    carol: await seedUser('carol', 'viewer', ['L3']),
  };
}
