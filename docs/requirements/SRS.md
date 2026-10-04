# Cinewren — SRS (Software Requirements Specification)

| | |
|---|---|
| **Status** | Draft v0.1 (2026-10-04). Written by an agent under delegation. The project owner has not reviewed it. |
| **Owns** | The canonical, uniquely identified, verifiable requirements (functional, interface, data, nonfunctional) and the requirement-level traceability matrix. |
| **Does not own** | Business rationale ([BRD](BRD.md)), capabilities and journeys ([PRD](PRD.md)), detailed workflow behaviour and business rules ([FRD](FRD.md)), design ([HLD](../design/HLD.md), [SDD](../design/SDD.md), [TDD](../design/TDD.md), [LLD](../design/LLD.md)), sequencing ([ROADMAP](../ROADMAP.md)). |

Visual and interaction design is owned by [UX](../design/UX.md). Other documents must reference requirements here by ID. They must not restate them with different wording. To change a requirement, edit it here and update its trace links.

## 1. Conventions

- **IDs** are stable. Never renumber or reuse one. A retired requirement keeps its row and gets status `Withdrawn` plus a reason.
- **Priority:** `Must` = required for v1.0 ([ROADMAP](../ROADMAP.md) milestone M5 exit). `Should` = planned for v1.0, but it can slip with a recorded decision. `Could` = only if cheap. Deferred items are listed in [PRD §6](PRD.md#6-non-goals-and-deferred-capabilities), not here.
- **Verification method:** `T` = automated test, `I` = inspection or review, `D` = demonstration on a deployed environment, `A` = analysis or measurement.
- **Implementation status:** the repository had no source code on 2026-10-04, so every requirement is **Not started**. Implementation status is tracked per milestone in the [ROADMAP](../ROADMAP.md). It is not tracked per row here, so that it does not drift in two places.
- **Proposed values:** a number marked *(proposed)* is a design target chosen under delegation. It is not an established commitment. Change it here, with a reason, when evidence warrants.
- **Trace columns:** `Source` = PRD capability (`CAP-*`) or FRD workflow / business rule (`WF-*`, `BR-*`). `Design` = HLD component (`C-*`), LLD section (`LLD-*`) or ADR. `MS` = delivering milestone.

## 2. System context (summary)

Cinewren (the product name was chosen by the project owner on 2026-10-04) is a self-hosted federated media frontend. The operator deploys it to their own Cloudflare account. It presents movies and TV from several Jellyfin, Emby and Plex servers ("origins") as one deduplicated library. When a viewer presses play, it picks the best source and sends the viewer's browser **directly to that origin**. Video bytes never pass through Cloudflare. The architecture is in [HLD](../design/HLD.md). The governing decisions are [ADR-0002](../adr/0002-cloudflare-control-plane-origins-deliver-media.md) and [ADR-0003](../adr/0003-direct-to-origin-playback.md).

## 3. Functional requirements

### 3.1 Server management (FR-SRV)

| ID | Requirement | Pri | Source | Design | MS | Verify |
|---|---|---|---|---|---|---|
| FR-SRV-001 | An operator can register an origin server. The registration gives its type (`jellyfin`, `emby` or `plex`), a display name, an HTTPS base URL and service-account credentials. | Must | CAP-1, WF-1 | C-API, C-PROV, LLD-API, ADR-0008 | M1 | T |
| FR-SRV-002 | Before saving a registration, and whenever the operator re-validates, the system checks four things: TLS reachability, credential validity, the server's identity (its unique server ID) and its product version. The credential check refuses administrator service accounts (Jellyfin and Emby: `IsAdministrator`; Plex: owner tokens are refused, a restricted managed user is used). If any check fails, the system rejects the registration and returns an error naming the check that failed. | Must | WF-1 | C-PROV, LLD-PROV | M1 | T |
| FR-SRV-003 | The system discovers the movie and TV libraries visible to the service account. It lets the operator enable or disable each library for the platform. Only enabled libraries are synced. | Must | CAP-1, WF-1 | C-SYNC, LLD-SCHEMA | M1 | T |
| FR-SRV-004 | An operator can edit, disable, re-enable and remove a server. Disabling stops sync and excludes its sources from browse and playback. Removing deletes its credentials, libraries and sources per DR-005. | Must | WF-10 | C-API, LLD-SCHEMA | M2 | T |
| FR-SRV-005 | An operator can replace a server's credentials without losing catalog data. | Should | WF-11 | C-API, ADR-0008 | M5 | T |
| FR-SRV-006 | An operator can set an integer priority per server. Source selection uses it as a tie-breaker (BR-5). | Should | BR-5 | LLD-SEL | M3 | T |
| FR-SRV-007 | Base URLs must use `https://`. Plain `http://` is rejected, except when the deployment flag `ALLOW_INSECURE_ORIGINS` is set. Only local development may set that flag. | Must | WF-1 | LLD-PROV, NFR-SEC-003 | M1 | T |

### 3.2 Catalog sync (FR-SYNC)

| ID | Requirement | Pri | Source | Design | MS | Verify |
|---|---|---|---|---|---|---|
| FR-SYNC-001 | The system syncs every enabled server on a schedule. Incremental sync runs every 60 minutes *(proposed)* and full sync every 24 hours *(proposed)*. Both intervals are configuration values. | Must | CAP-2, WF-2 | C-SYNC, ADR-0009, LLD-SYNC | M2 | T |
| FR-SYNC-002 | An operator can trigger a full or incremental sync of one server on demand. A server never has two sync runs at once. | Must | WF-2 | C-SYNC, LLD-SYNC | M2 | T |
| FR-SYNC-003 | Sync normalizes provider items into the canonical schema. Item types are movie, series, season and episode. Normalized fields are titles, year, overview, genres, runtime, external IDs (TMDB, IMDb, TVDB), artwork references and media versions. Each media version records container, video codec, resolution, HDR format, bitrate, audio tracks and subtitle tracks. | Must | CAP-2, WF-2 | C-PROV, LLD-PROV, LLD-SCHEMA | M2 | T |
| FR-SYNC-004 | Sync is idempotent. Re-running a sync over unchanged origin data produces no catalog-visible changes. Bookkeeping fields such as last-seen markers may be updated. An interrupted run can be retried without creating duplicate items or sources. | Must | WF-2 | LLD-SYNC | M2 | T |
| FR-SYNC-005 | After a full sync of a library completes successfully, every source in that library that the run did not see is marked `missing` (BR-4). A missing source that is seen again is restored. | Must | BR-4 | LLD-SYNC | M2 | T |
| FR-SYNC-006 | Each sync run records its type, status (`queued`, `running`, `succeeded`, `partial` or `failed`), start and end times, counts (added, updated, missing, errors) and a bounded error summary. The operator can view these. | Must | CAP-13, WF-2 | LLD-SCHEMA, LLD-API | M2 | T |
| FR-SYNC-007 | A sync failure on one server does not affect other servers' syncs. It also does not affect the availability of already-synced catalog data. | Must | WF-2 | C-SYNC, ADR-0009 | M2 | T |
| FR-SYNC-008 | Sync also captures, from origin metadata, each item's people (cast and crew, with role or character and order) and its collection memberships (Plex collections, Jellyfin and Emby box sets), including each collection's name, overview, artwork and external IDs. | Must | CAP-15, CAP-16, WF-2 | C-PROV, LLD-PROV, LLD-SCHEMA | M2 | T |

### 3.3 Catalog (FR-CAT)

| ID | Requirement | Pri | Source | Design | MS | Verify |
|---|---|---|---|---|---|---|
| FR-CAT-001 | When provider items represent the same work under BR-2, they appear as one canonical item with multiple sources. | Must | CAP-3, WF-3, BR-2 | C-CAT, ADR-0010, LLD-MATCH | M2 | T |
| FR-CAT-002 | Users can browse movies and TV series as unified lists, independent of library and server. Lists can be sorted by title, year or date added, and are paginated. | Must | CAP-4 | C-CAT, LLD-API | M2 | T |
| FR-CAT-003 | Users can filter browse lists by genre, year range and best available resolution. | Should | CAP-4 | C-CAT, LLD-API | M2 | T |
| FR-CAT-004 | Users can search titles by token or prefix. Search ignores case and diacritics. Results respect NFR-PERF-001. | Must | CAP-4, WF-4 | C-CAT, ADR-0006, LLD-SCHEMA | M2 | T |
| FR-CAT-005 | An item's detail view shows its metadata and artwork. It summarizes the versions available to the user, for example "4K HDR · 1080p", and how many servers the user can play it from. For a series it lists seasons and episodes. | Must | CAP-5 | C-CAT, LLD-API | M2 | T |
| FR-CAT-006 | Every catalog response (browse, search, detail and artwork) contains only items and sources the user may see under BR-1. | Must | BR-1 | C-AUTH, C-CAT, LLD-API | M2 | T |
| FR-CAT-007 | An operator can manually merge two canonical items, or split a source out of an item. These overrides persist across syncs (BR-3). | Should | CAP-12, WF-9 | LLD-MATCH, LLD-SCHEMA | M5 | T |
| FR-CAT-008 | The home view shows "Recently added" (M2) and "Continue watching" (M3) rows. | Should | CAP-4, CAP-8 | C-CAT, LLD-API | M2, M3 | T |
| FR-CAT-009 | The platform serves artwork. Browsers never receive origin credentials or direct origin artwork URLs. | Must | CAP-5 | C-API, ADR-0012 | M2 | T |
| FR-CAT-010 | An operator can list the sources flagged as match conflicts under BR-2 and resolve each one with FR-CAT-007. | Should | CAP-12, BR-2 | LLD-MATCH, LLD-API | M5 | T |
| FR-CAT-011 | Search also matches people by name. A person page lists the visible titles they appear in, with their role. People are merged across servers per BR-10. | Must | CAP-15, BR-10 | C-CAT, C-MATCH, ADR-0015, LLD-MATCH | M2 | T |
| FR-CAT-012 | Users can browse collections and open a collection page listing its visible member titles. Search also matches collections. Collections are merged across servers per BR-10. A collection with no visible members is hidden (BR-1). | Must | CAP-16, BR-10 | C-CAT, C-MATCH, ADR-0015, LLD-MATCH | M2 | T |
| FR-CAT-013 | The title view lists every visible copy with its server, resolution, HDR format, audio, file size and expected playability on this device (`direct_play`, `transcode` or `unavailable`). The automatically selected copy is marked. | Should | CAP-5, CAP-7 | C-WEB, LLD-API, [UX](../design/UX.md) | M3 | T |

### 3.4 Playback (FR-PLAY)

| ID | Requirement | Pri | Source | Design | MS | Verify |
|---|---|---|---|---|---|---|
| FR-PLAY-001 | A play request for an item, or for a specific episode, returns a playback descriptor. The descriptor contains the selected source, an origin stream URL, the mode (`direct_play`, `direct_stream` or `transcode`), available audio and subtitle tracks, a session ID and an expiry. | Must | CAP-6, WF-5 | C-PLAY, LLD-API | M3 | T |
| FR-PLAY-002 | Every play request includes the client's device capabilities. These are supported containers, video and audio codecs, maximum resolution and HDR support. | Must | WF-5 | C-WEB, LLD-SEL | M3 | T |
| FR-PLAY-003 | Without a user override, the system picks the source with the deterministic algorithm in BR-5 / LLD-SEL. | Must | CAP-6, BR-5 | C-PLAY, LLD-SEL | M3 | T |
| FR-PLAY-004 | If a selected source fails to start, the client can request a replacement. The request excludes the failed sources, and the system returns the next-best source or a clear "no playable source" error. | Should | CAP-10, WF-5 | C-PLAY, LLD-SEL | M3 | T |
| FR-PLAY-005 | A user can choose a specific version or source manually. The choice overrides automatic selection for that play request. | Should | CAP-7 | C-PLAY, LLD-API | M3 | T |
| FR-PLAY-006 | A user can choose the audio track and subtitle track, including none. Text subtitles are delivered as WebVTT. The origin burns image-based subtitles into a transcode. | Must | CAP-11 | C-PLAY, C-WEB, LLD-PROV | M3 | T |
| FR-PLAY-007 | The credential embedded in a stream URL is scoped to one playback session. It cannot authorize administrative actions, and it is revoked or expires when the session ends or expires (BR-6, BR-9). Provider mechanisms (verified T1.1): Jellyfin and Emby use a per-session token minted by re-authenticating the service account with a per-session (Jellyfin) or pooled (Emby) DeviceId, revoked by logout; Plex uses a restricted managed user's tokens (pending verification). Jellyfin uses token-gated HLS only, never `static=true` direct-play URLs, because Jellyfin 12.1 serves those without authentication. The session token keeps the service account's non-admin scope, so it is not stream-only. | Must | BR-6, BR-9 | ADR-0013, LLD-TOKEN | M3 | T, I |
| FR-PLAY-008 | The platform never proxies, relays or caches video or audio stream bytes. Stream URLs in descriptors always point at the origin's own hostname. | Must | WF-5 | ADR-0002, ADR-0003 | M3 | T, I |
| FR-PLAY-009 | The system reports playback session telemetry (start, position, stop) to the origin, so the origin can track sessions and end transcodes. This is not a write-back of watched state, which is deferred (DEF-4). | Should | WF-5, WF-6 | C-PROV, LLD-PROV | M3 | T |
| FR-PLAY-010 | The playback descriptor includes machine-readable reason codes for the selection (for example `direct_play`, `hdr_unsupported`, `server_unreachable`). The UI renders them as a one-sentence explanation of why a copy was chosen, or why another copy would transcode or is unavailable. | Should | CAP-6, BR-5 | LLD-SEL, LLD-API, [UX](../design/UX.md) | M3 | T |

### 3.5 Progress (FR-PROG)

| ID | Requirement | Pri | Source | Design | MS | Verify |
|---|---|---|---|---|---|---|
| FR-PROG-001 | The client reports playback position every 15 s *(proposed)* and on pause, seek-end, stop and page hide. The system stores one position per user per canonical item, independent of which source played. | Must | CAP-8, WF-6 | C-PLAY, LLD-SCHEMA | M3 | T |
| FR-PROG-002 | Starting playback of a partially watched item offers to resume from the stored position, on whichever source is selected. | Must | CAP-8, WF-6 | C-WEB | M3 | T |
| FR-PROG-003 | An item is marked watched automatically when the position reaches the BR-7 threshold. Users can also mark items watched or unwatched manually. | Must | CAP-8, BR-7 | C-PLAY | M3 | T |
| FR-PROG-004 | For a series, the system identifies the next episode to watch: the first unwatched episode after the last one watched. | Should | CAP-8, J-3 | C-CAT | M3 | T |

### 3.6 Users and access (FR-USR)

| ID | Requirement | Pri | Source | Design | MS | Verify |
|---|---|---|---|---|---|---|
| FR-USR-001 | Users authenticate with WebAuthn passkeys only. Every application and API route requires a valid session, except static assets and the public setup, invite-redemption, login and health endpoints. Requests without a valid session get 401. | Must | CAP-9, WF-7 | C-AUTH, ADR-0014 | M0 | T |
| FR-USR-002 | Accounts can be created only by redeeming a valid operator-issued invite link: single-use, unexpired (7 days *(proposed)*), not revoked. Redeeming it registers a passkey. The first operator is created through the `/setup` flow, which needs the `SETUP_TOKEN` secret and is disabled once any operator exists. No other account-creation path exists. | Must | WF-7 | C-AUTH, ADR-0014, LLD-SCHEMA | M0 | T |
| FR-USR-003 | There are two roles, `operator` and `viewer`. The server enforces operator-only endpoints on every request. | Must | BR-8 | C-AUTH, LLD-API | M0 | T |
| FR-USR-004 | An operator can create, list and revoke invites. Each invite carries a display name, a role and default grants. | Must | CAP-9, WF-7 | C-API, ADR-0014, LLD-SCHEMA | M0 | T |
| FR-USR-005 | An operator can grant or revoke a viewer's access to each enabled library. A new viewer's grants default to the set chosen at invitation, which defaults to all enabled libraries. Operators implicitly have access to every enabled library, which they need for curation. | Must | CAP-9, BR-1 | C-AUTH, LLD-SCHEMA | M2 | T |
| FR-USR-006 | A user can sign out, which revokes the current session. A user can list, add and remove their own passkeys, but cannot remove their last one. | Must | CAP-9 | C-AUTH, LLD-API | M0 | T |
| FR-USR-007 | An operator can issue a single-use re-enrollment link (24 h expiry, *proposed*) that adds a passkey to an existing user's account. A documented command-line procedure, run with Cloudflare account access, issues a recovery link for an operator who has lost every passkey. | Should | CAP-9, WF-7 | ADR-0014, LLD-API | M2 | T, D |
| FR-USR-008 | An operator can disable, re-enable and delete users. Disabling or deleting a user revokes their sessions immediately. Deleting removes their personal data per DR-005. BR-8 protects the last operator. | Must | CAP-9, WF-7, BR-8 | C-API, LLD-SCHEMA | M2 | T |

### 3.7 Operations (FR-OPS)

| ID | Requirement | Pri | Source | Design | MS | Verify |
|---|---|---|---|---|---|---|
| FR-OPS-001 | The system probes every enabled server every 5 minutes *(proposed)*. It records reachability, latency and the derived status (`active`, `degraded` or `unreachable`) per the FRD server state machine. | Should | CAP-10, WF-8 | C-HEALTH, LLD-SYNC | M5 | T |
| FR-OPS-002 | Source selection excludes sources on `unreachable` servers and deprioritizes those on `degraded` servers. | Should | CAP-10, BR-5 | LLD-SEL | M5 | T |
| FR-OPS-003 | Operators can view each server's sync status: last run and outcome, next scheduled run, and recent errors. | Must | CAP-13 | C-WEB, LLD-API | M2 | D, T |
| FR-OPS-004 | Operators can view each server's health status and recent probe history. | Should | CAP-10, CAP-13 | C-WEB, LLD-API | M5 | D |
| FR-OPS-005 | The system keeps an append-only audit log of operator actions: server, user, permission and curation changes. Operators can view it. | Should | CAP-13 | LLD-SCHEMA | M5 | T |
| FR-OPS-006 | An operator can export primary data as JSON: users, grants, progress, curation overrides, and server configuration without secrets. | Could | CAP-13 | LLD-API | M5 | T |
| FR-OPS-007 | `GET /api/v1/health` is public and returns only an overall status (`ok` or `degraded`). An operator-only endpoint returns detailed status, such as database connectivity. | Should | CAP-13 | C-API, LLD-API | M0 | T |
| FR-OPS-008 | Another operator can deploy their own Cinewren instance from a tagged release by following the self-host guide (Deploy to Cloudflare button or `wrangler`). First-run setup is completed through FR-USR-002. | Should | CAP-14 | TDD, ADR-0011 | M5 | D |

## 4. Interface requirements (IR)

| ID | Requirement | Pri | Design | MS | Verify |
|---|---|---|---|---|---|
| IR-001 | The platform API is JSON over HTTPS under `/api/v1`. Every response carries a request ID. Errors use one envelope (`LLD-API`). Breaking changes require a new version prefix. | Must | LLD-API | M0 | T |
| IR-002 | All origin interaction goes through the provider interface `MediaProvider` (`LLD-PROV`). No code outside the adapters depends on provider-specific types. | Must | ADR-0004, LLD-PROV | M1 | I, T |
| IR-003 | A Jellyfin adapter supports Jellyfin server versions 12.1 and later. Only these versions were tested in the T1.1 spike (docs/spikes/2026-provider-spike.md); older versions need a follow-up spike. | Must | LLD-PROV | M1 | T |
| IR-004 | An Emby adapter supports Emby server versions 4.10 and later. Only these versions were tested in the T1.1 spike. | Must | LLD-PROV | M4 | T |
| IR-005 | A Plex adapter supports Plex Media Server versions 1.43 and later. Only these versions were tested in the T1.1 spike. | Must | LLD-PROV | M4 | T |
| IR-006 | Authentication uses the W3C WebAuthn Level 2+ API in the browser. Server-side verification uses a vetted library (`TDD`), with the RP ID set to the deployment hostname. | Must | ADR-0014 | M0 | T |
| IR-007 | The web player uses HTML5 `<video>` for direct play. For HLS it uses native playback where available and Media Source Extensions (via `hls.js`) elsewhere. | Must | TDD, C-WEB | M3 | T |

## 5. Data requirements (DR)

| ID | Requirement | Pri | Design | MS | Verify |
|---|---|---|---|---|---|
| DR-001 | Cloudflare D1 is the system of record. **Primary data** is users, grants, progress, curation overrides, server configuration and the audit log. **Derived data** is the catalog, rebuildable from origins by a full sync. | Must | ADR-0006, LLD-SCHEMA | M0 | I |
| DR-002 | Origin credentials are encrypted at rest with AES-256-GCM, using a key held in a Worker secret. Each ciphertext records its key version, so keys can be rotated: an operator job re-encrypts every sealed row under the current key and a status endpoint reports when an old key is safe to remove (LLD-TOKEN "Rotation"). The operator keeps an offline copy of the key, as the setup guide requires. If the key is lost, credentials must be re-entered, but the catalog and primary data are unaffected. | Must | ADR-0008, LLD-TOKEN | M1 | T |
| DR-003 | Retention *(all proposed)*: missing sources are purged 30 days after being marked missing. Sync-run history is kept 90 days, playback-session records 30 days, health-probe history 7 days and the audit log 365 days. Progress is kept until the user is deleted, or until its item is purged under DR-005, whichever comes first. | Must | LLD-SYNC | M2, M5 | T |
| DR-004 | Schema changes use versioned, forward-only D1 migrations. Each migration stays compatible with the previously deployed Worker version (expand → migrate → contract). | Must | TDD, LLD-SCHEMA | M0 | I |
| DR-005 | Deletion cascades. Deleting a user removes their progress, playback sessions and grants, and anonymizes their audit-log references. Removing a server removes its credentials, libraries and sources. A canonical item is removed only when its last source is purged (DR-003 retention) or removed with its server. Its progress records and curation overrides are removed with it. Items whose sources are all `missing` are hidden, not deleted, so progress survives temporary absences. | Must | LLD-SCHEMA | M2 | T |

## 6. Nonfunctional requirements (NFR)

| ID | Requirement | Pri | Design | MS | Verify |
|---|---|---|---|---|---|
| NFR-SEC-001 | Origin credentials and service-account tokens never reach the browser, logs, error messages or exports. The only exception is the session-scoped stream credential under FR-PLAY-007. | Must | ADR-0008, ADR-0013 | M1 | T, I |
| NFR-SEC-002 | All authorization is enforced server-side. Each request that addresses a resource by ID checks the caller's access to that resource. Origins do not enforce library grants on stream or PlaybackInfo endpoints (verified T1.1), so Cinewren must enforce BR-1 before issuing any playback descriptor. | Must | C-AUTH | M0 | T |
| NFR-SEC-003 | The app is served over HTTPS only, with HSTS. A Content-Security-Policy limits `script-src` to self. `media-src` and `connect-src` are limited to self plus the registered origin hostnames, generated from server configuration. | Must | TDD, LLD-API | M3 | T |
| NFR-SEC-004 | Setup, invite-redemption and login endpoints are rate limited per client IP *(proposed: 10 requests/min)*. | Must | TDD, ADR-0014 | M0 | T |
| NFR-SEC-008 | Play, progress and operator mutation endpoints are rate limited per user *(proposed: 60 play requests/min, 600 mutations/min)*. | Should | TDD | M5 | T |
| NFR-SEC-005 | Outbound origin requests go only to the registered base URL's host. Redirects to other hosts are refused. | Must | LLD-PROV | M1 | T |
| NFR-SEC-006 | CI runs dependency vulnerability scanning and secret scanning on every PR. | Should | TDD | M0 | I |
| NFR-SEC-007 | Session IDs are random (≥ 128 bits), stored only as hashes, and sent in `HttpOnly; Secure; SameSite=Lax` cookies. Idle expiry is 14 days and absolute expiry 90 days *(proposed)*. State-changing requests are rejected unless the `Origin` header matches the app origin. Invite, re-enrollment and setup tokens are stored only as hashes. WebAuthn challenges are single-use with a short TTL. | Must | ADR-0014, LLD-TOKEN | M0 | T |
| NFR-PRIV-001 | Personal data is limited to display name, role, grants, passkey public-key metadata, and viewing progress and history. Cinewren collects no email address (ADR-0014). The app embeds no third-party analytics or trackers. | Must | TDD | M0 | I |
| NFR-PERF-001 | At the NFR-SCALE-001 envelope, catalog browse, search and detail API responses have p95 server time ≤ 300 ms *(proposed)*. | Should | LLD-SCHEMA | M5 | A |
| NFR-PERF-002 | A play request returns its descriptor within p95 ≤ 2 s *(proposed)*, including origin calls. | Should | LLD-SEL | M5 | A |
| NFR-PERF-003 | The initial route's JavaScript is ≤ 250 KB gzipped *(proposed)*. | Should | TDD | M2 | T |
| NFR-SCALE-001 | Design envelope *(proposed, per [ROADMAP](../ROADMAP.md) assumption A-1)*: ≤ 50 users, ≤ 20 servers, ≤ 200,000 source items and ≤ 20 concurrent playback sessions. Exceeding it may require design changes. | Must | HLD | M5 | A |
| NFR-REL-001 | Browse, search and detail keep working on last-synced data when any or all origins are unreachable. | Must | ADR-0006 | M2 | T |
| NFR-REL-002 | Sync and probe calls to origins retry transient failures with exponential backoff and jitter, up to a bounded number of attempts *(proposed: 5)*. | Must | LLD-SYNC | M2 | T |
| NFR-REL-003 | Primary data can be restored to any point in the D1 Time Travel window. Targets *(proposed)*: RPO ≤ 24 h, RTO ≤ 4 h. The restore procedure is documented and rehearsed once before v1.0. | Should | TDD | M5 | D |
| NFR-COST-001 | No media stream bytes pass through Cloudflare. At the design envelope, Cloudflare spend stays within the Workers Paid base fee plus small usage *(proposed target: ≤ US$10/month)*. | Should | ADR-0002 | M5 | A |
| NFR-COMP-001 | The deployment complies with Cloudflare's service-specific terms on video delivery. No video is served through proxied (orange-cloud) hostnames or Tunnel public hostnames on Free, Pro or Business plans. | Must | ADR-0002 | M3 | I |
| NFR-A11Y-001 | The web UI meets WCAG 2.2 AA *(proposed target)*. The player is fully keyboard operable and supports captions. | Should | TDD | M5 | A, T |
| NFR-UX-001 | The web UI provides dark and light themes. It follows `prefers-color-scheme` by default and offers a per-user override. Both themes are built from one token set ([UX](../design/UX.md)) and each meets NFR-A11Y-001 contrast independently. | Must | [UX](../design/UX.md) | M2 | T, A |
| NFR-COMPAT-001 | Supported clients *(proposed)* are the latest two major versions of Chrome, Edge, Firefox and Safari, on desktop and mobile. | Must | TDD | M3 | T |
| NFR-OBS-001 | Logs are structured JSON with request ID, user ID (never display name) and route. They contain no secrets. Sync runs, play decisions and errors are logged. | Must | TDD | M0 | I, T |
| NFR-OBS-002 | Operational metrics are queryable: sync duration and error counts per server, play-request outcomes and the selection-mode distribution. | Should | TDD | M5 | D |
| NFR-MAINT-001 | Code is TypeScript in strict mode. Provider adapters are isolated behind IR-002, and each has a contract-test suite run against recorded fixtures. | Must | TDD | M1 | I, T |
| NFR-MAINT-002 | Documentation and roadmap status are updated in the same change as the behaviour they describe (see [AGENTS.md](../../AGENTS.md)). | Must | — | M0 | I |
| NFR-MAINT-003 | Releases are versioned (SemVer) with release notes. Upgrading a self-hosted instance to a newer release applies its pending D1 migrations safely, following DR-004 and the upgrade steps in the self-host guide. | Should | TDD | M5 | T, D |
| NFR-TEST-001 | CI runs on every PR: typecheck, lint, unit, Workers-runtime integration and provider contract tests, documentation checks, and (from M2) end-to-end browser tests against mock origins. | Must | TDD | M0 | I |

## 7. Coverage notes

- **Out of scope by design:** native, TV and mobile apps; music, photos and live TV; offline downloads; multi-tenant hosting; hiding origin hostnames from viewers; writing watch state back to origins. These are deferred in [PRD §6](PRD.md#6-non-goals-and-deferred-capabilities), so no requirements exist for them.
- **No compliance regime** (GDPR, COPPA, accessibility law and the like) has been identified as binding on this personal or household deployment ([ROADMAP assumption A-7](../ROADMAP.md#3-constraints-assumptions-decisions-and-open-questions)). NFR-PRIV-001 and DR-005 are conservative defaults, not legal compliance claims.
- **Requirements whose final form depends on the M1 provider spike:** FR-PLAY-007, FR-PLAY-009 and IR-003 to IR-005. The spike is resolved by [docs/spikes/2026-provider-spike.md](../spikes/2026-provider-spike.md) for Jellyfin and Emby; Plex items remain open pending the managed-user spike. Changes are recorded in [ADR-0013](../adr/0013-session-scoped-origin-stream-credentials.md).

## 8. Must-requirement coverage by milestone

| Milestone | Must requirements delivered |
|---|---|
| M0 | FR-USR-001, FR-USR-002, FR-USR-003, FR-USR-004, FR-USR-006, IR-001, IR-006, NFR-SEC-004, NFR-SEC-007, DR-001, DR-004, NFR-SEC-002, NFR-PRIV-001, NFR-OBS-001, NFR-MAINT-002, NFR-TEST-001 |
| M1 | FR-SRV-001, FR-SRV-002, FR-SRV-003, FR-SRV-007, IR-002, IR-003, DR-002, NFR-SEC-001, NFR-SEC-005, NFR-MAINT-001 |
| M2 | FR-SRV-004, FR-SYNC-001 to FR-SYNC-007, FR-CAT-001, FR-CAT-002, FR-CAT-004, FR-CAT-005, FR-CAT-006, FR-CAT-009, FR-CAT-011, FR-CAT-012, FR-SYNC-008, FR-USR-005, FR-USR-008, NFR-UX-001, FR-OPS-003, DR-003 (catalog retention), DR-005, NFR-REL-001, NFR-REL-002 |
| M3 | FR-PLAY-001, FR-PLAY-002, FR-PLAY-003, FR-PLAY-006, FR-PLAY-007, FR-PLAY-008, FR-PROG-001, FR-PROG-002, FR-PROG-003, IR-007, NFR-SEC-003, NFR-COMP-001, NFR-COMPAT-001 |
| M4 | IR-004, IR-005 (Emby and Plex parity for every Must above that touches providers) |
| M5 | DR-003 (operational retention), NFR-SCALE-001 (verified by analysis); v1.0 release gate re-verifies all Musts |
