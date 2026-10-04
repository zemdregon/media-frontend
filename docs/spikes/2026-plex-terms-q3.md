# Q-3: Do Plex's terms permit a self-hosted third-party web client to use a PMS HTTP API?

| Field | Value |
|---|---|
| Status | Research note |
| Date | 2026-10-04 |
| Author | Agent-authored (Claude) |
| Question | Q-3, Cinewren project |
| Legal status | **Not legal advice.** Reading of public pages only; no contact with Plex. |
| Verdict | Appears **permitted in principle** for personal/household use; **some clauses are unclear**; overall risk **low to medium** (see Assessment). |

## 1. Sources consulted (all retrieved 2026-10-04 via Firecrawl; some from Firecrawl's cache, so pages may be a few days old)

| Source | URL | Version seen |
|---|---|---|
| Plex Terms of Service (TOS) | https://www.plex.tv/about/privacy-legal/plex-terms-of-service/ | "Revised October 30, 2025" |
| Plex Trademarks and Guidelines | https://www.plex.tv/about/privacy-legal/plex-trademarks-and-guidelines/ | page metadata modified 2024-01-25 |
| Plex Media Server API docs (developer.plex.tv) | https://developer.plex.tv/pms/ | "Plex Media Server (1.2.3)", license shown: Apache 2.0 |
| Plex blog, "Plex Pro Week '25: API Unlocked" | https://www.plex.tv/blog/plex-pro-week-25-api-unlocked/ | published 2025-09-21/22 |

Not found / not read: no separate "developer terms of service" or API usage policy was found in the search results or on the developer.plex.tv page. I did not read the Plex privacy policy, the Plex Pass feature page, or the forum Dev Community rules. Absence of a separate API terms document is a finding of this search, not proof that none exists.

## 2. Relevant quoted clauses

### 2.1 Plex's stated stance on the API (blog, 2025-09-21)
- "For the first time, we are publishing official API documentation for your Plex Media Server!"
- "The release of the PMS API documentation is a starting point for this path that all are welcome to use."
- "...it has possibly been the worst-kept secret that an API exists on every Plex Media Server... we applaud all of these efforts."
- "The API also includes information on authentication, which is necessary to handle up front, as the API calls don't work without proper authentication."
- On tokens: "once you have a JWT token, you can use it exactly like the old tokens in the X-Plex-Token header!" and "Rate Limiting: Built-in protection against abuse".

### 2.2 developer.plex.tv headers section
- "`X-Plex-Client-Identifier` | An opaque identifier unique to the client"; "`X-Plex-Product` | The name of the client product"; "`X-Plex-Token` | An authentication token, obtained from plex.tv"; "`X-Plex-Device-Name` | A friendly name for the client".
- "`X-Plex-Client-Identifier` is typically required, as is `X-Plex-Token` for authentication."
- On plex.tv auth errors: "429 Too Many Requests: Rate limit exceeded (nonce requests are rate-limited)" and "Nonce requests are rate-limited to prevent abuse". Only the JWT/nonce endpoints are documented as rate limited; no numeric limits for PMS endpoints were found.
- Spec license shown on page: "License: Apache 2.0". This appears to license the OpenAPI specification document, not grant any rights to Plex services. Not verified further.

### 2.3 TOS: grant and Interfacing Software
- Grant: "a personal (non-commercial), revocable, limited, non-exclusive, nontransferable, and non-sublicensable license to access and use the Plex Solution (by you and your Authorized Users...)".
- "Interfacing Software" means "any software that you obtain or provide and that accesses or calls any PMS Software provided by Plex as part of the Plex Solution including, but not limited to, plug-ins for the Plex Solution, channel plug-ins, metadata agents, and client applications that communicate directly or indirectly with the Plex Solution."
- "You are responsible and liable for any Interfacing Software, including any data collection that may be undertaken or occur through the Interfacing Software."
- "...you will use and integrate the Interfacing Software in a manner consistent with acceptable use of the Plex Solution pursuant to this TOS."
- Conditions when "making, or assisting others in making, available any Interfacing Software": grant Plex a licence to use/promote/distribute it (and its name); "provide and include (or link to) a privacy notice"; and "include in the source code of the Interfacing Software a copyright notice of the form: Copyright (c) <year> <copyright holders>". The grant is also described as a licence "to any person obtaining a copy of the Interfacing Software... to deal in the Interfacing Software without restriction". Plex says it will honour a notice from the owner who does not want Plex to use it, after at least 30 days.
- This clause shows Plex contemplates third-party "client applications" calling PMS. It is the closest thing found to an authorisation, but it is framed as a liability/licensing clause, not an explicit permission.

### 2.4 TOS: restrictions
- "(a) use the Plex Solution to create any service, software or documentation that performs substantially the same functionality as the Plex Solution" (potentially relevant to a media frontend; see Assessment).
- "(c) encumber, sublicense, transfer, distribute, rent, lease, time-share, or use the Plex Solution in any service bureau arrangement or otherwise for the benefit of any third party".
- "(e) disable, circumvent, or otherwise avoid or undermine any security device, mechanism, protocol, or procedure implemented in the Plex Solution".
- "(h) use the Plex Solution in any manner which could damage, disable, overburden, or impair the Plex Solution or interfere with any third party's authorized use of the Plex Solution."
- "Plex expressly prohibits you and any third parties from: ... (iii) replicating any exclusive Plex Pass functionality as described [on the Plex Pass page]; or (iv) obtaining Plex Pass functionality without a valid Plex Pass."
- Also "(d) adapt, combine, create derivative works of, or otherwise modify the Plex Solution" and "mirror, frame" appear in the list of prohibitions; their application to an API client is unclear.

### 2.5 TOS: PMS software and content
- "You may only use the PMS Software: (i) on a device or hardware that you own; (ii) to add Content... ; and (iii) ... as a part of your use of the Plex Solution".
- "Content available on your PMS Software must be on storage that you own." and "You are expressly prohibited from engaging in or facilitating the unauthorized sharing or distribution of Content."
- Authorized Users: "you may enable members of your immediate family, for whom you will be responsible... to access and use the Plex Solution". Note this says "immediate family"; the TOS text I retrieved does not mention Plex Home or managed users. Whether a "household" equals "immediate family" is unclear.
- "The content layout, formatting, and features (or functionality) of and online or remote access processes for the Plex Solution shall be as made available by Plex in its sole discretion." (Plex may change or restrict the API at will.)

### 2.6 Trademarks and Guidelines
- You may not "Use Plex or derivatives thereof in the name of your application"; may not "Register a domain containing Plex (or misspellings of Plex)"; may not use "Plex trademark icons" or derivative iconography ("a play symbol in profile").
- You may "include language on your site explaining that your application 'Works with Plex'", and "Use 'for Plex' following the name of your application, provided that the name of your application is unique."
- You may not "Copy the Plex look and feel of any Plex web site (including the use of our distinct color combinations, graphic designs or typography)" or "Feature any Plex trademarks in a manner that is more prominent than the names and trademarks identifying your business, product or service."
- "If you use any Plex trademarks, you must provide attribution of Plex ownership", e.g. "'Plex, the Plex Play logo and Plex Media Server are trademarks of Plex and used under a license'".
- Listed marks include PLEX, PLEX PASS, PLEX MEDIA SERVER, PLEX.TV. TOS: "any use of such marks without the express written permission of Plex is strictly prohibited" (cross-referring to the Guidelines).

## 3. Assessment

| Aspect | Reading | Rating |
|---|---|---|
| Calling the PMS HTTP API from a third-party client | Plex publicly documents the API and says it is "for all" to use; the TOS defines "client applications" as Interfacing Software and treats them as contemplated. No clause found that bans third-party clients. | Permitted in principle |
| Personal, self-hosted, household use, no redistribution | Fits the "personal (non-commercial)" licence and no "distribute/service bureau" concern if only the owner's household uses it. | Permitted, with caveats |
| Restricted (Home/managed) user token created by the owner | Token is issued via normal Plex features and used with X-Plex-Token as documented. The TOS grant to "immediate family" vs. a broader "household" is unclear. | Unclear (minor) |
| "Substantially the same functionality" clause (a) | A media-browsing/playback frontend overlaps with Plex's own clients. Clause is worded around using "the Plex Solution to create" such software and is aimed, on a plain reading, at cloning; Plex itself invites API clients. Interpretation is untested. | Unclear |
| Playback in browser from the server | Uses documented PMS streaming/transcode endpoints under the owner's own server and token. Transcoding/remote-streaming limits tied to Plex Pass or Remote Watch Pass (see Plex Pass page, not read) may apply. | Unclear; depends on Pass entitlements |
| Branding | Guidelines are strict: no "Plex" in app name or domain, no Plex icons or look and feel. | Restricted (manageable) |
| Enforcement | No evidence found of Plex acting against API clients; the blog is supportive. Plex may change terms and the API at its sole discretion. | Low enforcement signal; platform risk |

**Overall: permitted in principle with constraints; risk Low-to-Medium.** Highest-probability issues are trademark/branding mistakes and any behaviour that looks like Plex Pass circumvention or server overload; the clause (a) ambiguity is the main residual legal uncertainty. Single-household private deployment keeps Cinewren far from the clauses on distribution, service bureau, and commercial use. If Cinewren is ever distributed to other server owners, the Interfacing Software conditions (privacy notice, copyright notice, licence grant to Plex) and the trademark guidelines apply directly, and risk rises.

## 4. Conditions and constraints for Cinewren

1. **Product identification.** Always send `X-Plex-Product` (e.g. "Cinewren", not containing "Plex"), `X-Plex-Client-Identifier` (stable, opaque, unique per Cinewren install/device), `X-Plex-Token`, and ideally `X-Plex-Device-Name`, `X-Plex-Version`, `X-Plex-Platform`. Do not spoof an official Plex client's product or identifier. (The last two optional headers are common practice but were not verified on the page text retrieved.)
2. **No circumvention of Plex Pass or security.** Do not bypass entitlement checks, token scoping or the managed user's restrictions (parental/library limits), or replicate Plex-Pass-exclusive features (TOS restrictions (e) and the Plex Pass sentence). Do not extract or reuse the owner's admin token; use only the managed-user token.
3. **Rate limits / load.** No numeric PMS limits documented. Cache metadata, avoid polling loops and bulk full-library scans on every page load, respect HTTP 429, back off, and keep plex.tv auth calls (nonce/JWT refresh, 7-day token lifetime) minimal. Aim to satisfy clause (h) ("overburden, or impair").
4. **Token handling.** Store the managed-user token server-side, never in client bundles or logs; plan for JWT refresh as Plex migrates ("JWT Authentication (Recommended)").
5. **Branding / trademark.** Do not put "Plex" in the product name, repo/domain name or icons; avoid Plex's colours, typography and layout; use plain text such as "Works with Plex" if mentioned; if any Plex mark is shown, add the attribution statement and keep it less prominent than Cinewren's. Using the Plex logo at all requires accepting the trademark licence; simplest is to avoid logos.
6. **Privacy/legal housekeeping** (needed if ever distributed): privacy notice, source copyright notice "Copyright (c) <year> <holders>", and awareness that Plex receives a broad licence to Interfacing Software and its name under the TOS.
7. **Scope.** Keep use to the owner's household, no sharing of access or content outside it, no resale or hosted multi-tenant service. Content stays on storage the owner owns.
8. **Federation caveat.** If Cinewren later federates across several owners' servers or exposes one owner's server to non-household viewers, re-run this analysis (clauses (c), Authorized Users).

## 5. Recommendation for the owner

- Proceed with the Plex integration for private household use; the published sources support using the PMS API with a managed-user token, and nothing retrieved prohibits a third-party client.
- Implement the header, rate-limit and branding rules above before any public repo, screenshot or demo is released.
- Because clause (a), "immediate family" vs. household, and Pass-tied streaming limits are ambiguous, and because Plex can change terms and the API "in its sole discretion", treat Plex as a replaceable backend behind an adapter, and keep the note date-stamped.
- Low-cost confirmation: ask Plex via https://www.plex.tv/contact/?option=legal or the Dev Community forum (https://forums.plex.tv/c/dev-community/113) whether a self-hosted third-party web client using a managed-user token is acceptable, and keep the reply. For anything commercial or distributed, obtain actual legal review.
- Open items not covered: Plex Pass/Remote Watch feature page and any limits on remote/browser playback, Plex privacy policy, forum developer guidelines, and regional (EU/Plex GmbH) terms differences.
