# ADR-0010: External-ID matching with manual overrides

## Status

Accepted

## Date

2026-10-04

## Deciders

Agent under delegation (2026-10-04); owner review pending. The owner's concept requires deduplicated items (the Interstellar example) but gives no matching rule; the rule is an agent decision.

## Context

The federated library is only useful if the same work on several servers appears once (BO-1, CAP-3). A wrong merge hides a title behind another and may play the wrong video. A missed merge only shows a duplicate. Origins usually provide TMDB/IMDb/TVDB IDs (A-9); Cinewren does not call TMDB itself in v1 (DEF-9).

## Decision

Matching follows BR-2:

- Automatic merge only when the media type is the same and the items share at least one strong external ID (TMDB or IMDb; TVDB for series and episodes).
- Episodes merge by (merged series, season number, episode number) or by episode external ID.
- Conflicting IDs (for example same IMDb, different TMDB) are not merged and are flagged for review.
- No fuzzy title and year matching. Items without strong IDs stay separate canonical items.
- Operators can manually merge or split. Overrides persist across syncs and win over automatic matching (BR-3, FR-CAT-007). Overrides are stored as primary data and survive a catalog rebuild (DR-001).
- The matcher is one module used by sync and curation (C-MATCH), deterministic and re-runnable.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Fuzzy title + year matching | False merges on remakes, same-year titles, and localized titles. Hard to explain or reverse. A wrong merge is worse than a duplicate. |
| Cinewren calls TMDB to resolve missing IDs | Adds an external dependency, API key and quota, and a metadata-enrichment scope (DEF-9). Reconsider if audit shows many unmatched titles. |
| Manual-only merging | Does not scale to thousands of titles; defeats BO-1. |
| Prefer one origin's metadata as canonical, no matching | Cannot dedupe across servers. |

## Consequences

- Positive: predictable, explainable merges; errors are biased toward harmless duplicates.
- Negative: titles lacking IDs on all origins show as duplicates until an operator merges them. Operator curation load depends on how well origin metadata is matched.
- Negative: provider ID quality varies (for example Plex GUID formats; to verify in M1 spike).
- Obligation: a review queue for conflicts, and a sample audit of merge accuracy against the proposed success measure in the BRD (J-6, WF-9).

## Revisit when

- Sample audits show unacceptable duplicate rates because of missing IDs (then consider TMDB lookup, DEF-9).
- Wrong-merge reports occur despite BR-2.

## Related

- FR-CAT-001, FR-CAT-007, BR-2, BR-3, DR-001 in [SRS](../requirements/SRS.md)
- [ADR-0009](0009-pull-based-sync-cron-and-queues.md), [ADR-0006](0006-d1-system-of-record.md)
- [LLD](../design/LLD.md) (LLD-MATCH), [ROADMAP](../ROADMAP.md) (M2, M5)
