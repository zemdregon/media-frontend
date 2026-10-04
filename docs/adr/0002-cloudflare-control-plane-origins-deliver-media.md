# ADR-0002: Cloudflare control plane; origins deliver media

## Status

Accepted

## Date

2026-10-04

## Deciders

Owner direction (2026-10-04 concept), recorded by agent. The split between control plane and media delivery comes from the owner-provided [concept](../sources/2026-10-04-initial-architecture-concept.md). The terms-of-service evidence below was checked by the agent against Cloudflare documentation on 2026-10-04.

## Context

The owner's concept: Cloudflare provides the UI, catalog/index and auth/control plane; Jellyfin, Emby and Plex servers remain the media origins, doing transcoding and delivery (constraints C-1 to C-4). The concept itself warns against routing sustained video through a Worker.

Evidence (Cloudflare documentation, checked 2026-10-04):

- Cloudflare's Free, Pro and Business CDN service-specific terms prohibit serving video or disproportionately large files through proxied traffic unless a paid video product is used (Stream, or Stream Delivery on Enterprise). Source: <https://developers.cloudflare.com/fundamentals/reference/policies-compliances/delivering-videos-with-cloudflare/>
- The same restriction applies to Cloudflare Tunnel **public hostname** routes, but not to Tunnel private network routes. Source: <https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/>
- Workers can technically stream large bodies, but that does not change the terms above.

Relevant requirements: FR-PLAY-008, NFR-COMP-001, NFR-COST-001.

## Decision

- Cloudflare (Workers with Static Assets, D1) hosts the web app, API, catalog and auth. It is the control plane only (C-1).
- Media bytes never transit Cloudflare: not through Workers, not through the CDN on proxied hostnames, not through Tunnel public hostnames (C-2).
- Media files stay on the origin servers. Nothing is stored in R2 (C-3).
- Origins are Jellyfin, Emby and Plex (C-4).
- Operators serve origins on hostnames that are not proxied by Cloudflare (A-3).

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Proxy video through Workers (viewer -> Worker -> origin) | Breaches the Free/Pro/Business video terms for proxied traffic (see Context). Adds Worker request, CPU and subrequest-limit pressure per stream. Concept also advises against it. |
| Re-host video in Cloudflare Stream | Paid per-minute storage and delivery; duplicates libraries already held by origins; loses origin transcoding and per-user entitlements; conflicts with C-3 and NFR-COST-001. |
| Store media in R2 and serve from there | Serving video through the CDN falls under the same terms; copies terabytes of media; conflicts with C-3. |
| Expose origins via Tunnel public hostnames | Same video restriction applies to public hostname routes. |
| Run the whole stack on a VPS | Gives up the low-ops, low-cost serverless control plane the owner chose (C-1, BO-2). |

## Consequences

- Positive: Cloudflare cost stays small and independent of viewing hours (NFR-COST-001).
- Positive: compliant with the documented terms (NFR-COMP-001) as long as origin hostnames are DNS-only.
- Negative: browsers must reach origins directly over HTTPS (A-3). Operator setup burden; origin hostnames are visible to viewers (see [ADR-0003](0003-direct-to-origin-playback.md)).
- Negative: Cinewren cannot transcode or buffer for a slow origin. Playback quality is bounded by the origin.
- Obligation: the setup guide must state the DNS-only requirement. Terms may change; the check date above is 2026-10-04.

## Revisit when

- Cloudflare's video terms or Tunnel rules change materially.
- The owner decides to adopt a Cloudflare video product.
- An operator deploys on an Enterprise plan with different terms.

## Related

- C-1 to C-4; FR-PLAY-008, NFR-COMP-001, NFR-COST-001 in [SRS](../requirements/SRS.md)
- [ADR-0003](0003-direct-to-origin-playback.md), [ADR-0011](0011-single-operator-deployment-model.md)
- [HLD](../design/HLD.md)
