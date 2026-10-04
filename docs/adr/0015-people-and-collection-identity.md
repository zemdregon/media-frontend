# ADR-0015: People and collection identity across servers

## Status

Accepted

## Date

2026-10-04

## Deciders

**Owner decision (2026-10-04, Q-7):** v1 includes collections and search across people and collections, as shown in the design reference ([UX](../design/UX.md)).
How people and collections are identified and merged across servers is an **agent decision under delegation; owner review pending.**

## Context

[ADR-0010](0010-external-id-matching-with-manual-overrides.md) merges *titles* across servers only on strong external IDs, to avoid false merges. Origins also expose people (cast and crew) and collections: Plex collections, and Jellyfin and Emby box sets. Users expect one "Christopher Nolan" and one "Alien collection", not one per server. The costs of errors differ. A wrongly merged person mostly pollutes search results. A wrongly merged collection shows a misleading group of titles.

## Decision

1. **People** are canonical records (`people`) linked to provider person IDs, with credits joining a person to canonical items (role: actor, director, writer and so on; character; order).
   - They merge across servers when they share a TMDB or IMDb person ID.
   - Without external IDs, they merge only on an exact normalized name match (case- and diacritic-folded), and only if neither record carries a conflicting external ID.
   - Ambiguous cases stay separate. An operator can merge or split people with the FR-CAT-007 mechanism.
2. **Collections** are canonical records (`collections`) linked to provider collection IDs.
   - They merge across servers only on a shared TMDB collection ID. There is no name-only merging, because names like "Favourites" are common and personal.
   - Unmerged same-name collections show separately, labelled with their server.
   - Operators can merge or split collections (FR-CAT-007, FR-CAT-010).
   - Membership is the union of the members of all merged provider collections, filtered by BR-1.
3. Both are **derived data** (DR-001), rebuilt by sync (FR-SYNC-008). Curation overrides for them are primary data.
4. Search indexes titles, people names and collection names in one FTS5 index with a `kind` column ([ADR-0006](0006-d1-system-of-record.md)).

## Alternatives considered

| Alternative | Why not chosen |
|---|---|
| Same strict rule as titles for people (IDs only) | Many origin person records lack IDs, which would leave heavy duplication in people search. Name collisions for people are rarer and cheaper than for titles. |
| Name-based merge for collections | Personal collection names ("Kids", "Favourites") would wrongly merge across different owners' servers. |
| Enrich from TMDB to obtain IDs | Deferred (DEF-9). It adds an external dependency and API terms. |
| No cross-server merging (per-server people and collections) | Duplicates everywhere. It defeats BO-1. |

## Consequences

- **Schema:** adds people, credits, collections and collection membership, with their provider-link tables (LLD-SCHEMA). Sync volume per item grows (credits). The HLD write estimate must include it.
- **Risk:** name-based people merging can wrongly join two different people with identical names. Operator split is the remedy.
- **Visibility:** collection and person pages must apply BR-1 to every member, so they never reveal hidden titles or their counts.

## Revisit when

- Duplicate or wrongly merged people are commonly reported. The fix then is either stricter ID-only merging, or adding TMDB enrichment (DEF-9).
- Origins expose collection IDs that are stable across servers other than TMDB.

## Related

FR-SYNC-008, FR-CAT-007, FR-CAT-010, FR-CAT-011, FR-CAT-012, BR-1, BR-10, [ADR-0010](0010-external-id-matching-with-manual-overrides.md), [LLD](../design/LLD.md) (LLD-MATCH, LLD-SCHEMA).
