# ADR-0004: Provider adapter abstraction

## Status

Accepted

## Date

2026-10-04

## Deciders

Agent under delegation (2026-10-04); owner review pending. The idea of a provider interface with Jellyfin, Emby and Plex implementations is in the owner-provided [concept](../sources/2026-10-04-initial-architecture-concept.md); the exact boundary rules here are agent decisions.

## Context

Cinewren must support Jellyfin, Emby and Plex (C-4), whose APIs, authentication and identifiers differ. The client must not know which type serves an item (C-5), and new origin types should be addable without client changes (BO-4). Emby and Jellyfin share ancestry but have diverged; Plex differs substantially. Provider behaviour will change across versions (Q-6).

## Decision

All origin interaction goes through a `MediaProvider` interface (component C-PROV). `JellyfinProvider`, `EmbyProvider` and `PlexProvider` implement it. The interface covers: validating a server (identity, version, credentials), listing libraries, paging items, fetching artwork, producing playback info and an origin stream URL for a session, listing audio/subtitle tracks, and reporting playback start/progress/stop. The concept's method list is a starting point; the authoritative contract belongs in LLD-PROV.

Rules:

- The adapters normalize into canonical types (movie, series, season, episode; media versions with codec, resolution, HDR, bitrate, tracks). No provider-specific type appears outside an adapter (IR-002).
- Each adapter has a contract-test suite run against recorded fixtures (NFR-MAINT-001). The same suite runs against all adapters.
- Adapters make outbound calls only to the registered host (NFR-SEC-005).
- Provider type is stored on the server record and may appear in operator-only views. It does not appear in viewer-facing API fields.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Jellyfin-only in v1, abstract later | Abstraction retrofitted after launch leaks Jellyfin types into the catalog and API. Plex and Emby support is a stated outcome (BO-4). Mitigated instead by sequencing: Jellyfin first (M1..M3), others at M4. |
| Treat Emby as a Jellyfin variant (one shared adapter) | APIs have diverged; version-specific behaviour would hide inside conditionals. Shared helpers inside separate adapters are still allowed. |
| Depend on a third-party SDK per provider | Workers runtime constraints and bundle size; SDK maintenance risk; adapter surface needed is small. Not ruled out for individual helpers. |
| Expose provider-specific endpoints to the client | Violates C-5 and BO-4; couples the UI to server types. |

## Consequences

- Positive: client and catalog are provider-neutral; adding an origin type is a bounded task.
- Positive: one contract suite catches parity gaps (M4 exit).
- Negative: the lowest-common-denominator risk. Features only one provider supports (for example Plex-specific metadata) need an explicit optional capability, not a leak.
- Negative: upfront design effort in M1 before a second adapter exists, so the interface may need changes at M4. Changing it is allowed; the contract tests make it visible.

## Revisit when

- A fourth origin type is requested.
- The M1 spike or M4 parity work shows the interface cannot express a provider's playback negotiation.

## Related

- IR-002 to IR-005, NFR-MAINT-001, NFR-SEC-005, FR-PLAY-009 in [SRS](../requirements/SRS.md)
- [ADR-0013](0013-session-scoped-origin-stream-credentials.md)
- [LLD](../design/LLD.md) (LLD-PROV), [ROADMAP](../ROADMAP.md) (M1, M4)
