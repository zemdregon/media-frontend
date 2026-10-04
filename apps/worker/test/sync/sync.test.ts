// T2.1, T2.2 and M2 exit checks (a) and (c): the sync orchestrator, normalization, upsert, missing
// marking and retention, through the real consumer and local D1 with a fake provider.
import { beforeEach, describe, expect, it } from 'vitest';
import { ProviderError } from '../../src/providers/errors';
import { runRetention } from '../../src/sync/retention';
import { enqueueRun, reapStaleLeases, schedulerTick } from '../../src/sync/scheduler';
import { handleSyncMessage } from '../../src/sync/run';
import {
  FakeOrigin,
  catalogSnapshot,
  count,
  credit,
  db,
  makeHarness,
  movie,
  one,
  resetCatalog,
  rows,
  seedServer,
  syncOnce,
  unavailable,
} from './harness';

beforeEach(resetCatalog);

const LIB = 'A-lib';
const PLIB = 'A-plib';

async function setup(items = [movie('m1', 'Interstellar', { tmdb: '157336', imdb: 'tt0816692' })]) {
  await seedServer({ id: 'A', libraries: [{ id: LIB, providerId: PLIB }] });
  const origin = new FakeOrigin('A');
  origin.setItems(PLIB, items);
  const h = makeHarness({ origins: [origin] });
  return { origin, h };
}

describe('T2.1 sync orchestrator', () => {
  it('a scheduled tick enqueues one run per due server and none for the others', async () => {
    await seedServer({ id: 'A' });
    await seedServer({ id: 'B' });
    await seedServer({ id: 'D', status: 'disabled' });
    await seedServer({ id: 'U', status: 'unreachable' });
    await seedServer({ id: 'N', libraries: [{ id: 'N-lib', enabled: false }] });
    const h = makeHarness();
    const tick = await schedulerTick(h.deps);
    expect(tick.enqueued.map((e) => e.serverId).sort()).toEqual(['A', 'B']);
    expect(tick.enqueued.every((e) => e.type === 'full')).toBe(true);
    expect(h.sent).toHaveLength(2);
    // The next tick finds both runs active (the per-server lock) and enqueues nothing.
    expect((await schedulerTick(h.deps)).enqueued).toEqual([]);
    expect(h.sent).toHaveLength(2);
  });

  it('is due again at the incremental interval, and for a full run at the full interval', async () => {
    const { h } = await setup();
    await syncOnce(h, 'A');
    h.clock.now += 30 * 60_000;
    expect((await schedulerTick(h.deps)).enqueued).toEqual([]);
    h.clock.now += 31 * 60_000;
    expect((await schedulerTick(h.deps)).enqueued.map((e) => e.type)).toEqual(['incremental']);
    await h.drain();
    h.clock.now += 25 * 3_600_000;
    expect((await schedulerTick(h.deps)).enqueued.map((e) => e.type)).toEqual(['full']);
  });

  it('refuses a second trigger while a run is queued or running (FR-SYNC-002)', async () => {
    const { h } = await setup();
    const first = await enqueueRun(h.deps, 'A', 'full', 'manual');
    expect(first.ok).toBe(true);
    const second = await enqueueRun(h.deps, 'A', 'incremental', 'manual');
    expect(second).toEqual({
      ok: false,
      reason: 'in_progress',
      runId: first.ok ? first.runId : null,
    });
    expect(await count('sync_runs')).toBe(1);
    expect(h.sent).toHaveLength(1);
  });

  it('upgrades a queued incremental run to full when a full run is requested', async () => {
    const { h } = await setup();
    await syncOnce(h, 'A');
    const inc = await enqueueRun(h.deps, 'A', 'incremental', 'manual');
    expect(inc).toMatchObject({ ok: true, type: 'incremental' });
    await enqueueRun(h.deps, 'A', 'full', 'manual');
    expect(
      (await one<{ type: string }>("SELECT type FROM sync_runs WHERE status = 'queued'"))?.type,
    ).toBe('full');
  });

  it('retries transient errors with exponential full-jitter backoff, then succeeds (NFR-REL-002)', async () => {
    const { origin, h } = await setup();
    origin.itemErrors = [unavailable(), unavailable(), unavailable()];
    const r = await syncOnce(h, 'A');
    expect(r.status).toBe('succeeded');
    // random() = 0.5: delay = floor(0.5 * min(30 s, 0.5 s * 2^n)): 250, 500, 1000
    expect(h.sleeps).toEqual([250, 500, 1000]);
    expect(await count('sources')).toBe(1);
  });

  it('gives up after 5 attempts: the library fails and the run ends failed', async () => {
    const { origin, h } = await setup();
    origin.itemErrors = Array.from({ length: 5 }, unavailable);
    const r = await syncOnce(h, 'A');
    expect(r.status).toBe('failed');
    expect(h.sleeps).toHaveLength(4);
    expect(String(r.run.error_summary)).toContain('UNAVAILABLE');
    expect(r.run.errors).toBe(1);
  });

  it('does not retry a non-transient error', async () => {
    const { origin, h } = await setup();
    origin.itemErrors = [new ProviderError('PROTOCOL', 'bad payload', false)];
    const r = await syncOnce(h, 'A');
    expect(r.status).toBe('failed');
    expect(h.sleeps).toEqual([]);
  });

  it('a rejected credential ends the run failed and names the cause', async () => {
    const { origin, h } = await setup();
    origin.itemErrors = [new ProviderError('AUTH', 'refused', false)];
    const r = await syncOnce(h, 'A');
    expect(r.status).toBe('failed');
    expect(String(r.run.error_summary)).toContain('credentials');
  });

  it('one failing library makes the run partial; the other library is kept', async () => {
    await seedServer({
      id: 'A',
      libraries: [
        { id: 'l1', providerId: 'p1' },
        { id: 'l2', providerId: 'p2' },
      ],
    });
    const origin = new FakeOrigin('A');
    origin.setItems('p1', [movie('m1', 'One', { tmdb: '1' })]);
    origin.setItems('p2', [movie('m2', 'Two', { tmdb: '2' })]);
    origin.itemErrors = [new ProviderError('PROTOCOL', 'bad', false)];
    const h = makeHarness({ origins: [origin] });
    const r = await syncOnce(h, 'A');
    expect(r.status).toBe('partial');
    expect(await count('sources')).toBe(1);
    expect(JSON.parse(String(r.run.libraries_failed))).toEqual(['l1']);
    expect(JSON.parse(String(r.run.libraries_ok))).toEqual(['l2']);
  });

  it('one server failing leaves the others succeeded and their catalog intact (FR-SYNC-007)', async () => {
    await seedServer({ id: 'A' });
    await seedServer({ id: 'B' });
    const a = new FakeOrigin('A');
    const b = new FakeOrigin('B');
    a.setItems('A-plib', [movie('a1', 'Alpha', { tmdb: '1' })]);
    b.setItems('B-plib', [movie('b1', 'Beta', { tmdb: '2' })]);
    a.itemErrors = Array.from({ length: 5 }, unavailable);
    const h = makeHarness({ origins: [a, b] });
    const tick = await schedulerTick(h.deps);
    expect(tick.enqueued).toHaveLength(2);
    await h.drain();
    const status = Object.fromEntries(
      (
        await rows<{ server_id: string; status: string }>('SELECT server_id, status FROM sync_runs')
      ).map((r) => [r.server_id, r.status]),
    );
    expect(status).toEqual({ A: 'failed', B: 'succeeded' });
    expect(await count('sources', "server_id = 'B'")).toBe(1);
    // A's earlier data survives A's later failure.
    a.itemErrors = [];
    await syncOnce(h, 'A');
    a.itemErrors = Array.from({ length: 5 }, unavailable);
    await syncOnce(h, 'A');
    expect(await count('sources', "server_id = 'A' AND status = 'present'")).toBe(1);
  });

  it('an uncaught error in one run does not stop another server being handled', async () => {
    await seedServer({ id: 'A' });
    await seedServer({ id: 'B' });
    const b = new FakeOrigin('B');
    b.setItems('B-plib', [movie('b1', 'Beta', { tmdb: '2' })]);
    const h = makeHarness({ origins: [b] }); // no origin for A: openServer throws
    await schedulerTick(h.deps);
    const messages = [...h.sent];
    h.sent.length = 0;
    const results: string[] = [];
    for (const m of messages) {
      try {
        if (m.kind === 'sync') results.push(await handleSyncMessage(h.deps, m));
      } catch {
        results.push('threw');
      }
    }
    expect(results.sort()).toEqual(['succeeded', 'threw']);
  });

  it('after an unexpected error the lease is released so the retry claims the run at once', async () => {
    const { origin, h } = await setup();
    origin.itemErrors = [new Error('D1 down')];
    const r = await enqueueRun(h.deps, 'A', 'full', 'manual');
    if (!r.ok) throw new Error('enqueue failed');
    await expect(handleSyncMessage(h.deps, { runId: r.runId })).rejects.toThrow('D1 down');
    expect((await one<{ status: string }>('SELECT status FROM sync_runs'))?.status).toBe('running');
    expect(await handleSyncMessage(h.deps, { runId: r.runId })).toBe('succeeded');
  });

  it('a redelivered message for a finished run, or a run someone else holds, is skipped', async () => {
    const { h } = await setup();
    const r = await syncOnce(h, 'A');
    expect(await handleSyncMessage(h.deps, { runId: r.runId })).toBe('skipped');
    const held = await enqueueRun(h.deps, 'A', 'full', 'manual');
    if (!held.ok) throw new Error('enqueue failed');
    await db
      .prepare(
        "UPDATE sync_runs SET status = 'running', lease_token = 'x', lease_expires_at = ? WHERE id = ?",
      )
      .bind(h.clock.now + 60_000, held.runId)
      .run();
    expect(await handleSyncMessage(h.deps, { runId: held.runId })).toBe('skipped');
  });

  it('continues across invocations from the checkpoint and ends with the same data', async () => {
    const items = Array.from({ length: 7 }, (_, i) =>
      movie(`m${i}`, `Movie ${i}`, { tmdb: String(100 + i) }),
    );
    const { h } = await setup(items);
    h.deps.config.pageSize = 2;
    h.deps.config.maxPagesPerInvocation = 1;
    const r = await enqueueRun(h.deps, 'A', 'full', 'manual');
    if (!r.ok) throw new Error('enqueue failed');
    const handled = await h.drain();
    expect(handled).toBeGreaterThan(3); // one message per page, continuation messages included
    const run = await one<Record<string, unknown>>('SELECT * FROM sync_runs WHERE id = ?', r.runId);
    expect(run?.status).toBe('succeeded');
    expect(run?.added).toBe(7);
    expect(await count('media_items')).toBe(7);
  });

  it('the reaper re-queues a run whose lease expired, then fails it after 3 reaps', async () => {
    const { h } = await setup();
    const r = await enqueueRun(h.deps, 'A', 'full', 'manual');
    if (!r.ok) throw new Error('enqueue failed');
    h.sent.length = 0;
    await db
      .prepare(
        "UPDATE sync_runs SET status = 'running', lease_token = 'dead', lease_expires_at = ? WHERE id = ?",
      )
      .bind(h.clock.now, r.runId)
      .run();
    for (let i = 1; i <= 3; i++) {
      h.clock.now += 16 * 60_000;
      expect((await reapStaleLeases(h.deps)).requeued).toEqual([r.runId]);
    }
    h.clock.now += 16 * 60_000;
    expect((await reapStaleLeases(h.deps)).failed).toEqual([r.runId]);
    const run = await one<{ status: string; error_summary: string }>(
      'SELECT status, error_summary FROM sync_runs',
    );
    expect(run?.status).toBe('failed');
    expect(run?.error_summary).toContain('dead-lettered');
  });

  it('a stuck queued run is re-sent by the reaper so it cannot hold the lock forever', async () => {
    const { h } = await setup();
    await enqueueRun(h.deps, 'A', 'full', 'manual');
    h.sent.length = 0;
    h.clock.now += 16 * 60_000;
    expect((await reapStaleLeases(h.deps)).requeued).toHaveLength(1);
    expect(h.sent).toHaveLength(1);
  });

  it('records counts, times and a bounded error summary on the run (FR-SYNC-006)', async () => {
    const { h } = await setup();
    const r = await syncOnce(h, 'A');
    expect(r.run).toMatchObject({
      status: 'succeeded',
      type: 'full',
      trigger: 'manual',
      added: 1,
      updated: 0,
      missing: 0,
      errors: 0,
    });
    expect(r.run.started_at).toBeTypeOf('number');
    expect(r.run.ended_at).toBeTypeOf('number');
    expect(r.run.lease_token).toBeNull();
    expect(
      Number((await one<{ v: string }>("SELECT v FROM meta WHERE k = 'catalog_version'"))?.v),
    ).toBeGreaterThan(0);
  });

  it('an incremental run with no earlier success lists everything (nothing to be incremental against)', async () => {
    const { h, origin } = await setup();
    const r = await enqueueRun(h.deps, 'A', 'incremental', 'manual');
    expect(r).toMatchObject({ ok: true, type: 'full' });
    await h.drain();
    expect(origin.lastRequests[0]?.since).toBeUndefined();
  });

  it('an incremental run passes the last good start minus the skew as `since`', async () => {
    const { h, origin } = await setup();
    const first = await syncOnce(h, 'A');
    const startedAt = Number(first.run.started_at);
    h.clock.now += 61 * 60_000;
    await syncOnce(h, 'A', 'incremental');
    expect(origin.lastRequests.at(-1)?.since).toBe(startedAt - 10 * 60_000);
  });
});

describe('T2.2 normalization, upsert and idempotency (FR-SYNC-003, FR-SYNC-004)', () => {
  it('normalizes an item into the canonical schema with versions, IDs and metadata', async () => {
    const { h } = await setup([
      movie('m1', 'Interstellar', {
        tmdb: '157336',
        imdb: 'tt0816692',
        originalTitle: 'Interstellar (orig)',
        overview: 'Space.',
        genres: ['Sci-Fi'],
        runtimeMs: 10_000,
        versions: [
          {
            providerVersionId: 'v1',
            container: 'mkv',
            videoCodec: 'hevc',
            width: 3840,
            height: 2160,
            hdr: 'hdr10',
            bitrate: 9,
            sizeBytes: 5,
            audio: [{ index: 1, codec: 'eac3', channels: 6, language: 'eng', isDefault: true }],
            subtitles: [
              {
                index: 2,
                codec: 'srt',
                kind: 'text',
                isForced: false,
                isDefault: false,
                isExternal: true,
                language: 'eng',
              },
            ],
          },
          { providerVersionId: 'v2', height: 1080, hdr: 'none', audio: [], subtitles: [] },
        ],
      }),
    ]);
    await syncOnce(h, 'A');
    const item = await one<Record<string, unknown>>('SELECT * FROM media_items');
    expect(item).toMatchObject({
      type: 'movie',
      title: 'Interstellar',
      original_title: 'Interstellar (orig)',
      overview: 'Space.',
      year: 2014,
      runtime_ms: 10_000,
      best_height: 2160,
      has_hdr: 1,
    });
    expect(JSON.parse(String(item?.genres))).toEqual(['Sci-Fi']);
    expect(await rows('SELECT scheme, value FROM external_ids ORDER BY scheme')).toEqual([
      { scheme: 'imdb', value: 'tt0816692' },
      { scheme: 'tmdb', value: '157336' },
    ]);
    const versions = await rows<{ provider_version_id: string; subtitle_tracks: string }>(
      'SELECT * FROM media_versions ORDER BY provider_version_id',
    );
    expect(versions.map((v) => v.provider_version_id)).toEqual(['v1', 'v2']);
    expect(JSON.parse(String(versions[0]?.subtitle_tracks))[0]).toMatchObject({
      kind: 'text',
      external: true,
    });
    expect(await rows('SELECT * FROM item_availability')).toHaveLength(1);
    expect(await rows("SELECT name FROM search_fts WHERE kind = 'title'")).toEqual([
      { name: 'Interstellar' },
    ]);
  });

  it('a re-run over unchanged data produces no catalog-visible change', async () => {
    const { h } = await setup([
      movie('m1', 'Interstellar', {
        tmdb: '157336',
        credits: [credit('p1', 'Matthew McConaughey', { tmdb: '10297' })],
      }),
      movie('m2', 'Memento', { imdb: 'tt0209144' }),
    ]);
    await syncOnce(h, 'A');
    const before = await catalogSnapshot();
    h.clock.now += 3_600_000;
    const second = await syncOnce(h, 'A');
    expect(await catalogSnapshot()).toEqual(before);
    expect(second.run).toMatchObject({ added: 0, updated: 0, missing: 0 });
    // Bookkeeping may move.
    expect(await count('sources', 'last_seen_sync_id = ?', second.runId)).toBe(2);
  });

  it('a bumped provider timestamp alone (Jellyfin re-saves on every scan) rewrites nothing', async () => {
    const { h, origin } = await setup([
      movie('m1', 'Interstellar', { tmdb: '1', providerUpdatedAt: 1 }),
    ]);
    await syncOnce(h, 'A');
    const before = await catalogSnapshot();
    origin.setItems(PLIB, [movie('m1', 'Interstellar', { tmdb: '1', providerUpdatedAt: 999 })]);
    const r = await syncOnce(h, 'A');
    expect(r.run.updated).toBe(0);
    expect(await catalogSnapshot()).toEqual(before);
  });

  it('a changed field updates the source, the item and the search row', async () => {
    const { h, origin } = await setup([
      movie('m1', 'Interstellar', { tmdb: '1', overview: 'old' }),
    ]);
    await syncOnce(h, 'A');
    origin.setItems(PLIB, [
      movie('m1', 'Interstellar II', {
        tmdb: '1',
        overview: 'new',
        versions: [
          { providerVersionId: 'v9', height: 2160, hdr: 'none', audio: [], subtitles: [] },
        ],
      }),
    ]);
    const r = await syncOnce(h, 'A');
    expect(r.run.updated).toBe(1);
    expect(await one('SELECT title, overview, best_height FROM media_items')).toEqual({
      title: 'Interstellar II',
      overview: 'new',
      best_height: 2160,
    });
    expect(
      (await rows('SELECT provider_version_id FROM media_versions')).map(
        (v) => v.provider_version_id,
      ),
    ).toEqual(['v9']);
    expect(await rows("SELECT name FROM search_fts WHERE kind = 'title'")).toEqual([
      { name: 'Interstellar II' },
    ]);
    expect(await count('media_items')).toBe(1);
  });

  it('writes the checkpoint with the page, so a continuation resumes at the next cursor', async () => {
    const items = Array.from({ length: 5 }, (_, i) =>
      movie(`m${i}`, `Movie ${i}`, { tmdb: String(i) }),
    );
    const { h, origin } = await setup(items);
    h.deps.config.pageSize = 2;
    h.deps.config.maxPagesPerInvocation = 1;
    const r = await enqueueRun(h.deps, 'A', 'full', 'manual');
    if (!r.ok) throw new Error('enqueue failed');
    const job = h.sent.shift();
    if (job?.kind !== 'sync') throw new Error('expected a sync job');
    await handleSyncMessage(h.deps, job);
    expect(
      JSON.parse(
        String((await one<{ checkpoint: string }>('SELECT checkpoint FROM sync_runs'))?.checkpoint),
      ),
    ).toMatchObject({ libraryIdx: 0, cursor: '2' });
    expect(origin.itemCalls).toBe(1);
    expect(h.sent).toHaveLength(1);
  });
});

describe('M2 exit check (c): a killed sync, retried, leaves no duplicates', () => {
  const many = () =>
    Array.from({ length: 6 }, (_, i) =>
      movie(`m${i}`, `Movie ${i}`, {
        tmdb: String(500 + i),
        credits: [credit(`p${i}`, `Actor ${i}`, { tmdb: String(900 + i) })],
      }),
    );

  it('killed between pages', async () => {
    const { h, origin } = await setup(many());
    h.deps.config.pageSize = 2;
    origin.crashAfterCalls = 1; // the second page call dies
    const r = await enqueueRun(h.deps, 'A', 'full', 'manual');
    if (!r.ok) throw new Error('enqueue failed');
    const job = h.sent.shift();
    if (job?.kind !== 'sync') throw new Error('expected a sync job');
    await expect(handleSyncMessage(h.deps, job)).rejects.toThrow('killed');
    expect(await count('sources')).toBe(2);
    await h.drain(); // not re-queued by the dead process; the queue's retry delivers it again
    await handleSyncMessage(h.deps, { runId: r.runId });
    expect(await count('sources')).toBe(6);
    expect(await count('media_items')).toBe(6);
    expect(await count('people')).toBe(6);
    expect(await count('credits')).toBe(6);
    expect(await count('media_versions')).toBe(6);
    expect((await one<{ status: string }>('SELECT status FROM sync_runs'))?.status).toBe(
      'succeeded',
    );
  });

  it('killed in the middle of a page, between D1 batches', async () => {
    const big = movie('m0', 'Big Cast', {
      tmdb: '42',
      credits: Array.from({ length: 40 }, (_, i) =>
        credit(`p${i}`, `Actor ${i}`, { tmdb: String(1000 + i), order: i }),
      ),
    });
    const { h } = await setup([big, ...many().slice(1)]);
    // Fail the second batch call of the run (the first chunk of the big item has been committed).
    let batches = 0;
    const realBatch = db.batch.bind(db);
    const flaky = new Proxy(db, {
      get(target, prop) {
        if (prop === 'batch') {
          return (stmts: D1PreparedStatement[]) => {
            batches++;
            if (batches === 2) return Promise.reject(new Error('isolate killed'));
            return realBatch(stmts);
          };
        }
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const crashing = { ...h.deps, db: flaky };
    const r = await enqueueRun(h.deps, 'A', 'full', 'manual');
    if (!r.ok) throw new Error('enqueue failed');
    h.sent.length = 0;
    // The item write fails part-way; the page then reports a failed library rather than corrupting.
    await handleSyncMessage(crashing, { runId: r.runId }).catch(() => undefined);
    const after = await one<{ status: string }>('SELECT status FROM sync_runs');
    expect(
      after?.status === 'running' || after?.status === 'failed' || after?.status === 'partial',
    ).toBe(true);
    // Retry as a fresh full run (or the released lease): same data, no duplicates.
    if (after?.status === 'running') await handleSyncMessage(h.deps, { runId: r.runId });
    else await syncOnce(h, 'A');
    expect(await count('sources')).toBe(6);
    expect(await count('media_items')).toBe(6);
    expect(await count('media_versions')).toBe(6);
    expect(
      await count('credits', "source_id = (SELECT id FROM sources WHERE provider_item_id = 'm0')"),
    ).toBe(40);
    expect(await count('people')).toBe(40); // p1..p5 are the same origin people as in the big cast
    expect(await count('search_fts', "kind = 'title'")).toBe(6);
    expect(await count('sources', "content_hash = ''")).toBe(0);
  });
});

describe('T2.2 missing marking, restore and purge (FR-SYNC-005, BR-4, DR-003)', () => {
  const two = () => [movie('m1', 'One', { tmdb: '1' }), movie('m2', 'Two', { tmdb: '2' })];

  it('a source absent from a completed full sync becomes missing, and is restored when seen again', async () => {
    const { h, origin } = await setup(two());
    await syncOnce(h, 'A');
    origin.setItems(PLIB, [two()[0]!]);
    const r = await syncOnce(h, 'A');
    expect(r.run.missing).toBe(1);
    expect(
      await one("SELECT status, missing_since FROM sources WHERE provider_item_id = 'm2'"),
    ).toEqual({ status: 'missing', missing_since: h.clock.now });
    const m2 = await one<{ media_item_id: string }>(
      "SELECT media_item_id FROM sources WHERE provider_item_id = 'm2'",
    );
    expect(await count('item_availability', 'media_item_id = ?', m2?.media_item_id)).toBe(0);
    expect(await count('media_items')).toBe(2); // hidden, not deleted (DR-005)

    origin.setItems(PLIB, two());
    await syncOnce(h, 'A');
    expect(
      await one("SELECT status, missing_since FROM sources WHERE provider_item_id = 'm2'"),
    ).toEqual({ status: 'present', missing_since: null });
    expect(await count('item_availability', 'media_item_id = ?', m2?.media_item_id)).toBe(1);
  });

  it('an incremental run never marks sources missing, but restores a missing one it sees', async () => {
    const { h, origin } = await setup(two());
    await syncOnce(h, 'A');
    origin.setItems(PLIB, [two()[0]!]);
    await syncOnce(h, 'A');
    h.clock.now += 61 * 60_000;
    origin.setItems(PLIB, [two()[1]!]); // only m2 "changed"
    const r = await syncOnce(h, 'A', 'incremental');
    expect(r.run.missing).toBe(0);
    expect(await count('sources', "status = 'present'")).toBe(2);
  });

  it('a failed or partial library never has sources marked missing (BR-4)', async () => {
    const { h, origin } = await setup(two());
    await syncOnce(h, 'A');
    origin.setItems(PLIB, []);
    origin.itemErrors = [new ProviderError('PROTOCOL', 'bad', false)];
    await syncOnce(h, 'A');
    expect(await count('sources', "status = 'present'")).toBe(2);
  });

  it('the mass-missing guard refuses an empty listing, and an operator force overrides it', async () => {
    const items = Array.from({ length: 120 }, (_, i) =>
      movie(`m${i}`, `Movie ${i}`, { tmdb: String(i + 1) }),
    );
    const { h, origin } = await setup(items);
    await syncOnce(h, 'A');
    origin.setItems(PLIB, []);
    const guarded = await syncOnce(h, 'A');
    expect(guarded.run.missing).toBe(0);
    expect(String(guarded.run.error_summary)).toContain('MASS_MISSING_GUARD');
    expect(await count('sources', "status = 'present'")).toBe(120);
    await syncOnce(h, 'A', 'full', { force: true });
    expect(await count('sources', "status = 'missing'")).toBe(120);
  });

  it('an item with a missing and a present source keeps the present source metadata', async () => {
    await seedServer({ id: 'A', priority: 5 });
    await seedServer({ id: 'B', priority: 1 });
    const a = new FakeOrigin('A');
    const b = new FakeOrigin('B');
    a.setItems('A-plib', [movie('a1', 'Alpha Title', { tmdb: '7', overview: 'from A' })]);
    b.setItems('B-plib', [movie('b1', 'Beta Title', { tmdb: '7', overview: 'from B' })]);
    const h = makeHarness({ origins: [a, b] });
    await syncOnce(h, 'A');
    await syncOnce(h, 'B');
    expect(await one('SELECT title, overview FROM media_items')).toEqual({
      title: 'Alpha Title',
      overview: 'from A',
    });
    a.setItems('A-plib', []);
    await syncOnce(h, 'A');
    expect(await one('SELECT title, overview FROM media_items')).toEqual({
      title: 'Beta Title',
      overview: 'from B',
    });
    expect(await count('item_availability')).toBe(1);
  });

  it('the purge removes sources missing for more than 30 days, then their sourceless items', async () => {
    const { h, origin } = await setup(two());
    await syncOnce(h, 'A');
    origin.setItems(PLIB, [two()[0]!]);
    await syncOnce(h, 'A');
    h.clock.now += 29 * 86_400_000;
    expect((await runRetention(h.deps)).sourcesPurged).toBe(0);
    expect(await count('media_items')).toBe(2);
    h.clock.now += 2 * 86_400_000;
    const result = await runRetention(h.deps);
    expect(result).toMatchObject({ sourcesPurged: 1, itemsPurged: 1 });
    expect(await count('sources')).toBe(1);
    expect(await count('media_items')).toBe(1);
    expect(await count('media_versions')).toBe(1);
    expect(await count('search_fts', "kind = 'title'")).toBe(1);
  });

  it('retention prunes old operational rows but never the latest run per server', async () => {
    const { h } = await setup();
    await syncOnce(h, 'A');
    h.clock.now += 100 * 86_400_000;
    const old = h.clock.now - 150 * 86_400_000;
    await db.batch([
      db
        .prepare(
          "INSERT INTO sync_runs (id, server_id, type, trigger, status, queued_at) VALUES ('old1','A','full','schedule','succeeded',?)",
        )
        .bind(old),
      db
        .prepare("INSERT INTO health_probes (id, server_id, probed_at, ok) VALUES ('hp','A',?,1)")
        .bind(h.clock.now - 8 * 86_400_000),
      db
        .prepare(
          "INSERT INTO idempotency_keys (user_id, key, route, request_hash, created_at) VALUES ('u','k','r','h',?)",
        )
        .bind(h.clock.now - 2 * 86_400_000),
    ]);
    await runRetention(h.deps);
    expect((await rows<{ id: string }>('SELECT id FROM sync_runs')).map((r) => r.id)).not.toContain(
      'old1',
    );
    expect(await count('sync_runs')).toBe(1); // the latest per server stays even though it is > 90 days old
    expect(await count('health_probes')).toBe(0);
    expect(await count('idempotency_keys')).toBe(0);
  });
});
