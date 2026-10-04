/**
 * Test harness for sync and matching (T2.1 to T2.3, T2.9, T2.10): a fake provider whose catalog
 * the test edits between runs, an in-memory queue that can be drained like the real consumer,
 * a controllable clock, and D1 seeding helpers. No test touches the network.
 */
import { env } from 'cloudflare:workers';
import { createLogger } from '../../src/platform/logger';
import { ProviderError } from '../../src/providers/errors';
import type {
  ItemsPage,
  ListItemsRequest,
  MediaProvider,
  NormalizedCollection,
  NormalizedCredit,
  NormalizedItem,
  NormalizedVersion,
  ProviderContext,
} from '../../src/providers/types';
import { DEFAULT_SYNC_CONFIG, type SyncConfig } from '../../src/sync/config';
import type { JobMessage, OpenedServer, SyncDeps } from '../../src/sync/deps';
import { handleJob } from '../../src/sync/jobs';

export const db = env.DB;

// --- clock, queue, deps ---

export interface Harness {
  deps: SyncDeps;
  sent: JobMessage[];
  sleeps: number[];
  clock: { now: number };
  origins: Map<string, FakeOrigin>;
  /** Handles queued messages one at a time until the queue is empty (the real consumer). */
  drain(limit?: number): Promise<number>;
}

export function makeHarness(
  options: { config?: Partial<SyncConfig>; origins?: FakeOrigin[]; serverIds?: string[] } = {},
): Harness {
  const sent: JobMessage[] = [];
  const sleeps: number[] = [];
  const clock = { now: 1_800_000_000_000 };
  const origins = new Map<string, FakeOrigin>();
  (options.origins ?? []).forEach((o, i) => origins.set(options.serverIds?.[i] ?? o.serverId, o));
  let counter = 0;
  const deps: SyncDeps = {
    db,
    queue: {
      send: (m) => {
        sent.push(m);
        return Promise.resolve();
      },
    },
    config: { ...DEFAULT_SYNC_CONFIG, ...options.config },
    now: () => clock.now,
    sleep: (ms) => {
      sleeps.push(ms);
      clock.now += ms;
      return Promise.resolve();
    },
    random: () => 0.5,
    newId: () =>
      `T${String(++counter).padStart(8, '0')}${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
    logger: createLogger({}, () => undefined),
    openServer: (server): Promise<OpenedServer> => {
      const origin = origins.get(server.id);
      if (!origin) return Promise.reject(new Error(`No fake origin for ${server.id}`));
      return Promise.resolve({ provider: origin.provider(), ctx: origin.ctx(server.id) });
    },
  };
  const h: Harness = {
    deps,
    sent,
    sleeps,
    clock,
    origins,
    async drain(limit = 50) {
      let handled = 0;
      while (sent.length > 0) {
        if (handled >= limit) throw new Error('queue did not drain');
        const job = sent.shift();
        if (!job) break;
        await handleJob(deps, job, deps.logger);
        handled++;
      }
      return handled;
    },
  };
  return h;
}

// --- the fake origin ---

/** A provider whose catalog is plain data the test mutates between runs. */
export class FakeOrigin {
  items = new Map<string, NormalizedItem[]>();
  collections: NormalizedCollection[] = [];
  /** Errors thrown by the next `listItems` calls, consumed in order. */
  itemErrors: unknown[] = [];
  collectionErrors: unknown[] = [];
  itemCalls = 0;
  lastRequests: ListItemsRequest[] = [];
  /** Throws once, after this many successful `listItems` calls (a killed run). */
  crashAfterCalls: number | null = null;
  constructor(readonly serverId: string) {}

  setItems(libraryId: string, items: NormalizedItem[]): void {
    this.items.set(libraryId, items);
  }

  ctx(serverId: string): ProviderContext {
    return {
      server: { id: serverId, type: 'jellyfin', baseUrl: new URL('https://fake.example.test') },
      secret: { kind: 'password', username: 'u', password: 'p' },
      fetch: () => Promise.reject(new Error('the fake origin has no HTTP')),
      onTokenRefresh: () => Promise.resolve(),
    };
  }

  provider(): MediaProvider {
    const origin = this;
    const unsupported = () =>
      Promise.reject(new ProviderError('UNSUPPORTED', 'not in the fake', false));
    return {
      type: 'jellyfin',
      validate: unsupported,
      listLibraries: () => Promise.resolve([]),
      listItems(_ctx, req): Promise<ItemsPage> {
        origin.itemCalls++;
        origin.lastRequests.push(req);
        if (origin.crashAfterCalls !== null && origin.itemCalls > origin.crashAfterCalls) {
          origin.crashAfterCalls = null;
          return Promise.reject(new Error('process killed'));
        }
        const err = origin.itemErrors.shift();
        if (err) return Promise.reject(err instanceof Error ? err : new Error('boom'));
        const all = origin.items.get(req.libraryId) ?? [];
        const start = req.cursor === undefined ? 0 : Number(req.cursor);
        const slice = all.slice(start, start + req.pageSize);
        const next = start + slice.length;
        return Promise.resolve({
          items: slice,
          nextCursor: next < all.length ? String(next) : null,
        });
      },
      listCollections(_ctx, req) {
        const err = origin.collectionErrors.shift();
        if (err) return Promise.reject(err instanceof Error ? err : new Error('boom'));
        const start = req.cursor === undefined ? 0 : Number(req.cursor);
        const slice = origin.collections.slice(start, start + req.pageSize);
        const next = start + slice.length;
        return Promise.resolve({
          collections: slice,
          nextCursor: next < origin.collections.length ? String(next) : null,
        });
      },
      getItem: () => Promise.resolve(null),
      getArtworkRequest: () => new Request('https://fake.example.test/'),
      probe: () => Promise.resolve({ ok: true, latencyMs: 1 }),
      createSessionCredential: unsupported,
      revokeSessionCredential: unsupported,
      negotiatePlayback: unsupported,
      reportPlayback: unsupported,
    };
  }
}

export const unavailable = (): ProviderError =>
  new ProviderError('UNAVAILABLE', 'The origin answered with status 503.', true);

// --- item builders ---

const base = {
  genres: [] as string[],
  artwork: {},
  versions: [] as NormalizedVersion[],
  credits: [] as NormalizedCredit[],
};

export const version = (
  id: string,
  height = 1080,
  hdr: NormalizedVersion['hdr'] = 'none',
): NormalizedVersion => ({
  providerVersionId: id,
  container: 'mkv',
  videoCodec: 'h264',
  width: Math.round((height * 16) / 9),
  height,
  hdr,
  sizeBytes: 1000,
  audio: [{ index: 1, codec: 'aac', language: 'eng', isDefault: true }],
  subtitles: [],
});

export function movie(
  id: string,
  title: string,
  o: Partial<NormalizedItem> & { tmdb?: string; imdb?: string } = {},
): NormalizedItem {
  const { tmdb, imdb, ...rest } = o;
  return {
    ...base,
    providerItemId: id,
    type: 'movie',
    title,
    year: 2014,
    externalIds: { ...(tmdb ? { tmdb } : {}), ...(imdb ? { imdb } : {}) },
    versions: [version(`${id}-v1`)],
    dateAdded: 1_700_000_000_000,
    ...rest,
  };
}

export function series(
  id: string,
  title: string,
  o: Partial<NormalizedItem> & { tvdb?: string; tmdb?: string; imdb?: string } = {},
): NormalizedItem {
  const { tvdb, tmdb, imdb, ...rest } = o;
  return {
    ...base,
    providerItemId: id,
    type: 'series',
    title,
    year: 1951,
    externalIds: {
      ...(tvdb ? { tvdb } : {}),
      ...(tmdb ? { tmdb } : {}),
      ...(imdb ? { imdb } : {}),
    },
    dateAdded: 1_700_000_000_000,
    ...rest,
  };
}

export const season = (id: string, parent: string, n: number): NormalizedItem => ({
  ...base,
  providerItemId: id,
  providerParentId: parent,
  type: 'season',
  title: `Season ${n}`,
  seasonNumber: n,
  externalIds: {},
  dateAdded: 1_700_000_000_000,
});

export const episode = (
  id: string,
  parent: string,
  s: number,
  e: number,
  o: Partial<NormalizedItem> = {},
): NormalizedItem => ({
  ...base,
  providerItemId: id,
  providerParentId: parent,
  type: 'episode',
  title: `Episode ${e}`,
  seasonNumber: s,
  episodeNumber: e,
  externalIds: {},
  versions: [version(`${id}-v1`, 720)],
  dateAdded: 1_700_000_000_000,
  ...o,
});

export const credit = (
  personId: string,
  name: string,
  o: {
    role?: NormalizedCredit['role'];
    tmdb?: string;
    imdb?: string;
    character?: string;
    order?: number;
  } = {},
): NormalizedCredit => ({
  person: {
    providerPersonId: personId,
    name,
    externalIds: { ...(o.tmdb ? { tmdb: o.tmdb } : {}), ...(o.imdb ? { imdb: o.imdb } : {}) },
  },
  role: o.role ?? 'actor',
  ...(o.character ? { character: o.character } : {}),
  order: o.order ?? 0,
});

export const collection = (
  id: string,
  name: string,
  members: string[],
  tmdb?: string,
): NormalizedCollection => ({
  providerCollectionId: id,
  name,
  externalIds: tmdb ? { tmdb } : {},
  artwork: {},
  memberProviderItemIds: members,
});

// --- D1 seeding and inspection ---

export async function resetCatalog(): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM servers'),
    db.prepare('DELETE FROM media_items'),
    db.prepare('DELETE FROM people'),
    db.prepare('DELETE FROM collections'),
    db.prepare('DELETE FROM search_fts'),
    db.prepare('DELETE FROM curation_overrides'),
    db.prepare('DELETE FROM meta'),
    db.prepare('DELETE FROM audit_log'),
  ]);
}

export interface SeedServer {
  id: string;
  priority?: number;
  status?: string;
  libraries?: { id: string; providerId?: string; kind?: 'movies' | 'tv'; enabled?: boolean }[];
  baseUrl?: string;
  type?: string;
}

export async function seedServer(s: SeedServer): Promise<void> {
  const now = 1_700_000_000_000;
  const libs = s.libraries ?? [{ id: `${s.id}-lib`, providerId: `${s.id}-plib` }];
  await db.batch([
    db
      .prepare(
        `INSERT INTO servers (id, type, name, base_url, origin_server_id, status, priority, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        s.id,
        s.type ?? 'jellyfin',
        `Server ${s.id}`,
        s.baseUrl ?? `https://${s.id}.example.test`,
        `origin-${s.id}`,
        s.status ?? 'active',
        s.priority ?? 0,
        now,
        now,
      ),
    db
      .prepare(
        'INSERT INTO server_credentials (server_id, key_version, secret_envelope, updated_at) VALUES (?, 1, ?, ?)',
      )
      .bind(s.id, 'cw1.1.invalid.invalid', now),
    ...libs.map((l) =>
      db
        .prepare(
          `INSERT INTO libraries (id, server_id, provider_library_id, name, kind, enabled)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          l.id,
          s.id,
          l.providerId ?? `${l.id}-p`,
          `Library ${l.id}`,
          l.kind ?? 'movies',
          l.enabled === false ? 0 : 1,
        ),
    ),
  ]);
}

export async function rows<T = Record<string, unknown>>(
  sql: string,
  ...binds: unknown[]
): Promise<T[]> {
  return (
    await db
      .prepare(sql)
      .bind(...binds)
      .all<T>()
  ).results;
}

export async function one<T = Record<string, unknown>>(
  sql: string,
  ...binds: unknown[]
): Promise<T | null> {
  return db
    .prepare(sql)
    .bind(...binds)
    .first<T>();
}

export async function count(table: string, where = '1=1', ...binds: unknown[]): Promise<number> {
  return (
    (await one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, ...binds))?.n ??
    -1
  );
}

/** Everything a viewer can observe about the catalog, minus bookkeeping (`last_seen_sync_id`). */
export async function catalogSnapshot(): Promise<unknown> {
  return {
    items: await rows('SELECT * FROM media_items ORDER BY id'),
    sources: await rows(
      `SELECT id, server_id, library_id, provider_item_id, media_item_id, title, year, status,
              missing_since, content_hash, external_ids, match_method, artwork, meta, updated_at
         FROM sources ORDER BY id`,
    ),
    versions: await rows('SELECT * FROM media_versions ORDER BY id'),
    externalIds: await rows('SELECT * FROM external_ids ORDER BY media_item_id, scheme, value'),
    availability: await rows('SELECT * FROM item_availability ORDER BY media_item_id, library_id'),
    people: await rows('SELECT * FROM people ORDER BY id'),
    links: await rows('SELECT * FROM person_provider_links ORDER BY id'),
    credits: await rows('SELECT * FROM credits ORDER BY source_id, link_id, role'),
    collections: await rows('SELECT * FROM collections ORDER BY id'),
    collectionLinks: await rows(
      'SELECT id, collection_id, name, overview, tmdb_collection_id FROM collection_provider_links ORDER BY id',
    ),
    members: await rows('SELECT * FROM collection_members ORDER BY link_id, source_id'),
    conflicts: await rows('SELECT * FROM match_conflicts ORDER BY id'),
    fts: await rows(
      'SELECT kind, entity_id, name, alt_name FROM search_fts ORDER BY kind, entity_id',
    ),
  };
}

/** Runs one sync of `serverId` through the real orchestrator and consumer; returns the run row. */
export async function syncOnce(
  h: Harness,
  serverId: string,
  type: 'full' | 'incremental' = 'full',
  options: { force?: boolean } = {},
): Promise<{ runId: string; status: string; run: Record<string, unknown> }> {
  const { enqueueRun } = await import('../../src/sync/scheduler');
  const r = await enqueueRun(h.deps, serverId, type, 'manual', options);
  if (!r.ok) throw new Error('a run is already active');
  await h.drain();
  const run = (await one<Record<string, unknown>>(
    'SELECT * FROM sync_runs WHERE id = ?',
    r.runId,
  ))!;
  return { runId: r.runId, status: String(run.status), run };
}
