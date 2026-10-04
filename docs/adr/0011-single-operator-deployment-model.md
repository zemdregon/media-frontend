# ADR-0011: Single-operator deployment model

## Status

Accepted

## Date

2026-10-04

## Deciders

Agent under delegation (2026-10-04); owner review pending. Rests on assumption A-1; the owner has not confirmed it.

## Context

Nothing in the owner's concept requires multiple tenants. Multi-tenancy affects data isolation, billing, abuse handling, key management and legal exposure (the operator carries content responsibility, A-7). The target is a household or friends group. Envelope: <= 50 users, <= 20 servers (NFR-SCALE-001). Question Q-1 (will Cinewren ever be multi-operator or hosted?) is open.

## Decision

Each deployment belongs to one operator in the operator's own Cloudflare account: one Worker, one D1 database, one Access team. There is no tenant concept in the schema or API. "Operator" is a role within that deployment (BR-8), not an organization. Hosted or multi-tenant service is deferred (DEF-3).

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Multi-tenant from the start (tenant ID on every row) | Cost in every query and test, plus billing, abuse and legal concerns, for a need nobody has stated. Adds the largest risk to NFR-SEC-002. |
| Hosted SaaS operated by the project | Operator would host others' media pointers and credentials; content and compliance liability (A-7); out of scope. |
| Design for tenants but ship single-tenant | Speculative; the abstraction would be guessed without a real second tenant. Isolation by deployment (one account each) is the cheap path if Q-1 flips. |

## Consequences

- Positive: simple schema and authorization; isolation is by Cloudflare account; costs land on the operator (NFR-COST-001).
- Negative: no shared deployment; each operator deploys and upgrades their own. Setup must be well documented (J-1).
- Negative: changing to multi-tenancy later would be a schema and security-model change requiring a new ADR and likely a migration.
- Neutral: scale limits are those of one D1 and one Worker (NFR-SCALE-001).

## Revisit when

- Q-1 is answered yes.
- The owner wants to offer a managed instance to others.
- The design envelope is exceeded.

## Related

- A-1, A-7, Q-1 in [ROADMAP](../ROADMAP.md); NFR-SCALE-001, NFR-COST-001 in [SRS](../requirements/SRS.md)
- [ADR-0006](0006-d1-system-of-record.md), [ADR-0007](0007-cloudflare-access-identity.md), [ADR-0008](0008-origin-service-accounts-and-credential-encryption.md)
- [HLD](../design/HLD.md), [ROADMAP](../ROADMAP.md)
