# Cinewren — HLD (High-Level Design)

| | |
|---|---|
| **Status** | Draft v0.1, 2026-10-04, agent-authored under delegation; not owner-reviewed. Nothing described here is implemented (the repository has no source code). Updated 2026-10-04 for owner decisions (ADR-0014, self-hosting). |
| **Owns** | System context and boundaries, major components (`C-*`), external dependencies, trust boundaries (`TB-*`), data flows (`DF-*`), deployment topology, origin reachability requirements, threat model, capacity and cost assumptions, availability posture. |
| **Does not own** | Requirements ([SRS](../requirements/SRS.md)), business rationale ([BRD](../requirements/BRD.md)), capabilities ([PRD](../requirements/PRD.md)), workflow rules ([FRD](../requirements/FRD.md)), module-level collaboration and the requirement-to-design table ([SDD](SDD.md)), test and build practice ([TDD](TDD.md)), field-level contracts and algorithms ([LLD](LLD.md)), sequencing ([ROADMAP](../ROADMAP.md)). |

Provenance labels used below: **Owner direction (2026-10-04)** means the owner supplied it (product name, the [concept document](../sources/2026-10-04-initial-architecture-concept.md), the agent-routing policy). The owner supplied the concept and asked for a plan; that is not approval of every detail here. **Owner decision (2026-10-04)** marks the three decisions recorded in [ADR-0014](../adr/0014-passkey-auth-with-invite-links.md) and [ADR-0011](../adr/0011-single-operator-deployment-model.md): passkeys and invite links only, self-hosting by other operators, and origin hostnames visible to viewers ([ADR-0003](../adr/0003-direct-to-origin-playback.md)). **Agent decision (delegated)** covers everything else, including the ADR-0014 implementation details; it is not yet owner-reviewed. Assumptions are `A-n`, open questions `Q-n`.

## 1. Architecture in one paragraph

Cloudflare hosts the web app, the API, the catalog index and authentication (Workers, Static Assets, D1, Queues). Jellyfin, Emby and Plex servers ("origins") hold the media and do transcoding and delivery. The Worker syncs every origin into one deduplicated catalog. At play time it selects the best source, negotiates playback with the origin, and hands the browser a stream URL that points **directly at the origin**. Video bytes never pass through Cloudflare ([ADR-0002](../adr/0002-cloudflare-control-plane-origins-deliver-media.md), [ADR-0003](../adr/0003-direct-to-origin-playback.md)). The first is **Owner direction (2026-10-04)** backed by Cloudflare's published terms; the direct-playback choice is an **Agent decision** consistent with the owner-provided recommendation (Option A in the concept document).

## 2. System context

```mermaid
flowchart LR
  viewer["Viewer browser<br/>(P-2, E-BROWSER)"]
  operator["Operator<br/>(P-1, browser + wrangler CLI)"]
  subgraph cf["Cloudflare account (operator-owned)"]
    worker["Cinewren Worker<br/>C-WEB assets, C-API, C-AUTH, C-CAT, C-MATCH,<br/>C-SYNC, C-HEALTH, C-PLAY, C-PROV, C-ART, C-CRYPTO"]
    d1[("D1 database")]
    queues[["Queues<br/>sync jobs"]]
  end
  jf["Jellyfin origin(s)"]
  em["Emby origin(s)"]
  px["Plex origin(s)"]

  viewer -->|"HTTPS app + API, session cookie"| worker
  operator -->|"HTTPS app + API, session cookie"| worker
  worker <-->|"binding"| d1
  worker -->|"enqueue / consume"| queues
  worker -->|"service credentials, HTTPS"| jf
  worker -->|"service credentials, HTTPS"| em
  worker -->|"service credentials, HTTPS"| px
  viewer ==>|"media stream, session credential, HTTPS (never via Cloudflare)"| jf
  viewer ==>|"media stream"| em
  viewer ==>|"media stream"| px
```

The bold edges are the only path for media bytes. The operator additionally uses `wrangler` to deploy and to set secrets; that path is outside runtime scope.

## 3. Boundaries and explicit exclusions

**Inside the system:** the SPA, the `/api/v1` API, the D1 catalog and primary data, sync, health probing, source selection, playback negotiation, artwork proxying, credential encryption.

**Outside the system (not built, not operated by Cinewren):**

| Exclusion | Why | Reference |
|---|---|---|
| Hosting, storing or transcoding media | Origins do this. Constraints C-2, C-3; no media in R2 | [ADR-0002](../adr/0002-cloudflare-control-plane-origins-deliver-media.md) |
| Proxying or caching stream bytes (including via Cloudflare Tunnel public hostnames) | Cloudflare video terms; FR-PLAY-008, NFR-COMP-001 | [ADR-0002](../adr/0002-cloudflare-control-plane-origins-deliver-media.md) |
| Hiding origin hostnames from viewers (media gateway) | Deferred as DEF-1; viewers seeing origin hostnames is acceptable (**Owner decision (2026-10-04)**) | [ADR-0003](../adr/0003-direct-to-origin-playback.md) |
| Origins reachable only on private networks | Unsupported in v1 (A-4, Q-5, DEF-10) | [PRD](../requirements/PRD.md) |
| Origin installation, TLS certificates, DNS, reverse proxies | Operator responsibility (A-2, A-3) | Section 9 |
| Native/TV apps, multi-tenant hosting, writing watch state back to origins, own metadata enrichment | Deferred (DEF-2, DEF-3, DEF-4, DEF-9) | [PRD](../requirements/PRD.md) |
| Passwords, OAuth or other external identity providers, email or SMS sign-in | Passkeys and invite links only (**Owner decision (2026-10-04)**) | [ADR-0014](../adr/0014-passkey-auth-with-invite-links.md) |

## 4. Major components

All components live in one Worker deployable ([ADR-0005](../adr/0005-single-worker-typescript-stack.md)). The split is logical (modules), not physical (services).

| ID | Component | Responsibilities | Key requirements |
|---|---|---|---|
| C-WEB | Web client | React + TypeScript SPA (Vite), served as Workers Static Assets. Browse, search, detail, admin screens, player (`<video>` + hls.js), reports capabilities and progress. Talks only to the Cinewren API (C-5). | FR-PLAY-002, FR-PROG-002, IR-007, NFR-A11Y-001 |
| C-API | API layer | Hono router under `/api/v1`; request ID, error envelope, CSP/HSTS headers, rate limiting, input validation. Thin: delegates to services. | IR-001, NFR-SEC-003, NFR-SEC-004, NFR-SEC-008 |
| C-AUTH | Auth and authorization | WebAuthn ceremonies, invites, sessions, roles and library grants; exposes the per-request permission context used by every service ([ADR-0014](../adr/0014-passkey-auth-with-invite-links.md)). | FR-USR-001..008, IR-006, NFR-SEC-002, NFR-SEC-007 |
| C-CAT | Catalog service | Browse, search (D1 FTS5, verified 2026-10-04), detail, home rows, next-episode. Single place that applies BR-1 visibility filtering. | FR-CAT-001..009, FR-PROG-004 |
| C-MATCH | Matching and dedup | External-ID matching (BR-2), manual merge/split (BR-3). Used by sync and curation. | FR-CAT-001, FR-CAT-007 |
| C-SYNC | Sync orchestrator | Cron enqueues one sync-run message per server; the queue consumer pages through providers and writes D1 idempotently; marks missing sources; retention purge. | FR-SYNC-001..007, NFR-REL-002 |
| C-HEALTH | Health prober | Cron probes each server; derives status; stores probe history. | FR-OPS-001, FR-OPS-002, FR-OPS-004 |
| C-PLAY | Playback service | Source selection (BR-5), session creation, provider negotiation, stream credential issuance and revocation, progress and watched state. | FR-PLAY-001..009 (FR-PLAY-004 in M3), FR-PROG-001, FR-PROG-003 |
| C-PROV | Provider adapters | `MediaProvider` interface; `JellyfinProvider`, `EmbyProvider`, `PlexProvider`. The only code that knows provider types or calls origins. | IR-002..005, NFR-SEC-005, NFR-MAINT-001 |
| C-ART | Artwork proxy | Fetches origin images with service credentials; small-image passthrough, cached via Cache API; permission-checked. | FR-CAT-009, [ADR-0012](../adr/0012-artwork-proxy-with-edge-cache.md) |
| C-CRYPTO | Credential vault | AES-256-GCM envelope encryption with a key from a Worker secret and key versioning. | DR-002, NFR-SEC-001, [ADR-0008](../adr/0008-origin-service-accounts-and-credential-encryption.md) |

Collaboration between these components is in the [SDD](SDD.md). Field-level contracts are in the [LLD](LLD.md).

## 5. External dependencies

| Dependency | Used for | Notes |
|---|---|---|
| Cloudflare Workers, Static Assets | Compute, SPA hosting | Workers Paid plan required (A-5, [ADR-0005](../adr/0005-single-worker-typescript-stack.md)) |
| Cloudflare D1 | System of record ([ADR-0006](../adr/0006-d1-system-of-record.md)) | D1 FTS5 support is verified ([SQL statements](https://developers.cloudflare.com/d1/sql-api/sql-statements/), checked 2026-10-04). Time Travel retention is 30 days on Workers Paid ([Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/), verified 2026-10-04) |
| Cloudflare Queues | Sync job fan-out ([ADR-0009](../adr/0009-pull-based-sync-cron-and-queues.md)) | Queues are available on the Free and Paid plans ([changelog](https://developers.cloudflare.com/changelog/post/2026-02-04-queues-free-plan/), verified 2026-10-04) |
| Cloudflare Cache API | Artwork cache | Per-colo cache; best-effort, never required for correctness |
| Jellyfin, Emby, Plex servers | Media origins | Auth, token and CORS behaviour unverified; see Section 9 and Q-3, Q-6 |
| Operator DNS and TLS for origins | Browser-reachable HTTPS origins | A-3; not provided by Cinewren |

## 6. Trust boundaries

```mermaid
flowchart LR
  net(["Internet (viewer / operator browsers)"])
  subgraph acct["Operator's Cloudflare account"]
    worker["Worker public surface"]
    app["App routes (session required)"]
    d1[("D1")]
  end
  origin["Origin server"]
  net -- "TB-1" --> worker
  worker -- "TB-2" --> app
  app -- "TB-5" --> d1
  app -- "TB-3" --> origin
  net -. "TB-4 (media + subtitles, direct)" .-> origin
```

| ID | Boundary | What crosses | How authenticated | Main threats |
|---|---|---|---|---|
| TB-1 | Internet ↔ Worker public surface | Every request from a browser. The only unauthenticated routes are setup, redeem, login, health and static assets (FR-USR-001, FR-OPS-007). | Rate limits (NFR-SEC-004), single-use hashed tokens (NFR-SEC-007), WebAuthn (IR-006) | Brute force and enumeration, leaked invite or `SETUP_TOKEN`, phishing, cross-origin requests |
| TB-2 | Authenticated session ↔ app routes | Every request to a route other than the public ones | Session cookie checked in one middleware, `Origin` check on state-changing requests (NFR-SEC-007); then user record, role, grants | Session cookie theft, CSRF, a route added outside the middleware |
| TB-3 | Worker and origins | Library metadata, playback negotiation, session creation/revocation, artwork bytes, health probes | Dedicated non-admin service account per origin, credentials decrypted only for the call ([ADR-0008](../adr/0008-origin-service-accounts-and-credential-encryption.md)); HTTPS only (FR-SRV-007) | SSRF through server URL, credential leak, hostile origin metadata, redirect to another host |
| TB-4 | Browser and origins (direct) | Media stream, subtitle files, HLS segments | Session-scoped stream credential in the URL ([ADR-0013](../adr/0013-session-scoped-origin-stream-credentials.md), proposed, pending M1 spike); HTTPS | Stolen or shared stream URL, mixed content, origin hostnames visible to viewers (accepted; **Owner decision (2026-10-04)**) |
| TB-5 | Worker and D1 | All reads and writes of primary and derived data | Worker binding (no network credential) | Data loss or corruption, cross-user data access through query bugs, secrets stored in plaintext |

## 7. Data flows

```mermaid
flowchart LR
  B["Browser"]
  W["Worker"]
  D[("D1")]
  Q[["Queues"]]
  O["Origin"]
  C["Cache API"]

  W -- "DF-1 sync: cron enqueue, consume, page, upsert" --> Q
  Q --> W
  W <-- "DF-1 list/detail calls" --> O
  W -- "DF-1 upsert" --> D
  B -- "DF-2 browse/search" --> W
  W -- "DF-2 filtered query" --> D
  B -- "DF-3 play request + capabilities" --> W
  W -- "DF-3 negotiate, session" --> O
  W -- "DF-3 descriptor with origin stream URL" --> B
  B == "DF-4 media stream (browser to origin only, never via Cloudflare)" ==> O
  B -- "DF-5 progress" --> W
  W -- "DF-5 position, watched" --> D
  W -. "DF-5 report start/progress/stop (FR-PLAY-009)" .-> O
  B -- "DF-6 artwork request" --> W
  W <-- "DF-6 cache lookup/store" --> C
  W -- "DF-6 cache miss fetch" --> O
```

| ID | Flow | Data | Frequency / size | Detail |
|---|---|---|---|---|
| DF-1 | Catalog sync | Provider item metadata into D1 | Incremental 60 min, full 24 h (FR-SYNC-001, proposed); many small pages inside one run per server | [SDD](SDD.md) WF-2, LLD-SYNC in [LLD](LLD.md) |
| DF-2 | Browse and search | Filtered catalog JSON | Per user interaction; no origin call | NFR-REL-001 follows from this: no origin dependency |
| DF-3 | Play negotiation | Capabilities in; descriptor out; origin session create | Per play; one or two origin calls | [SDD](SDD.md) WF-5, LLD-SEL, LLD-TOKEN |
| DF-4 | Media stream | Video, audio, segments, subtitles | Continuous, tens of Mbps | Browser and origin only. FR-PLAY-008 |
| DF-5 | Progress | Position every 15 s (proposed), watched flag | Small JSON | [SDD](SDD.md) WF-6 |
| DF-6 | Artwork | Poster/backdrop images | Many small GETs; cached | [ADR-0012](../adr/0012-artwork-proxy-with-edge-cache.md) |

## 8. Deployment topology

One Worker project (one `wrangler` configuration) exports three handlers: `fetch` (static assets fall through to the Hono API), `scheduled` (sync enqueue, health probe, retention purge) and `queue` (sync job consumer). ([ADR-0005](../adr/0005-single-worker-typescript-stack.md), [ADR-0009](../adr/0009-pull-based-sync-cron-and-queues.md)).

| Environment | Worker + D1 | Auth | Purpose |
|---|---|---|---|
| local | `wrangler dev`, local D1 | Real passkeys; WebAuthn works on `localhost`, so no bypass is needed | Development, tests; `ALLOW_INSECURE_ORIGINS` may be set here only (FR-SRV-007) |
| staging | Separate Worker, D1, Queue, secrets | Own RP ID (the staging hostname) and own first-operator setup | Pre-release checks, restore rehearsal (NFR-REL-003) |
| production | Separate Worker, D1, Queue, secrets | Own RP ID (the app hostname) | Live |

| Binding / resource | Type | Used by | Notes |
|---|---|---|---|
| `DB` | D1 | all services via repository layer | Forward-only migrations (DR-004) |
| Sync queue | Queue (producer and consumer on same Worker) | C-SYNC | One message = one sync run of one server; a continuation message is sent when the run reaches its time deadline (LLD-SYNC) |
| `CREDENTIAL_KEYS` | Worker secret | C-CRYPTO | JSON map of key version to key; set via `wrangler secret put`; the only entry in `secrets.required`; never in `vars` (names owned by the [TDD](TDD.md)) |
| `CREDENTIAL_KEY_CURRENT` | Configuration `var` | C-CRYPTO | Key version used for new encryptions |
| `SETUP_TOKEN` | Worker secret | C-AUTH | One-time first-operator setup (FR-USR-002); not in `secrets.required` (it is ignored once an operator exists); rotate it if leaked; setup is disabled once an operator exists |
| `ALLOW_INSECURE_ORIGINS`, sync intervals | Configuration `vars` | C-PROV, C-SYNC | FR-SRV-007, FR-SYNC-001 |
| Static Assets | Assets binding | C-WEB | Free to serve; SPA fallback routing |
| Cache API | Runtime API | C-ART | Cache keys must include the artwork identity, never user identity; permission check happens before cache lookup (Section 10) |

**Self-hosting.** Other operators may run their own single-operator instance ([ADR-0011](../adr/0011-single-operator-deployment-model.md); **Owner decision (2026-10-04)**). Each operator deploys their own Worker, D1 database and secrets from a tagged release (FR-OPS-008, NFR-MAINT-003) and creates their first operator through `/setup` with their own `SETUP_TOKEN`. Instances share nothing; there is no hosted multi-tenancy. Upgrades apply the release's pending D1 migrations (DR-004).

**DNS and proxying (NFR-COMP-001):**

- The Cinewren app hostname may be proxied (orange cloud): it serves HTML, JS and small JSON and images, not video.
- **Origin hostnames MUST be non-proxied** (DNS-only, or non-Cloudflare networking). Proxying them, or exposing them through a Cloudflare Tunnel public hostname, would route video through Cloudflare on Free/Pro/Business plans, which Cloudflare's terms prohibit. Tunnel private network routes are not affected, but they are not reachable from viewer browsers (see Q-5).
- Sources: [Delivering videos with Cloudflare](https://developers.cloudflare.com/fundamentals/reference/policies-compliances/delivering-videos-with-cloudflare/), [Tunnel FAQ](https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/) (checked 2026-10-04).
- Cinewren cannot verify the operator's DNS settings. It can only check that the registered URL is HTTPS (FR-SRV-007); the setup guide must state the rule. A Worker-side check for Cloudflare-proxied responses (for example a `cf-ray` response header on the validation call) is a possible aid, to be evaluated in M1.

## 9. Origin reachability requirements

| Requirement | Statement | Basis |
|---|---|---|
| Worker to origin | Origin API reachable from Cloudflare's network over public HTTPS, for sync, health and playback negotiation. | A-4; private-only origins unsupported (Q-5) |
| Browser to origin | Origin reachable from each viewer's browser over HTTPS with a publicly trusted certificate, on a non-proxied hostname. | A-3, NFR-COMP-001 |
| No mixed content | The app is HTTPS-only, so stream, subtitle and segment URLs must be `https://`. Plain `http://` origins are rejected at registration (FR-SRV-007). | NFR-SEC-003 |
| CSP | `media-src` and `connect-src` include only self plus registered origin hostnames, generated from server configuration. Adding a server changes the CSP. | NFR-SEC-003 |
| CORS | `<video>` direct play of a cross-origin URL does not need CORS headers unless the element uses `crossorigin` or reads the response from script. hls.js fetches playlists and segments via XHR/fetch, and `<track>` WebVTT loads require CORS. Whether Jellyfin, Emby and Plex send suitable CORS headers by default, and which settings the operator must change, is **to verify in M1 spike**. | Browser platform behaviour; provider behaviour unverified |
| Range requests | Origins must honour HTTP range requests for direct play seek (standard for all three; confirm in M1 spike). | Provider behaviour: to verify in M1 spike |
| Origin visibility | Viewers can see origin hostnames in network traffic. Acceptable (**Owner decision (2026-10-04)**). | [ADR-0003](../adr/0003-direct-to-origin-playback.md) |

Residential NAT, dynamic DNS and certificate management are the operator's responsibility (A-2, A-3). The setup guide, delivered in M0 (ROADMAP T0.7), should list tested reverse-proxy and DNS patterns.

## 10. Threat model (concise)

| Threat | Boundary | Mitigations | Residual risk |
|---|---|---|---|
| Stolen or shared stream URL | TB-4 | Credential scoped to one playback session, expires or is revoked at session end (FR-PLAY-007, BR-9); short authorization window; cannot perform admin actions. [ADR-0013](../adr/0013-session-scoped-origin-stream-credentials.md) | If a provider cannot mint per-session tokens, the fallback is a per-server restricted playback token with rotation, a documented higher risk. Pending M1 spike. |
| Service credential leak (logs, errors, exports, browser) | TB-3, TB-5 | Encrypted at rest (DR-002), decrypted only inside C-CRYPTO/C-PROV, never logged or exported (NFR-SEC-001, NFR-OBS-001); dedicated non-admin account (A-2, [ADR-0008](../adr/0008-origin-service-accounts-and-credential-encryption.md)); rotation (FR-SRV-005) | Leak of the Worker secret plus a D1 export exposes credentials; key versioning limits the blast radius. |
| IDOR across libraries | TB-2, TB-5 | Server-side checks on every ID-addressed request (NFR-SEC-002); BR-1 filter in one place in C-CAT (FR-CAT-006); sources the user cannot see are not disclosed, even as counts | Query-layer bugs; covered by authorization tests in [TDD](TDD.md). |
| SSRF via server URL | TB-3 | HTTPS-only (FR-SRV-007); outbound requests only to the registered host, redirects to other hosts refused (NFR-SEC-005); operator-only registration (BR-8); registration validates server identity (FR-SRV-002) | An operator can still point at an internal-looking public host; Workers cannot reach private networks, which limits impact. Whether to block IP literals and reserved ranges is a design item for LLD-PROV. |
| Malicious origin returns hostile metadata or XSS payloads | TB-3 | Metadata treated as untrusted data; UI renders text only (no raw HTML); CSP `script-src 'self'` (NFR-SEC-003); bounded field sizes on normalization (FR-SYNC-003); artwork served from Cinewren with content-type checks | A compromised origin can still show misleading titles; operator removes the server (FR-SRV-004). |
| Invite link leaked or forwarded | TB-1 | Single use, 7-day expiry *(proposed)*, revocation, and the operator sees redemption (FR-USR-002, FR-USR-004); token stored hashed (NFR-SEC-007) | Whoever redeems first gets the account; the operator can disable it. |
| Session cookie theft | TB-2 | `HttpOnly; Secure; SameSite=Lax`, hashed storage, idle and absolute expiry, revocation on sign-out, disable or delete, `Origin` check (NFR-SEC-007, FR-USR-006, FR-USR-008) | A stolen live cookie works until expiry or revocation. |
| Brute force or enumeration on public auth endpoints | TB-1 | Per-IP rate limits on setup, redeem and login (NFR-SEC-004); single-use challenges and tokens; uniform error responses for invalid tokens | Distributed attempts; passkeys have no guessable secret, and tokens are random. |
| `SETUP_TOKEN` leak before setup | TB-1 | Setup is disabled once an operator exists (FR-USR-002); rotate the secret; complete setup right after deploy | A leak between deploy and first setup lets a stranger become the first operator. |
| Phishing | TB-1 | Passkeys are bound to the RP ID, so a look-alike site cannot obtain an assertion (IR-006) | Phishing of an invite link falls under the leaked-invite row. |
| Abuse of play endpoint (session exhaustion, origin hammering) | TB-3 | Per-user rate limits (NFR-SEC-008, proposed); session expiry (BR-9); concurrent-session bound within NFR-SCALE-001; negotiation timeouts and bounded retries (NFR-REL-002) | Authenticated viewer can still burn origin transcode capacity within limits. |
| D1 data loss or corruption | TB-5 | Catalog is derived and rebuildable (DR-001); primary data restorable via Time Travel with documented, rehearsed restore (NFR-REL-003); JSON export (FR-OPS-006, Could); expand-migrate-contract migrations (DR-004) | Time Travel retention is 30 days on Workers Paid (verified 2026-10-04, [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)); RPO/RTO are proposed targets. |
| Cache poisoning or cross-user artwork leak | TB-3 | Permission check before cache lookup; cache key excludes user identity; origin responses restricted to image content types | Cached artwork may outlive a grant revocation for the TTL; acceptable for posters, to confirm in [ADR-0012](../adr/0012-artwork-proxy-with-edge-cache.md). |

## 11. Capacity and cost assumptions

Design envelope: NFR-SCALE-001 (50 users, 20 servers, 200,000 source items, 20 concurrent playback sessions, all proposed under A-1). Cost target: NFR-COST-001.

**Verified Cloudflare limits (checked 2026-10-04):**

| Fact | Value | Source |
|---|---|---|
| Free plan Worker | 10 ms CPU, 50 external subrequests per invocation, 100k requests/day, 5 cron triggers per account | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Paid plan Worker | CPU default 30 s, up to 5 min per HTTP request; cron CPU 30 s (interval under 1 h) or 15 min (1 h or more); 10,000 subrequests default (configurable up to 10M); 6 simultaneous outgoing connections per request; cron and queue consumer wall duration 15 min; `waitUntil` extends up to 30 s | same |
| D1 pricing | Free: 5M rows read/day, 100k rows written/day, 5 GB; from 2026-09-01 Free-plan queries fail once the daily limit is exceeded. Paid: 25B reads/month and 50M writes/month included, 5 GB included then $0.75/GB-month | [Pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| D1 per-database size limit | See the linked page (not restated here) | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |

The Free plan is unsuitable (A-5): a single full sync exceeds Free-plan CPU, subrequest and daily D1 write limits.

**Estimate for a full sync of 200,000 items (proposed; to be measured in M2 and M5):**

| Quantity | Assumption | Estimate |
|---|---|---|
| Origin page calls | 200 items per page (proposed), one list call per page | about 1,000 subrequests per full sync, about 50 per server run, far below 10,000 per invocation |
| Origin detail calls | Only for items whose list payload lacks versions or tracks; assume 10% | up to about 20,000 extra subrequests across the whole run, inside the run's time-bounded invocations, 6 concurrent connections max |
| D1 rows written, first full sync | About 6 rows per source item (source, versions, external IDs, search index entry, canonical link) | about 1.2M rows |
| D1 rows written, steady state | FR-SYNC-004 requires no catalog-visible changes on unchanged data; a content hash lets the writer skip unchanged items. Assume 2% churn per day (about 25k rows). Each full sync also touches `last_seen_sync_id` on every present source, which BR-4 missing-marking needs (LLD-SYNC) | about 200k rows per day from full-sync bookkeeping, about 6M per month (estimate; to be measured in M5), still within the 50M/month included on Workers Paid |
| D1 rows read per full sync | About 2 to 5 reads per item for hash comparison and match lookup | 0.4M to 1M rows |
| Stored size | About 2 to 4 KB per item including indexes | 0.4 to 0.8 GB, within the 5 GB included |
| Queue messages per full sync | One message per server run (20 servers in the envelope), plus a continuation message each time a run reaches its 12 min deadline (LLD-SYNC); pages and detail calls are loops inside the consumer, not messages | about 20 to 60 across all servers |

Reading: the first sync and any forced re-sync dominate write cost, yet 1.2M rows is small against the 50M/month included. The steady-state full-sync bookkeeping adds about 6M rows a month. A naive daily full sync that rewrote every row would cost about 36M writes per month, close to the included amount, which is why idempotent skip-unchanged writes (FR-SYNC-004) are a cost requirement as well as a correctness one. Steady-state cost is expected to stay within the Workers Paid base fee (NFR-COST-001, proposed target US$10/month); to be confirmed by measurement in M5.

Concurrent playback load on the Worker is low: a play request is one D1 read set and at most two origin calls; progress writes are 20 sessions at 15 s intervals (proposed), roughly 1.3 writes per second at the envelope.

## 12. Availability posture

| Situation | Behaviour | Requirement |
|---|---|---|
| One origin down | Browse unaffected. Sources on that server are excluded at play time once marked `unreachable`, and failover to the next source is offered from M3 (FR-PLAY-004; health-based exclusion is FR-OPS-002, M5). Title is hidden only if no source remains (BR-1). | FR-SYNC-007, CAP-10 |
| All origins down | Browse, search and detail work from last-synced data; play returns a clear "no playable source" error. | NFR-REL-001 |
| Sync failing | Existing catalog stays; failures isolated per server and visible to the operator. | FR-SYNC-007, FR-OPS-003 |
| Cloudflare outage (Workers, D1 or Queues) | The entire control plane is unavailable. Already-started streams continue because they are browser-to-origin, but no new playback starts. There is no second provider. | Accepted single-provider risk (Owner direction on Cloudflare, C-1); mitigation limited to export (FR-OPS-006) and restore (NFR-REL-003). No availability target is set for v1. |
| D1 unavailable | API returns errors; health endpoint reports database status (FR-OPS-007). | NFR-REL-003 for restore. |

## 13. Related documents

[SRS](../requirements/SRS.md) (requirements) · [SDD](SDD.md) (integrated design, requirement-to-design table) · [TDD](TDD.md) · [LLD](LLD.md) · [ROADMAP](../ROADMAP.md) (milestones M0 to M5) · [ADR-0002](../adr/0002-cloudflare-control-plane-origins-deliver-media.md) · [ADR-0003](../adr/0003-direct-to-origin-playback.md) · [ADR-0004](../adr/0004-provider-adapter-abstraction.md) · [ADR-0006](../adr/0006-d1-system-of-record.md) · [ADR-0009](../adr/0009-pull-based-sync-cron-and-queues.md) · [ADR-0011](../adr/0011-single-operator-deployment-model.md) · [ADR-0014](../adr/0014-passkey-auth-with-invite-links.md)

History: [ADR-0007](../adr/0007-cloudflare-access-identity.md) (Cloudflare Access) was superseded by ADR-0014 on 2026-10-04.
