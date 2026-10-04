# Performance and cost at the design envelope (T5.7)

| | |
|---|---|
| Date | 2026-10-04 |
| Requirements | NFR-SCALE-001 (envelope), NFR-PERF-001 (browse, search, detail p95 ≤ 300 ms, proposed), NFR-PERF-002 (play descriptor p95 ≤ 2 s, proposed), NFR-COST-001 (≤ US$10 a month, proposed) |
| Verdict | **Latency:** met on this local setup after three fixes (§4); without them detail, year-sorted browse, home and the min-height filter were not. **Cost:** estimated about **US$5 a month**, the Workers Paid base fee, with no usage charge at the envelope (§6). **Both are local measurements and an estimate, not production figures.** |

## 1. What was measured, and what that means

All latency figures are **local measurements**: wall-clock time of an HTTP request from a Node process to `wrangler dev` on the same machine. `wrangler dev` runs workerd with Miniflare's D1, which is SQLite on local disk. That is **not** production D1:

- Production D1 adds a network hop between the Worker and the database (a few milliseconds to tens of milliseconds depending on region and read replication), and runs queries on a different SQLite build and storage engine. Expect production per-query latency to be **higher** than here by that hop, once per sequential query a request makes. Catalog requests make one to six.
- Local D1 has no cold start, no cross-region effects and no noisy neighbours.
- The client and Worker share one machine (a small cloud VM, shared CPU), so timings include scheduling noise. Variation of 20 to 30 % between runs is normal; the figures below are from one full run.
- Under concurrency, workerd on one machine serves requests on one thread, so "10 concurrent clients" mostly measures queueing behind a single isolate. Production runs isolates in parallel. Treat the concurrent rows as a pessimistic burst test, not a capacity figure.
- Rows read and written cannot be measured locally: Miniflare's D1 does not return `rows_read`. Query plans (§3) and the cost model (§6) stand in.

The numbers still show what matters most: whether a query is **index-driven or scans**. A plan that scans 200,000 rows locally scans them in production too, and costs rows read there.

## 2. Setup

`node scripts/perf/run.mjs` (or `pnpm perf`; `--quick` for a short run). Everything is local and nothing is deployed. It takes about seven minutes.

1. Applies the migrations to a fresh local D1 (`scripts/perf/.state`, git-ignored).
2. Creates 50 users (1 operator, 49 viewers) with live session cookies, starts the Worker (port 8789) and the mock Jellyfin origin from `apps/e2e` (port 8791), and **registers the mock origin through the real admin API**, so the play path uses a server whose credential is in the vault.
3. Seeds the envelope straight into SQLite with recursive CTEs (about 10 s, `scripts/perf/seed.mjs`):

| Table | Rows |
|---|---|
| servers (19 synthetic, 1 the mock origin) / libraries | 20 / 40 |
| users / library grants (viewers see about half the libraries) | 50 / 1,004 |
| canonical items (60,000 movies, 6,000 series, 14,000 seasons, 40,000 episodes) | 120,000 |
| sources and media versions (a copy per item, plus about 80,000 extra movie copies on other servers) | 200,001 |
| item availability | 200,001 |
| people / credits (about 5 per movie, 3 per series) | 40,000 / 318,000 |
| collections / members | 2,000 / 20,000 |
| search index entries (titles, people, collections) | 108,000 |
| watch progress | 2,000 |

   The database file is about 220 MB, so the storage estimate in HLD §11 (0.5 to 1.0 GB) is conservative. One movie in twenty keeps a single copy, on the mock origin, so that play has targets that cannot fail over to a synthetic server.
4. Restarts the Worker and measures, **300 requests per endpoint after 30 warm-up requests**, sequentially, as a viewer (users rotating) and as the operator. Ids come from per-user samples of items that user can actually see, so a viewer is not measured on 404s. Then a ten-client concurrent run on five representative endpoints, an 80-page keyset walk through the title-sorted movie list, and play.
5. For every catalog and play query, runs `EXPLAIN QUERY PLAN` on the SQL the app really issues (the query builders in `apps/worker/src/db` are imported and run against a recording fake, so the analysed SQL cannot drift) and times each query in the SQLite engine alone: `node scripts/perf/explain.mjs --plans` re-runs this on the left-over database.

No `ANALYZE` was run: Cinewren's migrations do not run it, so the planner has no statistics, which is the worst case for plan choice.

## 3. Results after the fixes (local measurements)

Server time as the client sees it, milliseconds. p95 target for browse, search and detail: 300 ms.

| Endpoint (sequential, 300 requests) | Viewer p50 | Viewer p95 | Operator p50 | Operator p95 |
|---|---|---|---|---|
| home (recently added, continue watching) | 16.2 | 23.9 | 16.6 | 26.4 |
| browse movies by title (first page) | 16.1 | 23.0 | 12.8 | 18.4 |
| browse series by title | 13.8 | 20.4 | 11.6 | 18.9 |
| browse movies newest first | 14.4 | 21.7 | 12.2 | 19.7 |
| browse movies by year | 16.1 | 25.2 | 12.7 | 19.0 |
| browse, genre filter | 31.0 | 46.4 | 16.3 | 23.6 |
| browse, year range filter | 58.4 | 84.1 | 57.6 | 76.0 |
| browse, minimum height filter | 30.4 | 44.0 | 17.6 | 27.1 |
| browse, 80-page keyset walk (3 users) | 13.4 | 20.7 | | |
| search, 2-letter prefix (titles, people, collections) | 61.7 | 84.4 | 60.2 | 84.6 |
| search, one common word | 55.8 | 81.2 | 50.9 | 73.2 |
| search, two words | 17.2 | 26.8 | 16.2 | 24.5 |
| search, no hits | 15.2 | 23.9 | 14.4 | 21.3 |
| detail, movie | 17.7 | 27.7 | 17.5 | 26.0 |
| detail, series | 17.0 | 27.2 | 18.9 | 29.9 |
| detail, series seasons | 12.7 | 20.3 | 14.4 | 23.0 |
| detail, movie versions | 12.5 | 21.4 | 14.8 | 22.2 |
| person page | 13.4 | 22.9 | 14.0 | 21.5 |
| collection page | 12.2 | 19.0 | 12.7 | 20.5 |
| collections list | 51.5 | 76.1 | 52.4 | 76.6 |

**Every p95 is under 90 ms against the 300 ms target** on this setup. The slowest are search on a common prefix (three FTS queries, about 60 ms), the year-range filter and the collections list. Maximum single requests reached 250 to 340 ms (first request of a new connection or GC pauses), above the p99.

Ten concurrent clients (viewer, 300 requests): home p95 151 ms, browse p95 139 ms, movie detail p95 190 ms, series detail p95 171 ms, seasons p95 122 ms, versions p95 124 ms, search for a common word **p95 668 ms** (about 20 requests a second, three FTS queries per request on one thread). The last one exceeds 300 ms under a burst of ten simultaneous common-word searches in a single local isolate; that is a queueing artefact of this setup and an unlikely load for 50 users, but it marks search as the endpoint to re-measure on staging D1 first.

**Play descriptor, NFR-PERF-002 (target p95 ≤ 2 s)**, against the local mock origin, which answers instantly (so this is Worker, D1 and credential-minting time, **not** origin latency):

| Case | p50 | p95 | p99 | max |
|---|---|---|---|---|
| 300 sequential plays (spread over 50 users; each descriptor request mints a session credential at the origin and calls PlaybackInfo) | 33.7 ms | 76.2 ms | 94.9 ms | 430 ms |
| 100 plays, 20 in flight at once (the NFR-SCALE-001 concurrent-session bound) | 457 ms | 615 ms | 685 ms | 685 ms |

Each play made two origin calls (406 sign-ins and 405 PlaybackInfo calls for about 400 requests). A real origin adds its own round trips: p95 in production is Worker time plus two sequential origin calls (which Jellyfin typically answers in tens to a few hundred milliseconds, more for a transcode start). With 2 s allowed, that leaves headroom of about 1.3 s for the origin, but only a measurement against the real servers on staging can confirm it.

### Query plans

After the fixes, **no catalog or play query has a full table scan** (a `SCAN` without an index). Queries that remain over 10 ms in the SQLite engine alone: year-range filter 28 to 42 ms (index range plus a sort of the range), search by person name 12 to 24 ms, genre filter 19 ms (a `json_each` match over candidate rows), minimum-height filter 20 ms, title search 14 ms. Everything else is under 5 ms. Temp B-trees remain in some plans (ordering by relevance, grouping credits); each sorts a bounded set.

## 4. Issues found and fixed

Found by running the real queries at the envelope. Before-figures are from the first run of the same script, before any change (viewer, 60 sequential requests, local).

| # | Problem | Evidence before | Fix | After |
|---|---|---|---|---|
| Q1 | **Family-of-sources predicate scanned `sources`.** Detail versions, the copy table and the minimum-height filter matched an item's sources with `OR` of three conditions, so SQLite scanned `sources` by `status` (`SEARCH fs USING INDEX src_missing (status=?)`) for each item instead of probing `src_item`. | Movie versions query 358 ms (viewer) and 431 ms (operator); series versions 858 ms and 1,830 ms; **minimum-height filter 106 s (viewer) and 17.7 s (operator) for one page**, and the HTTP run of it did not finish. | `familySources` in `apps/worker/src/db/catalog.ts` rewritten as `media_item_id IN (item UNION children UNION grandchildren)`, which uses `src_item`. Same results, no migration. | versions 0 to 1 ms; min-height filter 20 ms (viewer), 4 ms (operator); HTTP p95 44 ms |
| Q2 | **Home "Recently added" sorted every visible title.** `type IN ('movie','series')` cannot use `mi_added (type, date_added DESC, id)` for ordering. | Query 247 ms (viewer), 381 ms (operator); HTTP p50 337 ms, **p95 466 ms** | `recentlyAdded` reads one ordered, limited branch per type and merges them (`UNION ALL`). A partial index was tried and rejected: it works with `INDEXED BY` but the planner does not choose it without statistics. | query 1 to 2 ms; HTTP p50 16 ms, p95 24 ms |
| Q3 | **Year-sorted browse sorted every visible title.** The sort key is `COALESCE(year, 0)` (null years first, carried in the keyset cursor), which `mi_year (type, year, id)` cannot serve. | Query 211 to 231 ms; HTTP p50 476 ms, **p95 915 ms** | Migration `0004_perf_indexes.sql`: `mi_year0 ON media_items(type, COALESCE(year, 0), id)`. LLD-SCHEMA updated. `SCHEMA_VERSION_REQUIRED` is now 4. | query 1 to 2 ms; HTTP p50 16 ms, p95 25 ms |

The worker test suite (700 tests, including the catalog, BR-1 visibility and migration-guard tests) passes unchanged with these changes. Items Q1 and Q2 change query text only, so they ship with the code; Q3 needs `wrangler d1 migrations apply` (the deploy script and the schema guard already do that).

The rest of the catalog code, including BR-1 visibility predicates (`visibleItem`, `visibleSource`, and the `EXISTS` chains for people and collections), was left as it is: they are index-driven (`item_availability`, `library_grants`, `libraries` and `servers` primary keys) and cost 1 to 5 ms.

## 5. Observations that are not fixed

- **Search on a very common prefix** costs about 60 ms and scales with the number of matching titles: the title query ranks all FTS hits (`bm25`) before applying visibility and the limit. At 120,000 items that is still fine; a catalog an order of magnitude larger, or a viewer who can see only a small fraction of the matches, would feel it.
- **Year-range filter** (about 60 ms) sorts the matching range by title. A composite index per filter is not worth the write cost at this size.
- **Collections list** (about 52 ms at the Worker, 2 ms in the engine): the time is in the follow-up label query and mapping, not the main query. Candidate for a later look; not near the target.
- No `ANALYZE` is run by the product. D1 may maintain statistics itself; if plans differ on staging, re-run `node scripts/perf/explain.mjs` against a restored copy.
- Latency here excludes artwork requests, which go through the Worker (`/api/v1/artwork`) and call the origin; they are the largest request-count component in §6.

## 6. Cost estimate at the envelope (NFR-COST-001)

**This is an estimate from a model, not a measurement and not a bill.** Local runs cannot report Workers CPU time or D1 rows read. The model is deliberately pessimistic where the inputs are unknown, and the per-line sensitivity is shown.

### Pricing used

Verified with the Cloudflare documentation search on **2026-10-04** (the Workers pricing page was last updated 2026-10-02):

| Item | Workers Paid | Source |
|---|---|---|
| Plan | US$5 a month minimum | <https://developers.cloudflare.com/workers/platform/pricing/> |
| Worker requests | 10 million a month included, then US$0.30 per million; requests for static assets are free and unlimited | same |
| Worker CPU time | 30 million CPU ms a month included, then US$0.02 per million CPU ms; no charge for duration or egress | same |
| D1 rows read | first 25 billion a month included, then US$0.001 per million | same (D1 section); <https://developers.cloudflare.com/d1/platform/pricing/> |
| D1 rows written | first 50 million a month included, then US$1.00 per million; each index touched by a write adds a written row | same |
| D1 storage | first 5 GB included, then US$0.75 per GB-month; no egress or throughput charge | same |
| Queues | 1 million operations a month included, then US$0.40 per million; about 3 operations (write, read, delete) per message; an operation is per 64 KB | same |
| Workers Logs (observability is enabled in `wrangler.jsonc`) | 20 million log events a month included, then US$0.60 per million; from 2026-12-01 the Observability pricing applies instead | same |

Not charged by Cloudflare for this design: media bytes (they never pass through Cloudflare, ADR-0002), egress, and Static Assets requests. Not included: a custom domain registration, if bought outside Cloudflare, and the cost of the origin servers. The Workers rate-limiting bindings used for NFR-SEC-004 and NFR-SEC-008 have no separate line on the pricing page; this is taken as no charge.

### Model

50 users all active every day (30 days), which is the high end for a household or friends instance.

| Quantity per month | Assumption | Estimate | Included | Charge |
|---|---|---|---|---|
| **Worker requests** | Per user-day: 40 API calls (home, browse, search, detail), 150 artwork requests (300 posters, half answered from the browser cache), 1 playback session of 2 h with a progress event every 15 s (480) and a handful of start, stop and credential calls: about 675. 1,500 user-days. Add 8,640 cron ticks (every 5 min) and a daily job | **about 1.0 million** | 10 million | US$0 |
| **Worker CPU** | 10 ms per request on average (pessimistic: catalog requests mostly wait on D1, not on CPU) gives 10 million ms. Sync: a full pass over 200,000 items each day at about 1 ms of CPU per item (JSON parsing and hashing) gives 6 million ms | **about 16 million ms** | 30 million | US$0 |
| **D1 rows read** | Request side: 1.0 million D1-touching requests at an average of 5,000 rows read (pessimistic, indexed queries touch tens to low thousands) is 5 billion. Sync: 0.4 to 1 million per full sync (HLD §11), daily, so about 30 million | **about 5 billion** | 25 billion | US$0 |
| **D1 rows written** | Sync bookkeeping about 200,000 a day (HLD §11) is 6 million; churn and credits about 0.6 million; progress and session writes (480 events a session, with their index rows, about 3 rows each) 2.2 million; the first sync, once, about 2.4 million | **about 9 million** (about 11 in the first month) | 50 million | US$0 |
| **D1 storage** | The seeded envelope database is about 220 MB; HLD §11 estimated 0.5 to 1.0 GB. Take 1 GB | **about 1 GB** | 5 GB | US$0 |
| **Queue operations** | 20 to 60 messages per full sync (HLD §11), daily: at most 1,800 messages a month, 3 operations each, plus purge continuations | **about 6,000** | 1 million | US$0 |
| **Workers Logs** | One invocation log and one `http.request` line per request: about 2 million events | **about 2 million** | 20 million | US$0 |
| **Total** | | | | **US$5.00 (the plan fee)** |

### Sensitivity

| If | Effect |
|---|---|
| Traffic is 10 times the model (10 million requests, 100 million CPU ms) | Requests at the included limit (US$0); CPU (100 − 30) × US$0.02 = US$1.40; total about **US$6.40** |
| CPU per request is 3 times higher (30 ms) and sync CPU too | about 48 million ms, 18 million over, US$0.36 |
| Row reads are 10 times higher (50 billion) | 25 billion over × US$0.001 per million = US$25. This is the one dimension where a regression matters: **without the Q1 fix a single min-height browse scanned about 200,000 rows**, so 125,000 such requests a month would exhaust the allowance. Keep the plan check (`explain.mjs`: zero full scans) in the release checklist |
| Writes are 5 times higher (45 million) | still inside 50 million |
| Daily full sync rewrote every row (HLD §11's naive case, about 36 million writes a month) | about 45 million, still inside, but with no headroom; FR-SYNC-004 skip-unchanged writes are what keep it small |

**Conclusion (estimate): about US$5 a month, comfortably within the proposed US$10 target (NFR-COST-001), with usage charges only plausible if traffic grows several-fold or a query regresses to scanning.** Confirm after the first month on staging with the D1 `meta.rows_read` and the Workers analytics, and replace the model inputs with those.

## 7. Limits of this analysis

- Local, not production D1 (§1). Latency in production will be higher by the Worker-to-D1 hop.
- One machine for client and server; one run; no repeated runs for confidence intervals.
- Synthetic data: titles built from a 190-word list, uniform distributions, no external IDs or alternative titles; real catalogs have heavier skew (a few very large series, a long tail of people).
- Concurrency up to 10 for reads and 20 for play, in one local isolate.
- No sync run at the envelope. Sync cost is taken from HLD §11 estimates, not measured. This report does not replace the M5 measurement HLD §11 asks for; it measures the read path.
- Origin latency is not included in play.
- Rows read and Workers CPU were not measured (§1, §6).

## 8. Re-running

```sh
pnpm install
pnpm perf              # full run, about 7 minutes; results in scripts/perf/.state/results.json
pnpm perf -- --quick   # 60 requests per endpoint
node scripts/perf/explain.mjs --plans   # plans and engine times on the left-over database
```

Needs Node 22.15 or newer (`node:sqlite`, type stripping and `module.registerHooks`). Ports 8789 (Worker) and 8791 (mock origin) are used; the end-to-end suite uses 8788 and 8790, so the two can coexist.
