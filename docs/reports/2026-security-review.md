# Cinewren — v1.0 security review (T5.8)

| | |
|---|---|
| **Status** | Complete. No open critical or high findings. Three medium-or-lower items are open with recommendations; the items in [§8](#8-items-that-need-owner-acceptance) wait for an owner decision but do not block T5.8. |
| **Date** | 2026-10-04 |
| **Reviewer** | Agent under delegation. **This is not a third-party audit.** |
| **Roadmap task** | [T5.8](../ROADMAP.md#m5--hardening-self-host-packaging-and-v10--planned), against the threat model in [HLD §10](../design/HLD.md#10-threat-model-concise) |
| **Code reviewed** | Branch `c/laughing-dirac-nh2651` at `128cb03`, plus the fixes in this change |

## 1. Scope

In scope: `apps/worker` (every route, middleware, service, D1 query, provider adapter, the vault, the cron and queue handlers), `apps/web` (rendering of origin-supplied data, URL handling, third-party requests) and `packages/shared` (request schemas). Also `wrangler.jsonc` (self-host, repository root), `apps/worker/wrangler.jsonc` (maintainer local, staging and production), `.gitignore`, `.dev.vars.example`, the CI workflow and the dependency tree.

Requirements and design checked against: NFR-SEC-001 to NFR-SEC-008, NFR-PRIV-001, FR-PLAY-007, FR-PLAY-008, BR-1, DR-002, DR-005; [ADR-0002](../adr/0002-cloudflare-control-plane-origins-deliver-media.md), [ADR-0008](../adr/0008-origin-service-accounts-and-credential-encryption.md), [ADR-0013](../adr/0013-session-scoped-origin-stream-credentials.md) and [ADR-0014](../adr/0014-passkey-auth-with-invite-links.md) with their amendments; LLD-TOKEN, LLD-API, LLD-ERR and their implementation notes; the [provider spike](../spikes/2026-provider-spike.md).

Out of scope: the origin servers themselves, the operator's DNS, TLS and reverse proxy, Cloudflare's platform, and `apps/e2e`, `scripts/perf` (owned by the concurrent T5.7 work). No live deployment was tested and no penetration test was run.

## 2. Method

1. Read the threat model, trust boundaries TB-1 to TB-5 and data flows DF-1 to DF-6 in the [HLD](../design/HLD.md), and listed the control each threat relies on.
2. Manual code review of every request path, from the route table in `apps/worker/src/api/app.ts` through middleware order (request ID, security headers, schema guard, config, `Origin` check, public routes, session guard, per-user limiter, operator guard) to each service and its SQL.
3. Targeted searches across the code: SQL built with template strings (all interpolations are constants or placeholder names), FTS `MATCH` input, `dangerouslySetInnerHTML`, `href`/`src` built from data, `console.*` and every logger call that could carry a secret, every `fetch`, every place a credential is decrypted.
4. Cross-checked each LLD statement about revocation, sweeping, hashing and atomicity against the code that implements it. Two of the high findings came from this step: the LLD said "revoking open sessions comes first", and the code did it afterwards or not at all.
5. `pnpm audit` (result: "No known vulnerabilities found"), a git history search for committed secrets (none), and a review of the CI `audit` and `secret-scan` jobs.
6. Each finding fixed here has a regression test that fails on the old code. That was confirmed by running the new tests against the unfixed files.

Severity uses a CVSS-like reading: attack vector, privileges required, user interaction, and impact on confidentiality, integrity and availability. It is adjusted for this deployment model: a single operator, a small invited group, and origins whose session tokens carry the service account's full non-admin scope (ADR-0013 correction).

## 3. Threat-model coverage

Each row is a threat from [HLD §10](../design/HLD.md#10-threat-model-concise).

| Threat (boundary) | Controls in code | Evidence | Verdict |
|---|---|---|---|
| Stolen or shared stream URL (TB-4) | A per-session token is minted per play: a unique DeviceId on Jellyfin, a leased pool slot on Emby. Jellyfin uses HLS only, never `static=true`. Stop is reported, then the token is revoked, on stop, replacement, expiry and failure. The BR-9 sweep retries pending revocations. Plex is excluded from selection while `playbackVerified` is false. | `playback/lifecycle.ts`, `playback/service.ts`; `test/playback/play.test.ts` (token rejected after stop, replacement, unstarted expiry and idle expiry) | **Holds after fixes.** User delete and disable (SR-01), server removal (SR-02) and loss of access mid-session (SR-06) previously left tokens valid. SR-09 and the accepted token-scope residual (SR-20) remain. |
| Service credential leak through logs, errors, exports or the browser (TB-3, TB-5) | AES-256-GCM envelopes with a fresh 96-bit IV and AAD `cinewren\|purpose\|rowId`; non-extractable keys. The logger redacts sensitive keys and strips query strings from URLs. The error envelope never echoes origin text. The export uses explicit column lists. Play descriptors are sealed before they are stored for idempotency. Artwork responses copy no origin header. | `vault/vault.ts`, `platform/logger.ts`, `api/errors.ts`, `ops/service.ts`; `test/vault.test.ts`, `test/logger.test.ts`, `test/ops.test.ts` (export has no secrets), `test/playback/play.test.ts` (no token or password in D1 rows) | **Holds.** Rotation tooling is now wired (SR-07). |
| IDOR across libraries (TB-2, TB-5) | One BR-1 predicate (`visibleItem`, `visibleSource`, `visiblePerson`, `visibleCollection`) is bound into every catalog, artwork, playback and progress query. Session events and progress are keyed by `user_id`. Hidden and unknown resources both return 404. | `db/catalog.ts`, `db/playback.ts`; `test/catalog.test.ts`, `test/sync/visibility.test.ts`, `test/artwork.test.ts`, `test/playback/play.test.ts` | **Holds after fix.** BR-1 is now also enforced on every session event (SR-06). Minor metadata disclosures: SR-12, SR-13. |
| SSRF via server URL (TB-3) | HTTPS only. Outside local mode, IP literals, `localhost`, `*.local`, `*.internal`, `*.home.arpa`, single-label names, userinfo, query and fragment are refused. All origin I/O goes through one host-pinned fetch with `redirect: 'manual'`, at most 3 same-origin hops, and timeouts. Identity is checked before credentials are sent. Only operators can register servers. | `providers/url-policy.ts`, `providers/origin-fetch.ts`; `test/providers/origin-fetch.test.ts`, `test/servers.test.ts` | **Holds.** DNS names that resolve to private ranges stay an accepted residual (SR-11). |
| Hostile origin metadata or XSS (TB-3) | React renders text only. There is no `dangerouslySetInnerHTML` and no data-built `href` other than internal, `encodeURIComponent`-encoded paths. Stream and subtitle URLs must match the origin's scheme and host. CSP is `script-src 'self'` with `base-uri 'none'` and `frame-ancestors 'none'`. Artwork content types are allowlisted (no SVG) and capped at 10 MB. | `apps/web/src`, `playback/service.ts` (`onOriginHost`), `api/middleware/security-headers.ts`, `artwork/proxy.ts`; `test/csp.test.ts`, `test/artwork.test.ts` | **Holds.** |
| Invite link leaked or forwarded (TB-1) | 256-bit tokens, stored as SHA-256 only, carried in the URL fragment. A compare-and-set redeem is guarded inside one batch. Expiry is 7 days for signup and 24 hours for re-enrollment. Operators can revoke. Every failure returns one `INVITE_INVALID` code. | `auth/invites.ts`, `db/auth.ts`; `test/auth.test.ts` | **Holds.** Expired invitees are now swept (SR-03). |
| Session cookie theft (TB-2) | `__Host-cw_session` cookie: `HttpOnly; Secure; SameSite=Lax; Path=/`. The 256-bit ID is stored hashed. Idle expiry is 14 days and absolute 90; the idle window slides at most hourly. The session row is deleted on logout, passkey removal, disable and delete. Role and status are re-read from `users` on every request. | `auth/sessions.ts`, `db/auth.ts`; `test/auth.test.ts`, `test/users.test.ts` | **Holds after fix.** A stolen cookie can no longer enroll a new passkey without a fresh passkey assertion (SR-04). Users cannot list their sessions (SR-15). |
| Brute force or enumeration on public auth endpoints (TB-1) | `RL_AUTH` allows 10 requests per minute per IP on setup, invite and login. Challenges are single use (deleted first, with `DELETE … RETURNING`). Login failures look alike (one 401). Setup-disabled and bad-token are both 404. | `api/middleware/rate-limit.ts`, `auth/webauthn.ts`, `auth/setup.ts`; `test/auth.test.ts` (real binding wired) | **Holds.** Timing note: SR-10. |
| `SETUP_TOKEN` leak before setup (TB-1) | Constant-time compare of hashes. The first-operator insert is guarded by `NOT EXISTS`, so concurrent setups cannot both win (the passkey insert's foreign key aborts the loser's batch). Setup is disabled once any operator exists. | `auth/setup.ts`, `auth/tokens.ts`, `db/auth.ts`; `test/auth.test.ts` | **Holds** (residual as stated in the HLD). |
| Phishing (TB-1) | WebAuthn checks the expected origin and RP ID and requires user verification. `RP_ID` must equal the `APP_ORIGIN` host or a parent of it, checked fail-closed at config load. | `auth/webauthn.ts`, `platform/config.ts` | **Holds.** |
| Abuse of the play endpoint (TB-3) | `RL_PLAY` allows 60 per minute and `RL_MUTATION` 600 per minute, per user. `Idempotency-Key` is required on play. At most 2 candidates are tried, with a 5 s origin timeout. The Emby DeviceId pool is bounded. | `api/middleware/rate-limit.ts`, `playback/idempotency.ts`; `test/ops.test.ts` | **Holds.** Own-account writes now also count (SR-08). |
| D1 data loss or corruption (TB-5) | Batches are atomic. Compare-and-set and guard statements protect transitions. Migrations are forward-only and guarded. BR-8 is enforced in the statement. | `db/*.ts`; `test/migrations-guard.test.ts`, `test/users.test.ts` | **Holds** (the restore rehearsal is T5.6, not this review). |
| Cache poisoning or cross-user artwork leak (TB-3) | Permission is checked before any cache lookup. The key holds no user identity. Only image types are cached. | `artwork/proxy.ts`; `test/artwork.test.ts` | **Holds after fix.** The key now includes the source server (SR-05). |

Additional areas the brief named:

| Area | Result |
|---|---|
| CSRF | `originCheck` runs on every `/api/*` request whose method is not GET, HEAD or OPTIONS. That covers the public auth routes, play, events, progress, curation and every admin route. A missing `Origin` is refused. Bodies must be `application/json`, which also rules out form posts. No GET changes state. |
| Operator guard | `requireOperator` is mounted on `/api/v1/admin/*` after the session guard. No admin path is reachable through the catalog or playback routers, which are mounted earlier. `test/auth.test.ts` asserts 403 for viewers. |
| Last-operator protection | Guard statements cover `UPDATE` and `DELETE`. `remove` now also pre-checks before touching any playback (SR-01). |
| SQL injection | Every value is bound. Template interpolation is used only for constant fragments (the predicates, a column chosen from a two-value union, `SORT_KEY` from a zod enum). FTS input is reduced to letter and digit tokens, each quoted (`ftsMatch`). |
| CSP | Correct for the threat. Documents list only registered, exposed origins under `media-src` and `connect-src`; JSON and images get the `'self'` policy; a failed lookup falls back to `'self'`. HSTS, `nosniff`, `Referrer-Policy: no-referrer` and COOP are set. |
| Queues | Only the Worker can produce messages. Unknown shapes are acknowledged and logged. Sync runs are claimed through leases. See SR-17. |
| DR-005 | User delete anonymizes audit references and cascades everything else. Server removal hides the server, deletes its credentials and purges in chunks. Credential revocation now happens first (SR-01, SR-02). |
| Privacy (NFR-PRIV-001) | No email is collected. The SPA loads no third-party script, font or analytics; fonts are bundled from `@fontsource`. The user agent is stored only as a coarse "Browser on OS" hint. |
| Dependencies (NFR-SEC-006) | `pnpm audit`: no known vulnerabilities. CI runs `pnpm audit --audit-level high` and gitleaks on every PR. |
| Configuration | `.dev.vars` and `.env*` are git-ignored, and `.dev.vars.example` holds no values. The root `wrangler.jsonc` holds no account IDs and requires `CREDENTIAL_KEYS`. `SETUP_TOKEN` is intentionally optional. The staging D1 ID and hostname are committed; they are not secrets. See SR-18 for the maintainer config's top level. |

## 4. Findings

| ID | Title | Severity | Location | Status |
|---|---|---|---|---|
| SR-01 | User delete and disable left origin stream credentials valid | **High** | `apps/worker/src/users/service.ts:182, :200` | **Fixed** |
| SR-02 | Server removal deleted the credentials that revocation needs | **High** | `apps/worker/src/servers/purge.ts:193, :210` | **Fixed** |
| SR-03 | `sweepAuth` was never implemented | Medium | `apps/worker/src/db/auth.ts:518`, `apps/worker/src/index.ts:50` | **Fixed** |
| SR-04 | Adding a passkey needs only a session, with no fresh authentication | Medium | `apps/worker/src/auth/passkeys.ts:40, :54` | **Fixed** (this change) |
| SR-05 | Artwork cache key ignored the source server | Low | `apps/worker/src/artwork/proxy.ts:160` | **Fixed** |
| SR-06 | A live playback session outlived the loss of access (BR-1) | Medium | `apps/worker/src/playback/service.ts:423` | **Fixed** |
| SR-07 | Master-key rotation is not wired | Low | `apps/worker/src/sync/jobs.ts:45`, `apps/worker/src/vault/rotation.ts` | **Fixed** |
| SR-08 | Own-account writes were not rate limited | Low | `apps/worker/src/api/middleware/rate-limit.ts:32` | **Fixed** |
| SR-09 | Revocation at user delete or server removal is best effort when the origin is down | Low | `apps/worker/src/users/service.ts:205`, `apps/worker/src/servers/purge.ts:193` | Open (residual) |
| SR-10 | Login timing differs for an unknown credential | Info | `apps/worker/src/auth/login.ts:33` | Accepted |
| SR-11 | Hostnames that resolve to private ranges cannot be blocked | Info | `apps/worker/src/providers/url-policy.ts:64` | Accepted (LLD-PROV) |
| SR-12 | Item detail shows the metadata source's fields even when that copy is hidden | Info | `apps/worker/src/db/catalog.ts:286` | Open |
| SR-13 | Person and collection art may come from a server the viewer is not granted | Info | `apps/worker/src/db/catalog.ts:637` | Open |
| SR-14 | Service-account admin status is checked only at validation | Info | `apps/worker/src/providers/plex.ts:132`, `apps/worker/src/providers/mediabrowser.ts:228` | Open |
| SR-15 | `GET`/`DELETE /me/sessions` (LLD-API) is not implemented | Info | `apps/worker/src/api/routes/me.ts:34` | Open |
| SR-16 | Setup verify does not bind the display name to the options call | Info | `apps/worker/src/auth/setup.ts:46` | Accepted |
| SR-17 | Queue message validation is shallow | Info | `apps/worker/src/sync/jobs.ts:53` | Accepted |
| SR-18 | The maintainer config's top level is local mode | Info | `apps/worker/wrangler.jsonc` (top-level `vars`) | Open |
| SR-19 | Crash window between minting and recording a Jellyfin token | Info | `apps/worker/src/playback/service.ts` (`attempt`) | Accepted (LLD-TOKEN M3 notes) |
| SR-20 | A stream token carries the service account's full non-admin scope | Info | Provider behaviour; ADR-0013 correction | Accepted (ADR-0013) |

Counts: critical 0, high 2, medium 3, low 4, info 11. Fixed: 8 (both highs, all three mediums, three lows). SR-04 and SR-07 were fixed after the review, in follow-up changes, on owner decision 2026-10-04.

### SR-01 — User delete and disable left origin stream credentials valid (High, fixed)

- **Rationale:** AV:N/AC:L/PR:L/UI:N, confidentiality high. Base score about 6.5, raised to high for two reasons: the token's scope is wider than the user's grants (origins do not enforce library grants, SRS NFR-SEC-002), and the bug defeats Must controls FR-PLAY-007, FR-USR-008 and DR-005.
- **Problem:** `DELETE /admin/users/{id}` cascaded `playback_sessions` in the same batch, and nothing revoked first. LLD-SCHEMA says "Before the batch runs, any live sessions are revoked". The rows that held the sealed token were gone, so neither the call nor the sweep could ever revoke it. Jellyfin tokens have no default lifetime, so the token stayed valid indefinitely. Disabling a user deleted their auth sessions but left playback sessions live, so a token stayed valid until the BR-9 idle expiry, up to 4 hours.
- **Exploit:** a viewer the operator is about to remove starts a play, copies the `ApiKey` from the stream URL, and keeps using it against the origin API after deletion. They can browse and stream every library the service account can see, including libraries they were never granted.
- **Fix:** `revokeAllSessions(deps, {userId}, reason)` in `playback/lifecycle.ts` ends every live session and revokes every credential still held: stop first, then logout. `remove` pre-checks BR-8, so the last operator is refused before anything is touched, then revokes, then runs the delete batch. `update` revokes after a successful disable; failures stay `revoke_pending` for the sweep.
- **Tests:** `test/playback/play.test.ts`, "T5.8 security review regressions": SR-01 delete, last operator, and disable.

### SR-02 — Server removal deleted the credentials that revocation needs (High, fixed)

- **Rationale:** same impact class as SR-01. The attack complexity is higher, because the attacker needs a live session at removal time, but the bug guarantees failure exactly when an operator removes a server because something went wrong.
- **Problem:** `startServerRemoval` set `revoke_pending = 1` and deleted `server_credentials` in the same batch. A code comment said "M3 revokes these". The sweep's `revokeSession` then found no credentials (`PlaybackUnavailableError`). It retried for 24 hours and abandoned, or found the server row purged and cleared the envelope. The origin token was never revoked.
- **Exploit:** as SR-01, for every viewer who was playing from the removed server.
- **Fix:** revoke every credential-holding session of the server first, while the credentials exist. Then run the original batch. Anything still unrevoked is logged as `playback.revoke_abandoned`.
- **Tests:** `test/playback/play.test.ts`, "SR-02: removing a server revokes its live credentials…". `test/users.test.ts` now asserts that the session is ended with `end_reason = 'server_removed'`. The earlier assertion encoded the buggy behaviour.

### SR-03 — `sweepAuth` was never implemented (Medium, fixed)

- **Rationale:** AV:N/AC:L/PR:N, availability low, plus a spec gap. LLD-TOKEN requires the five-minute sweep, and `index.ts` claimed it ran.
- **Problem:** expired WebAuthn challenges and sessions were never deleted. Every unauthenticated `POST /auth/login/options` adds a row, and `RL_AUTH` only slows this per IP, so a distributed client could grow D1 without bound. Users of expired signup invites were never deleted, contrary to the FRD rule, so their display names stayed reserved.
- **Fix:** `sweepAuth(db, now)` in `db/auth.ts` deletes in chunks of 500, at most 20 chunks per step per tick. It is wired as its own task on the five-minute tick.
- **Test:** `test/auth.test.ts`, "T5.8 SR-03: sweepAuth removes expired auth artefacts". Live rows survive and a second run finds nothing.

### SR-04 — Adding a passkey needs only a session (Medium, fixed)

- **Rationale:** AV:N/AC:H/PR:N/UI:N, confidentiality and integrity high, but it requires a stolen `HttpOnly` cookie first, which is AC:H.
- **Problem and exploit:** whoever holds a stolen session cookie can call `POST /me/passkeys/options` and `/verify` with their own authenticator. They then hold a permanent credential, which survives the stolen session's expiry or revocation. For an operator account this is full control.
- **Mitigations present:** the passkey appears in the victim's passkey list, and removing it ends every session created with it (the `sessions.passkey_id` cascade).
- **Recommendation:** require a fresh assertion from an existing passkey in the add-passkey ceremony, or a recent-sign-in window (for example, a session younger than 10 minutes) before options are issued. Audit-log passkey additions for operators. This needs an LLD-API and UX change, so it was not done in this review.
- **Fix (this change; owner decision 2026-10-04, "Require fresh login to register new passkey"):** `POST /me/passkeys/options` and `/verify` answer 401 `REAUTH_REQUIRED` unless the current session completed a user-verified passkey ceremony within the last 5 minutes *(proposed)*. That is the sign-in itself, or the new `POST /me/reauth/options` and `/verify`, an assertion limited to the user's own passkeys that sets `sessions.reauth_at` (migration `0005_session_reauth.sql`). A successful add clears `reauth_at` with a compare-and-set, so each fresh authentication adds one passkey. Removing a passkey is not gated (agent decision): it only reduces access. Settings → Passkeys runs "Confirm it's you" before creating the new passkey. Operator audit logging of passkey additions is not part of this fix.
- **Tests:** `test/auth.test.ts`, "T5.8 SR-04: adding a passkey needs a fresh authentication" (no fresh auth, after re-auth, after 5 minutes, another user's passkey or challenge, sign-in versus re-auth challenges, single use, failed registration, login sets freshness); `apps/web/src/routes/passkeys.test.tsx`.

### SR-05 — Artwork cache key ignored the source server (Low, fixed)

- **Rationale:** confidentiality low. The only bytes that could leak are another copy's artwork for the same title.
- **Problem:** the key was `entity/id/slot/tag`. Plex tags are timestamps, so two copies on different servers can share a tag. A viewer granted only one copy could be served the image cached from the other. An image fetched from a fallback candidate was also stored under the preferred candidate's key.
- **Fix:** the key is now `entity/id/slot/server/tag`. An image is stored only under the key of the candidate that supplied it, and every candidate's key is checked before any origin call.
- **Test:** `test/artwork.test.ts`, "T5.8 SR-05: equal tags on two servers never share a cache entry".

### SR-06 — A live playback session outlived the loss of access (Medium, fixed)

- **Rationale:** AV:N/AC:L/PR:L, confidentiality medium. The control (grant revocation, library or server disable) silently fails to stop an ongoing session.
- **Problem:** BR-1 was checked only at `POST /play`. Events kept a session alive indefinitely: BR-9 expires a session only after 4 hours without a report, so a client sending a progress event every 15 s keeps it forever. The stream token therefore stayed valid after the operator revoked the grant or disabled the library or server. Progress was also still written for the now-hidden item.
- **Fix:** each event re-checks that the session's source is visible to the caller (`sourceStillVisible`, the same BR-1 predicate). If it is not, the session ends with `access_revoked`, the credential is revoked, and the client gets 410 `SESSION_EXPIRED`.
- **Tests:** `test/playback/play.test.ts`, "SR-06" (revoked grant with keep-alives; disabled server).

### SR-07 — Master-key rotation is not wired (Low, fixed)

- **Problem:** `reencryptServerCredentials` and `keyVersionsInUse` exist but nothing calls them, and `reencrypt` queue messages are acknowledged as not handled. LLD notes record this as not yet implemented. `GET /admin/status` cannot yet confirm that an old key is safe to remove. Playback-session and idempotency envelopes, which live at most 4 hours and 24 hours, are not counted either.
- **Impact:** after a master-key leak the operator cannot complete WF-11 without manual work. The blast radius is still bounded by key versioning.
- **Recommendation:** wire the scheduler step (LLD-TOKEN "Rotation"), report `keyVersionsInUse` in `/admin/status`, and document waiting 24 hours after the switch before removing a key.
- **Fix (owner decision 2026-10-04, "build rotation job" before v1.0):** the operator starts rotation with `POST /admin/vault/rotate` (checks that `CREDENTIAL_KEY_CURRENT` is in `CREDENTIAL_KEYS`, counts rows not on it, queues a `reencrypt` job, writes one `vault.rotate` audit row) and reads `GET /admin/vault/status` (rows per key version, `complete`, `missingKeyVersions`, `removableKeyVersions`; never key material). The queue consumer re-encrypts server credentials, cached service tokens, play-session credentials and sealed idempotency responses in bounded batches, with a compare-and-set, and continues by enqueueing its own next slice. Status counts all of those, so the "wait 24 hours" advice became "wait for `complete`". Catalog cursors are sealed with the vault but live minutes and hold no secret, so they are deliberately not re-encrypted. The procedure is in `docs/operations/self-host.md` and `setup.md`.
- **Tests:** `test/vault-rotation.test.ts` (all columns, resume, idempotent re-run, mid-rotation reads, early key removal detected, no key material in responses or logs, operator-only, audit row), plus `test/vault.test.ts`.

### SR-08 — Own-account writes were not rate limited (Low, fixed)

`POST /me/passkeys/options`, `/verify`, `DELETE /me/passkeys/{id}` and `PATCH /me/preferences` were not in any per-user class, so a signed-in user could create challenge rows without limit. They now count against `RL_MUTATION`. Test: `test/ops.test.ts`, "own-account writes use the mutation budget (T5.8 SR-08)".

### SR-09 — Revocation at user delete or server removal is best effort when the origin is down (Low, open)

- **Problem:** if the origin cannot be reached at that moment, the revocation in SR-01 and SR-02 fails. User delete then cascades the rows, and server removal deletes the credentials, so nothing can retry. The event is logged as `playback.revoke_abandoned`. A play that races the removal batch is in the same position.
- **Mitigation:** an unreachable origin usually also means an unusable token, and the operator can rotate or disable the service account on the origin. Disabling a user keeps the rows, so the sweep retries.
- **Recommendation:** keep `server_credentials` until no session of the server holds a credential, letting the purge job delete them last. For users, either keep tombstoned playback rows until revoked, or disable first and delete once revocations clear.

### SR-10 to SR-20 (Info)

- **SR-10:** login returns before signature verification when the credential ID is unknown. Credential IDs are random, 16 or more bytes, so this enables no practical enumeration.
- **SR-11:** a public hostname can resolve to a private or rebinding address. Workers subrequests cannot reach private networks, and only operators register servers (LLD-PROV: accepted residual).
- **SR-12:** for viewers, `ItemDetail` uses the canonical item's metadata source (title, overview, poster tag) even when that copy is on a library they are not granted. It describes the same title and the tag is opaque. Recommendation: prefer a visible source's fields for viewers.
- **SR-13:** `entityArtworkCandidates` picks any provider link on an exposed server, which can be a server the viewer has no grant on. The result is a portrait of a person who is visible to the viewer. Recommendation: restrict to links whose server has a library granted to the caller.
- **SR-14:** a service account that is promoted to administrator on the origin after registration is not noticed until the next validation (credential replacement or re-enable). Recommendation: repeat the admin probe in the health round.
- **SR-15:** users cannot list or end their other sessions. Removing the passkey that created a session ends it. Recommendation: implement the LLD-API endpoints.
- **SR-16:** `setup/verify` takes `displayName` from its own body. The setup token gates the call, so there is no security effect.
- **SR-17:** `isJob` checks only `kind`. Only the Worker can enqueue, and a malformed run ID fails its lookup and is acknowledged.
- **SR-18:** the top level of `apps/worker/wrangler.jsonc` is `ENVIRONMENT=local` (URL policy lifted, insecure origins allowed). A `wrangler deploy` without `--env` would publish it as `cinewren`. It fails closed: `APP_ORIGIN` is `http://localhost:8787`, so every state-changing request fails the `Origin` check and WebAuthn fails. Self-hosters use the root config, which is `production`. Recommendation: give the top level a distinct Worker name, such as `cinewren-local`.
- **SR-19:** a Worker crash between Jellyfin minting a token and the session row recording it leaves an unrecorded token. Accepted in the LLD-TOKEN M3 notes; the window is milliseconds.
- **SR-20:** a session token is not stream-only. It carries the restricted service account's non-admin scope, and origins do not enforce library grants on stream endpoints. Accepted in the [ADR-0013](../adr/0013-session-scoped-origin-stream-credentials.md) correction. This is why SR-01, SR-02 and SR-06 matter.

## 5. Changes made in this review

| File | Change |
|---|---|
| `apps/worker/src/playback/lifecycle.ts` | `revokeAllSessions` (SR-01, SR-02) |
| `apps/worker/src/db/playback.ts` | `listCredentialHoldingSessions`, `sourceStillVisible` |
| `apps/worker/src/users/service.ts`, `apps/worker/src/db/users.ts` | Revoke on disable; BR-8 pre-check, then revoke, then delete (SR-01) |
| `apps/worker/src/servers/purge.ts` | Revoke before the removal batch (SR-02) |
| `apps/worker/src/playback/service.ts` | BR-1 re-check on every event (SR-06) |
| `apps/worker/src/db/auth.ts`, `apps/worker/src/index.ts` | `sweepAuth` on the tick (SR-03) |
| `apps/worker/src/artwork/proxy.ts` | Per-server cache key (SR-05) |
| `apps/worker/src/api/middleware/rate-limit.ts` | `/me/*` writes count as mutations (SR-08) |
| Tests | `test/playback/play.test.ts`, `test/auth.test.ts`, `test/artwork.test.ts`, `test/ops.test.ts`, `test/users.test.ts` |
| Docs | LLD-TOKEN T5.8 notes, TDD-D5 limiter classes, ROADMAP T5.8 |

## 6. Residual risks

1. **Token scope (SR-20).** While a session is live, its token can browse every library the service account sees. The control is BR-1 before issuing a descriptor, plus prompt revocation. Keep the service account limited to the libraries Cinewren needs.
2. **Unreachable origin at removal (SR-09)** leaves an unrevoked token, which is logged.
3. **Stolen session cookie (SR-04, fixed).** A stolen cookie can no longer add a passkey on its own. Within 5 minutes of the victim's own sign-in or re-authentication, a thief holding that cookie could still add one; it would show in the passkey list.
4. **Private-address resolution of an operator-entered host (SR-11).**
5. **`SETUP_TOKEN` window** between deploy and first setup (HLD).
6. **Cached artwork can outlive a grant revocation in the browser** for its `private` max-age. The edge cache never serves without a fresh permission check.
7. **No master-key rotation tooling yet (SR-07).**

## 7. Verification

`pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (all Worker and web tests, including the new regressions), `pnpm build`, `node scripts/check-docs.mjs` and `pnpm audit` all pass on this change. The new regression tests were also run against the unfixed source files and fail there, which shows they detect the defects.

## 8. Items that need owner acceptance

**Owner decisions, 2026-10-04:**
- SR-04: fix (require a fresh login to add a passkey).
- SR-07: fix (build the rotation job before v1.0).
- SR-09: **accepted** for v1.0.
- SR-11: **accepted**.
- SR-20: **accepted**.

None of these blocks T5.8: no critical or high finding is open. They are listed so the owner can accept them or ask for them to be fixed before v1.0.

| Item | Recommendation | Agent proposal |
|---|---|---|
| SR-04, passkey enrollment without fresh authentication | Fix before v1.0 with a fresh-assertion step (LLD-API and UX change) | Owner decision 2026-10-04: require a fresh login. **Fixed** (this change) |
| SR-09, best-effort revocation when the origin is down at delete or removal | Accept for v1.0; harden later by deleting credentials last | Accept |
| SR-07, no master-key rotation tooling | Wire the `reencrypt` job before the first real key rotation | Accept for v1.0, with the manual procedure documented |
| SR-11, private-range DNS names | Already accepted in LLD-PROV as an agent decision; owner confirmation requested | Accept |
| SR-20, token scope (ADR-0013 correction) | Already recorded; owner confirmation requested | Accept |
