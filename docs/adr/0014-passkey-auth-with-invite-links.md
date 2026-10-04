# ADR-0014: Passkey authentication with operator invite links

## Status

Accepted. Supersedes [ADR-0007](0007-cloudflare-access-identity.md).

## Date

2026-10-04

## Deciders

**Owner decision (2026-10-04):** sign-in uses passkeys only. Accounts are created only through an operator invite link, which leads to signup; without one, no account can be made. Cloudflare Access is not used. The owner asked why Access was planned and then chose this instead.
Implementation details below (bootstrap, recovery, sessions, token lifetimes) are **agent decisions under delegation; owner review pending.**

## Context

ADR-0007 delegated authentication to Cloudflare Access. That stops strangers at the edge, and Cinewren stores no passwords. The owner then decided that others may self-host Cinewren ([ADR-0011](0011-single-operator-deployment-model.md)). With Access, every self-hoster would have to set up a Zero Trust team, and invites would live in two places: Cinewren and the Access policy. The owner chose an app-native, passwordless model instead.

## Decision

1. **Authentication is WebAuthn passkeys only.** There are no passwords, OAuth, email links or SMS. The RP ID is the deployment's app hostname. A user may register several passkeys.
2. **Accounts exist only through invites.** An operator creates an invite that carries a role and default library grants. Cinewren produces a link containing a random single-use token. The token is stored hashed, expires after 7 days *(proposed)* and can be revoked. Opening the link shows signup, where the invitee registers a passkey and the user becomes `active`. There is no other account-creation path. Without a valid invite, the registration endpoints refuse.
3. **First-operator bootstrap.** The `/setup` flow needs the one-time `SETUP_TOKEN` Worker secret, and it creates the first operator with a passkey. It is permanently disabled once any operator exists. `SETUP_TOKEN` is deliberately left out of `secrets.required`, so that operators can delete it after setup without blocking later deploys ([TDD](../design/TDD.md)).
4. **Recovery.** An operator can issue a re-enrollment link for an existing user, for example after a lost device. It is single-use, expires after 24 h *(proposed)*, and adds a passkey to the existing account. If the last operator loses every passkey, a documented `wrangler`-run command issues a recovery link. Running it requires access to the Cloudflare account, which is the root of trust.
5. **Sessions.** A random 256-bit session ID is sent in a `HttpOnly; Secure; SameSite=Lax` cookie and stored hashed in D1. Idle expiry is 14 days and absolute expiry 90 days *(proposed)*. Logout and user disable or delete revoke sessions immediately. State-changing requests require a same-origin `Origin` header.
6. **Abuse controls.** Setup, invite-redemption and login endpoints are rate limited (NFR-SEC-004). WebAuthn challenges are single-use with a short TTL.
7. **Health endpoint.** `GET /api/v1/health` is public and returns only an overall status. Detailed status is operator-only (FR-OPS-007).
8. Cloudflare Access is neither required nor designed in. An operator may still put it in front as an extra layer, but that is unsupported.

## Alternatives considered

| Alternative | Why not chosen |
|---|---|
| Cloudflare Access (ADR-0007) | Owner decision. It also burdens self-hosters with Zero Trust setup and two-place invites. |
| Passkeys plus OAuth (Google, GitHub) | Owner chose passkeys only. That means fewer dependencies and no third-party identity provider. |
| Passwords | Phishable, and they need storage, reset flows and breach handling. |
| Email magic links | Needs an email-sending dependency, and the security is only as good as the user's inbox. |
| Sign in via Plex or Jellyfin | Ties identity to one provider, which conflicts with C-5 and ADR-0004. |

## Consequences

- **Positive:** phishing-resistant sign-in and no shared secrets stored. No external identity provider and nothing for self-hosters to configure beyond `SETUP_TOKEN`. One place to manage people.
- **Negative:** Cinewren now owns auth code (WebAuthn ceremonies, sessions, CSRF, rate limiting), which adds M0 scope (ROADMAP T0.5). Strangers reach the Worker, where unauthenticated routes are limited to the setup, redeem, login and health endpoints. Recovery depends on operators. Passkeys need a WebAuthn-capable browser or device, which every NFR-COMPAT-001 browser is.
- **To verify in M0:** that the chosen WebAuthn server library (proposed `@simplewebauthn/server`) runs in the Workers runtime, and the Workers rate-limiting options.

## Revisit when

- Viewers commonly lack passkey-capable devices, or recovery load becomes significant.
- A deployment needs SSO or group sync. That would mean adding OAuth or OIDC, which requires a new ADR.
- Hosted multi-tenancy is ever considered ([ADR-0011](0011-single-operator-deployment-model.md)).

## Related

FR-USR-001 to FR-USR-007, FR-OPS-007, NFR-SEC-002, NFR-SEC-004, NFR-SEC-007, IR-006, [HLD](../design/HLD.md) (C-AUTH, TB-1, TB-2), [LLD](../design/LLD.md) (LLD-SCHEMA, LLD-API), [ROADMAP](../ROADMAP.md) T0.5.
