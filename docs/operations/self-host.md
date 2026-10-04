# Cinewren — Self-host guide

| | |
|---|---|
| **Status** | Draft v0.1, 2026-10-04. Agent-authored under delegation (ROADMAP T5.5); not owner-reviewed. The Deploy button path and the upgrade rehearsal on a fresh Cloudflare account are **not yet verified** (see the notes in §3 and §7). |
| **Owns** | How another operator deploys, first-runs, upgrades and rolls back their own Cinewren from a tagged release. |
| **Does not own** | Release design and rollback semantics ([TDD](../design/TDD.md) §9, §10), the deployment model ([ADR-0011](../adr/0011-single-operator-deployment-model.md)), authentication ([ADR-0014](../adr/0014-passkey-auth-with-invite-links.md)), requirements ([SRS](../requirements/SRS.md) FR-OPS-008, NFR-MAINT-003). |

Cinewren is one operator per deployment (ADR-0011): you run your own Worker, D1 database and queues on your own Cloudflare account, and you invite your viewers. Nothing is shared with other deployments. Deploys use **Cloudflare Workers Builds** or **`wrangler`** from your machine. This repository needs no GitHub deploy secrets, and the release workflow never deploys.

The maintainer-only staging steps are in [setup.md](setup.md). Self-hosters use the config in this guide, the repository-root `wrangler.jsonc`, **not** `apps/worker/wrangler.jsonc`, which is the maintainer's dev and staging config.

## 1. Prerequisites

- A Cloudflare account on the **Workers Paid** plan (assumption A-5: Queues and cron triggers need it).
- A **release tag** to deploy (see [Releases](https://github.com/zemdregon/media-frontend/releases)). Deploy tags, not `main`.
- For the manual path: Node.js 22 or newer, `pnpm`, and a Cloudflare API token (or `wrangler login`).
- A hostname for the app. `*.workers.dev` works for trials; a custom domain on your Cloudflare account is better for long-term use. The hostname becomes the WebAuthn RP ID, and **changing it later invalidates every registered passkey**, so decide first.
- At least one Jellyfin, Emby or Plex server reachable as described in §8.

## 2. What gets created

| Resource | Name in `wrangler.jsonc` | Purpose |
|---|---|---|
| Worker (with static assets) | `cinewren` | UI, API, scheduler |
| D1 database | `cinewren` (binding `DB`) | System of record (ADR-0006) |
| Queue and dead-letter queue | `cinewren-jobs`, `cinewren-jobs-dlq` (binding `JOBS_QUEUE`) | Sync jobs |
| Rate-limit bindings | `RL_AUTH` (10/min per IP), `RL_PLAY` (60/min per user), `RL_MUTATION` (600/min per user) | NFR-SEC-004, NFR-SEC-008. `namespace_id` must be unique in your account: `5501`, `5511` and `5521` by default. Change them if they collide. |
| Cron triggers | `*/5 * * * *`, `17 3 * * *` | Scheduler tick, daily retention |

The config contains no account IDs. The D1 database and queues are created by name on your account.

## 3. Path A: Deploy to Cloudflare button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/zemdregon/media-frontend)

What the button does (per [Cloudflare's docs](https://developers.cloudflare.com/workers/platform/deploy-buttons/)): it copies the repository into your GitHub or GitLab account, provisions the D1 database and queues declared in the root `wrangler.jsonc`, offers the secrets named in `.dev.vars.example` and the root `package.json` `cloudflare.bindings` for entry, and sets up Workers Builds so every push to your copy's production branch deploys.

Limits specific to this repository:

- **Monorepo.** Cloudflare supports only a fully isolated subdirectory, so the button points at the **repository root**, where the self-host `wrangler.jsonc` lives, and not at `apps/worker`. This is the documented way to deploy a monorepo from the root, but it has not been run end to end on a fresh account. If it fails, use path B.
- **The repository must be public** (it is) and on github.com or gitlab.com.
- **The button clones the default branch, not a tag.** After it finishes, reset your copy to the release you want (§7, "Upgrading").
- **The origin must be set after the first deploy.** The workers.dev address is only known afterwards, so the first build deploys with the placeholder `APP_ORIGIN` of `https://cinewren.CHANGE-ME.workers.dev`. Edit `vars.APP_ORIGIN` and `vars.RP_ID` in your copy's `wrangler.jsonc` (or use a custom domain you already know), commit, and Workers Builds redeploys. Do this **before** `/setup`.
- **Build and deploy commands.** Set them as in §9. The button may prefill the root `package.json` `build` script; the build command in §9 builds the SPA only.

Then continue with §5 (secrets) and §6 (first run).

## 4. Path B: manual `wrangler` deploy

```sh
git clone https://github.com/zemdregon/media-frontend cinewren && cd cinewren
git checkout v0.1.0                       # the release tag you are deploying
pnpm install --frozen-lockfile
pnpm exec wrangler login                  # or export CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID
```

1. Edit the root `wrangler.jsonc`: set `vars.APP_ORIGIN` (exact origin, `https://<host>`, no trailing slash) and `vars.RP_ID` (the host). For a custom domain, also add `"routes": [{ "pattern": "<host>", "custom_domain": true }]`.
2. Build the SPA: `pnpm build:web`.
3. Create the Worker and put the secrets (§5) with the commands below. Wrangler creates the D1 database and queues on first deploy; or create them yourself with `wrangler d1 create cinewren`, `wrangler queues create cinewren-jobs` and `wrangler queues create cinewren-jobs-dlq` and add the `database_id`.
4. Deploy: `pnpm run deploy`. It applies D1 migrations to the remote database, then deploys the Worker. Order matters (TDD §3): migrations first.

If a command asks for a worker that does not exist yet, run `pnpm run deploy` once, then set the secrets, then re-run it.

## 5. Variables and secrets

Variables live in `wrangler.jsonc`:

| Var | Value |
|---|---|
| `ENVIRONMENT` | `production` |
| `APP_ORIGIN` | your exact public origin, `https://<host>` |
| `RP_ID` | the hostname of `APP_ORIGIN` (permanent once passkeys exist) |
| `CREDENTIAL_KEY_CURRENT` | `1` for a new deployment |

Secrets are never put in the config or the repository. Generate them into a restricted file or straight into a password manager, then store them:

```sh
umask 077
# SETUP_TOKEN: one-time first-run token, 32 random bytes as base64url
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=' > setup-token.txt
# CREDENTIAL_KEYS: JSON map of key version to a base64 32-byte AES key
printf '{"1":"%s"}' "$(openssl rand -base64 32)" > credential-keys.json

cd apps/worker
pnpm exec wrangler secret put SETUP_TOKEN      --config ../../wrangler.jsonc < ../../setup-token.txt
pnpm exec wrangler secret put CREDENTIAL_KEYS  --config ../../wrangler.jsonc < ../../credential-keys.json
```

With the **Deploy button**, paste the same two values into the secret fields the button shows (descriptions come from `.dev.vars.example`). For local development, copy `.dev.vars.example` to `apps/worker/.dev.vars`.

### Back up `CREDENTIAL_KEYS` offline (DR-002)

Copy `credential-keys.json` into a password manager or other offline storage **before the first deploy**, then delete the local file and `setup-token.txt`. Cloudflare cannot return a secret once stored. If the key is lost, the encrypted origin credentials cannot be recovered and you must re-enter every server's credentials; your catalog and other primary data are unaffected. To rotate the key, follow the procedure below, which includes backing up the new map.

`CREDENTIAL_KEYS` is listed in `secrets.required`, so a deploy fails if it is missing. `SETUP_TOKEN` is deliberately not required, so you can delete it afterwards.

### Rotate the master key (DR-002, WF-11)

Do this when a key may have leaked, or on your own schedule. Origin credentials, cached service tokens and in-flight play credentials are all sealed under a versioned key, and rotation moves every one of them to the new version while old and new keys are both available.

1. **Create and back up the new key.** Generate it (`openssl rand -base64 32`) and add it to the map under version `n+1`, keeping every old version: `{"1":"<old>","2":"<new>"}`. Save the **whole new map offline** (password manager) before you store it, because Cloudflare cannot return a secret (DR-002).
2. **Store the secret and switch the current version.** `pnpm exec wrangler secret put CREDENTIAL_KEYS --config ../../wrangler.jsonc` (from `apps/worker`), then set `CREDENTIAL_KEY_CURRENT` to `n+1` in `wrangler.jsonc` (a plain variable, not a secret).
3. **Deploy.** From now on every new write is sealed under version `n+1`, and reads of older rows keep working because the old key is still present.
4. **Start the job.** As an operator, in the signed-in browser console or with your session cookie: `POST /api/v1/admin/vault/rotate` (JSON, same-origin). It answers `202 {"currentKeyVersion":2,"pendingRows":N,"enqueued":true}` and writes a `vault.rotate` audit row. The queue consumer re-encrypts in batches and continues by itself; it is safe to call again at any time.
5. **Wait for completion.** `GET /api/v1/admin/vault/status` lists the rows per key version. Wait for `"complete": true` (`pendingRows` is 0). It reports key versions and counts only, never key material. A version listed under `missingKeyVersions` has rows that no configured key can read; it means an old key was removed too early. Put that key back and run step 4 again.
6. **Only then remove the old key.** Check that status still says complete (a deploy that was still rolling out during step 4 can leave a few late rows), and that the version is listed in `removableKeyVersions`. Store `CREDENTIAL_KEYS` without it, deploy, and keep the offline backup of the old key for as long as you keep database backups from before the rotation, since a restore brings old-version rows back.

Catalog list cursors are also sealed with the key but live only minutes and hold no secret, so they are not re-encrypted. A client that holds one across the removal simply restarts its listing.

## 6. First run

1. Open `https://<host>/setup`.
2. Paste `SETUP_TOKEN`, enter a display name and register a passkey. This creates the first operator (FR-USR-002). After that every `/setup` endpoint returns 404.
3. Delete the token: `pnpm exec wrangler secret delete SETUP_TOKEN --config ../../wrangler.jsonc` (from `apps/worker`).
4. Check `GET https://<host>/api/v1/health` returns `{"status":"ok"}`. `degraded` means D1 is unreachable or migrations are pending (§7).
5. Register your servers (§8), then invite viewers with invite links from the operator UI.

If the last operator loses every passkey, run the recovery command from a checkout of your repository, signed in to Cloudflare with `wrangler login`: `pnpm recover:operator -- --config wrangler.jsonc --remote --origin https://<host>` (add `--user <display name or id>` if you have several operators). It writes a single-use, 24 h re-enrollment link for that operator straight to D1 and prints it; open it to add a new passkey. It needs access to your Cloudflare account, which is the root of trust ([ADR-0014](../adr/0014-passkey-auth-with-invite-links.md) §4, FR-USR-007).

## 7. Upgrading to a new release

Read the GitHub Release first: it lists the changelog section, the migrations in the release, and any new or changed configuration. Cinewren uses SemVer. Minor and patch releases add only compatible (expand) migrations and optional configuration. A **major** release may contain breaking migrations; its notes tell you to upgrade to the latest minor of the previous major first.

1. **Undo point.** Record a D1 Time Travel bookmark: `pnpm exec wrangler d1 time-travel info cinewren --config ../../wrangler.jsonc` (from `apps/worker`).
2. **Bring the tag into your deployment.**
   - Button path (your copy of the repository): `git remote add upstream https://github.com/zemdregon/media-frontend`, `git fetch upstream --tags`, then `git merge v<new>`. Keep your own `wrangler.jsonc` edits (`APP_ORIGIN`, `RP_ID`, routes). Push. Workers Builds deploys.
   - Manual path: `git fetch --tags && git checkout v<new> && pnpm install --frozen-lockfile`, re-apply your `wrangler.jsonc` edits, then `pnpm build:web && pnpm run deploy`.
3. **Migrations apply in order, before the Worker.** `pnpm run deploy` runs `wrangler d1 migrations apply DB --remote`, which applies every pending migration in numeric order and skips those already recorded in `d1_migrations`. Skipping minor versions inside one major is safe. Rehearse the same logic offline with `pnpm check:upgrade` (previous release database to this checkout, local D1 only).
4. **The `MIGRATIONS_PENDING` guard.** If the Worker is deployed while the database is behind the migration number it needs (migrations were skipped), it refuses to run new code on an old schema: every `/api/*` route returns **503 `MIGRATIONS_PENDING`** with `Retry-After: 60`, and `/api/v1/health` returns `degraded`. The SPA shell still loads. Fix: run `pnpm run migrate`. It clears itself on the next request; no redeploy is needed.
5. **Smoke check.** `/api/v1/health` is `ok`, sign in, and run a sync from the operator UI.

### Rollback

- **Code:** `pnpm exec wrangler versions list --config ../../wrangler.jsonc`, then `wrangler rollback <version-id> --message "reason"`. Migrations are forward-only and expand-only within a major, so the previous Worker keeps working against the newer schema (the guard only blocks a Worker that is *ahead* of the database). Changes to bindings (a new queue or rate limiter) have rollback constraints: ship them alone ([TDD §9.4](../design/TDD.md)).
- **Schema:** there is no down-migration. A bad migration is fixed by a new migration, or as a last resort by a D1 Time Travel restore to the bookmark from step 1 (`wrangler d1 time-travel restore cinewren --bookmark=<id>`), which discards data written since. Details: [TDD §10](../design/TDD.md).

## 8. Connecting origins

- **Non-proxied HTTPS hostnames only.** Each Jellyfin, Emby or Plex server must be reachable at a public HTTPS hostname with a valid certificate, and that hostname must **not** be Cloudflare-proxied (orange cloud) or a Tunnel public hostname: video would then flow through Cloudflare, which is not allowed on Free, Pro or Business plans (NFR-COMP-001, [ADR-0002](../adr/0002-cloudflare-control-plane-origins-deliver-media.md)). Use grey-cloud DNS or a non-Cloudflare hostname.
- **Non-admin service accounts.** Create a dedicated, non-admin user on each origin with access to the intended libraries only. Cinewren refuses administrator accounts and stores the credentials encrypted ([ADR-0008](../adr/0008-origin-service-accounts-and-credential-encryption.md)).
- **Plex:** create a restricted managed user for Cinewren and share only the libraries it should expose.
- **Jellyfin:** playback uses HLS. Make sure the service user may transcode or remux as needed and that your server's HLS endpoints are reachable from browsers.
- **Emby:** same non-admin rule as Jellyfin.

## 9. Workers Builds settings

Workers Builds is the only supported automatic deploy mechanism; no deploy secrets are stored in GitHub. Cloudflare dashboard, **Workers & Pages → cinewren → Settings → Build** (the button sets most of this up):

| Setting | Value |
|---|---|
| Git repository | your copy of the repository |
| Production branch | the branch you deploy from (releases are merged or checked out here) |
| Root directory | `/` |
| Build command | `pnpm install --frozen-lockfile && pnpm build:web` |
| Deploy command | `pnpm run deploy` (migrations, then `wrangler deploy`) |
| Non-production branch builds | Off, unless you want preview URLs |
| Build variables | none required; `NODE_VERSION=22` if the default is older |

The build token must be allowed to edit D1 so that migrations can run remotely. Whether Workers Builds applies remote migrations with the build token's permissions was flagged "to verify" in TDD §9.2 and is still to be confirmed on a fresh account. If it fails, run `pnpm run migrate` from your machine after the build, or set the deploy command to only `wrangler deploy` and migrate by hand. The guard in §7 makes either safe.
