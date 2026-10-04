// Captures the SQL the catalog and playback read paths issue, by running the real query builders
// (apps/worker/src/db/*.ts) against a fake D1 that records `prepare(sql).bind(...).all()`. Used for
// EXPLAIN QUERY PLAN and rows-read measurement, so the analysed SQL cannot drift from the app's.
// Needs Node 22.15 or newer (type stripping and module.registerHooks).
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

// The Worker sources import siblings without a file extension; resolve them as .ts.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (specifier.startsWith('.') && !/\.\w+$/.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw err;
    }
  },
});

const src = (rel) => pathToFileURL(new URL(`../../apps/worker/src/${rel}`, import.meta.url).pathname).href;

/** @param {{ item: string, series: string, season: string, person: string, collection: string, viewer: string }} ids */
export async function captureQueries(ids) {
  const cat = await import(src('db/catalog.ts'));
  const pb = await import(src('db/playback.ts'));
  const out = [];
  let current = '';
  const db = {
    prepare(sql) {
      return {
        bind(...params) {
          return {
            all() {
              out.push({ name: current, sql, params });
              return Promise.resolve({ results: [] });
            },
          };
        },
      };
    },
  };
  const run = async (name, fn) => {
    current = name;
    await fn();
  };
  const viewer = { userId: ids.viewer, isOperator: false };
  const operator = { userId: 'PU000', isOperator: true };
  const match = (t) => `{name alt_name}:("${t}"*)`;

  for (const [who, v] of [
    ['viewer', viewer],
    ['operator', operator],
  ]) {
    const q = (name, fn) => run(`${name} [${who}]`, fn);
    await q('home: recently added', () => cat.recentlyAdded(db, v, 20));
    await q('home: continue watching', () => pb.continueWatching(db, v, 60_000, 20));
    const base = { sort: 'title', desc: false, limit: 51 };
    await q('browse: movies by title, page 1', () =>
      cat.browseItems(db, v, { ...base, type: 'movie' }),
    );
    await q('browse: movies by title, deep page', () =>
      cat.browseItems(db, v, { ...base, type: 'movie', after: ['lantern 12', 'm030000'] }),
    );
    await q('browse: series by title', () => cat.browseItems(db, v, { ...base, type: 'series' }));
    await q('browse: movies by date added', () =>
      cat.browseItems(db, v, { ...base, type: 'movie', sort: 'added', desc: true }),
    );
    await q('browse: movies by year', () =>
      cat.browseItems(db, v, { ...base, type: 'movie', sort: 'year' }),
    );
    await q('browse: genre filter', () =>
      cat.browseItems(db, v, { ...base, type: 'movie', genre: 'Western' }),
    );
    await q('browse: year range filter', () =>
      cat.browseItems(db, v, { ...base, type: 'movie', yearFrom: 1950, yearTo: 1959 }),
    );
    await q('browse: min height filter', () =>
      cat.browseItems(db, v, { ...base, type: 'movie', minHeight: 2160 }),
    );
    for (const kind of ['title', 'person', 'collection']) {
      await q(`search: ${kind}, 2-letter prefix`, () =>
        cat.searchHits(db, v, kind, match('ni'), undefined, 9),
      );
      await q(`search: ${kind}, word`, () =>
        cat.searchHits(db, v, kind, match('night'), undefined, 9),
      );
    }
    await q('detail: item', () => cat.getVisibleItem(db, v, ids.item));
    await q('detail: versions', () => cat.visibleVersions(db, v, ids.item));
    await q('detail: cast', () => cat.itemCast(db, v, ids.item, 20));
    await q('detail: collections of item', () => cat.itemCollections(db, v, ids.item));
    await q('detail: series item', () => cat.getVisibleItem(db, v, ids.series));
    await q('detail: series versions', () => cat.visibleVersions(db, v, ids.series));
    await q('detail: series child count', () => cat.visibleChildCount(db, v, ids.series));
    await q('detail: seasons', () => cat.visibleChildren(db, v, ids.series, undefined, 51));
    await q('detail: episodes', () => cat.visibleChildren(db, v, ids.season, undefined, 51));
    await q('person: header', () => cat.getVisiblePerson(db, v, ids.person));
    await q('person: credits', () => cat.personCredits(db, v, ids.person, undefined, 51));
    await q('collections: browse', () => cat.browseCollections(db, v, undefined, 51));
    await q('collection: header', () => cat.getVisibleCollection(db, v, ids.collection));
    await q('collection: members', () => cat.collectionMembers(db, v, ids.collection, undefined, 51));
    await q('play: visible item', () => pb.getVisiblePlayItem(db, v, ids.item));
    await q('play: candidates', () => pb.visibleCandidates(db, v, ids.item));
  }
  return out;
}

/** Inlines `?N` parameters as SQL literals, for tools that take no bound parameters. */
export function inline({ sql, params }) {
  return sql.replace(/\?(\d+)/g, (_, n) => {
    const v = params[Number(n) - 1];
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return String(v);
    return `'${String(v).replaceAll("'", "''")}'`;
  });
}
