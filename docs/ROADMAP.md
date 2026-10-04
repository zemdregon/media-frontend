# Cinewren — Roadmap (canonical delivery plan)

| | |
|---|---|
| **Status** | Draft v0.1 (2026-10-04). Written by an agent under delegation. The project owner has not reviewed it. |
| **Authority** | **This is the canonical source** for scope boundaries, priorities, dependencies, sequencing, milestone status and completion criteria. Detailed content lives in the linked documents, and this file links to them rather than copying them. |
| **Update rule** | Every change that completes, starts, blocks or re-scopes work updates the milestone status here in the same commit (see [AGENTS.md](../AGENTS.md)). |

## 1. Product summary

**Cinewren** is a self-hosted, federated media frontend. An operator deploys it to their own Cloudflare account. It merges the movie and TV libraries of several Jellyfin, Emby and Plex servers into **one deduplicated catalog**. For example, it shows a title once as "Interstellar (2014) · 4K HDR · 1080p · Available from 3 servers". When a viewer presses play, Cinewren picks the best copy and sends the browser **directly to that server**. Cloudflare handles everything up to the moment playback begins. Video bytes never pass through it.

- **Users:** an operator (P-1) and the household or friends they invite (P-2). See [PRD](requirements/PRD.md).
- **Outcomes:** BO-1 to BO-5 in the [BRD](requirements/BRD.md): one library, low cost, best available playback, backend-agnostic design, safe operation.
- **Non-goals (v1):** native or TV apps, multi-tenant hosting, hiding origin hostnames, music, photos and live TV, transcoding or storing media in Cloudflare, and others. The full list with revisit triggers is in [PRD §6](requirements/PRD.md#6-non-goals-and-deferred-capabilities).

## 2. Current state and target state

| | Current state (evidence: repository on 2026-10-04) | Target state (v1.0, end of M5) |
|---|---|---|
| Code | None. The repository had no commits, source, tests or configuration before this documentation commit. | A single Cloudflare Worker serving the SPA and API, with D1, Queues and cron handlers, and Jellyfin, Emby and Plex adapters. |
| Docs | Only the owner-provided concept ([sources](sources/2026-10-04-initial-architecture-concept.md)) existed, outside the repo. | This document set, kept in sync with the code. |
| Infra | None provisioned by this work. No production infrastructure was touched. | Staging and production Workers, each with its own D1 database and Access application. |

**Audit finding:** no roadmap or plan existed in the repository, authoritative or fragmented. The only planning input was a single concept document. This roadmap is therefore newly derived from that document, the owner's instructions and the 2026-10-04 product name. It does not replace any earlier plan.

## 3. Constraints, assumptions, decisions and open questions

**Provenance labels:**
- **Owner direction** means the owner supplied it on 2026-10-04: the concept document, the name *Cinewren* and the agent-routing policy in AGENTS.md.
- **Agent decision** means a decision made under delegation, not yet reviewed by the owner. Supplying the concept does not mean the owner approved every derived detail.

### Constraints (owner direction)
- **C-1:** Cloudflare (Workers with Static Assets, and D1) hosts the UI, the API, the catalog and the auth control plane.
- **C-2:** Media bytes never transit Cloudflare. This is also required by Cloudflare's terms for Free, Pro and Business plans, including Tunnel public hostnames ([ADR-0002](adr/0002-cloudflare-control-plane-origins-deliver-media.md)).
- **C-3:** Media stays on the origins. No media is stored in R2.
- **C-4:** The supported origins are Jellyfin, Emby and Plex.
- **C-5:** The client talks only to the Cinewren API. Provider types are an implementation detail ([ADR-0004](adr/0004-provider-adapter-abstraction.md)).
- **C-6:** Agent workflow follows [AGENTS.md](../AGENTS.md).

### Assumptions (agent decisions; revisit if wrong)
| ID | Assumption | If wrong |
|---|---|---|
| A-1 | Single-operator deployment for a small invited group (envelope NFR-SCALE-001) | Multi-tenancy redesign. [ADR-0011](adr/0011-single-operator-deployment-model.md) would be superseded. |
| A-2 | The operator can create a non-admin service account on each origin | [ADR-0008](adr/0008-origin-service-accounts-and-credential-encryption.md) needs revisiting. |
| A-3 | Browsers reach origins over HTTPS on non-Cloudflare-proxied hostnames | Media gateway (DEF-1) or Cloudflare Stream would be needed. Major change. |
| A-4 | Workers reach origin APIs over public HTTPS | Private connectivity (Q-5) is needed. |
| A-5 | Workers Paid plan | Free-plan limits (10 ms CPU, 50 subrequests) make sync infeasible. |
| A-6 | Web browser is the only v1 client | — |
| A-7 | Personal or household use of media the operator is entitled to. No binding regulatory regime is identified. | A legal review would be needed before wider use. |
| A-8 | English-only UI | — |
| A-9 | Origins expose TMDB, IMDb or TVDB IDs for most items | Matching quality drops. TMDB enrichment (DEF-9) would be reconsidered. |

### Material decisions
13 ADRs are indexed in [adr/README.md](adr/README.md). ADR-0002 records owner direction. The others are agent decisions. **ADR-0013 (session-scoped stream credentials) is `Proposed`** until the M1 spike confirms it.

### Open questions (none block M0)
| ID | Question | Blocks | Default until answered |
|---|---|---|---|
| Q-1 | Will Cinewren ever be hosted for multiple operators? | Nothing in v1 | No ([ADR-0011](adr/0011-single-operator-deployment-model.md)) |
| Q-2 | Must origin hostnames be hidden from viewers? | Nothing in v1 | No ([ADR-0003](adr/0003-direct-to-origin-playback.md)) |
| Q-3 | Plex API terms and the token model for third-party clients | M4 Plex task | Resolved by the T1.1 spike |
| Q-5 | Should private-network-only origins be supported? | Nothing in v1 | Unsupported (DEF-10) |
| Q-6 | Minimum provider versions | M1 / M4 adapters | Fixed by the T1.1 spike |
| ~~Q-4~~ | Product name | — | **Resolved 2026-10-04 by the owner: Cinewren** |

### Conflicts found and how they were resolved
| Conflict | Resolution |
|---|---|
| The concept says Workers *can* stream multi-GB responses, and also that Cloudflare terms restrict video delivery. | The terms win. They were checked on 2026-10-04 and also cover Tunnel public hostnames. See ADR-0002 and NFR-COMP-001. |
| The concept suggests "Cloudflare Tunnel" as a way to expose origins. | Tunnel *public hostnames* fall under the same video restriction, so they are rejected for media. Private Tunnel routes are deferred (Q-5). See [HLD](design/HLD.md). |
| The concept lists Option A (direct) and Option B (gateway). | Option A was selected and Option B deferred ([ADR-0003](adr/0003-direct-to-origin-playback.md)). |
| The concept puts the server token in the playback URL (`?token=...`). Passing the long-lived server token to browsers would violate BR-6. | Session-scoped credentials ([ADR-0013](adr/0013-session-scoped-origin-stream-credentials.md), Proposed). |
| The owner's routing text said `agents.md`. The task brief defaults to `AGENTS.md` when neither exists. | Neither file existed, so `AGENTS.md` was created, which is the conventional casing. No case-variant duplicate exists. |

## 4. Documentation map

| Path | Purpose | Authoritative for | Status |
|---|---|---|---|
| [AGENTS.md](../AGENTS.md) | Agent operating rules and model routing | How agents work in this repository | Current |
| [CLAUDE.md](../CLAUDE.md) | Claude Code entry point. It imports AGENTS.md. | Nothing; it only points to AGENTS.md | Current |
| **docs/ROADMAP.md** (this file) | Delivery plan | Scope boundaries, priority, sequence, status, completion criteria | Draft v0.1 |
| [requirements/BRD.md](requirements/BRD.md) | Business Requirements | Business problem, outcomes BO-*, stakeholders, business constraints, success measures | Draft v0.1 |
| [requirements/PRD.md](requirements/PRD.md) | Product Requirements | Personas P-*, capabilities CAP-*, journeys J-*, UX principles, non-goals DEF-* | Draft v0.1 |
| [requirements/FRD.md](requirements/FRD.md) | Functional Requirements | Workflows WF-*, **business rules BR-***, permission matrix, state machines, validation | Draft v0.1 |
| [requirements/SRS.md](requirements/SRS.md) | Software Requirements Specification | **Every FR, IR, DR and NFR requirement and the requirement trace matrix** | Draft v0.1 |
| [design/HLD.md](design/HLD.md) | High-Level Design | Components C-*, trust boundaries TB-*, data flows DF-*, deployment topology, threat model | Draft v0.1 |
| [design/SDD.md](design/SDD.md) | Software Design Document | Subsystem collaboration, module layout, shared patterns, requirement→design satisfaction | Draft v0.1 |
| [design/TDD.md](design/TDD.md) | Technical Design Document | Stack, tooling, config, testing, CI/CD, release, rollback, backup, cross-cutting technical choices | Draft v0.1 |
| [design/LLD.md](design/LLD.md) | Low-Level Design | Schema, API contracts, provider interface, algorithms, credential lifecycle, error handling (sections LLD-*) | Draft v0.1 |
| [adr/](adr/README.md) | Architecture Decision Records | Individual architectural decisions and their supersession | ADR-0001 to ADR-0012 Accepted, ADR-0013 Proposed |
| [sources/2026-10-04-initial-architecture-concept.md](sources/2026-10-04-initial-architecture-concept.md) | Archived owner-provided concept | Nothing. Historical input only. | Historical |

**Traceability chain:** BO (BRD) → CAP / J (PRD) → WF / BR (FRD) → FR / NFR (SRS: its `Design` and `MS` columns) → C / LLD / ADR (design) → milestone task (this file) → verification (the SRS `Verify` column plus each milestone's exit checks below). The SDD holds the requirement→design satisfaction table.

## 5. Status legend and overview

`Done` · `In progress` · `Partial` · `Planned` · `Blocked` · `Deferred`. A status other than `Planned` must cite evidence: a commit, PR, test name or file path.

| Milestone | Goal | Depends on | Status |
|---|---|---|---|
| M0 | Foundations: scaffold, CI, auth, schema v1, staging | — | Planned (docs portion `Done`: this commit) |
| M1 | Provider spike, Jellyfin adapter, server registration | M0 | Planned |
| M2 | Catalog: sync, matching, browse/search/detail, users and grants | M1 | Planned |
| M3 | Playback on Jellyfin: selection, session credentials, player, progress | M2 | Planned |
| M4 | Emby and Plex adapters at parity | M3 (M4 can start after M1 for adapter-only work) | Planned |
| M5 | Hardening and v1.0 release gate | M3, M4 | Planned |
| Later | DEF-1 to DEF-11 | v1.0 and the triggers in PRD §6 | Deferred |

```mermaid
flowchart LR
  M0[M0 Foundations] --> M1[M1 Spike + Jellyfin + registration]
  M1 --> M2[M2 Catalog]
  M2 --> M3[M3 Playback]
  M1 -. adapter work .-> M4[M4 Emby + Plex]
  M3 --> M4
  M3 --> M5[M5 Hardening / v1.0]
  M4 --> M5
```

No dates are committed. The owner has not set any, and no staffing is known.

## 6. Milestones

Every milestone exit requires three things: CI green on `main`, docs and this file updated, and every listed SRS ID passing its `Verify` method. The checks below are **planned verification**. No test exists yet.

### M0 — Foundations · Planned

**Objective:** a deployable, empty-but-secure Cinewren skeleton with the engineering workflow in place.
**Must requirements:** see [SRS §8](requirements/SRS.md#8-must-requirement-coverage-by-milestone), M0 row. **Should:** FR-OPS-007, NFR-SEC-006.

| Task | Objective | Refs | Depends | Done when |
|---|---|---|---|---|
| T0.1 | Scaffold the repository: pnpm, TypeScript strict, Vite + React SPA, Hono Worker with Static Assets, `wrangler` config for `local` / `staging` / `production`, ESLint and Prettier | ADR-0005, [TDD](design/TDD.md), [SDD](design/SDD.md) (module layout) | — | `pnpm build` and `pnpm typecheck` pass. `wrangler dev` serves the SPA shell at `/` and `/api/v1/health` responds locally. |
| T0.2 | CI workflow: install, typecheck, lint, unit and Workers integration tests (Vitest pool-workers), docs check, dependency audit, secret scanning | NFR-TEST-001, NFR-SEC-006, [TDD](design/TDD.md) | T0.1 | A PR shows all jobs. A deliberately broken link or type error fails CI. |
| T0.3 | Docs check script (`scripts/check-docs.mjs`): relative links resolve, IDs referenced are defined, LLD section IDs exist | NFR-MAINT-002 | — | **Done** in this commit. It runs locally (see §9). CI wiring is part of T0.2. |
| T0.4 | D1 schema v1 migration covering the M0 to M2 tables, with the migration runner in local and CI | DR-001, DR-004, [LLD-SCHEMA](design/LLD.md) | T0.1 | Migrations apply to an empty local D1. An integration test asserts the tables, indexes and FK cascades. |
| T0.5 | Access JWT middleware, user bootstrap from `BOOTSTRAP_OPERATOR_EMAILS`, role guard | FR-USR-001 to FR-USR-003, IR-006, NFR-SEC-002, ADR-0007 | T0.4 | Tests: missing or invalid or expired JWT → 401; valid non-invited user → 403; bootstrap operator created; viewer → 403 on an operator route. |
| T0.6 | API conventions: request ID, error envelope, structured logger, security headers baseline, health endpoint | IR-001, NFR-OBS-001, NFR-PRIV-001, FR-OPS-007 | T0.1 | Tests assert the envelope shape, the `x-request-id` header, that no email appears in log lines, and that health returns DB status. |
| T0.7 | Staging environment: Worker, D1 and Access application. Documented in an operator setup guide (`docs/operations/setup.md`, to be created in this task). | A-5, [HLD](design/HLD.md) deployment | T0.5, T0.6 | **Demonstration:** an invited identity loads the staging SPA through Access, and an uninvited one gets 403. *Prerequisite (owner action): a Cloudflare account on Workers Paid with an Access team.* |

**M0 exit:** T0.1 to T0.7 done. M0 Must IDs verified. ADR-0006's FTS5 assumption confirmed or replaced on D1 (spike within T0.4).

### M1 — Provider spike, Jellyfin adapter, server registration · Planned

**Objective:** settle the provider facts the design rests on, then register a real Jellyfin server.

| Task | Objective | Refs | Depends | Done when |
|---|---|---|---|---|
| T1.1 | **Provider spike** (Jellyfin, Emby, Plex) against real or containerized servers. Determine: auth for a non-admin service account; library listing and incremental "changed since" support; external IDs; playback negotiation (direct play or HLS URLs); whether a **per-session revocable stream credential** can be minted; CORS behaviour on stream, HLS and subtitle URLs; start/progress/stop reporting; minimum versions. | ADR-0013, Q-3, Q-6, IR-003 to IR-005, [LLD-PROV](design/LLD.md) | M0 | Spike report saved at `docs/spikes/2026-provider-spike.md`. ADR-0013 moved to Accepted or superseded. IR-003 to IR-005 version minimums and any FR-PLAY-007 / FR-PLAY-009 changes made in the SRS. LLD-PROV notes marked verified or corrected. |
| T1.2 | `MediaProvider` interface, normalized types, recorded-fixture contract test harness | IR-002, NFR-MAINT-001, ADR-0004 | T1.1 | The harness runs one shared contract suite per adapter against fixtures. |
| T1.3 | Credential vault (AES-256-GCM, versioned keys) | DR-002, NFR-SEC-001, ADR-0008, [LLD-TOKEN](design/LLD.md) | M0 | Tests: round-trip; wrong key fails; key rotation re-encrypts; ciphertext never appears in API responses or logs. |
| T1.4 | Jellyfin adapter: validate, list libraries, list items (paged), get item | IR-003, FR-SRV-002, NFR-SEC-005 | T1.2 | Contract suite green on fixtures. Redirects off-host refused (test). |
| T1.5 | Server registration API and minimal operator UI: register, validate, enable libraries, https enforcement | FR-SRV-001 to FR-SRV-003, FR-SRV-007, WF-1 | T1.3, T1.4 | Tests for each WF-1 failure path. **Demonstration:** a real Jellyfin server registered on staging with its libraries listed. |

**M1 exit:** all M1 Must IDs verified. The spike report is merged. No `(to verify in M1 spike)` marker remains for Jellyfin, and the Emby and Plex markers are either resolved or explicitly carried into M4.

### M2 — Federated catalog · Planned

**Objective:** viewers see one deduplicated, permission-filtered catalog from synced servers.

| Task | Objective | Refs | Depends |
|---|---|---|---|
| T2.1 | Sync orchestrator: cron → Queue → consumer; checkpointed paging; per-server lock; run records | FR-SYNC-001, FR-SYNC-002, FR-SYNC-004, FR-SYNC-006, FR-SYNC-007, NFR-REL-002, ADR-0009, [LLD-SYNC](design/LLD.md) | M1 |
| T2.2 | Normalization and upsert; missing marking; retention purge | FR-SYNC-003, FR-SYNC-005, DR-003, BR-4 | T2.1 |
| T2.3 | Matching (external IDs, episode alignment, conflict flags) | FR-CAT-001, BR-2, ADR-0010, [LLD-MATCH](design/LLD.md) | T2.2 |
| T2.4 | Catalog query layer with central BR-1 filtering; browse, filters, search (FTS5), detail, home "Recently added" | FR-CAT-002 to FR-CAT-006, FR-CAT-008, NFR-REL-001 | T2.3 |
| T2.5 | Artwork proxy with edge cache | FR-CAT-009, ADR-0012 | T2.4 |
| T2.6 | Users and grants: invite, disable, delete with cascades; library grants; server disable and removal | FR-USR-004, FR-USR-005, FR-SRV-004, DR-005, BR-8 | T2.4 |
| T2.7 | Web UI: home, browse, search, detail (versions badge, "Available from N servers"), operator sync-status page | FR-OPS-003, NFR-PERF-003, [PRD](requirements/PRD.md) J-2 | T2.4–T2.6 |
| T2.8 | E2E harness: Playwright against `wrangler dev` with a mock origin | NFR-TEST-001 | T2.7 |

**M2 exit checks:**
- (a) The integration test "same movie on two mock servers yields one item with two sources" passes.
- (b) A viewer without a grant can't reach a restricted item by ID. Detail, artwork and search all return 404, verified by an IDOR test.
- (c) A killed sync mid-run, when retried, leaves no duplicates.
- (d) Browse works with all mock origins offline.
- (e) **Demonstration:** a staging catalog from a real Jellyfin server.

### M3 — Playback (Jellyfin) · Planned

**Objective:** press play, start the best Jellyfin source directly from the origin, and resume later.

| Task | Objective | Refs | Depends |
|---|---|---|---|
| T3.1 | Device capability detection in the client | FR-PLAY-002, NFR-COMPAT-001 | M2 |
| T3.2 | Source selection (BR-5) with a fixture-driven test table, including the Interstellar example | FR-PLAY-003, FR-SRV-006, [LLD-SEL](design/LLD.md) | M2 |
| T3.3 | Playback sessions and session-scoped stream credentials (per the T1.1 outcome); expiry and revocation job | FR-PLAY-001, FR-PLAY-007, BR-9, ADR-0013, [LLD-TOKEN](design/LLD.md) | T1.1, T3.2 |
| T3.4 | Player: direct play and HLS (hls.js / native), audio and subtitle selection, manual version choice, dynamic CSP | FR-PLAY-005, FR-PLAY-006, FR-PLAY-008, IR-007, NFR-SEC-003 | T3.3 |
| T3.5 | Progress, resume, watched state, next episode, "Continue watching"; start/stop reporting to the origin | FR-PROG-001 to FR-PROG-004, FR-PLAY-009, FR-CAT-008, BR-7 | T3.4 |
| T3.6 | Compliance check: the operator setup guide documents non-proxied origin hostnames; a test asserts every descriptor URL host equals a registered origin host | NFR-COMP-001, FR-PLAY-008 | T3.4 |

**M3 exit checks:**
- (a) An E2E test against the mock origin plays, pauses, reloads and resumes.
- (b) A test shows a stream credential is rejected by the mock origin after session end or expiry.
- (c) **Demonstration:** on staging, a real Jellyfin title plays in current Chrome, Firefox and Safari. Browser devtools show media requests going only to the origin host.
- (d) All M3 Must IDs verified.

### M4 — Emby and Plex parity · Planned

| Task | Objective | Refs | Depends |
|---|---|---|---|
| T4.1 | Emby adapter (likely close to Jellyfin; confirm in T1.1) | IR-004 | T1.2, T3.3 |
| T4.2 | Plex adapter, including Q-3 terms check | IR-005, Q-3 | T1.2, T3.3 |
| T4.3 | Cross-provider matching test: one title on all three types merges into one item | FR-CAT-001 | T4.1, T4.2 |

**M4 exit:** the shared contract suite is green for all three adapters. **Demonstration:** one title present on Jellyfin, Emby and Plex shows as one item and plays from each source via manual override.

### M5 — Hardening and v1.0 · Planned (high level)

Scope: health probing and failover (FR-OPS-001, FR-OPS-002, FR-OPS-004, FR-PLAY-004); curation merge/split and the conflict list (FR-CAT-007, FR-CAT-010); credential rotation (FR-SRV-005); audit log (FR-OPS-005); export (FR-OPS-006); rate limits (NFR-SEC-004); operational retention (DR-003); metrics (NFR-OBS-002); accessibility audit (NFR-A11Y-001); performance and cost analysis at the envelope (NFR-PERF-001, NFR-PERF-002, NFR-SCALE-001, NFR-COST-001); restore rehearsal (NFR-REL-003); a security review against the [HLD](design/HLD.md) threat model.

**v1.0 exit:** every `Must` in the SRS is verified with evidence. Any `Should` not done has a recorded decision here. The security review has no open high findings. A production deploy and rollback have been rehearsed.

### Later — Deferred
DEF-1 to DEF-11 per [PRD §6](requirements/PRD.md#6-non-goals-and-deferred-capabilities). Each needs its revisit trigger met and, where it is architectural (DEF-1, DEF-3, DEF-10), a new ADR.

## 7. Risks and blockers

| ID | Risk | Impact | Mitigation / trigger |
|---|---|---|---|
| R-1 | A provider can't mint a session-scoped, revocable, non-admin stream credential | BR-6 weakened, or a gateway (DEF-1) is needed | T1.1 spike first. The fallback is in ADR-0013. |
| R-2 | Origins not reachable by browsers on non-proxied HTTPS (home NAT, CGNAT) | Playback impossible for that origin | A setup-guide prerequisite (A-3). Revisit DEF-1 or Q-5 if common. |
| R-3 | Missing CORS headers on origin HLS or subtitle responses | HLS via MSE or subtitles fail in some browsers | Verified in T1.1. The operator reverse-proxy recipe goes in the setup guide. |
| R-4 | Plex API terms or stability for third-party clients | Plex adapter delayed or dropped | Q-3 is checked in T1.1 and T4.2. Plex is the last adapter. |
| R-5 | Cloudflare terms or limit changes | Architecture assumptions break | Facts re-checked at each milestone exit, with dates noted in ADR-0002. |
| R-6 | Poor external-ID coverage on origins | Duplicate items | Manual curation (FR-CAT-007). DEF-9 enrichment can be reconsidered. |
| R-7 | D1 FTS5 is unavailable or limited | Search design changes | Checked in T0.4. The fallback is in ADR-0006. |
| B-1 | **Owner action:** a Cloudflare account on Workers Paid with an Access team, needed for staging deploys | Blocks T0.7 and every later *demonstration*. Local development is not blocked. | Owner provides it before T0.7. |
| B-2 | **Owner action:** access to at least one Jellyfin test server (or approval to use containerized test servers) | Blocks the T1.1 real-server checks | Containerized Jellyfin and Emby are acceptable. Plex may need a Plex account. |

## 8. Next actionable milestone

**M0 — Foundations.** Start with T0.1, then T0.2 and T0.4 in parallel.
- **Prerequisites:** none for local work. B-1 is needed only for T0.7.
- **Verification:** the M0 exit criteria above. Every M0 Must ID in [SRS §8](requirements/SRS.md#8-must-requirement-coverage-by-milestone) passes its Verify method, CI is green on `main`, and the staging demonstration (T0.7) is recorded in this file with a link.

## 9. Change log

| Date | Change | By |
|---|---|---|
| 2026-10-04 | Initial roadmap and document set derived from the owner-provided concept. Product named Cinewren (owner). T0.3 docs check script added and run. | Agent under delegation |
