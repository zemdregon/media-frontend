# ADR-0009: Pull-based sync with Cron Triggers and Queues

## Status

Accepted

## Date

2026-10-04

## Deciders

Agent under delegation (2026-10-04); owner review pending. The concept says the app "would periodically query each server's API"; the scheduling mechanism is an agent decision.

## Context

The catalog is derived from up to 20 origins and 200,000 source items (NFR-SCALE-001). Sync must run on a schedule, be triggerable on demand, be idempotent, and isolate failures per server (FR-SYNC-001, FR-SYNC-002, FR-SYNC-004, FR-SYNC-007). It must retry transient failures with backoff (NFR-REL-002).

Workers limits (Cloudflare docs, checked 2026-10-04): on Paid, cron trigger CPU is 30 s for intervals under 1 h and 15 min for 1 h or longer; queue consumer wall duration is 15 min; 10,000 subrequests per invocation by default; 6 simultaneous outgoing connections per request. `waitUntil` extends at most 30 s. Free plan: 10 ms CPU and 50 subrequests (hence A-5). Queues availability by plan: to verify in M0.

## Decision

- A Cron Trigger fires on the schedule and enqueues one job per enabled server (and library) on Cloudflare Queues. A queue consumer pages through the provider and writes D1, one bounded page per message, re-enqueueing a continuation until done.
- Incremental sync every 60 min and full sync every 24 h (proposed; FR-SYNC-001), as configuration. Only a full sync can mark sources `missing` (BR-4, FR-SYNC-005).
- Writes are idempotent upserts keyed by (server_id, provider_item_id) (FR-SYNC-004). A per-server lock or run record prevents concurrent runs (FR-SYNC-002).
- Each server's jobs fail and retry independently. Failures end in a `partial` or `failed` run record, never in catalog damage (FR-SYNC-006, FR-SYNC-007).
- The same Cron also drives health probes and retention jobs (LLD-SYNC).
- Operator on-demand triggers enqueue the same jobs.

## Alternatives considered

| Alternative | Why rejected / deferred |
|---|---|
| Origin webhooks (push changes) | Jellyfin/Emby/Plex webhook support differs and is partly plugin-based; Cinewren would need inbound endpoints reachable from origins and signature handling. Still needs periodic full sync for deletions. Deferred as an optional later optimization. |
| Cloudflare Workflows | Durable multi-step execution fits long jobs, but adds a second orchestration model and more platform surface. Cron + Queues is sufficient for page-sized jobs. Revisit if page-continuation logic becomes complex. |
| Durable Object alarms | One DO per server could serialize runs naturally, but cross-server D1 writes still go through D1 and DO state adds a second store. Reserved for real-time needs (DEF-5). |
| A single long cron invocation syncing everything | Hits CPU/duration/subrequest limits; one slow origin blocks all; no per-server retry. |

## Consequences

- Positive: bounded work per invocation; per-server isolation; automatic retries and backoff via Queues; scales within the envelope.
- Negative: sync lag up to the incremental interval; deletions appear only after a full sync.
- Negative: more moving parts to test (queue consumer, continuation, locking). Contract and Workers-runtime integration tests are required (NFR-TEST-001).
- Obligation: poison-message handling and a dead-letter strategy in LLD-SYNC. Origin rate courtesy (limit concurrency per origin; 6 outgoing connections per request).

## Revisit when

- Origins reliably support change webhooks and lag matters to operators.
- Queues are unavailable or unsuitable on the target plan (to verify in M0).
- Full-sync duration at the envelope exceeds consumer limits.

## Related

- FR-SYNC-001 to FR-SYNC-007, NFR-REL-002, NFR-SCALE-001, DR-003, BR-4 in [SRS](../requirements/SRS.md)
- [ADR-0005](0005-single-worker-typescript-stack.md), [ADR-0006](0006-d1-system-of-record.md), [ADR-0010](0010-external-id-matching-with-manual-overrides.md)
- [LLD](../design/LLD.md) (LLD-SYNC), [ROADMAP](../ROADMAP.md) (M2)
