# ADR-0012: Artwork proxy with edge cache

## Status

Accepted

## Date

2026-10-04

## Deciders

Agent under delegation (2026-10-04); owner review pending.

## Context

Posters and backdrops live on origins and require origin credentials to fetch. FR-CAT-009 forbids giving browsers origin credentials or direct origin artwork URLs. Artwork must also obey the per-user visibility rules (FR-CAT-006, BR-1): a user must not fetch art for an item they cannot see. Artwork is small compared with video, so the Cloudflare video restriction ([ADR-0002](0002-cloudflare-control-plane-origins-deliver-media.md)) is not the concern; images are ordinary cacheable web content.

## Decision

The Worker serves artwork through an artwork proxy (C-ART, data flow DF-6):

1. The request carries the canonical item and image kind; the Worker checks the user's access (BR-1).
2. It selects a present source, fetches the image from the origin with the service credential (never exposed), and returns it with long-lived cache headers.
3. Responses are stored in the Cloudflare Cache API with a long TTL (value in LLD; proposed). Cache keys are per canonical item and image kind, not per user. Authorization is checked before a cache hit is served, so the cache is only a speed layer.
4. No resizing in v1 (passthrough). Image dimension variants are deferred.

The artwork reference stored in the catalog identifies the origin image, not a URL usable by browsers (FR-SYNC-003).

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Direct origin artwork URLs with tokens | Would put an origin credential in many page URLs with weak scoping; contradicts FR-CAT-009; leaks hostnames in every list view; token caching problems. |
| Cloudflare Images (transform or hosted) | Adds a paid service and an upload or transform pipeline, to gain resizing for a small library. Reconsider if image weight hurts NFR-PERF-003 or page load. |
| Mirror artwork to R2 | Duplicates data, needs a sync pipeline and storage lifecycle; conflicts with the "derived data only" catalog model unless treated as cache; extra cost and complexity. Cache API gives most of the benefit. |
| Fetch on every request, no cache | Hits origins on every list render; origin load and latency. |

## Consequences

- Positive: credentials stay server-side; one authorization model for all catalog responses.
- Negative: Worker invocations per image (a grid of posters is many requests); counts against request pricing and the Workers subrequest budget. At NFR-SCALE-001 volumes this should be small, to be checked in the M5 cost analysis (NFR-COST-001).
- Negative: Cache API is per data center and best-effort; cold hits reach the origin. Origin down means uncached art fails; the UI needs a placeholder.
- Negative: cache can hold art after access is revoked, but only served after the authorization check.
- Obligation: cap response size and content type allowlist for proxied images (NFR-SEC-005 still applies).

## Revisit when

- Image volume makes Worker request cost or latency significant.
- Resizing or modern formats are needed.
- Origins are often unreachable while viewers browse (consider an R2 mirror as cache).

## Related

- FR-CAT-006, FR-CAT-009, FR-SYNC-003, NFR-SEC-001, NFR-SEC-005, NFR-COST-001 in [SRS](../requirements/SRS.md)
- [ADR-0002](0002-cloudflare-control-plane-origins-deliver-media.md), [ADR-0008](0008-origin-service-accounts-and-credential-encryption.md)
- [HLD](../design/HLD.md) (C-ART, DF-6), [LLD](../design/LLD.md) (LLD-API)
