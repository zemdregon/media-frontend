# ADR-0013: Session-scoped origin stream credentials

## Status

**Proposed** (pending M1 provider spike; see Exit criteria)

## Date

2026-10-04 (proposed)

## Deciders

Agent under delegation (2026-10-04); owner review pending. Not accepted: the mechanics below are unverified.

## Context

Under [ADR-0003](0003-direct-to-origin-playback.md) the browser streams from the origin, so the stream URL must carry some origin credential. Giving the browser the service-account token would let a viewer read the whole shared library and, depending on the provider, do more (BR-6, NFR-SEC-001). FR-PLAY-007 requires a credential scoped to one playback session, unable to authorize administrative actions, and revoked or expired when the session ends (BR-9).

Provider mechanics are unverified (Q-3, Q-6):

- Jellyfin/Emby: authenticating the service account with a unique per-session `DeviceId` may yield a distinct access token that can be revoked on session end (to verify in M1 spike).
- Plex: a transient or delegated token may exist (to verify in M1 spike); Plex API terms and token model for third-party clients are open (Q-3).

## Decision (proposed)

For each playback session the Worker obtains an origin credential that is unique to that session, usable only for streaming, and revocable, embeds it in the stream URL, and revokes it (or lets it expire) when the session ends or expires. The service-account token itself never leaves the Worker.

Per provider (all to verify in M1 spike):
- Jellyfin/Emby: authenticate the service account with a unique per-session DeviceId, use the resulting session access token, revoke it on session end.
- Plex: transient or delegation token.

**Fallback if a provider cannot meet the exit criteria**, in order of preference: (1) a per-server restricted playback account token (playback-only, no admin) with scheduled rotation and a documented residual risk; (2) a media gateway for that provider (DEF-1, requires superseding [ADR-0003](0003-direct-to-origin-playback.md) in part). Any fallback needs a new ADR or an amendment recorded here.

## Exit criteria (spike)

For each of Jellyfin, Emby and Plex, record yes/no with evidence for:

1. Can a per-session credential be minted by the service account without human interaction?
2. Can that credential be prevented from performing administrative actions (user, library, server, or settings changes)? Test by attempting representative admin calls.
3. Can it be revoked on demand, or does it expire on a bounded lifetime? Test that the stream URL stops working.
4. Does minting many credentials create operational problems (device list growth, rate limits, license limits)?

Recording the result: amend this ADR's status to Accepted with a per-provider results table, or supersede it with a new ADR choosing a fallback. Update FR-PLAY-007 in the [SRS](../requirements/SRS.md) if the outcome changes it.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Share the service account token with the browser | Viewer could use it outside Cinewren and read the library beyond their grants; violates BR-6 and FR-PLAY-007. |
| Media gateway (DEF-1) | Keeps all credentials server-side but adds hosting and bandwidth, and conflicts with the lightweight-ops outcome. Kept as a fallback. |
| Signed-URL reverse proxy at the origin (operator runs a signing proxy in front of each origin) | Works across providers and gives true short-lived URLs, but each operator must deploy and maintain a component per origin, and the proxy handles all bytes. A viable fallback for advanced operators; not a default. |
| Per-viewer origin accounts | Provisioning burden on every origin (see [ADR-0008](0008-origin-service-accounts-and-credential-encryption.md)). |

## Consequences

- Positive (if accepted): leak of a stream URL exposes only one session's stream, for a bounded time.
- Negative: extra origin calls per play (affects NFR-PERF-002); sessions may clutter origin device lists; revocation must run on stop, expiry and failure paths (LLD-TOKEN).
- Risk: if no acceptable mechanism exists for a provider, that provider's direct playback is weakened or requires a gateway; M3 (Jellyfin) and M4 (Emby, Plex) are affected. M1 is the place to learn this.

## Revisit when

- The M1 spike completes (mandatory; this ADR must leave Proposed).
- A provider changes its token model in a new version.

## Related

- FR-PLAY-007, FR-PLAY-008, FR-PLAY-009, NFR-SEC-001, BR-6, BR-9, IR-003 to IR-005 in [SRS](../requirements/SRS.md) (see its coverage notes)
- [ADR-0003](0003-direct-to-origin-playback.md), [ADR-0004](0004-provider-adapter-abstraction.md), [ADR-0008](0008-origin-service-accounts-and-credential-encryption.md)
- [LLD](../design/LLD.md) (LLD-TOKEN, LLD-PROV), [ROADMAP](../ROADMAP.md) (M1, M3)
