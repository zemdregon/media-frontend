# ADR-0007: Cloudflare Access for identity

## Status

Accepted

## Date

2026-10-04

## Deciders

Agent under delegation (2026-10-04); owner review pending. The owner's concept lists "auth" among Cloudflare's roles but does not choose a mechanism; this choice is the agent's.

## Context

Cinewren is a private app for a small invited group (A-1). It needs authentication that a non-technical viewer can use (P-2), and authorization (roles, per-library grants) that Cinewren enforces itself (BR-1, BR-8, NFR-SEC-002). Origin accounts are separate and are not the viewers' identities: viewers never receive origin credentials (BR-6).

Cloudflare Access can front the Worker, run identity providers (one-time PIN, Google, and others), and attach a signed JWT (`Cf-Access-Jwt-Assertion`) to each request. Details of JWT validation beyond signature, audience, issuer and expiry are not verified here (to verify in M0).

## Decision

- Authentication is delegated to Cloudflare Access. The Worker verifies the Access JWT on every request: signature against the team's published keys, audience, issuer, expiry (FR-USR-001, IR-006). There is no exemption. Uptime monitoring reaches the health endpoint (FR-OPS-007) with an Access service token, and service-token identities are authorized for that endpoint only.
- Authorization is application-level: users keyed by verified email, role `operator` or `viewer`, per-library grants (FR-USR-002 to FR-USR-005). A valid Access identity without an active user record gets 403.
- Operators are bootstrapped from `BOOTSTRAP_OPERATOR_EMAILS`; at least one active operator always exists (BR-8).
- Access policies decide who can reach the app at all. Cinewren decides what they can see. Both layers must allow.
- Environments use separate Access applications.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Own authentication (passkeys / OAuth / password) | Large security surface: credential storage, recovery, rate limiting, session management. A sensitive area to get wrong, and not the product's value. Operators already have Cloudflare. |
| Delegate to origin-server logins (Jellyfin/Emby/Plex accounts) | Three login systems with different mechanics; users may have no account on some origins; would expose per-user origin tokens to browsers; breaks the single-identity federated model and BR-6. |
| Access in front only, no app-level users | Cannot express per-user library grants or roles server-side (BR-1, BR-8). |
| Third-party identity provider (Auth0, Clerk, etc.) | Another vendor, cost and data processor for a few users; Access already provides IdP integration. |

## Consequences

- Positive: no passwords or sessions in the app; MFA and IdP choice are Access configuration.
- Negative: hard dependency on Cloudflare Access and its availability. Local development needs a documented JWT bypass restricted to local mode (to be designed in M0, never enabled in deployed environments).
- Negative: operator must configure Access correctly (J-1); a misconfigured policy is an access-control risk. The setup guide and a deployment check should cover it.
- Neutral: Access plan limits on seats apply (to verify at M0 against the intended group size).

## Revisit when

- Viewers need to sign in without Cloudflare Access (for example, native apps, DEF-2).
- Q-1 resolves to multi-operator hosting.
- Access pricing or seat limits conflict with NFR-COST-001.

## Related

- FR-USR-001 to FR-USR-005, FR-OPS-007, IR-006, BR-8, NFR-SEC-002 in [SRS](../requirements/SRS.md)
- [ADR-0011](0011-single-operator-deployment-model.md)
- [HLD](../design/HLD.md) (TB-1, TB-2), [ROADMAP](../ROADMAP.md) (M0)
