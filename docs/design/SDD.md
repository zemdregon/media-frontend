# Cinewren — SDD (Software Design Description)

| | |
|---|---|
| **Status** | Draft v0.1, 2026-10-04, agent-authored under delegation; not owner-reviewed. Nothing described here is implemented (the repository has no source code). Updated 2026-10-04 for owner decisions (ADR-0014, self-hosting). |
| **Owns** | Integrated software design: how subsystems collaborate per workflow, module and package structure, shared design patterns, interface ownership, cross-subsystem invariants, and the requirements-to-design satisfaction table. |
| **Does not own** | System context, trust boundaries, deployment, threat model, capacity ([HLD](HLD.md)); field-level schemas, endpoint contracts and algorithms ([LLD](LLD.md)); test strategy and tooling practice ([TDD](TDD.md)); requirements ([SRS](../requirements/SRS.md)); workflow rules ([FRD](../requirements/FRD.md)); sequencing ([ROADMAP](../ROADMAP.md)). |

All design choices here are **Agent decisions (delegated)**, not yet owner-reviewed, unless marked **Owner decision (2026-10-04)**. The owner decisions are those in [ADR-0014](../adr/0014-passkey-auth-with-invite-links.md) (passkeys only, invite-link-only signup) and [ADR-0011](../adr/0011-single-operator-deployment-model.md) (self-hosting); the ADR-0014 implementation details are agent decisions. The component IDs (`C-*`) are defined in the [HLD](HLD.md).

## 1. Design approach

One Worker, one TypeScript codebase, strict typing ([ADR-0005](../adr/0005-single-worker-typescript-stack.md)). Business logic is plain TypeScript modules that receive their dependencies (D1 handle, provider factory, clock, random source, crypto key) as arguments, so the same logic runs behind `fetch`, `scheduled` and `queue` handlers and under test. Three entry points are thin shells over shared services; they hold no business rules.

## 2. Module and package structure

**Decision: a small pnpm workspace with three packages.** Alternatives were a single package (simpler, but the SPA and the Worker would share types through relative imports across build boundaries) and many packages (overhead the single-operator scale does not justify, A-1). Three packages give the SPA and Worker one source of API types (`packages/shared`) while keeping one deployable. This follows ADR-0005's pnpm choice.

```text
/
├── AGENTS.md
├── docs/                       # this documentation set
├── pnpm-workspace.yaml
├── apps/
│   └── web/                    # C-WEB: React + Vite SPA, built into the Worker's assets dir
│       └── src/{routes,components,player,api-client,state}
├── packages/
│   └── shared/                 # API request/response types, error codes, zod schemas, enums
│       └── src/{api,errors,domain}
├── worker/                     # the single deployable (wrangler.jsonc lives here)
│   ├── migrations/             # forward-only D1 migrations (DR-004)
│   ├── test/                   # Workers-runtime integration tests + provider fixtures
│   └── src/
│       ├── index.ts            # exports { fetch, scheduled, queue }
│       ├── api/                # C-API: Hono app, route modules, middleware, envelope
│       ├── auth/               # C-AUTH (ADR-0014)
│       │   ├── webauthn/       # registration and login ceremonies, challenge store
│       │   ├── sessions/       # create, hash, validate, revoke; the one session middleware
│       │   ├── invites/        # invite, re-enrollment and setup tokens (hashed, single-use)
│       │   └── users.ts        # user, role and grant resolution
│       ├── catalog/            # C-CAT: query layer, search, home rows, visibility filter
│       ├── match/              # C-MATCH: matching and curation
│       ├── sync/               # C-SYNC: schedule, job handlers, retention purge
│       ├── health/             # C-HEALTH: probe job, status derivation
│       ├── playback/           # C-PLAY: selection, sessions, progress
│       ├── artwork/            # C-ART: proxy and cache
│       ├── providers/
│       │   ├── types.ts        # MediaProvider interface and normalized types (LLD-PROV)
│       │   ├── jellyfin/  emby/  plex/
│       │   └── contract/       # shared contract-test suite run against each adapter
│       ├── crypto/             # C-CRYPTO: envelope encryption, key versioning
│       ├── db/                 # D1 access: repositories, transaction helpers, migrations runner
│       └── platform/           # clock, random, logger, request context, env typing, config
└── (root config: tsconfig base, eslint, vitest, playwright)
```

Dependency rules (enforced by lint, design in [TDD](TDD.md)):

| Module | May import | Must not import |
|---|---|---|
| `api` | services (`catalog`, `playback`, `sync`, `auth`, `health`, `artwork`, `match`), `shared`, `platform` | `providers/*`, `crypto`, raw `db` queries |
| `catalog`, `match`, `playback`, `sync`, `health`, `artwork` | `db`, `providers/types` (interface only), `crypto` (only via `providers` factory), `platform`, `shared` | `providers/jellyfin` etc. directly |
| `providers/*` | `providers/types`, `crypto` (to decrypt a credential for one call), `platform` | `db`, other services |
| `db` | `platform`, `shared` | any service |
| `apps/web` | `shared` only | `worker/*` |

The rule that nothing outside `providers/*` depends on provider-specific types is how IR-002 is made checkable (inspection plus lint).

## 3. Shared design patterns

| Pattern | Where | Purpose |
|---|---|---|
| Adapter | `providers/*` implement `MediaProvider` | Hide Jellyfin/Emby/Plex differences; new provider needs no client change ([ADR-0004](../adr/0004-provider-adapter-abstraction.md), BO-4) |
| Repository / query module | `db/`, `catalog/queries` | All SQL lives in one layer; services never build SQL; visibility filter has one home (Section 5) |
| Command handlers for mutations | `api` routes call named commands (`registerServer`, `grantLibrary`, `mergeItems`, `startPlayback`) | One place per mutation for validation, audit-log write (FR-OPS-005) and authorization |
| Idempotent job handlers | `sync/` | Each queue message is safe to deliver twice; upserts keyed by `(server_id, provider_item_id)` ([ADR-0009](../adr/0009-pull-based-sync-cron-and-queues.md), FR-SYNC-004) |
| Result/error envelope | services return `Result<T, AppError>`; `api` maps to the single HTTP envelope with request ID | Uniform errors, no thrown strings, no secrets in messages (IR-001, NFR-SEC-001); detail in LLD-ERR |
| Dependency injection via `env` | `platform/context.ts` builds a `Deps` object from `env` once per invocation | Services never read globals; tests supply fakes and local D1 |
| Clock and random injection | `Clock`, `Random` in `Deps` | Deterministic tests for expiry (BR-9), retention (DR-003), jitter (NFR-REL-002), ID generation |
| Bounded work units | sync and probe jobs | Each invocation fits Worker limits (HLD Section 11); progress is checkpointed in D1, not in memory |
| Config as typed object | `platform/config.ts` parses `vars` once | Intervals, thresholds, flags (FR-SYNC-001, BR-7, BR-9) are configuration, not constants in code |

## 4. Workflow collaboration

Diagrams are module-level. Field-level contracts live in the [LLD](LLD.md); business rules live in the [FRD](../requirements/FRD.md).

### 4.1 WF-2 Catalog sync (full or incremental)

```mermaid
sequenceDiagram
  autonumber
  participant Cron as scheduled handler
  participant Sync as sync (C-SYNC)
  participant Q as Queue
  participant Prov as providers (C-PROV)
  participant Match as match (C-MATCH)
  participant DB as db
  Cron->>Sync: tick (interval from config)
  Sync->>DB: select enabled servers; skip any with a running run
  Sync->>DB: create sync_run (queued)
  Sync->>Q: enqueue job(server, library, cursor)
  Q->>Sync: deliver job (consumer)
  Sync->>DB: mark run running; load server and library
  Sync->>Prov: listItems(library, cursor) via factory (decrypts credential for the call)
  Prov-->>Sync: normalized page + next cursor
  Sync->>DB: upsert sources, versions (skip if content hash unchanged)
  Sync->>Match: link changed items to canonical items
  Match->>DB: read external IDs, write canonical links
  alt more pages
    Sync->>Q: enqueue next cursor
  else last page of full sync
    Sync->>DB: mark unseen sources missing; finish run (succeeded / partial / failed)
  end
```

Design notes: one job is one bounded page; the cursor lives in the message and the run record, so a retry resumes. Errors in one server never touch another's jobs (FR-SYNC-007). Transient origin errors retry with backoff and jitter via the Queue and the adapter (NFR-REL-002). A job that exhausts retries marks the library failed and the run `partial` or `failed`. Missing-marking only happens after a completed full pass (FR-SYNC-005).

### 4.2 WF-5 Play request, selection and authorization

```mermaid
sequenceDiagram
  autonumber
  participant Web as C-WEB
  participant Api as api + auth
  participant Play as playback (C-PLAY)
  participant Cat as catalog queries
  participant Prov as providers
  participant DB as db
  Web->>Api: POST play (item/episode, capabilities, optional override or exclusions)
  Api->>Api: session middleware validates the cookie; resolve user, role, grants
  Api->>Play: startPlayback(user ctx, request)
  Play->>Cat: candidate sources visible to user (BR-1 filter)
  Cat-->>Play: sources + versions + server health
  Play->>Play: select source (BR-5 / LLD-SEL), or honour override
  Play->>Prov: negotiate(source, capabilities, tracks) via factory
  Prov-->>Play: mode, stream URL parts, session credential (LLD-TOKEN)
  Play->>DB: insert playback_session (authorized, expiry)
  Play-->>Api: descriptor (origin stream URL, mode, tracks, session ID, expiry)
  Api-->>Web: descriptor
  Web->>Web: player loads origin URL directly (DF-4, no Worker involved)
  alt start fails
    Web->>Api: play again with excluded sources (FR-PLAY-004)
  end
```

Design notes: selection is a pure function over data fetched by `catalog` and `health`, so it is testable without I/O (LLD-SEL). Only `providers` and `crypto` ever see an origin credential. The descriptor contains only the session-scoped stream credential (FR-PLAY-007). If negotiation fails on one source, `playback` may try the next-ranked source within the latency budget (NFR-PERF-002) before returning a "no playable source" error.

### 4.3 WF-6 Progress reporting and resume

```mermaid
sequenceDiagram
  autonumber
  participant Web as C-WEB
  participant Api as api + auth
  participant Play as playback
  participant DB as db
  participant Prov as providers
  Web->>Api: PUT progress (session ID, position, event)
  Api->>Play: reportProgress(user ctx, session, position, event)
  Play->>DB: verify session belongs to user and is live
  Play->>DB: upsert position per (user, canonical item); apply BR-7 watched rule
  opt origin reporting enabled (FR-PLAY-009)
    Play->>Prov: reportPlayback(source, session, position, event) best effort
  end
  Play-->>Api: ok (+ watched flag)
  Note over Web,Play: On play, Web asks for stored position and offers resume (FR-PROG-002)
```

Position is stored per user per canonical item, never per source, so resume works on whichever source is selected next (FR-PROG-001). Origin reporting failures never fail the progress write. Stop events end the session and trigger credential revocation (LLD-TOKEN); sessions silent beyond the BR-9 limit are expired by the scheduled retention job.

### 4.4 WF-7 Authentication and user provisioning

Signup by invite (account creation has no other path except the first-operator `/setup`, which follows the same ceremony with `SETUP_TOKEN` in place of the invite token):

```mermaid
sequenceDiagram
  autonumber
  participant B as Browser
  participant Api as api (rate limit)
  participant Auth as auth (C-AUTH)
  participant DB as db
  B->>Api: open invite link, POST redeem (token)
  Api->>Auth: redeemInvite(token)
  Auth->>DB: look up hash(token); check unused, unexpired, not revoked
  alt invalid, used, expired or revoked
    Auth-->>B: uniform refusal
  else valid
    Auth->>DB: store single-use challenge (short TTL)
    Auth-->>B: registration options (RP ID, challenge)
    B->>B: navigator.credentials.create
    B->>Api: POST attestation response
    Api->>Auth: verifyRegistration(response)
    Auth->>DB: consume challenge; verify origin, RP ID and signature
    Auth->>DB: in one transaction: create user (role and grants from invite, active), store passkey, mark invite used
    Auth->>DB: create session (store hash of the ID)
    Auth-->>B: Set-Cookie session (HttpOnly, Secure, SameSite=Lax)
  end
```

Login and ongoing requests:

```mermaid
sequenceDiagram
  autonumber
  participant B as Browser
  participant Api as api (rate limit, session middleware)
  participant Auth as auth (C-AUTH)
  participant DB as db
  B->>Api: POST login start
  Api->>Auth: loginOptions()
  Auth->>DB: store single-use challenge (short TTL)
  Auth-->>B: authentication options
  B->>B: navigator.credentials.get
  B->>Api: POST assertion
  Api->>Auth: verifyLogin(assertion)
  Auth->>DB: consume challenge; load passkey; verify signature and counter; user active
  Auth->>DB: create session (hash only)
  Auth-->>B: Set-Cookie session
  B->>Api: later app request with cookie
  Api->>Auth: validate session; Origin check if state-changing
  Auth->>DB: find hash; check idle and absolute expiry, user active
  Auth-->>Api: user context (id, role, granted library IDs), or 401
```

The user context is computed once per request in the session middleware and passed down; services never re-derive identity. Invite creation and revocation, re-enrollment links, passkey management, sign-out and user disable or delete (which revoke sessions) are commands in `auth`, with the BR-8 last-operator guard in the user command (LLD-SCHEMA, LLD-API). The wire details are in LLD-API; the choice and rationale are in [ADR-0014](../adr/0014-passkey-auth-with-invite-links.md).

## 5. Cross-subsystem invariants

| ID | Invariant | Where enforced | How it is checked |
|---|---|---|---|
| INV-1 | BR-1 visibility filtering is applied in exactly one place: the `catalog` query layer. Every list, search, detail, artwork lookup, play candidate and next-episode query goes through it. No other module composes a query over sources or libraries. | `catalog/queries` (C-CAT) | Authorization tests per endpoint; lint rule banning `db` access to source tables outside `catalog` and `sync`/`match` write paths |
| INV-2 | Origin credentials are decrypted only inside `crypto` and `providers`, per call, and the plaintext is never stored, logged or returned. | C-CRYPTO, C-PROV | Type-level: decrypted credential type not exported outside those modules; log redaction test; export test (NFR-SEC-001) |
| INV-3 | Only `providers/*` knows provider types; services see normalized types. | Module dependency rules (Section 2) | Lint and inspection (IR-002) |
| INV-4 | No code path proxies or caches media or audio bytes. Only artwork (small images) passes through the Worker. | C-PLAY returns URLs only; C-ART restricted to image types and size cap | Descriptor tests assert origin host; inspection (FR-PLAY-008) |
| INV-5 | Every mutation is authorized by role in the command handler and writes an audit record where FR-OPS-005 applies. | Command handlers | Tests per command |
| INV-6 | Sync writes are idempotent and keyed by `(server_id, provider_item_id)`; canonical IDs are stable across syncs and manual overrides win over automatic matching (BR-3). | `sync`, `match`, `db` | Re-run tests (FR-SYNC-004) |
| INV-7 | Outbound origin requests target only the registered host; cross-host redirects are refused. | Single outbound HTTP helper used by all adapters | Adapter contract tests (NFR-SEC-005) |
| INV-8 | Primary data (users, grants, progress, overrides, server config, audit) is never rebuilt from origins; derived data (catalog) may be. Migrations never drop primary data. | `db` migrations, retention jobs | Review and restore rehearsal (DR-001, NFR-REL-003) |
| INV-9 | The session check lives in one middleware (`auth/sessions`). Every route except setup, redeem, login, health and static assets is registered behind it, and it also performs the `Origin` check on state-changing requests. | `api` router composition, `auth/sessions` | Route-table test that fails on any unlisted public route; per-endpoint 401 tests (FR-USR-001, NFR-SEC-007) |
| INV-10 | Session IDs, invite, re-enrollment and setup tokens are stored only as hashes; the plaintext appears once, in the cookie or link given to its holder, and is never logged. | `auth/sessions`, `auth/invites`, `db` | Schema holds no plaintext token column; log redaction test (NFR-SEC-007, NFR-OBS-001) |

## 6. Interface responsibilities

| Interface | Requirement | Owner (design) | Producer | Consumer |
|---|---|---|---|---|
| Platform HTTP API `/api/v1` | IR-001 | LLD-API in [LLD](LLD.md) | `worker/src/api` | `apps/web` through `packages/shared` types |
| Provider interface `MediaProvider` | IR-002, IR-003..005 | LLD-PROV in [LLD](LLD.md) | `worker/src/providers/*` | `sync`, `health`, `playback`, `artwork`, server-registration command |
| WebAuthn authentication | IR-006 | [ADR-0014](../adr/0014-passkey-auth-with-invite-links.md); details in LLD-API | Browser WebAuthn API | `worker/src/auth` |
| Browser media playback | IR-007 | [TDD](TDD.md) (player approach); descriptor in LLD-API | origin servers | `apps/web/src/player` |
| D1 schema | DR-001, DR-004 | LLD-SCHEMA in [LLD](LLD.md) | `worker/migrations` | `worker/src/db` only |
| Error envelope | IR-001 | LLD-ERR in [LLD](LLD.md) | `api` middleware | `apps/web/src/api-client` |

The SDD does not repeat endpoint shapes, table definitions or provider method signatures; those live in the LLD and must not be duplicated here.

## 7. Requirements-to-design satisfaction

Covers every Must and Should requirement in the [SRS](../requirements/SRS.md). The Could item FR-OPS-006 is omitted. Authentication rows follow [ADR-0014](../adr/0014-passkey-auth-with-invite-links.md). "LLD / ADR" gives the detailed design home; "TDD" means practice or tooling, not behaviour. Milestone delivery is in the [ROADMAP](../ROADMAP.md).

### 7.1 Functional

| Req | Components | Mechanism | LLD / ADR |
|---|---|---|---|
| FR-SRV-001 | C-API, C-PROV, C-CRYPTO | `registerServer` command validates then stores encrypted credentials | LLD-API, [ADR-0008](../adr/0008-origin-service-accounts-and-credential-encryption.md) |
| FR-SRV-002 | C-PROV | Adapter `validate()` checks TLS, auth, server ID and version; failure returns named check, nothing saved | LLD-PROV |
| FR-SRV-003 | C-PROV, C-SYNC | Adapter lists libraries; operator enable flag stored per library; sync reads only enabled | LLD-SCHEMA, LLD-PROV |
| FR-SRV-004 | C-API, db | Server state commands; disable excluded by the catalog filter; removal cascades | LLD-SCHEMA, LLD-API |
| FR-SRV-005 | C-API, C-CRYPTO | `rotateCredentials` re-validates then replaces ciphertext in place; catalog untouched | LLD-TOKEN, [ADR-0008](../adr/0008-origin-service-accounts-and-credential-encryption.md) |
| FR-SRV-006 | C-PLAY | Server priority integer is rank key 5 in selection | LLD-SEL |
| FR-SRV-007 | C-PROV, C-API | URL scheme check in registration; `ALLOW_INSECURE_ORIGINS` flag read from config | LLD-PROV |
| FR-SYNC-001 | C-SYNC | Cron tick enqueues incremental or full jobs by configured interval | LLD-SYNC, [ADR-0009](../adr/0009-pull-based-sync-cron-and-queues.md) |
| FR-SYNC-002 | C-API, C-SYNC | On-demand command creates a run; unique-running-run guard per server | LLD-SYNC |
| FR-SYNC-003 | C-PROV, db | Adapter normalizes to canonical types; schema holds items, versions, tracks, external IDs | LLD-PROV, LLD-SCHEMA |
| FR-SYNC-004 | C-SYNC | Upsert keyed by `(server_id, provider_item_id)`; content hash skips unchanged | LLD-SYNC, LLD-ERR |
| FR-SYNC-005 | C-SYNC | After a complete full pass, unseen sources set `missing`; reappearance restores | LLD-SYNC |
| FR-SYNC-006 | C-SYNC, C-API | `sync_run` record with status and counters; read endpoint for operators | LLD-SCHEMA, LLD-API |
| FR-SYNC-007 | C-SYNC | Per-server jobs and run records; failures caught per job; catalog reads independent of sync | LLD-SYNC, [ADR-0009](../adr/0009-pull-based-sync-cron-and-queues.md) |
| FR-CAT-001 | C-MATCH | Strong external ID matching under BR-2 produces canonical item with N sources | LLD-MATCH, [ADR-0010](../adr/0010-external-id-matching-with-manual-overrides.md) |
| FR-CAT-002 | C-CAT | Keyset-paginated sorted list queries over canonical items | LLD-API, LLD-SCHEMA |
| FR-CAT-003 | C-CAT | Filter predicates on genre, year, best resolution (denormalized best-resolution column) | LLD-API, LLD-SCHEMA |
| FR-CAT-004 | C-CAT | FTS5 index on normalized titles (fallback: LIKE on normalized column, verify in M0) | [ADR-0006](../adr/0006-d1-system-of-record.md), LLD-SCHEMA |
| FR-CAT-005 | C-CAT | Detail query aggregates versions and server counts from visible sources only | LLD-API |
| FR-CAT-006 | C-AUTH, C-CAT | INV-1 single visibility filter using the request's user context | LLD-API |
| FR-CAT-007 | C-MATCH | Override records consulted before automatic matching; persist across syncs | LLD-MATCH, LLD-SCHEMA |
| FR-CAT-008 | C-CAT | Home queries: recently added by date, continue watching from progress | LLD-API |
| FR-CAT-009 | C-ART, C-API | Artwork endpoint by item ID; permission check, then cache, then origin fetch | [ADR-0012](../adr/0012-artwork-proxy-with-edge-cache.md), LLD-API |
| FR-CAT-010 | C-MATCH, C-API | Conflict flags from matching are listed through an operator endpoint, and resolved through the FR-CAT-007 commands | LLD-MATCH, LLD-API |
| FR-PLAY-001 | C-PLAY | `startPlayback` returns descriptor built from selection plus negotiation | LLD-API, LLD-SEL |
| FR-PLAY-002 | C-WEB, C-API | Client probes `MediaSource`/`canPlayType` and sends capabilities with every request | LLD-API, LLD-SEL |
| FR-PLAY-003 | C-PLAY | Pure deterministic ranking function per BR-5 | LLD-SEL |
| FR-PLAY-004 | C-PLAY | Request carries excluded source IDs; selection reruns over remaining | LLD-SEL |
| FR-PLAY-005 | C-PLAY | Explicit version or source in request overrides ranking after visibility check | LLD-API, LLD-SEL |
| FR-PLAY-006 | C-PLAY, C-PROV, C-WEB | Adapter returns track lists and subtitle URLs (WebVTT); burn-in via transcode parameters | LLD-PROV |
| FR-PLAY-007 | C-PLAY, C-PROV, C-CRYPTO | Per-session origin credential minted at negotiation and revoked at end | [ADR-0013](../adr/0013-session-scoped-origin-stream-credentials.md), LLD-TOKEN |
| FR-PLAY-008 | C-PLAY | Descriptor contains URLs only; no stream endpoint exists in the Worker (INV-4) | [ADR-0002](../adr/0002-cloudflare-control-plane-origins-deliver-media.md), [ADR-0003](../adr/0003-direct-to-origin-playback.md) |
| FR-PLAY-009 | C-PROV, C-PLAY | Best-effort `reportPlayback` on start, progress, stop | LLD-PROV |
| FR-PROG-001 | C-PLAY, db | Progress upsert per `(user, canonical item)`; client reports on interval and events | LLD-SCHEMA, LLD-API |
| FR-PROG-002 | C-WEB | Client reads stored position, prompts resume, passes position to player | LLD-API |
| FR-PROG-003 | C-PLAY | BR-7 threshold evaluated on each report; manual toggle command | LLD-API |
| FR-PROG-004 | C-CAT | Next-episode query over series ordering and watched state | LLD-API |
| FR-USR-001 | C-AUTH, C-API | One session middleware guards every route except setup, redeem, login, health and static assets (INV-9); WebAuthn login creates the session | [ADR-0014](../adr/0014-passkey-auth-with-invite-links.md), LLD-API |
| FR-USR-002 | C-AUTH | Invite redemption (WF-7) is the only account-creation path; `/setup` with `SETUP_TOKEN` creates the first operator and is refused once an operator exists | [ADR-0014](../adr/0014-passkey-auth-with-invite-links.md), LLD-SCHEMA |
| FR-USR-003 | C-AUTH, C-API | Role check in command handlers and an operator-only route guard | LLD-API |
| FR-USR-004 | C-AUTH, C-API, db | Invite commands (create, list, revoke) and user commands (disable, enable, delete) with BR-8 guard, immediate session revocation and cascade | LLD-SCHEMA, LLD-API |
| FR-USR-005 | C-AUTH, db | Grants table user x library; defaults chosen at invite | LLD-SCHEMA |
| FR-USR-006 | C-AUTH, C-WEB | Sign-out command revokes the current session; passkey list, add and remove commands refuse removing the last passkey | LLD-API |
| FR-USR-007 | C-AUTH | Re-enrollment link is an invite-style token (24 h, single-use) that adds a passkey to an existing user; the documented `wrangler`-run recovery command issues one for a locked-out operator | [ADR-0014](../adr/0014-passkey-auth-with-invite-links.md), LLD-API |
| FR-OPS-001 | C-HEALTH | Cron probe job per server writes probe rows and derived status | LLD-SYNC |
| FR-OPS-002 | C-PLAY | Health state feeds the selection filter and rank key 4 | LLD-SEL |
| FR-OPS-003 | C-API, C-WEB | Sync status endpoint and admin view over `sync_run` and schedule | LLD-API |
| FR-OPS-004 | C-API, C-WEB | Probe history endpoint and admin view | LLD-API |
| FR-OPS-005 | C-API, db | Command handlers append audit rows (INV-5) | LLD-SCHEMA |
| FR-OPS-007 | C-API | Public route returns only overall status; operator-only route returns detail such as the DB ping | LLD-API |
| FR-OPS-008 | release process, deployment | Tagged releases plus self-host guide (Deploy to Cloudflare or `wrangler`); each instance has its own Worker, D1 and secrets; first-run setup through FR-USR-002 | [HLD](HLD.md) Section 8, [ADR-0011](../adr/0011-single-operator-deployment-model.md), [TDD](TDD.md) |

### 7.2 Interface, data

| Req | Components | Mechanism | LLD / ADR |
|---|---|---|---|
| IR-001 | C-API | Hono under `/api/v1`, request-ID middleware, one error envelope | LLD-API, LLD-ERR |
| IR-002 | C-PROV | `MediaProvider` interface and dependency rules (Section 2) | [ADR-0004](../adr/0004-provider-adapter-abstraction.md), LLD-PROV |
| IR-003 | C-PROV | Jellyfin adapter, version minimum fixed by M1 spike | LLD-PROV |
| IR-004 | C-PROV | Emby adapter, version minimum fixed by M1 spike | LLD-PROV |
| IR-005 | C-PROV | Plex adapter, version minimum fixed by M1 spike | LLD-PROV |
| IR-006 | C-AUTH, C-WEB | Browser `navigator.credentials` calls; server verification by a vetted library in `auth/webauthn`; RP ID is the deployment hostname | [ADR-0014](../adr/0014-passkey-auth-with-invite-links.md), [TDD](TDD.md) |
| IR-007 | C-WEB | `<video>` for direct play; native HLS or hls.js | [TDD](TDD.md) |
| DR-001 | db | D1 as system of record; primary vs derived separation (INV-8) | [ADR-0006](../adr/0006-d1-system-of-record.md), LLD-SCHEMA |
| DR-002 | C-CRYPTO | AES-256-GCM envelope, key from Worker secret, key version stored with ciphertext | [ADR-0008](../adr/0008-origin-service-accounts-and-credential-encryption.md), LLD-TOKEN |
| DR-003 | C-SYNC | Scheduled retention purge by table and age (configuration values) | LLD-SYNC |
| DR-004 | db | Forward-only migrations; expand, migrate, contract | LLD-SCHEMA, [TDD](TDD.md) |
| DR-005 | db | Cascading deletes in schema plus explicit steps for audit anonymization and orphan item removal | LLD-SCHEMA |

### 7.3 Nonfunctional

| Req | Components | Mechanism | LLD / ADR |
|---|---|---|---|
| NFR-SEC-001 | C-CRYPTO, C-PROV, C-API | INV-2; log redaction; export excludes secrets | [ADR-0008](../adr/0008-origin-service-accounts-and-credential-encryption.md), LLD-TOKEN |
| NFR-SEC-002 | C-AUTH, C-CAT | Per-request user context; ID-addressed reads re-check access | LLD-API |
| NFR-SEC-003 | C-API | HSTS and CSP middleware; `media-src`/`connect-src` built from registered server hostnames | LLD-API |
| NFR-SEC-004 | C-API | Per-user rate limit middleware on play, progress, mutations; per-IP limits on setup, redeem and login (mechanism chosen in TDD/LLD) | [TDD](TDD.md), LLD-API |
| NFR-SEC-005 | C-PROV | Single outbound helper pinned to registered host; redirects refused (INV-7) | LLD-PROV |
| NFR-SEC-007 | C-AUTH, C-API | Session cookie attributes, hashed session and token storage, expiries, single-use challenges, `Origin` check in the session middleware (INV-9, INV-10) | [ADR-0014](../adr/0014-passkey-auth-with-invite-links.md), LLD-TOKEN |
| NFR-SEC-006 | CI | Dependency and secret scanning in pipeline | [TDD](TDD.md) |
| NFR-PRIV-001 | db, C-WEB | Minimal user columns; no third-party scripts; CSP blocks them | [TDD](TDD.md), LLD-SCHEMA |
| NFR-PERF-001 | C-CAT, db | Indexed queries, keyset pagination, FTS index, denormalized columns | LLD-SCHEMA |
| NFR-PERF-002 | C-PLAY | Selection from one D1 read set; bounded origin timeouts; at most two origin calls typical | LLD-SEL, LLD-ERR |
| NFR-PERF-003 | C-WEB | Route-level code splitting; player loaded lazily | [TDD](TDD.md) |
| NFR-SCALE-001 | all | Sizing and cost estimate in [HLD](HLD.md) Section 11; bounded jobs, indexed queries | [HLD](HLD.md) |
| NFR-REL-001 | C-CAT, C-SYNC | Catalog served from D1 only; no origin call on browse paths | [ADR-0006](../adr/0006-d1-system-of-record.md) |
| NFR-REL-002 | C-SYNC, C-PROV | Backoff with jitter and bounded attempts via injected clock and random | LLD-SYNC, LLD-ERR |
| NFR-REL-003 | db | Time Travel restore procedure; export; rehearsal on staging | [TDD](TDD.md), [HLD](HLD.md) Section 10 |
| NFR-COST-001 | C-SYNC, C-PLAY | No stream bytes through Cloudflare; skip-unchanged writes limit D1 cost | [ADR-0002](../adr/0002-cloudflare-control-plane-origins-deliver-media.md), [HLD](HLD.md) |
| NFR-COMP-001 | deployment | Origin hostnames must be non-proxied; documented in setup guide; no video routes | [ADR-0002](../adr/0002-cloudflare-control-plane-origins-deliver-media.md), [HLD](HLD.md) Section 8 |
| NFR-A11Y-001 | C-WEB | Semantic components, keyboard-operable player, captions support | [TDD](TDD.md) |
| NFR-COMPAT-001 | C-WEB | Browser matrix in end-to-end tests; HLS fallback via hls.js | [TDD](TDD.md) |
| NFR-OBS-001 | platform, C-API | Structured JSON logger with request ID and user ID; redaction | [TDD](TDD.md), LLD-ERR |
| NFR-OBS-002 | platform | Metrics from structured logs or D1 counters (mechanism decided in TDD) | [TDD](TDD.md) |
| NFR-MAINT-001 | providers | Strict TypeScript; contract-test suite per adapter on recorded fixtures | [TDD](TDD.md) |
| NFR-MAINT-002 | process | Docs updated with behaviour (AGENTS.md) | [TDD](TDD.md) |
| NFR-MAINT-003 | release process, db | SemVer tags with release notes; upgrade applies pending forward-only migrations (DR-004) per the self-host guide | [TDD](TDD.md), LLD-SCHEMA |
| NFR-TEST-001 | CI | Pipeline stages per requirement | [TDD](TDD.md) |

## 8. Open design items

| ID | Item | Home |
|---|---|---|
| OD-1 | Rate-limiting mechanism. **Closed:** the Workers rate limiting binding ([TDD](TDD.md)). | NFR-SEC-004, [TDD](TDD.md) |
| OD-2 | Queue topology. **Closed:** one jobs queue with typed messages plus a dead-letter queue. Health probes run inline in a cron handler, with two cron triggers (LLD-SYNC). | LLD-SYNC |
| OD-3 | Closed: Access removed (ADR-0014). Passkeys work on localhost, so no dev bypass is needed. | [ADR-0014](../adr/0014-passkey-auth-with-invite-links.md) |
| OD-4 | Server URL host restrictions. **Closed:** IP-literal and local or internal hostnames are blocked outside local mode. Resolved private IPs are an accepted residual risk (LLD-PROV). | LLD-PROV |
