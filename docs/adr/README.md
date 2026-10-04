# Cinewren — Architecture Decision Records

Status: Draft v0.1, 2026-10-04, agent-authored under delegation; not owner-reviewed.

## What ADRs are here

An ADR records one architecturally significant decision: the context, what was chosen, what was rejected and why, and who decided. They are the durable reason behind the design in [HLD](../design/HLD.md) and [LLD](../design/LLD.md), and the SRS design column points to them ([SRS](../requirements/SRS.md)). Sequencing is in the [ROADMAP](../ROADMAP.md). Nothing is implemented yet; ADRs describe intended design.

## When an ADR is required

Write one for any change to:

- system boundaries or components (what runs where);
- trust boundaries, or the security model (authentication, credentials, authorization);
- data ownership (what is primary data and what is derived);
- external dependencies (new service, vendor, or paid product);
- the provider abstraction (`MediaProvider`) or support for a new origin type;
- the deployment model (single operator, environments, plan requirements);
- anything an SRS requirement's design column points to an ADR for.

Not needed: library choices inside an existing decision, refactors, bug fixes, and wording changes. When unsure, write a short one.

## Lifecycle

`Proposed` -> `Accepted` -> `Deprecated` or `Superseded by ADR-NNNN`.

- A **Proposed** ADR may be edited freely while it is under discussion.
- Never edit the Decision of an **Accepted** ADR. To change course, write a new ADR, mark the old one `Superseded by ADR-NNNN`, and link both ways. Typo and link fixes are fine, as are dated additions to Status and the Related list.
- **Deprecated** means the decision no longer applies and nothing replaces it.
- ADR-0013 is Proposed; it moves to Accepted (or is superseded) by recording the M1 spike result in it.

## Provenance

Each ADR states who decided, honestly. "Owner direction" means the owner supplied the direction. "Agent under delegation; owner review pending" means an agent decided and the owner has not reviewed it. The owner asking for a plan is not approval of its details. When the owner reviews an ADR, record the date and outcome in Deciders.

## Numbering and files

Files are `NNNN-kebab-title.md`, numbered sequentially from 0001, never reused or renumbered. The H1 is `# ADR-NNNN: <Title>`. Start from [template.md](template.md). Use relative links only. Keep ADRs short (about 40 to 90 lines). Update the index below in the same change.

## Index

| # | Title | Status | Deciders / provenance | Date |
|---|---|---|---|---|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted | Agent under delegation; owner review pending | 2026-10-04 |
| [0002](0002-cloudflare-control-plane-origins-deliver-media.md) | Cloudflare control plane; origins deliver media | Accepted | Owner direction (2026-10-04 concept), recorded by agent; ToS evidence checked by agent | 2026-10-04 |
| [0003](0003-direct-to-origin-playback.md) | Direct-to-origin playback | Accepted | Agent decision following the concept's recommendation; **owner confirmed 2026-10-04** | 2026-10-04 |
| [0004](0004-provider-adapter-abstraction.md) | Provider adapter abstraction | Accepted | Agent under delegation; owner review pending | 2026-10-04 |
| [0005](0005-single-worker-typescript-stack.md) | Single Worker, TypeScript stack | Accepted | Agent under delegation; owner review pending | 2026-10-04 |
| [0006](0006-d1-system-of-record.md) | D1 as system of record | Accepted | Agent under delegation; owner review pending | 2026-10-04 |
| [0007](0007-cloudflare-access-identity.md) | Cloudflare Access for identity | **Superseded by [0014](0014-passkey-auth-with-invite-links.md)** | Agent under delegation; replaced by owner decision | 2026-10-04 |
| [0008](0008-origin-service-accounts-and-credential-encryption.md) | Origin service accounts and credential encryption | Accepted | Agent under delegation; owner review pending | 2026-10-04 |
| [0009](0009-pull-based-sync-cron-and-queues.md) | Pull-based sync with Cron Triggers and Queues | Accepted | Agent under delegation; owner review pending | 2026-10-04 |
| [0010](0010-external-id-matching-with-manual-overrides.md) | External-ID matching with manual overrides | Accepted | Agent under delegation; owner review pending | 2026-10-04 |
| [0011](0011-single-operator-deployment-model.md) | Single-operator deployment model | Accepted | Agent decision; **owner decision 2026-10-04**: one operator per deployment, self-hostable by others | 2026-10-04 |
| [0012](0012-artwork-proxy-with-edge-cache.md) | Artwork proxy with edge cache | Accepted | Agent under delegation; owner review pending | 2026-10-04 |
| [0013](0013-session-scoped-origin-stream-credentials.md) | Session-scoped origin stream credentials | **Proposed** (pending M1 spike) | Agent under delegation; owner review pending | 2026-10-04 |
| [0014](0014-passkey-auth-with-invite-links.md) | Passkey authentication with operator invite links | Accepted (supersedes 0007) | **Owner decision 2026-10-04** (passkeys and invite-only signup); details by agent, owner review pending | 2026-10-04 |
