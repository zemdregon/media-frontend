# Cinewren — Operator setup guide (M0)

| | |
|---|---|
| **Status** | Draft v0.1, 2026-10-04. Agent-authored under delegation; not owner-reviewed. |
| **Owns** | The manual steps to provision, configure, deploy, first-run and roll back one Cinewren deployment on Cloudflare. |
| **Does not own** | Configuration key semantics and release design ([TDD](../design/TDD.md) §4, §9), authentication model ([ADR-0014](../adr/0014-passkey-auth-with-invite-links.md)), requirements ([SRS](../requirements/SRS.md)). |

This is the **M0 guide** (ROADMAP T0.7) for the maintainer's staging. **Other operators follow the [self-host guide](self-host.md)** (T5.5: Deploy button path, upgrades, rollback), which uses the repository-root `wrangler.jsonc`. See [ROADMAP](../ROADMAP.md). Commands below are the manual Wrangler path from [TDD §9.2](../design/TDD.md); replace `<env>` with `staging` or `production`.

## 1. Prerequisites

- A Cloudflare account on the **Workers Paid** plan (assumption A-5; Queues and the cron triggers need it).
- Node.js, `pnpm` and `wrangler` (installed by `pnpm install` in the repository), and a checkout of the release tag you are deploying.
- An account-scoped API token for Wrangler (`CLOUDFLARE_API_TOKEN`) and your `CLOUDFLARE_ACCOUNT_ID`, or `wrangler login`.
- A hostname for the app. A `*.workers.dev` hostname is acceptable for staging and trials; production should use a custom domain on your Cloudflare account.

## 2. Origin and account requirements

- **Origins must be public HTTPS on non-Cloudflare-proxied hostnames.** Video must not be served through orange-cloud proxied hostnames or Tunnel public hostnames on Free, Pro or Business plans (NFR-COMP-001, [ADR-0002](../adr/0002-cloudflare-control-plane-origins-deliver-media.md)). Use grey-cloud DNS records or a non-Cloudflare hostname with a valid public TLS certificate for each Plex or Jellyfin server.
- **Use a non-admin service account on every origin.** Cinewren stores that account's credentials, encrypted, and must never hold administrator credentials ([ADR-0008](../adr/0008-origin-service-accounts-and-credential-encryption.md)).
- **Plex:** create a restricted managed user for Cinewren and share only the libraries it should expose (owner decision, 2026-10-04).
- **Jellyfin:** Cinewren streams through HLS. Create a dedicated non-admin user with access to the intended libraries only.
- The app hostname becomes the WebAuthn RP ID. **Changing it invalidates every registered passkey**, so choose it once.

## 3. Create the D1 database and queues

```sh
cd apps/worker
wrangler d1 create cinewren-<env>
wrangler queues create cinewren-<env>-jobs
wrangler queues create cinewren-<env>-jobs-dlq
```

Copy the database `database_id` (and the database and queue names) into the `env.<env>` block of `apps/worker/wrangler.jsonc`. The jobs queue consumer must name the DLQ as its `dead_letter_queue`.

## 4. Configure vars and secrets

Vars live in `env.<env>.vars` in `wrangler.jsonc` (TDD §4):

| Var | Value |
|---|---|
| `ENVIRONMENT` | `staging` or `production` |
| `APP_ORIGIN` | exact public origin, `https://<host>` (no trailing slash) |
| `RP_ID` | the hostname of `APP_ORIGIN` |
| `CREDENTIAL_KEY_CURRENT` | key version used for new encryptions, `1` for a new deployment |

Secrets are never placed in `vars`:

```sh
# SETUP_TOKEN: 32 random bytes, base64url
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=' | wrangler secret put SETUP_TOKEN --env <env>

# CREDENTIAL_KEYS: JSON map of key version to base64 32-byte AES key, e.g. {"1":"<base64>"}
printf '{"1":"%s"}' "$(openssl rand -base64 32)" | wrangler secret put CREDENTIAL_KEYS --env <env>
```

Generate the values into a file with restricted permissions (or a password manager) first, so that you hold a copy; Cloudflare cannot return a secret once stored. Do not paste secrets into shell history, tickets or logs. `CREDENTIAL_KEYS` is listed in `secrets.required`, so a deploy fails if it is missing; `SETUP_TOKEN` is deliberately not required so you can delete it after setup (ADR-0014 §3).

## 5. Back up the credential key offline (DR-002)

Store the `CREDENTIAL_KEYS` value in a password manager or other offline location **before** your first deploy. If it is lost, the encrypted origin credentials cannot be recovered and every server's credentials must be re-entered. The catalog and other primary data are not affected (TDD §4, DR-002). To rotate, see the procedure below; it includes backing up the new map.

### Rotating the master key (DR-002, WF-11)

Do this when a key may have leaked, or on your own schedule. Origin credentials, cached service tokens and in-flight play credentials are all sealed under a versioned key, and rotation moves every one of them to the new version while old and new keys are both available.

1. **Create and back up the new key.** Generate it (`openssl rand -base64 32`) and add it to the map under version `n+1`, keeping every old version: `{"1":"<old>","2":"<new>"}`. Save the **whole new map offline** (password manager) before you store it, because Cloudflare cannot return a secret (DR-002).
2. **Store the secret and switch the current version.** `pnpm exec wrangler secret put CREDENTIAL_KEYS --env <env>` , then set `CREDENTIAL_KEY_CURRENT` to `n+1` for the environment in `wrangler.jsonc` (a plain variable, not a secret).
3. **Deploy.** From now on every new write is sealed under version `n+1`, and reads of older rows keep working because the old key is still present.
4. **Start the job.** As an operator, in the signed-in browser console or with your session cookie: `POST /api/v1/admin/vault/rotate` (JSON, same-origin). It answers `202 {"currentKeyVersion":2,"pendingRows":N,"enqueued":true}` and writes a `vault.rotate` audit row. The queue consumer re-encrypts in batches and continues by itself; it is safe to call again at any time.
5. **Wait for completion.** `GET /api/v1/admin/vault/status` lists the rows per key version. Wait for `"complete": true` (`pendingRows` is 0). It reports key versions and counts only, never key material. A version listed under `missingKeyVersions` has rows that no configured key can read; it means an old key was removed too early. Put that key back and run step 4 again.
6. **Only then remove the old key.** Check that status still says complete (a deploy that was still rolling out during step 4 can leave a few late rows), and that the version is listed in `removableKeyVersions`. Store `CREDENTIAL_KEYS` without it, deploy, and keep the offline backup of the old key for as long as you keep database backups from before the rotation, since a restore brings old-version rows back.

Catalog list cursors are also sealed with the key but live only minutes and hold no secret, so they are not re-encrypted. A client that holds one across the removal simply restarts its listing.

## 6. Migrations and deploy

```sh
pnpm install
pnpm build                                   # builds the SPA and Worker
cd apps/worker
wrangler d1 migrations apply cinewren-<env> --env <env> --remote
wrangler deploy --env <env>
```

Apply migrations before deploying (TDD §3). For a custom domain, attach it to the Worker in the Cloudflare dashboard or with a `routes` entry, and make sure `APP_ORIGIN` and `RP_ID` match it.

Smoke checks:

- `GET /api/v1/health` returns `{"status":"ok"}` with the security headers.
- `/` serves the SPA.
- `GET /api/v1/me` without a session returns 401.
- `/setup` loads.


### Automatic deploys with Workers Builds (recommended)

Connect each environment's Worker to the GitHub repository in the Cloudflare dashboard (**Workers & Pages → the Worker → Settings → Build → Connect repository**):

| Setting | Value |
|---|---|
| Production branch | `main` |
| Root directory | `/` |
| Build command | `pnpm install --frozen-lockfile && pnpm build` |
| Deploy command | `pnpm --filter @cinewren/worker exec wrangler d1 migrations apply <db-name> --env <env> --remote && pnpm --filter @cinewren/worker exec wrangler deploy --env <env>` |
| Non-production branch builds | Off |

Its build token must be allowed to edit D1 so that migrations can run. Cinewren's own staging uses `<db-name>` = `cinewren-staging` and `<env>` = `staging`.

## 7. First run: create the operator

1. Open `https://<host>/setup`.
2. Paste the `SETUP_TOKEN`, enter a display name and register a passkey on your device. This creates the first operator (FR-USR-002), after which every `/setup` endpoint returns 404.
3. **Delete the token:** `wrangler secret delete SETUP_TOKEN --env <env>`. It is ignored once an operator exists, but there is no reason to keep it.
4. Register your servers (use the non-admin accounts from section 2), then invite viewers with invite links from the operator UI.

If the last operator loses every passkey, the recovery command in ADR-0014 §4 issues a recovery link; it needs access to the Cloudflare account, which is the root of trust.

## 8. Rollback

Roll back code with Wrangler versions (TDD §9.4):

```sh
wrangler versions list --env <env>
wrangler rollback <version-id> --env <env> --message "reason"
```

Migrations are forward-only; the previous Worker version keeps working against the current schema because of expand/contract. Changes to bindings (adding a queue or rate limiter) have rollback constraints, so ship them in a release with no other risky changes. A bad migration is fixed with a new migration, or in the worst case a D1 Time Travel restore, which also discards data written since.
