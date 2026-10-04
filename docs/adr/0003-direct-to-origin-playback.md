# ADR-0003: Direct-to-origin playback

## Status

Accepted. **Owner confirmed (2026-10-04):** viewers seeing origin hostnames is acceptable, and origins are reachable on public HTTPS (Q-2, A-3).

## Date

2026-10-04

## Deciders

Agent under delegation (2026-10-04). The owner confirmed on 2026-10-04 that origin hostnames being visible is acceptable and that origins are on public HTTPS (see Status). This follows the recommendation of the owner-provided [concept](../sources/2026-10-04-initial-architecture-concept.md) ("Option A, which I'd recommend"), but the selection was made by the agent. The owner supplied the concept and asked for a plan; that alone was not approval of the selection.

## Context

[ADR-0002](0002-cloudflare-control-plane-origins-deliver-media.md) rules out media through Cloudflare. Something else must carry the bytes from origin to browser. The concept names two options: (A) the Worker authorizes and returns an origin stream URL, and the browser streams directly from the origin; (B) a media gateway on a VPS between viewers and origins.

Constraints: C-2, C-5, assumptions A-3 (origins reachable over HTTPS from browsers, DNS-only), Q-2 (must origin hostnames be hidden? assumed no). Requirements: FR-PLAY-001, FR-PLAY-007, FR-PLAY-008, NFR-SEC-003.

## Decision

The playback descriptor returned by the Cinewren API contains a stream URL on the origin's own hostname, carrying a session-scoped credential ([ADR-0013](0013-session-scoped-origin-stream-credentials.md)). The browser fetches media directly from the origin (data flow DF-4, trust boundary TB-4). Cinewren never proxies, relays or caches stream bytes. A media gateway (Option B) is deferred (DEF-1).

The CSP `media-src`/`connect-src` lists the registered origin hostnames (NFR-SEC-003). Origins must permit the Cinewren app origin for CORS (to verify in M1 spike).

## Alternatives considered

| Alternative | Why rejected / deferred |
|---|---|
| Media gateway on a VPS (Option B) | Hides origins and could add auth in one place, but adds a server to run, pay for and secure, and a bandwidth bottleneck. It contradicts the lightweight-ops outcome (BO-2). Deferred (DEF-1), not excluded. |
| Worker redirect hybrid (Worker authenticates, then HTTP-redirects to origin) | Still direct delivery, so it is close to the chosen option. Rejected as the primary flow because the client needs the descriptor (tracks, mode, session ID, expiry) before playback, which a bare redirect cannot carry. A redirect can still be used for subtitle or artwork-adjacent endpoints if needed. |
| Worker proxy | Excluded by ADR-0002. |
| Cloudflare Tunnel for origins | Public hostname routes fall under the video restriction (ADR-0002). Private routes need a client-side agent, unsuitable for browsers. |

## Consequences

- Positive: zero media cost or latency added by Cinewren; simplest architecture.
- Negative: viewers learn origin hostnames and can contact origins directly. The stream credential limits what they can do ([ADR-0013](0013-session-scoped-origin-stream-credentials.md)).
- Negative: operator must expose origins with valid public TLS certificates (A-3). Private-only origins are unsupported (A-4, DEF-10, Q-5).
- Negative: failures (CORS, mixed content, certificate errors) occur in the browser, outside Cinewren's control; the player must surface them clearly (J-4).

## Revisit when

- Q-2 is answered "yes, hide origin hostnames" (adopt a gateway, DEF-1).
- Browser reachability proves to be a blocker for the target households.
- The M1 spike shows no acceptable per-session credential for a provider ([ADR-0013](0013-session-scoped-origin-stream-credentials.md) fallback).

## Related

- FR-PLAY-001, FR-PLAY-007, FR-PLAY-008, NFR-SEC-003, FR-SRV-007 in [SRS](../requirements/SRS.md)
- [ADR-0002](0002-cloudflare-control-plane-origins-deliver-media.md), [ADR-0013](0013-session-scoped-origin-stream-credentials.md)
- [HLD](../design/HLD.md) (DF-3, DF-4, TB-4)
