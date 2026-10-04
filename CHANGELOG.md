# Changelog

All notable changes to Cinewren are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). Release rules: [TDD §9.1](docs/design/TDD.md).

## [Unreleased]

### Added

- **Master-key rotation (SR-07, DR-002).** `POST /api/v1/admin/vault/rotate` queues a `reencrypt` job that moves server credentials, cached service tokens, play-session credentials and sealed idempotency responses to `CREDENTIAL_KEY_CURRENT` in batches, resumably and idempotently. `GET /api/v1/admin/vault/status` reports rows per key version and whether an old key can be removed. Rotation is audited as `vault.rotate`. The procedure is in the self-host and setup guides.

## [0.1.0] - 2026-10-04

First tagged release: the work of milestones M0 to M5 so far. This is a pre-1.0 release; the v1.0
gate is ROADMAP M5. Initial schema: migrations `0001` to `0003`.

### Added

- **Foundations (M0).** pnpm monorepo (React SPA, Hono Worker with Static Assets, shared types),
  CI, a docs consistency check, D1 schema v1, passkey-only authentication with a one-time
  `/setup` and operator invite links, session handling and an Origin check, per-IP auth rate
  limits, request IDs, a uniform error envelope, structured logging, security headers and
  `GET /api/v1/health`.
- **Providers and servers (M1).** The `MediaProvider` interface with a recorded-fixture contract
  suite, an AES-256-GCM credential vault with versioned keys, the Jellyfin adapter, and server
  registration with validation (non-admin service accounts, public HTTPS origins only).
- **Catalog (M2).** Cron and Queues sync with checkpointed runs, normalization, external-ID
  matching, a permission-filtered catalog query layer, FTS5 search, an artwork proxy with edge
  cache, people and collections, user lifecycle and library grants, the web UI (home, browse,
  search, detail, sync status), dark and light themes, and a Playwright E2E harness.
- **Playback (M3).** Device capability detection, source selection with failover, session-scoped
  stream credentials with expiry and revocation sweeps, a player for direct play and HLS,
  progress, resume and next-episode, and a "why this copy" explanation.
- **Emby and Plex (M4, in progress).** Plex adapter work and provider parity.
- **Operations (M5, in progress).** Server health probing and health-aware selection, per-user
  rate limits, retention jobs and the operator health view.
- **Self-hosting (T5.5).** `docs/operations/self-host.md`, a self-host `wrangler.jsonc` with no
  account IDs, a Deploy to Cloudflare button, `.dev.vars.example`, `pnpm run deploy` and
  `pnpm run migrate`, a tag-triggered release workflow, and an upgrade rehearsal
  (`pnpm check:upgrade`).
- **Upgrade safety.** The `MIGRATIONS_PENDING` guard: when the D1 schema is behind the code, API
  routes return 503 `MIGRATIONS_PENDING` and `GET /api/v1/health` reports `degraded`.

### Migrations

- `0001_init.sql`: schema v1.
- `0002_sources_meta.sql`: per-source display metadata.
- `0003_stream_device_leases.sql`: stream DeviceId pool leases.

### Upgrade notes

Fresh installs only; there is nothing to upgrade from. Later releases list their migrations here
and in the GitHub Release.

[Unreleased]: https://github.com/zemdregon/media-frontend/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/zemdregon/media-frontend/releases/tag/v0.1.0
