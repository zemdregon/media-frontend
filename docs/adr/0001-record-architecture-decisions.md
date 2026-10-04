# ADR-0001: Record architecture decisions

## Status

Accepted

## Date

2026-10-04

## Deciders

Agent under delegation (2026-10-04); owner review pending.

## Context

Cinewren starts from an empty repository. The owner supplied a concept document ([source](../sources/2026-10-04-initial-architecture-concept.md)) and asked for a plan. Many design choices follow from it, and several are agent decisions that the owner has not yet reviewed. Agents and humans will work on this repository in separate sessions with no shared memory. [AGENTS.md](../../AGENTS.md) governs the agent workflow (NFR-MAINT-002). Without a durable record, the reasons for a choice, and who made it, are lost.

The SRS design column already points at ADRs by number (for example ADR-0002, ADR-0008, ADR-0013), so the numbering must be stable from the start.

## Decision

We record architecturally significant decisions as ADRs in `docs/adr/`, in a lightweight MADR-style format ([template.md](template.md)). The rules are in [README.md](README.md). In short:

- One decision per file, named `NNNN-slug.md`, numbered sequentially and never reused.
- Every ADR states honestly who decided. An agent decision is labelled as such and stays "owner review pending" until the owner says otherwise.
- The decision text of an Accepted ADR is not edited. A change of mind is a new ADR that supersedes the old one.
- ADRs are written in the same change as the behaviour or design they govern.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Keep rationale only in the HLD | The HLD describes the current design and is edited freely. It loses the history of why and what was rejected. |
| Heavyweight RFC process with sign-off | Disproportionate for a single-operator project (A-1). Adds ceremony without a reviewer population. |
| Decisions in commit messages / PR descriptions only | Hard to find, not versioned with the design, and invisible to agents that read the docs tree. |
| Full MADR with all optional fields | More headings than this project needs. "MADR-lite" keeps the sections that carry weight. |

## Consequences

- Positive: a searchable, reviewable record; agents can check a decision before changing a boundary.
- Positive: provenance (owner direction vs agent decision) is explicit, so unreviewed decisions are visible.
- Negative: small overhead per significant change; the README defines the threshold to limit this.
- Obligation: the ADR index in [README.md](README.md) must be updated whenever an ADR is added or changes status.

## Revisit when

- More than one regular decision-maker joins (a review or approval step may be needed).
- The ADR set grows enough that the flat index is hard to navigate (consider topic grouping).

## Related

- NFR-MAINT-002 in [SRS](../requirements/SRS.md)
- [AGENTS.md](../../AGENTS.md)
- [HLD](../design/HLD.md), [ROADMAP](../ROADMAP.md)
