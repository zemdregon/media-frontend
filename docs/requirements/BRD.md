# Cinewren — BRD (Business Requirements Document)

| | |
|---|---|
| **Status** | Draft v0.1 (2026-10-04). Agent-authored under delegation; not owner-reviewed. Nothing described here is implemented. Updated 2026-10-04 for owner decisions (ADR-0014, self-hosting). Updated 2026-10-04 for owner decisions Q-7/Q-8. |
| **Owns** | Business problem, desired outcomes (BO-n) and proposed success measures, stakeholders, business constraints (C-n), cost and legal context, value proposition, business-level risks, outcome-to-capability trace. |
| **Does not own** | Capabilities, personas and journeys ([PRD](PRD.md)); workflows and business rules ([FRD](FRD.md)); verifiable requirements ([SRS](SRS.md)); architecture ([HLD](../design/HLD.md)); sequencing ([ROADMAP](../ROADMAP.md)). |

## 1. Provenance

| Label | Meaning in this document |
|---|---|
| **Owner direction (2026-10-04)** | The product name Cinewren; the [concept document](../sources/2026-10-04-initial-architecture-concept.md) (Cloudflare as UI, catalog and control plane; Plex, Jellyfin and Emby as media origins; a federated deduplicated library; a provider interface; a recommendation of direct streaming); the agent-routing policy in [AGENTS.md](../../AGENTS.md). The owner supplied the concept and asked for a plan. That is not approval of every detail below. |
| **Owner decision (2026-10-04)** | Passkey-only sign-in with operator invite links, with no external identity provider or edge access product ([ADR-0014](../adr/0014-passkey-auth-with-invite-links.md)); other operators may self-host while each deployment keeps one operator; viewers seeing origin hostnames is acceptable ([ADR-0003](../adr/0003-direct-to-origin-playback.md)), with origins on public HTTPS. |
| **Agent decision (delegated, 2026-10-04; not yet owner-reviewed)** | Everything else, including all outcome measures and targets. |
| **Assumption (A-n)** / **Open question (Q-n)** / *(proposed)* | Recorded in the [ROADMAP](../ROADMAP.md#3-constraints-assumptions-decisions-and-open-questions); the ones this document relies on are repeated in sections 5 and 7. |

## 2. Business problem

People who run more than one media server (for example a household Jellyfin server plus a friend's Plex server and an older Emby install) have no single place to browse and play everything they can reach. Each product's native client generally shows only its own ecosystem. The same film may exist on several servers in different qualities, and the viewer has to know which server holds which copy, which copy their device can play without transcoding, and which server is currently up.

The owner's concept is a federated front end: one catalog of titles, one sign-in, and a playback button that picks the best copy automatically. The concept also fixes the shape of the solution. Cloudflare hosts the application and the catalog. The existing servers keep storing, transcoding and delivering the media.

Not a business problem for v1: hosting content, replacing the origin servers, or serving the public. Cinewren is for one operator and a small invited group.

## 3. Desired outcomes

Measures are **Proposed targets** chosen by the agent. They have no owner sign-off and no baseline, and they are meant to be revised once real data exists. Measurement windows are tied to [ROADMAP](../ROADMAP.md) milestones, not dates.

| ID | Outcome | Proposed success measure | How it would be measured |
|---|---|---|---|
| BO-1 | **Unified library.** A viewer finds any title across all registered servers in one place without knowing which server holds it. | At least 95% of titles that share a strong external ID across servers appear as one item on a sample audit (per BR-2). Zero titles visible to a user that exist only in libraries that user was not granted (BR-1). | Audit of a sampled set against known duplicates in the M2 test data; automated permission tests. |
| BO-2 | **Low cost, lightweight operations.** The Cloudflare side is cheap and serverless, and no media passes through Cloudflare. | Monthly Cloudflare spend within NFR-COST-001. No video bytes through Workers, the CDN or Tunnel public hostnames (NFR-COMP-001, FR-PLAY-008). | Billing review and analysis at M5; configuration inspection. |
| BO-3 | **Best available playback.** The system picks the best playable copy automatically, minimizing needless transcoding and failed starts. | At least 90% of play attempts start on the first selected source in the M5 test window. The share of direct play versus transcode is reported (NFR-OBS-002). | Play-request outcome metrics during the M5 test window. |
| BO-4 | **Backend-agnostic.** A new origin type can be added without client changes. | A fourth adapter needs no change to client code or to anything outside the adapter layer (IR-002). | Design review and contract-test suite (NFR-MAINT-001). |
| BO-5 | **Safe operation.** Origin credentials are protected and the deployment complies with provider and platform terms. | Zero origin credentials in browser payloads, logs or exports (NFR-SEC-001). Compliance with Cloudflare's video terms confirmed by inspection (NFR-COMP-001). | Automated leak tests; security review at M5. |

## 4. Stakeholders

| Stakeholder | Interest | Influence in v1 |
|---|---|---|
| **Operator** (persona P-1) | Deploys Cinewren to their own Cloudflare account, registers servers, invites viewers, bears cost and content responsibility. | Decides what is registered and who gets access. |
| **Self-hosting operators** | Other people who deploy their own Cinewren from a release, each as the single operator of their own deployment (CAP-14). They want setup with no extra services beyond Cloudflare, and safe upgrades. | Not part of this deployment. They shape packaging and upgrade requirements and are the reason for BO-4 (backend-agnostic, reusable) and BO-5 (safe operation, including credential protection and a passkey-only sign-in). Owner decision (2026-10-04). |
| **Viewers** (persona P-2) | Find and play titles with minimal friction. Not technical. | Invited by the operator; no administrative rights. |
| **Origin server owners** | Their servers receive Cinewren's sync and playback traffic and their service account. | In v1 the origin owner is the operator (assumption A-2). A third-party owner would need consent and clear terms, which v1 does not provide for. |
| **Project owner** | Supplied the concept and the product name; accepts or changes the plan. | Has not yet reviewed this documentation set. |
| **Engineering agents** | Implement and document under the routing policy in [AGENTS.md](../../AGENTS.md) (constraint C-6). | Work from these documents; report conflicts instead of silently resolving them. |

Cloudflare and the media-server vendors are external parties whose terms and APIs constrain the design (sections 5 and 7). They are not stakeholders with any say in v1.

## 5. Business constraints, cost and legal context

| ID | Constraint | Provenance |
|---|---|---|
| C-1 | Cloudflare hosts the web app, API, catalog index and authentication (Workers with Static Assets, D1). Sign-in is passkey-only, with accounts created only from operator invite links ([ADR-0014](../adr/0014-passkey-auth-with-invite-links.md), Owner decision 2026-10-04). | Owner direction (2026-10-04) |
| C-2 | Media bytes never transit Cloudflare (Workers, CDN, or Tunnel public hostnames). | Owner direction (2026-10-04), supported by the Cloudflare video-delivery terms (see below) |
| C-3 | Media files stay on the origin servers. Nothing is stored in R2. | Owner direction (2026-10-04) |
| C-4 | Supported origin types are Jellyfin, Emby and Plex. | Owner direction (2026-10-04) |
| C-5 | The client talks only to the Cinewren API. Provider types are an implementation detail. | Owner direction (2026-10-04) |
| C-6 | The agent workflow is governed by [AGENTS.md](../../AGENTS.md). | Owner direction (2026-10-04) |

**Cost context (A-5).** Agent decision: the operator is assumed to be on the Workers Paid plan. Cloudflare's published Free-plan limits (checked 2026-10-04) are 10 ms CPU and 50 external subrequests per invocation, which are too small for catalog sync ([limits](https://developers.cloudflare.com/workers/platform/limits/)). The Paid plan raises these substantially, and the proposed ceiling for Cloudflare spend is in NFR-COST-001. Per-database size limits for D1 are documented at [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) and are not restated here. The operator also bears the cost of the origin servers and their network egress, which Cinewren does not change.

**Legal and terms context (A-7).** Cloudflare's service-specific terms for the Free, Pro and Business plans prohibit serving video or disproportionately large files through proxied traffic unless a paid video product is used. This also applies to Tunnel public-hostname routes and not to Tunnel private-network routes ([delivering videos](https://developers.cloudflare.com/fundamentals/reference/policies-compliances/delivering-videos-with-cloudflare/), [Tunnel FAQ](https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/), checked 2026-10-04). This is the factual basis for C-2 and for [ADR-0002](../adr/0002-cloudflare-control-plane-origins-deliver-media.md). Assumption A-7: use is personal or household, of media the operator is entitled to. Cinewren does not host or redistribute content, and the operator is responsible for content and licensing. No binding regulatory regime has been identified (SRS section 7). Plex, Jellyfin and Emby API terms and stability are unverified (Q-3), and the M1 spike is the point to check them.

## 6. Value proposition

| Compared with | What Cinewren offers | What it does not claim |
|---|---|---|
| Using each server's own app separately | One catalog, one search, one sign-in and one watch history across servers. Duplicate titles collapse to one entry showing the versions and how many servers have them (CAP-3, CAP-5). The best copy is chosen at play time (CAP-6). | Cinewren does not replace the origin servers' management features, and it is not a better player for any single server. |
| A media product's own multi-server features | Backend-agnostic: one front end over three server types, with viewer access controlled in one place (CAP-9). Features of individual products are not assessed in this document. | No claim is made about what any specific product does or does not support. Each product's native client generally shows only its own ecosystem, and that is the only comparison relied on. |
| Doing nothing | Viewers need no knowledge of which server holds a title or which is up (CAP-10). | The viewer's browser must still reach the origin directly (A-3). If it cannot, Cinewren cannot help in v1 (DEF-1, DEF-10). |

## 7. Business-level risks

| ID | Risk | Likelihood / impact (agent judgment) | Mitigation |
|---|---|---|---|
| BR-RISK-1 | Cloudflare terms or enforcement change, or video ends up routed through a prohibited path by operator misconfiguration. | Low / High | C-2 enforced by design (FR-PLAY-008); setup guide forbids proxied origin hostnames (A-3); inspection requirement NFR-COMP-001. |
| BR-RISK-2 | Plex, Jellyfin or Emby API or token behaviour does not allow the session-scoped credential model, or changes between versions. | Medium / High | M1 provider spike before commitment; fallback documented in [ADR-0013](../adr/0013-session-scoped-origin-stream-credentials.md); version minimums set by the spike (Q-6). |
| BR-RISK-3 | Viewer browsers cannot reach origins (private networks, mixed content, untrusted certificates). | Medium / High | Operator responsibility (A-3), documented in setup guide; private-only origins deferred (DEF-10, Q-5). Gateway option kept as a revisit path in [ADR-0003](../adr/0003-direct-to-origin-playback.md). |
| BR-RISK-4 | Wrong merges show the wrong title or hide a good copy. | Medium / Medium | Strong-ID-only matching (BR-2); manual merge and split (CAP-12); conflicting IDs flagged, not merged. |
| BR-RISK-5 | The origin's own hostname is visible to viewers, and some operators may object. | Medium / Low | Accepted: owner confirmed ADR-0003 (Owner decision, 2026-10-04), with origins on public HTTPS. Gateway deferred (DEF-1). |
| BR-RISK-6 | Origin credential exposure through Cinewren. | Low / High | Dedicated non-admin service accounts (A-2), encrypted storage (DR-002), no browser exposure (NFR-SEC-001, BR-6). |
| BR-RISK-7 | Scope creep toward a hosted service or a Cinewren-side transcoder. | Medium / Medium | Explicit non-goals: DEF-3 and DEF-8; Q-1 was decided by the owner on 2026-10-04: others may self-host, and hosted multi-tenancy is out of scope. |
| BR-RISK-8 | Single-owner, single-agent authorship leaves requirements unreviewed and the assumptions untested. | High / Medium | Every document is marked unreviewed; the owner is asked to review the A-n and Q-n lists first. |
| BR-RISK-9 | Passkey recovery burden falls on the operator. A viewer who loses every passkey needs an operator re-enrollment link, and an operator who loses theirs depends on another operator or, for the last one, on the CLI recovery procedure, which needs Cloudflare account access (FR-USR-007). Recovery load may grow with the number of viewers, and self-hosting operators must carry it unaided. | Medium / Medium | Several passkeys per user are allowed (FR-USR-006). The last passkey cannot be removed. Re-enrollment links are single-use and expire quickly. The recovery procedure is documented in the self-host guide. Revisit if viewers often lack passkey-capable devices ([ADR-0014](../adr/0014-passkey-auth-with-invite-links.md)). |

(The prefix `BR-RISK` avoids a clash with business rules BR-1 to BR-9, which live in the [FRD](FRD.md#business-rules).)

## 8. Outcome to capability trace

Capabilities are defined in [PRD §2](PRD.md#2-capabilities). Requirement-level trace is in the [SRS](SRS.md).

| Outcome | Primary capabilities | Supporting capabilities |
|---|---|---|
| BO-1 Unified library | CAP-2, CAP-3, CAP-4, CAP-5, CAP-15, CAP-16 | CAP-1, CAP-9, CAP-12 |
| BO-2 Low cost, lightweight operations | CAP-6 (direct-to-origin playback) | CAP-2 (pull-based sync), CAP-13 |
| BO-3 Best available playback | CAP-6, CAP-11 | CAP-7, CAP-8, CAP-10 |
| BO-4 Backend-agnostic | CAP-1, CAP-2 | CAP-6, CAP-14 |
| BO-5 Safe operation | CAP-1, CAP-9 | CAP-6, CAP-13, CAP-14 |

## 9. Scope boundary

In scope for v1.0: a web client for invited users; Jellyfin, Emby and Plex origins; movies and TV only; one operator per deployment, packaged so that other operators can self-host (CAP-14). The full deferred list is in [PRD §6](PRD.md#6-non-goals-and-deferred-capabilities). Delivery order is in the [ROADMAP](../ROADMAP.md).
