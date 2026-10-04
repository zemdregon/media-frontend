# AGENTS.md — Cinewren

Operating instructions for AI coding agents working in this repository. Humans are welcome to read along.

**Cinewren** is a self-hosted, federated media frontend. A Cloudflare Worker serves the UI, API and catalog. Jellyfin, Emby and Plex servers stay the media origins, and video streams go directly from origin to browser.

## 1. Start here: the canonical roadmap

**Read [`docs/ROADMAP.md`](docs/ROADMAP.md) before planning or implementing anything.** It is the canonical source for scope, priorities, dependencies, milestone status and completion criteria. Then read the specification sections that bear on your task (see §2). Don't reconstruct project history from commits or chat. If the docs don't answer a question, record the gap (see §4).

## 2. Which document owns what

| Subject | Canonical home |
|---|---|
| Scope boundaries, sequencing, status, done-criteria | [docs/ROADMAP.md](docs/ROADMAP.md) |
| Business outcomes (BO-*) | [docs/requirements/BRD.md](docs/requirements/BRD.md) |
| Personas, capabilities (CAP-*), journeys (J-*), non-goals (DEF-*) | [docs/requirements/PRD.md](docs/requirements/PRD.md) |
| Workflows (WF-*), **business rules (BR-*)**, permissions, state machines | [docs/requirements/FRD.md](docs/requirements/FRD.md) |
| **Every requirement (FR-*, IR-*, DR-*, NFR-*)** and its trace and verification | [docs/requirements/SRS.md](docs/requirements/SRS.md) |
| Components (C-*), trust boundaries, data flows, deployment, threat model | [docs/design/HLD.md](docs/design/HLD.md) |
| Subsystem collaboration, module layout, requirement→design map | [docs/design/SDD.md](docs/design/SDD.md) |
| Stack, config, testing, CI/CD, release, rollback, backup | [docs/design/TDD.md](docs/design/TDD.md) (TDD = Technical Design Document) |
| Schema, API contracts, algorithms, error handling (LLD-*) | [docs/design/LLD.md](docs/design/LLD.md) |
| Architectural decisions | [docs/adr/](docs/adr/README.md) |

Reference requirements and rules **by ID**. Never paraphrase them into a second copy.

## 3. Keep docs and code in sync

- **One change, one truth.** A PR that changes behaviour also updates the documents that describe it: SRS rows, LLD contracts and so on. In the same PR, it also updates the task and milestone status in `docs/ROADMAP.md`, with evidence (a test name, file path or PR link). Don't mark anything `Done` without evidence.
- **New or changed requirements** go in the SRS, with priority, trace, milestone and verification method. Never renumber or reuse an ID. Withdraw a requirement by setting its status instead.
- **Architecturally significant changes need an ADR.** That covers boundaries, trust or security model, data ownership, external dependencies, provider abstraction and deployment model. Follow [docs/adr/README.md](docs/adr/README.md). Never rewrite an Accepted ADR's decision; write a new ADR that supersedes it, and mark the old one `Superseded by ADR-NNNN`.
- Run `node scripts/check-docs.mjs` before committing doc changes. It checks links, ID references and LLD section IDs.

## 4. Conflicts, assumptions and superseded material

- **Precedence when sources disagree:** explicit owner decisions, then Accepted ADRs, then the canonical document for that subject (§2), then other documents, then code comments. Code shows *what is*, not *what was intended*. A plan shows *intent*, not *what is implemented*.
- **Don't silently pick a side.** Record the conflict and its resolution in the "Conflicts found" table in [ROADMAP §3](docs/ROADMAP.md#3-constraints-assumptions-decisions-and-open-questions), and fix the losing document.
- **Assumptions** (A-*) and **open questions** (Q-*) live in ROADMAP §3. If you must assume something to proceed, choose the conservative option, label it, and add it there.
- **Provenance:** don't describe agent decisions as owner-approved. Use the labels "Owner direction" and "Agent decision (delegated)" as the docs do.
- **Superseded documents** are marked superseded and linked to their replacement. Never delete them. `docs/sources/` is historical input and is never authoritative.
- **Ask the owner only** when a missing answer blocks the work, changes the product's purpose, or carries significant security, legal, financial or irreversible risk. Otherwise decide, document the decision and continue.
- **Ask blocking questions as multiple choice.** Owner direction (2026-10-04). Use the agent's built-in structured-question tool (for example `AskUserQuestion` in Claude Code). Don't ask open-ended questions in prose.
  - Batch related blockers into one prompt: up to four questions, each with 2–4 concrete options.
  - Put the recommended option first, labelled "(Recommended)". Each option's description says what that choice changes: which ADR, requirement or milestone.
  - Reference the blocker's ID (B-*, Q-*, A-*) in the question.
  - Record every answer in [ROADMAP §3](docs/ROADMAP.md#3-constraints-assumptions-decisions-and-open-questions) as "Owner decision (date)" and update the affected documents in the same change.
  - If no structured-question tool is available, present the same numbered options in text and ask for the option number.

## 5. Engineering guardrails (summary; details in the linked docs)

- Never route media bytes through Cloudflare, whether Worker, proxied hostname or Tunnel public hostname ([ADR-0002](docs/adr/0002-cloudflare-control-plane-origins-deliver-media.md)).
- Origin service credentials never reach the browser, logs or exports (NFR-SEC-001). Browsers get only session-scoped stream credentials ([ADR-0013](docs/adr/0013-session-scoped-origin-stream-credentials.md)).
- Provider-specific code lives only in provider adapters ([ADR-0004](docs/adr/0004-provider-adapter-abstraction.md)).
- Permission filtering (BR-1) is enforced server-side in the catalog query layer.
- Don't change production infrastructure or secrets unless a task explicitly calls for it.
- Authentication is passkeys only, and accounts are created only through operator invite links ([ADR-0014](docs/adr/0014-passkey-auth-with-invite-links.md)). Never add another sign-up path.
- Authentication is passkeys only, and accounts are created only through operator invite links ([ADR-0014](docs/adr/0014-passkey-auth-with-invite-links.md)). Never add another sign-up path.

## 6. Subagent routing and orchestration

> Owner direction (2026-10-04).

The primary agent acts as an orchestrator. It coordinates work through context-scoped subagents rather than doing coding and edits directly. This division of labor optimizes reasoning effort and keeps the main conversation focused on coordination and decision-making.

When delegating to subagents, route work based on task complexity and requirements. Models are listed from cheapest to most capable. Prices are Anthropic first-party API rates per million input/output tokens as of 2026-09-25; see the [Anthropic pricing page](https://platform.claude.com/docs/en/about-claude/pricing) for current rates.

| Model | Model ID | Price (in/out per MTok) | Use for |
|---|---|---|---|
| **Haiku 4.5** | `claude-haiku-4-5` | $1 / $5 | Cheapest and fastest. Simple, well-defined tasks such as file reads, pattern matching, routine edits, small scripts, exploratory searches and quick lookups. |
| **Sonnet 5.5** | `claude-sonnet-5-5` | $2 / $10 | Balanced speed and capability for general-purpose work such as multi-file refactoring, feature implementation, moderate analysis and code review. **The default choice for most substantive tasks.** |
| **Opus 5.5** | `claude-opus-5-5` | $4 / $20 | Strong reasoning for complex, high-stakes work such as architecture decisions, cross-system design, deep codebase analysis, security review and intricate bug diagnosis. Use it when Sonnet's output quality is insufficient. |
| **Fable 5.1** | `claude-fable-5-1` | $10 / $50 | Anthropic's most capable widely released model, and the most expensive. Turns on hard tasks can run for many minutes. Reserve it for the most demanding reasoning and long-horizon agentic work where Opus falls short. |

**Orchestrator responsibilities:** define the task scope, provide context and constraints, verify subagent work, and coordinate across multiple efforts. Route simple, independent subtasks to Haiku or Sonnet to reduce latency and cost. Reserve Opus and Fable for genuinely complex problems that need deep reasoning, or for work where failure would be costly.

**Subagent responsibilities:** execute focused work within the defined scope, such as code writes, edits, file operations and targeted analysis. Report results clearly so the orchestrator can verify them and coordinate the next step.

### 6.1 Delegation practice in this repository

These are agent additions that put the policy above into practice.

- **Brief subagents completely.** A subagent starts without your context. Give it the task ID from the ROADMAP, the SRS IDs it must satisfy, the relevant LLD sections and ADRs, the files it may touch, and its definition of done (the task's "Done when" column).
- **Default routing for Cinewren work:**

  | Work | Model |
  |---|---|
  | Doc link fixes, status updates, fixture capture, codebase lookups | Haiku |
  | Feature tasks (T*.*), adapters, UI, tests, routine reviews | Sonnet |
  | Provider spike analysis (T1.1), the security model (ADR-0008, ADR-0013), source selection or matching design changes, threat-model reviews, the v1.0 security review | Opus |
  | Escalation only, after an Opus attempt falls short | Fable |

- **Parallelize independent work.** Tasks without a dependency edge in the ROADMAP tables can run concurrently. Two subagents must never edit the same file at once; split by file ownership.
- **Verify before accepting.** The orchestrator checks subagent output against the task's completion checks. It runs the tests, `node scripts/check-docs.mjs` and the diff review itself; a subagent saying "done" is not enough. Re-delegate or escalate the model when output is below the bar.
- **Escalate on failure, not by default.** Move one tier up after a failed attempt with a clear brief, not pre-emptively.
- **Keep decisions with the orchestrator.** Subagents may propose ADRs or requirement changes, but the orchestrator accepts them and records them per §3.
- **Never put model identifiers in commits, PR text or code comments.** Model names belong in this policy file only.

## 7. Repository conventions

- Layout: `docs/` holds specifications, `scripts/` holds repository tooling, and the application layout is defined in [SDD](docs/design/SDD.md). No application code exists yet; the next milestone is M0 in the ROADMAP.
- Commits: small and focused, with an imperative subject line. Reference task and requirement IDs in the body, for example `T0.5: passkey login and sessions (FR-USR-001)`.
- Tooling commands (build, test, lint) will be listed here once T0.1 creates them. Until then, the only check is `node scripts/check-docs.mjs`.
