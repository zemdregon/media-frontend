# ADR-0006: D1 as system of record

## Status

Accepted

## Date

2026-10-04

## Deciders

Agent under delegation (2026-10-04); owner review pending. The owner's concept names D1 for the catalog, users and server relationships; making D1 the single system of record and excluding KV in v1 is an agent decision.

## Context

Cinewren stores primary data (users, grants, progress, curation overrides, server configuration, audit log) and derived data (the catalog, rebuildable by full sync), per DR-001. Browse and search must keep working when origins are down (NFR-REL-001). Envelope: <= 200,000 source items (NFR-SCALE-001). Search must ignore case and diacritics (FR-CAT-004).

Facts (Cloudflare docs, checked 2026-10-04, <https://developers.cloudflare.com/workers/platform/pricing/>): D1 Free plan gives 5M rows read/day, 100k rows written/day, 5 GB total, and from 2026-09-01 queries fail once a daily limit is exceeded. Paid includes 25B reads/month, 50M writes/month, 5 GB, then $0.75/GB-month. Per-database size limit: see <https://developers.cloudflare.com/d1/platform/limits/>.

Not verified: FTS5 support in D1, and Time Travel retention (both to verify in M0).

## Decision

- D1 is the system of record for primary and derived data. The catalog is derived and may be rebuilt from origins; primary data is backed up and restorable (NFR-REL-003).
- No KV in v1. One store, one consistency model.
- Search uses D1 FTS5 over a normalized title column (to verify in M0). Fallback if FTS5 is unavailable: indexed `LIKE` prefix search on a normalized (lowercased, diacritic-folded) title column.
- Schema changes are forward-only migrations compatible with the previously deployed Worker (DR-004).
- Reads are filtered by user grants in SQL so that unauthorized sources are never loaded (BR-1, FR-CAT-006).

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| KV-first (catalog and metadata in KV; the concept mentions KV for cacheable metadata) | Eventually consistent, no queries, no joins, no transactions. Permission-filtered lists and search would need duplicate index structures. No v1 use case needs it. |
| Durable Objects with SQLite | Strong per-object consistency, but one DO per shard complicates cross-server queries; the catalog is a cross-server join. Fits real-time presence (DEF-5), not v1. |
| External Postgres via Hyperdrive | Needs a database to run and secure outside Cloudflare, conflicting with low-ops (BO-2); added latency and connection management. |
| Separate stores for primary and derived data | Two backup stories and two failure modes at a scale (A-1) that does not need it. |

## Consequences

- Positive: transactions and relational integrity for matching and cascades (DR-005); cheap at the design envelope; one backup story.
- Negative: D1 size limit and single-region write characteristics bound scale (revisit trigger below). Write amplification during full sync must be controlled (batching, unchanged-row skipping; FR-SYNC-004).
- Negative: a failed FTS5 verification forces the weaker LIKE fallback and may miss NFR-PERF-001 at the top of the envelope.
- Obligation: M5 includes a restore rehearsal.

## Revisit when

- The catalog approaches the D1 per-database size limit or NFR-PERF-001 is missed at the envelope.
- Multi-operator hosting is considered (Q-1; one database per operator would be natural).
- Real-time features (DEF-5) are scheduled.

## Related

- DR-001, DR-004, DR-005, FR-CAT-004, FR-CAT-006, NFR-REL-001, NFR-REL-003, NFR-PERF-001, NFR-SCALE-001 in [SRS](../requirements/SRS.md)
- [ADR-0005](0005-single-worker-typescript-stack.md), [ADR-0011](0011-single-operator-deployment-model.md)
- [LLD](../design/LLD.md) (LLD-SCHEMA), [ROADMAP](../ROADMAP.md) (M0)
