# ADR-0005: Single Worker, TypeScript stack

## Status

Accepted

## Date

2026-10-04

## Deciders

Agent under delegation (2026-10-04); owner review pending. The owner's concept suggests Workers with Static Assets and D1 (C-1); the language, frameworks and tooling below are agent decisions.

## Context

Cloudflare hosts the app (C-1). The deployable must serve a SPA, an API, scheduled jobs (sync, health probes) and queue consumers ([ADR-0009](0009-pull-based-sync-cron-and-queues.md)). Operator effort should be minimal (BO-2, A-1): one project to deploy. Requirements: NFR-MAINT-001 (TypeScript strict), NFR-TEST-001, IR-001, NFR-PERF-003.

Workers limits (checked 2026-10-04, <https://developers.cloudflare.com/workers/platform/limits/>): Free plan allows 10 ms CPU and 50 external subrequests per invocation and 5 cron triggers per account; Paid defaults to 30 s CPU, 10,000 subrequests, 15 min cron/queue consumer duration. Sync pages through origins and writes D1, which does not fit the Free limits (A-5).

## Decision

- One Worker project (one `wrangler` config) with `fetch`, `scheduled` and `queue` handlers, serving the SPA through Workers Static Assets.
- API: Hono router under `/api/v1`, with request ID, a single error envelope and security headers (IR-001, NFR-SEC-003).
- Web: React + TypeScript SPA built with Vite; `<video>` plus hls.js for HLS (IR-007).
- TypeScript in strict mode everywhere. pnpm for packages.
- Tests: Vitest, with `@cloudflare/vitest-pool-workers` for Workers-runtime integration; Playwright for end-to-end from M2 (NFR-TEST-001).
- Environments: local (`wrangler dev`, local D1), staging, production, each with separate D1 and Access apps.
- The operator needs the Workers Paid plan (A-5).

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Cloudflare Pages + Functions | Cloudflare's direction for new projects is Workers with Static Assets (to verify against current docs before M0). Pages Functions have no first-class queue consumer in the same project. |
| Separate API Worker and UI Worker | Two deployables, service bindings, version skew between UI and API, double config for one operator. Reconsider only if scaling or ownership splits. |
| Next.js / Remix / SvelteKit full-stack frameworks | Server rendering is not needed for an authenticated app behind Access; adapter layers add runtime risk on Workers and bundle size. A plain SPA plus API is simpler to test. |
| Run on Node (VPS/containers) | Forfeits the serverless, low-ops outcome (BO-2) and C-1. |
| Free plan only | Insufficient CPU/subrequest/cron limits for sync (see Context). |

## Consequences

- Positive: one deploy, one version, atomic UI/API releases; cron and queue handlers share code with the API.
- Negative: a single Worker bundle limits isolation; a bug in one handler affects the deploy unit. Per-server sync isolation is therefore done in the queue design, not by process.
- Negative: operators must pay for Workers Paid (base fee; see NFR-COST-001).
- Neutral: Hono, Vite, Vitest versions to be pinned in M0.

## Revisit when

- Bundle size or startup time approach Worker limits.
- Sync load needs a separate consumer with different limits.
- Cloudflare changes Workers Static Assets or the Pages/Workers guidance.

## Related

- IR-001, IR-007, NFR-MAINT-001, NFR-TEST-001, NFR-PERF-003, NFR-SCALE-001 in [SRS](../requirements/SRS.md)
- [ADR-0006](0006-d1-system-of-record.md), [ADR-0009](0009-pull-based-sync-cron-and-queues.md), [ADR-0011](0011-single-operator-deployment-model.md)
- [HLD](../design/HLD.md), [TDD](../design/TDD.md), [ROADMAP](../ROADMAP.md) (M0)
