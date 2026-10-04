# Cinewren

A self-hosted, federated media frontend. One Cloudflare Worker serves the UI, API and catalog; your Jellyfin, Emby and Plex servers stay the media origins, and video streams directly from origin to browser. One operator per deployment; passkey sign-in; viewers join by invite link.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/zemdregon/media-frontend)

- **Self-host:** [docs/operations/self-host.md](docs/operations/self-host.md): the Deploy button and manual `wrangler` paths, secrets, first run, upgrades and rollback. Requires Cloudflare Workers Paid. The button deploys from the repository root; the manual path is the fallback if it fails.
- **Releases:** [CHANGELOG.md](CHANGELOG.md), SemVer, tagged `vX.Y.Z`.
- **Plan and specs:** [docs/ROADMAP.md](docs/ROADMAP.md), [architecture decisions](docs/adr/README.md), [operator setup (staging)](docs/operations/setup.md).
- **Contributing:** read [AGENTS.md](AGENTS.md) first.

## Develop

```sh
pnpm install
cp .dev.vars.example apps/worker/.dev.vars   # fill in the secrets
pnpm --filter @cinewren/worker dev
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm check:docs
```
