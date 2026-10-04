/* eslint-disable @typescript-eslint/no-non-null-assertion -- test fixtures: the rows asserted on were just written */
// Sync keeps `item_availability` current, proved through the catalog read layer's BR-1
// predicate (src/db/catalog.ts): a granted viewer sees what sync wrote, an ungranted viewer does
// not, and visibility follows missing, restore and library or server state.
import { beforeEach, describe, expect, it } from 'vitest';
import { browseItems, getVisiblePerson, personCredits, type Viewer } from '../../src/db/catalog';
import {
  FakeOrigin,
  credit,
  db,
  makeHarness,
  movie,
  one,
  resetCatalog,
  seedServer,
  syncOnce,
} from './harness';

beforeEach(async () => {
  await resetCatalog();
  await db.batch([db.prepare('DELETE FROM users')]);
});

const browse = (viewer: Viewer) =>
  browseItems(db, viewer, { sort: 'title', desc: false, limit: 50 }).then((r) =>
    r.map((x) => x.title),
  );

describe('BR-1 over synced data', () => {
  it('a granted viewer sees synced items, people credits follow, and state changes apply at once', async () => {
    await seedServer({ id: 'A' });
    const a = new FakeOrigin('A');
    a.setItems('A-plib', [
      movie('a1', 'Alien', {
        tmdb: '348',
        credits: [credit('p1', 'Sigourney Weaver', { tmdb: '10205' })],
      }),
    ]);
    const h = makeHarness({ origins: [a] });
    const now = 1;
    await db.batch([
      db
        .prepare(
          "INSERT INTO users (id, display_name, role, status, created_at) VALUES ('granted','G','viewer','active',?), ('plain','P','viewer','active',?), ('op','O','operator','active',?)",
        )
        .bind(now, now, now),
      db
        .prepare(
          "INSERT INTO library_grants (user_id, library_id, granted_at) VALUES ('granted','A-lib',?)",
        )
        .bind(now),
    ]);
    const granted: Viewer = { userId: 'granted', isOperator: false };
    const plain: Viewer = { userId: 'plain', isOperator: false };
    const op: Viewer = { userId: 'op', isOperator: true };

    await syncOnce(h, 'A');
    expect(await browse(granted)).toEqual(['Alien']);
    expect(await browse(plain)).toEqual([]);
    expect(await browse(op)).toEqual(['Alien']);
    const person = await one<{ id: string }>('SELECT id FROM people');
    expect((await getVisiblePerson(db, granted, person!.id))?.name).toBe('Sigourney Weaver');
    expect(await getVisiblePerson(db, plain, person!.id)).toBeNull();
    expect(await personCredits(db, granted, person!.id, undefined, 10)).toHaveLength(1);
    expect(await personCredits(db, plain, person!.id, undefined, 10)).toHaveLength(0);

    // Missing hides it; restore shows it again.
    a.setItems('A-plib', []);
    await syncOnce(h, 'A');
    expect(await browse(granted)).toEqual([]);
    expect(await getVisiblePerson(db, granted, person!.id)).toBeNull();
    a.setItems('A-plib', [
      movie('a1', 'Alien', {
        tmdb: '348',
        credits: [credit('p1', 'Sigourney Weaver', { tmdb: '10205' })],
      }),
    ]);
    await syncOnce(h, 'A');
    expect(await browse(granted)).toEqual(['Alien']);

    // Library and server state are applied by the predicate itself, with no sync needed.
    await db.prepare("UPDATE libraries SET enabled = 0 WHERE id = 'A-lib'").run();
    expect(await browse(granted)).toEqual([]);
    await db.prepare("UPDATE libraries SET enabled = 1 WHERE id = 'A-lib'").run();
    await db.prepare("UPDATE servers SET status = 'disabled' WHERE id = 'A'").run();
    expect(await browse(op)).toEqual([]);
  });

  it('a merged item is visible through either library and stays visible when one source goes missing', async () => {
    await seedServer({ id: 'A' });
    await seedServer({ id: 'B' });
    const a = new FakeOrigin('A');
    const b = new FakeOrigin('B');
    a.setItems('A-plib', [movie('a1', 'Alien', { tmdb: '348' })]);
    b.setItems('B-plib', [movie('b1', 'Alien', { tmdb: '348' })]);
    const h = makeHarness({ origins: [a, b] });
    await db.batch([
      db.prepare(
        "INSERT INTO users (id, display_name, role, status, created_at) VALUES ('gb','GB','viewer','active',1)",
      ),
      db.prepare(
        "INSERT INTO library_grants (user_id, library_id, granted_at) VALUES ('gb','B-lib',1)",
      ),
    ]);
    await syncOnce(h, 'A');
    await syncOnce(h, 'B');
    const gb: Viewer = { userId: 'gb', isOperator: false };
    expect(await browse(gb)).toEqual(['Alien']);
    a.setItems('A-plib', []);
    await syncOnce(h, 'A');
    expect(await browse(gb)).toEqual(['Alien']);
    b.setItems('B-plib', []);
    await syncOnce(h, 'B');
    expect(await browse(gb)).toEqual([]);
  });
});
