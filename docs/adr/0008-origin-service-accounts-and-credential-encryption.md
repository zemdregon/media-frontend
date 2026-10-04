# ADR-0008: Origin service accounts and credential encryption

## Status

Accepted

## Date

2026-10-04

## Deciders

Agent under delegation (2026-10-04); owner review pending.

## Context

Cinewren calls origins from the Worker for validation, sync, playback negotiation and progress reporting (TB-3). That needs stored origin credentials. Compromise of Cinewren's database must not hand over origin admin control (NFR-SEC-001, BR-6). The operator controls each origin enough to create a dedicated account (A-2). Exact token mechanics per provider are not verified (to verify in M1 spike).

Workers secrets are encrypted bindings set with `wrangler secret put`; `secrets.required` in config validates presence on deploy; secrets must never be placed in `vars` (Cloudflare docs, checked 2026-10-04).

## Decision

- Each registered origin uses a **dedicated, non-admin service account** with access limited to the libraries the operator wants shared (FR-SRV-003). Admin credentials are rejected where detectable (to verify in M1 spike); the setup guide forbids them.
- Credentials are stored in D1 encrypted with AES-256-GCM. The key is a Worker secret, never in `vars`, repo or logs. Each ciphertext records a key version so keys can be rotated (DR-002). A fresh random nonce is used per encryption.
- Decrypted credentials exist only in Worker memory for the duration of an outbound call. They never reach browsers, logs, errors or exports (NFR-SEC-001, BR-6). Exports omit secrets (FR-OPS-006).
- Credential replacement does not lose catalog data (FR-SRV-005). Key rotation re-encrypts rows with the new version.
- Outbound calls go only to the registered host; cross-host redirects are refused (NFR-SEC-005). HTTPS is required (FR-SRV-007).

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Reuse the operator's admin account/token | Compromise gives full origin control; far larger blast radius. |
| Per-viewer origin accounts | Needs account provisioning on every origin for every viewer; contradicts federated model and A-2 simplicity. Per-session credentials are handled in [ADR-0013](0013-session-scoped-origin-stream-credentials.md). |
| Store credentials plaintext in D1 | Database export or backup leak equals credential leak. |
| Workers secrets only (one secret per origin) | Secrets are set via deploy tooling, not through the app; cannot register servers at runtime (FR-SRV-001) and the number is bounded by config. |
| Cloudflare Secrets Store | Newer product; availability and plan terms not verified (to verify in M0). Possible later replacement for the master key. |

## Consequences

- Positive: a database leak alone yields only ciphertext; a stolen service credential is limited to non-admin read access.
- Negative: the master key becomes critical. Loss of it makes stored credentials unrecoverable (operator must re-enter them); the key must be backed up outside Cloudflare, and the setup guide must say so.
- Negative: rotation needs a re-encryption job and careful ordering (expand, migrate, contract).
- Obligation: log scrubbing and tests asserting that credentials never appear in responses or logs (NFR-SEC-001).

## Revisit when

- Cloudflare Secrets Store (or similar) is verified suitable for the master key.
- A provider cannot offer a non-admin service account with the needed access.
- Q-1 resolves to multi-operator hosting (per-tenant keys).

## Related

- FR-SRV-001, FR-SRV-005, FR-SRV-007, DR-002, NFR-SEC-001, NFR-SEC-005, BR-6 in [SRS](../requirements/SRS.md)
- [ADR-0013](0013-session-scoped-origin-stream-credentials.md), [ADR-0004](0004-provider-adapter-abstraction.md)
- [LLD](../design/LLD.md) (LLD-TOKEN), [ROADMAP](../ROADMAP.md) (M1)
