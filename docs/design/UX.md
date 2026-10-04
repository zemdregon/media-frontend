# Cinewren — UX (UX & visual design specification)

| | |
|---|---|
| **Status** | Draft v0.1 (2026-10-04). Agent-authored under delegation; not owner-reviewed. Nothing described here is implemented. |
| **Owns** | Visual identity, design tokens, layout, screen inventory, component specs, interaction states, copy tone. |
| **Does not own** | Requirements ([SRS](../requirements/SRS.md)); behaviour and rules ([FRD](../requirements/FRD.md)); API ([LLD](LLD.md)). Product context: [PRD](../requirements/PRD.md). |

## 1. Source of truth

The owner's design canvas is the visual reference: <https://claude.ai/artifact/LUvVfjGfMr3J4cEmRL44z8>. The owner said on 2026-10-04: "use this for design". This document is the implementable spec.

**Rule:** when the canvas and this document disagree, raise it with the owner and record it in the conflicts table in [ROADMAP §3](../ROADMAP.md#3-constraints-assumptions-decisions-and-open-questions). Known disagreements are listed in section 8.

| Artboard | Canvas file | Size | Covers |
|---|---|---|---|
| Library home | `Main.dc.html` | 1440 x 1240 | Nav, search, continue-watching hero, recently added grid, sources list |
| Title + source picker | `Title.dc.html` | 1440 x 1240 | Title detail, copies table (radiogroup), "why this copy" callout |
| Servers | `Servers.dc.html` | 1440 x 1240 | Server cards, add-server form |

All artboards are dark only. The canvas sample data (server names, titles) is illustrative.

## 2. Design principles

| Principle | Meaning in the UI |
|---|---|
| Provider-agnostic library | Viewers see one library. Server type (`JELLYFIN`, `PLEX`, `EMBY`) appears only as a small mono label, never as a brand colour, logo or filter. |
| Copies, not duplicates | One title is one tile. A chip says "N copies" (singular "1 copy"). The best copy is a single line under the title. |
| Explain choices | The title page always says why a copy was picked or not playable (the "why this copy" callout; FR-PLAY-010). |
| Honest status | Offline or degraded servers stay listed and are labelled unavailable, with since-when. Nothing is hidden to look healthy. |
| Accessible as drawn | 44 px minimum targets (48 px for primary actions), a visible 2 px focus ring, real `<a>`, `<button>`, `<input>`, `role="radiogroup"` controls, one `<h1>` per screen (NFR-A11Y-001). |

## 3. Design tokens

All colours are tokens on `:root`. Components never use raw hex values. Dark values are exact canvas values. Theme behaviour is in 3.5.

### 3.1 Colour tokens

Dark values: **canvas**. Light values: agent-derived, shown as light artboards in the canvas, and **accepted by the owner on 2026-10-04**.

| Token | Role | Dark (canvas) | Light (owner-accepted) |
|---|---|---|---|
| `--cw-bg` | Page background | `#0E0D0B` | `#FAF6EE` |
| `--cw-surface-nav` | Sidebar, add-server panel, copies table | `#14120E` | `#F2ECDF` |
| `--cw-surface-1` | Cards, hero, search field, callout | `#17150F` | `#FFFDF8` |
| `--cw-surface-2` | Chips, account button | `#201D16` | `#EDE6D6` |
| `--cw-surface-selected` | Selected nav item, selected segment | `#262219` | `#E6DCC6` |
| `--cw-surface-selected-row` | Selected copy row | `#211D15` | `#F0E7D2` |
| `--cw-border-row` | Row dividers | `#221F18` | `#EAE2D0` |
| `--cw-border` | Card and panel borders, progress track | `#2A261E` | `#E4DAC6` |
| `--cw-border-input` | Search field border (canvas) | `#2E2A21` | `#D6CBB3` |
| `--cw-border-strong` | Outline buttons, tags, input borders (canvas) | `#3A352A` | `#B8AB90` |
| `--cw-border-control` | Boundary of interactive controls needing 3:1 (new; see 3.4) | `#756D5A` | `#8A7F68` |
| `--cw-text` | Headings, primary text | `#F2EDE3` | `#1F1B14` |
| `--cw-text-2` | Names, strong secondary | `#E3DCCF` | `#2E2920` |
| `--cw-text-body` | Body copy, nav items | `#CFC7B8` | `#4A4437` |
| `--cw-text-muted` | Mono labels, metadata | `#A39B8B` | `#665F50` |
| `--cw-text-placeholder` | Input placeholder | `#8A8272` | `#6F6858` |
| `--cw-accent` | Primary fill, link, focus ring, progress | `#F2A93B` | `#9A5700` |
| `--cw-accent-hover` | Link and fill hover | `#FFC56E` | `#74400A` |
| `--cw-on-accent` | Text and icon on accent fill | `#1A1408` | `#FFFFFF` |
| `--cw-status-ok` | Online, direct play | `#5CC8B0` | `#0E7360` |
| `--cw-status-warn` | Indexing, needs transcode | `#F2A93B` | `#9A5700` |
| `--cw-status-bad` | Offline, unavailable, error | `#E8735A` | `#B3361E` |
| `--cw-alt-teal` | Alternate accent (canvas option) | `#7FD1C0` | `#1F7A6B` |
| `--cw-alt-coral` | Alternate accent (canvas option) | `#E8866A` | `#B04A2E` |

Notes:
- The canvas exposes the accent as a swappable prop with three options (amber, teal, coral). v1 ships amber only. The alternates are reserved, not used.
- Poster placeholders use per-title tinted fills (for example `#3D3418`, `#3A1F24`, `#2A3A3E`) with a `#ffffff14` hairline. Real artwork replaces them (FR-CAT-009). Fallback fill: `--cw-surface-2` with title text. In the light theme the fallback tint is the same hue at 12% over `--cw-surface-2`, with `--cw-text` title text.
- Status colour is never the only signal: always pair the dot with a text label.

### 3.2 Shape, spacing, sizing

| Group | Values |
|---|---|
| Radius (`--cw-r-*`) | 6 (chips, tags), 8 (nav item), 10 (poster, buttons, segments), 12 (search, hero art, callout), 14 (title poster, table), 16 (server card), 18 (hero, add panel), 22 (avatar, circle), pill 24 (default button) and 26 (large button) |
| Spacing scale (px) | 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 28, 32, 36, 40, 48, 64 |
| Targets | Minimum 44 (nav, secondary buttons, segments, account); 48 (primary and form buttons, inputs, search); 52 (title Play); copy rows 64 |
| Poster | Aspect `2 / 3`, radius 10 (14 on the title page), `1px solid #ffffff14` |
| Hero image | Aspect `16 / 9`, radius 12, progress bar 4 px at the bottom |
| Server progress bar | 6 px high, radius 3 |
| Focus ring | `outline: 2px solid var(--cw-accent); outline-offset: 2px` on `:focus-visible`. Never removed |
| Status dot | 8 x 8 px, radius 4 |

### 3.3 Typography

| Role | Family | Size (px) | Weight | Tracking | Line height |
|---|---|---|---|---|---|
| Display XL (title page h1) | Bricolage Grotesque | `clamp(48px, 7vw, 88px)` | 800 | -0.04em | 0.9 |
| Display L (page h1, Servers) | Bricolage Grotesque | 44 | 800 | -0.03em | 1 |
| Display M (hero title) | Bricolage Grotesque | 34 | 700 | -0.02em | 1.05 |
| Section heading (h2) | Bricolage Grotesque | 26 | 700 | -0.02em | normal |
| Card heading, wordmark | Bricolage Grotesque | 22 | 700 (wordmark 750) | -0.01em / -0.02em | normal |
| Poster title overlay | Bricolage Grotesque | 24 to 40 | 800 | -0.03em | 0.92 to 0.95 |
| Body L | Instrument Sans | 17 | 400 | 0 | 1.55 |
| Body | Instrument Sans | 15 to 16 | 400 / 600 | 0 | 1.5 |
| Small | Instrument Sans | 13 to 14 | 400 / 600 | 0 | 1.5 |
| Mono label (uppercase) | JetBrains Mono | 10 to 12 | 400 / 500 | 0.06em to 0.1em | normal |
| Mono value | JetBrains Mono | 11 to 14 | 400 | 0 | normal |

Fonts: Bricolage Grotesque (opsz 12..96, wght 400..800), Instrument Sans (400 to 700), JetBrains Mono (400, 500), loaded from Google Fonts with `display=swap` in the canvas. Fallback stacks: `system-ui, sans-serif` and `monospace`. Self-hosting the font files, to avoid a third-party request, is a follow-up (NFR-PRIV-001: no third-party trackers).

### 3.4 Contrast (WCAG 2.x formula)

Targets: body text at least 4.5:1; large text (24 px, or 19 px bold) and UI components at least 3:1.

| Pair | Dark | Light (owner-accepted) | Needs | Result |
|---|---|---|---|---|
| `text` on `bg` | 16.65 | 15.90 | 4.5 | Pass both |
| `text` on `surface-1` | 15.64 | 16.86 | 4.5 | Pass both |
| `text` on `surface-selected` | 13.58 | 12.58 | 4.5 | Pass both |
| `text-2` on `surface-1` | 13.39 | 14.21 | 4.5 | Pass both |
| `text-body` on `bg` | 11.58 | 8.96 | 4.5 | Pass both |
| `text-body` on `surface-selected-row` | 10.00 | 7.85 | 4.5 | Pass both |
| `text-muted` on `bg` | 7.05 | 5.87 | 4.5 | Pass both |
| `text-muted` on `surface-nav` | 6.79 | 5.38 | 4.5 | Pass both |
| `text-muted` on `surface-selected` | 5.75 | 4.65 | 4.5 | Pass both |
| `text-placeholder` on `bg` | 5.10 | 5.13 | 4.5 | Pass both |
| `accent` (text/link) on `bg` | 9.73 | 5.21 | 4.5 | Pass both |
| `accent` on `surface-nav` | 9.37 | 4.77 | 4.5 | Pass both |
| `accent-hover` on `bg` | 12.45 | 7.85 | 4.5 | Pass both |
| `on-accent` on `accent` (buttons, BEST badge) | 9.16 | 5.62 | 4.5 | Pass both |
| `status-ok` on `surface-1` | 8.99 | 5.68 | 4.5 | Pass both |
| `status-ok` on `surface-selected-row` | 8.27 | 4.69 | 4.5 | Pass both |
| `status-warn` on `surface-1` | 9.14 | 5.53 | 4.5 | Pass both |
| `status-bad` on `surface-1` | 6.11 | 5.96 | 4.5 | Pass both |
| `status-bad` on `surface-selected-row` | 5.62 | 4.93 | 4.5 | Pass both |
| `accent` ring/fill on `surface-selected` | 7.93 | 4.13 | 3 (UI) | Pass both |
| `border-control` on `bg` | 3.78 | 3.66 | 3 (UI) | Pass both |
| `border-control` on `surface-selected-row` | 3.27 | 3.21 | 3 (UI) | Pass both |

**Canvas pairs that fail (dark theme, as drawn):**

| Canvas element | Colours | Ratio | Needs | Resolution |
|---|---|---|---|---|
| Search field border | `#2E2A21` on `#0E0D0B` | 1.36 | 3 (UI) | Use `--cw-border-control` for the field boundary |
| Form input borders (Servers) | `#3A352A` on `#14120E` panel / `#0E0D0B` | about 1.5 | 3 (UI) | Use `--cw-border-control` |
| Unselected radio ring (copies) | `#5A5446` on `#14120E` | 2.43 | 3 (UI) | Use `--cw-border-control` |
| Outline buttons and segment borders | `#3A352A` on `#17150F` / `#14120E` | about 1.5 | 3 (UI) | The visible label identifies the control, so this passes SC 1.4.11 as drawn. Keep text 4.5:1. Prefer `--cw-border-control` for new controls |
| Card, panel and row borders | `#2A261E`, `#221F18` | 1.29 or less | none | Decorative separators. No requirement |

All canvas text pairs pass. Light-theme values were tuned until every row above passed; the light amber is darker than the dark theme accent (`#9A5700`) so it works as text and as a button fill with white text.

### 3.5 Theme behaviour (NFR-UX-001)

| Aspect | Rule |
|---|---|
| Default | Follow `prefers-color-scheme`. |
| Override | A per-user setting in Settings: System (default), Dark, Light. Stored with the user's preferences so it follows them across browsers. Until the account loads, a local copy avoids a flash. |
| Mechanism | Tokens in section 3.1 on `:root`. Light values under `@media (prefers-color-scheme: light)` guarded by `:root:not([data-theme="dark"])`, and under `:root[data-theme="light"]`. Dark is the base. Set `color-scheme` to match. |
| Parity | One token set, two value sets. No component has theme-specific CSS. |
| Compliance | Each theme meets contrast independently (3.4) and NFR-A11Y-001. |
| Media | Poster and hero scrims use `#00000099` to `transparent` gradients in both themes so overlaid title text stays readable. |

## 4. Layout

| Region | Spec |
|---|---|
| Shell | Flex row, wrap. Nav `flex: 1 1 232px`; main `flex: 999 1 560px; min-width: 0`. |
| Sidebar nav | 232 px on wide screens. Padding 28 x 18, `--cw-surface-nav`, 1 px right border. Wordmark, nav list (gap 2), then the sources list (library home only) under a top border. |
| Narrow widths | When main cannot keep 560 px (container under about 800 px), the nav wraps above main and spans the full width. Nav items then flow as a horizontally wrapping row. The sources list moves into the Servers screen for operators and collapses to a "Sources" disclosure for viewers. |
| Main column | Padding `28px clamp(16px, 4vw, 48px) 64px`; vertical gap 36 to 40. No horizontal page scroll at 320 px. |
| Poster grid | `grid-template-columns: repeat(auto-fit, minmax(min(168px, 100%), 1fr)); gap: 24px 20px`. |
| Server card grid | `repeat(auto-fit, minmax(min(300px, 100%), 1fr)); gap: 20px`. |
| Copies table | Min width 820 px inside an `overflow-x: auto` wrapper. Below that, the wrapper scrolls horizontally and the radio and server columns stay first. Do not drop columns. |
| Page header | Search field (`flex: 1 1 320px`, 48 px) plus account button on every screen except the player. |

| Breakpoint (container) | Behaviour |
|---|---|
| Under 560 px | Single column; hero art stacks above text; grid shows 2 columns at 320 px; buttons wrap full width. |
| 560 to 800 px | Nav above main; grid 3 to 4 columns. |
| Over 800 px | Sidebar and main side by side; grid fills with 168 px minimum tiles. |

### Navigation items

| Item | Icon (20 px, 1.6 stroke) | Visible to | Route |
|---|---|---|---|
| Home | house | All | `/` |
| Movies | film frame | All | `/movies` |
| Shows | screen | All | `/shows` |
| Collections | stacked cards | All | `/collections` |
| Servers | server rack | Operator only | `/servers` |
| Settings | sliders | All | `/settings` |

Operator-only items (Servers, and the Users, Sync and Health, Match conflicts and Curation tabs inside Settings or Servers) are not rendered for viewers. The server also enforces roles (FR-USR-003), so hiding is presentation only. The canvas shows Servers to everyone because it is an operator-view sample.

## 5. Screen inventory

| Screen | Status | Purpose | Primary components | SRS IDs |
|---|---|---|---|---|
| Library home | Designed in canvas | Resume, find, discover | Nav, search field, continue-watching hero, poster grid, sources list | FR-CAT-008, FR-PROG-001, FR-CAT-004 |
| Title detail + source picker | Designed in canvas | See a title and choose a copy | Title header, Play button, copies radiogroup, "why this copy" callout | FR-CAT-005, FR-CAT-013, FR-PLAY-005, FR-PLAY-010 |
| Servers | Designed in canvas | Register and monitor servers | Server card, segmented type selector, form field | FR-SRV-001 to FR-SRV-006, FR-OPS-003, FR-OPS-004 |
| Sign-in (passkey) | Not yet designed | Sign in | Centred card, primary button, alert | FR-USR-001 |
| Invite signup | Not yet designed | Redeem invite, register passkey | Centred card, form field, primary button | FR-USR-002 |
| First-run setup | Not yet designed | Create first operator | Stepper card, form field | FR-USR-002, FR-OPS-008 |
| Search results | Not yet designed | Find titles, people, collections | Grouped result sections | FR-CAT-004, FR-CAT-011, FR-CAT-012 |
| Person page | Not yet designed | Titles for one person | Person header, poster grid | FR-CAT-011 |
| Collections browse | Not yet designed | Browse collections | Collection tile grid | FR-CAT-012 |
| Collection page | Not yet designed | Titles in one collection | Header, poster grid | FR-CAT-012 |
| Movies / Shows browse | Not yet designed | Browse with filters | Filter bar, poster grid | FR-CAT-002, FR-CAT-003 |
| Series detail | Not yet designed | Seasons and episodes | Title header, season tabs, episode rows | FR-CAT-005, FR-CAT-009 |
| Player overlay | Not yet designed | Watch | Video, controls, track menus, version switch, error panel | FR-PLAY-001 to FR-PLAY-006, FR-PLAY-009, FR-PROG-001 |
| Settings | Not yet designed | Theme, passkeys, sign out | Segmented selector, passkey list | NFR-UX-001, FR-USR-006 |
| Operator: users and invites | Implemented at `/servers/users` (agent decision 2026-10-04; see divergence (p)) | Manage people and access | Table, invite dialog, grants checklist | FR-USR-004, FR-USR-005, FR-USR-007, FR-USR-008 |
| Operator: sync status | Not yet designed | Sync outcomes per server | Status table, run history | FR-OPS-003, FR-SYNC-002, FR-SYNC-006 |
| Operator: health | Not yet designed | Reachability history | Status dots, probe list | FR-OPS-001, FR-OPS-004 |
| Operator: match conflicts | Not yet designed | Resolve wrong merges | Conflict card pair, merge and split actions | FR-CAT-010, FR-CAT-007 |
| Operator: curation | Not yet designed | Manual merge and split | Search, two-pane picker | FR-CAT-007 |

### Wireframe-level specs (not yet designed)

Shared rules: shell from section 4, tokens from section 3, components from section 6. Every list has loading skeleton, empty and error states.

| Screen | Regions and components | States |
|---|---|---|
| Sign-in | Centred 420 px card on `--cw-bg`, wordmark, h1 "Sign in", one primary button "Use your passkey", helper line "Lost your passkey? Ask the person who invited you for a new link." No password or email field. | Waiting for browser prompt (button loading); cancelled (neutral alert, retry); no passkey found (alert + hint); disabled account (alert, no retry); offline. |
| Invite signup | Same card. Shows the invited display name (read-only, from the invite), optional "Name your passkey" field, primary button "Create passkey". | Valid; expired, revoked or used (error card, no form, "Ask for a new invite"); passkey unsupported (alert, link to supported browsers); success then redirect home. |
| First-run setup | Same card with 2 steps: Operator name; Create passkey. Final panel links to Servers with "Add your first server". Only reachable while no operator exists. | Setup already done (redirect to sign-in); setup token missing or wrong (error card). |
| Search results | Opens from the header search. Query echoed in h1 "Results for 'x'". Three sections in order: Titles (poster grid), People (person chips in a wrapping row), Collections (collection tiles). Each section shows up to 12 items with "See all". Section heading is mono uppercase with a count. | Typing (results update, announced via `aria-live="polite"` count); loading (skeleton tiles); none ("Nothing matches 'x'. Try fewer letters or another spelling."); partial (a section failed: inline alert, others still shown). |
| Person page | Header: avatar circle with initials (no photo required), name h1, mono line "ACTOR, DIRECTOR". Poster grid of visible titles; each tile adds the role as a third line ("as Maria"). | Loading; empty (person has no visible titles for this user); error. |
| Collections browse | h1 "Collections"; grid of collection tiles (`minmax(min(220px,100%),1fr)`). | Loading; empty ("No collections yet. They appear after a server's library is indexed."); error. |
| Collection page | Header: tile art, name h1, count "7 titles on 3 servers". Poster grid in collection order or year. | Loading; empty; error; some members unavailable (muted tile + "Offline" label, still listed). |
| Movies / Shows browse | h1; filter bar (selects for genre, year range, resolution; sort select title, year, date added) as 44 px controls; poster grid; "Load more" button or infinite scroll with a visible button fallback. Active filters shown as removable chips. | Loading; no matches ("No titles match these filters." + "Clear filters" secondary button); error. |
| Series detail | Title header as Title screen. Below: season tabs (segmented selector), episode list rows (number mono, title, runtime, watched tick, progress bar, "N copies" chip). Play button label: "Resume S2 E4" or "Play S1 E1". Copies picker per episode in an expandable row. | Loading; no episodes; episode all copies offline (row muted, "Offline since 03:14"); watched (check + label, not colour only). |
| Player overlay | Full-viewport black, controls auto-hide after 3 s of inactivity and reappear on any key or pointer. Top bar: back, title (and S/E). Bottom: seek bar, play/pause, skip 10 s, volume, tracks button (audio and subtitles, including Off), "Copy" button (version switch, opens the copies radiogroup), captions, fullscreen. All controls are native-keyboard operable (Space, K, arrows, F, M, C). | Buffering (spinner with text "Buffering"); resume prompt ("Resume from 1:12:04" / "Start over"); copy failed to start (panel: "This copy did not start. Trying Dad's Plex..." with Cancel; see below); no copy left (error panel with Retry and "Back to title"); subtitles loading; ended (next-episode card, 10 s countdown with Cancel). Failover and error copy follow FR-PLAY-004 and FR-PLAY-010. |
| Settings | Sections: Appearance (segmented System / Dark / Light), Passkeys (list with name, added date, "Remove" disabled on the last one with reason), Account (display name, role as read-only mono label, "Sign out"). | Add passkey: first "Confirm it's you" with an existing passkey (SR-04), then the browser prompt for the new one (loading, cancelled as a neutral note, error); remove confirm; saved toast. |
| Operator: users and invites | Tabs: People, Invites. People table: display name, role tag, library access summary, status, actions (Edit access, Re-enrol link, Disable, Delete). Invites: "New invite" opens a dialog (display name, role segmented, library checklist) then shows the single-use link with Copy button and expiry; list of open invites with Revoke. | Empty invites; link copied toast; delete confirm naming the person; last operator (Delete and Disable disabled with reason). |
| Operator: sync status | Server selector row, then per server: last run outcome (status dot + text), next run, counts, recent errors list, "Sync now" and "Full re-index" buttons. | Running (progress bar); partial (warn); failed (bad, error text); never run. |
| Operator: health | Server rows with current status and a 24 h strip of probe results (each cell labelled with a title and text alternative); latency is the Worker-measured value. | No probes yet; degraded; unreachable since. |
| Operator: match conflicts | List of conflict cards: two or more candidate source rows side by side (poster, title, year, server, file info), actions "Merge into one" (primary) and "Keep separate" (secondary). | Empty ("No conflicts to review"); resolved toast with Undo; error. |
| Operator: curation | Search two titles, show both copies tables, actions Merge, or select a source and "Split out". Shows a banner "This choice is kept across future indexing." | Nothing selected; merge preview; success toast; error. |

## 6. Components

Common states: default, hover, focus (2 px ring), selected, disabled (opacity .5 plus `aria-disabled`, still readable at 4.5:1 is not required for disabled but the label must remain legible), loading skeleton (`--cw-surface-2` blocks with a 1.2 s opacity pulse; respect `prefers-reduced-motion` by not animating), empty, error. Only state differences from common behaviour are listed.

| Component | Anatomy | States and behaviour | A11y notes |
|---|---|---|---|
| Nav item | `<a>` 44 px min, 20 px icon, label, radius 8, gap 12, padding 0 12 | Default `text-body`; hover `surface-2`; selected `surface-selected`, `text`, weight 600, `aria-current="page"`; focus ring. No loading or empty state | Icons `aria-hidden`; label always visible; nav is `<nav aria-label="Main">` |
| Search field | `<form role="search">`, 48 px, radius 12, magnifier icon, `<input type="search">`, `surface-1`, `border-control` | Placeholder "Search titles, people, collections across all servers"; focus shows ring on the form via `:focus-within`; loading shows a small inline spinner; error shows inline alert below | Visually hidden `<label>` "Search every server"; Enter submits; `Escape` clears; results count in a live region |
| Poster card | `<a>`: 2:3 poster (year top-left mono 11, title overlay), row with name (600/15) and "N copies" chip, then best-copy line (13, `text-muted`) | Hover raises poster 2 px and brightens border; focus ring on the whole link; selected n/a; unavailable variant: poster at 60% and best-copy line shows "Seedbox · offline" with a dot; skeleton: 2:3 block and two lines; broken artwork falls back to tinted fill with title | Link name is "Title, year, N copies". Overlay title is `aria-hidden` (duplicate of the name row). Chip text, not colour, carries the count |
| Continue-watching hero | `<section>`: 16:9 art with 4 px accent progress bar at the bottom (width = percent watched), mono label "CONTINUE WATCHING", title and year, line "26 min left · resuming from Basement NAS, direct play", Resume (primary) and "Choose another copy" (secondary) | Hover and focus as buttons; loading skeleton; empty: section is not rendered (no empty hero); error: replaced by inline alert with Retry; multiple items: horizontal row of hero cards, 1 per view on narrow screens | Progress bar has `role="progressbar"`, `aria-valuenow`, label "62% watched". Section labelled by its h2 |
| Primary pill button | Accent fill, `on-accent` text 700, optional 14 px play or plus icon, radius 24 (26 when 52 px high), min 48 | Hover `accent-hover`; focus ring; pressed 1 px down; disabled muted fill `surface-selected`, text `text-muted`; loading: spinner replaces icon, label stays, `aria-busy="true"`; error handled by a nearby alert | Real `<button>` or `<a>`. One primary per region |
| Secondary outline button | Transparent, 1 px `border-control`, `text` 600, radius 24 (10 in cards), min 44 | Hover `surface-2`; same disabled and loading rules | Label is a verb ("Re-index", "Edit") |
| Source picker radiogroup row | `role="radiogroup"` labelled by the section h2. Each row a `<button role="radio" aria-checked>`, 64 px min. Columns: radio (28), server (name 600 + BEST badge, then mono "TYPE · network"), video, HDR, audio, size, on this device (dot + text) | Selected: `surface-selected-row`, accent ring and fill. Hover `surface-2`. Unavailable row: still selectable to read why, but "Play" is disabled and the row shows "Unavailable" in `status-bad`. Loading: 4 skeleton rows. Empty: "No playable copy right now." Error: alert above the table | Arrow keys move selection within the group, Tab leaves it (roving tabindex). Header row `aria-hidden`; each cell carries a visually hidden label ("Video 1080p"). The BEST badge text is read ("Best copy") |
| BEST badge | Mono 10, 0.06em, radius 4, `accent` fill, `on-accent` text | One per title at most | Text, not colour |
| "Why this copy" callout | `surface-1` panel, border, radius 12; 20 px info icon in `accent`; bold line "Basement NAS: 1080p, direct play" and one explanation sentence | Updates (via `aria-live="polite"`) when the selection changes; error and unavailable reasons use `status-bad` icon | Plain sentence. Reason comes from the descriptor reason codes (FR-PLAY-010) |
| Server card | `<article>` radius 16, `surface-1`, padding 22: h2 name, mono URL (wraps), type tag (mono 11, bordered), status dot + text, optional indexing progress, 2-column `<dl>` (TITLES, LAST INDEXED, SIGN-IN, PRIORITY), actions "Re-index", "Edit" | Online (ok), Indexing (warn + progress bar with text "Indexing 1,184 of 1,910 items"), Offline (bad, "Offline since 03:14"), Disabled (muted, "Disabled"); loading skeleton; empty state for the list: "No servers yet" + Add server; error: card-level alert | `dl` semantics for stats; progress bar `role="progressbar"` with text value; actions labelled with server name ("Edit Basement NAS") |
| Segmented type selector | Row of 44 px `role="radio"` buttons in a `<fieldset>` with legend "Server type"; radius 10; selected: `surface-selected` fill and accent border | Hover `surface-2`; focus ring; disabled option greyed | Radio semantics with arrow-key navigation. Same pattern for System / Dark / Light and season tabs |
| Form field | Visible `<label>` (600/14), input 48 px, radius 10, `border-control`, mono for URLs and secrets, optional help line and error line | Focus: ring; error: border `status-bad` plus icon and message linked by `aria-describedby`; disabled; loading (Test connection) shows inline "Checking..." | Never placeholder-only labels. Password inputs use `autocomplete="off"` for server secrets |
| Status dot | 8 px circle plus mandatory text label | ok, warn, bad, muted (disabled) | Decorative (`aria-hidden`); the text carries meaning |
| Person chip | Pill 44 px high: 28 px initials circle (`surface-2`), name 600/14, optional mono role | Hover and focus as secondary button; selected n/a | `<a>` to the person page; initials `aria-hidden` |
| Collection tile | 3:2 tile radius 12: stacked-poster collage of up to 3 member artworks (fallback tinted fill), name (600/15), mono "7 TITLES" | Hover raises 2 px; skeleton; empty collage uses fallback fill | `<a>` name "Collection name, 7 titles" |
| Toast / alert | Inline alert: radius 12, `surface-1`, 1 px border in status colour, icon, text, optional action. Toast: same, bottom-left, 5 s, dismissible, pausing on hover and focus | Info, success (ok), warning, error (bad). Errors persist until dismissed | `role="status"` for info and success, `role="alert"` for errors. Never colour only |

## 7. Copy and tone

Plain, specific, owner-friendly. Say what happened, since when, and what happens next. No jargon in viewer screens, no exclamation marks, no blame.

| Rule | Good | Avoid |
|---|---|---|
| Specific times | "Offline since 03:14" | "Server unavailable" |
| Plain playback | "Plays as-is in this browser" | "Direct play (no transcode)" |
| "Copies" for viewers | "4 copies on 3 servers" | "4 sources" |
| "Servers" is fine | "Seedbox hasn't answered since 03:14." | "Origin 3 unreachable" |
| What happens next | "Cinewren keeps this copy listed and offers it again when the server is back." | "Error 503" |
| Mono uppercase for metadata labels | `SERVER`, `VIDEO`, `LAST INDEXED`, `CONTINUE WATCHING` | Mono for sentences |
| Verbs on buttons | "Resume", "Choose another copy", "Add and start indexing" | "Submit", "OK" |
| Honest limits | "No media is copied or stored here; transcoding stays on the server." | Implying Cinewren streams video |
| Passkeys | "Use your passkey" | "Enter password" |

Operator-facing copy may name server types, status codes and counts. Viewer-facing copy never asks for, or mentions, server credentials.

## 8. Divergences between the canvas and this specification

| ID | Canvas shows | Specification | Resolution or follow-up |
|---|---|---|---|
| (a) | Add-server form asks for "Jellyfin API key", "Emby API key", "Plex account token" | [ADR-0008](../adr/0008-origin-service-accounts-and-credential-encryption.md) requires a dedicated non-admin service account. Jellyfin and Emby API keys are typically admin-level (to verify in the M1 spike) | Field labels follow the M1 spike outcome. Copy must not ask for admin keys. Until then, a neutral label "Service account credential" with help "Create a read-only account on the server for Cinewren" is the fallback. Record in ROADMAP §3 |
| (b) | Source rows show "LAN · 3 ms" and "Remote · 41 ms" | Latency is measured from the Worker, not the viewer's network | Show Worker-measured health latency ("41 ms from Cinewren"). Viewer-side LAN detection is out of v1 scope unless a browser probe is added later. Drop the LAN/Remote wording; "directly over your home network" claims are not made |
| (c) | "Playing on: This browser, 1080p display" button with a chevron looks like a device picker | v1 plays only in this browser (DEF-2) | Render as a non-interactive capability summary ("This browser · up to 1080p · HDR not supported"), derived from reported capabilities (FR-PLAY-002). No chevron, not a button |
| (d) | Search placeholder names people and collections, Collections nav exists, but no screens | Now in scope per owner decision 2026-10-04 (FR-CAT-011, FR-CAT-012, FR-SYNC-008) | Specified in section 5; add artboards to the canvas |
| (e) | Dark only | Light theme required at v1 (NFR-UX-001) | **Resolved 2026-10-04:** light artboards were added to the canvas and the owner accepted them ("looks good"). |
| (f) | Account button shows "E" | No email is collected (NFR-PRIV-001, [ADR-0014](../adr/0014-passkey-auth-with-invite-links.md)) | Derive the initial from the display name (first letter, or first letters of the first two words). Accessible name stays "Account" plus the display name |
| (g) | Server names and titles (Basement NAS, Dad's Plex, Seedbox, Metropolis...) | Illustrative only | Not content, not test fixtures. Real data comes from synced catalogs |
| (h) | Servers list shows a "Sign-in: API key / Plex account" stat | Same credential question as (a) | Label follows (a); never display secrets |
| (i) | Nav shows Servers to everyone | Operator only (FR-USR-003) | Hide for viewers (section 4) |
| (j) | Unselected radio ring, search and input borders under 3:1 | Section 3.4 | Use `--cw-border-control`; ask the owner to accept the change **Owner accepted 2026-10-04**, together with the light artboards. |
| (k) | Library-home sidebar "Sources" list | No viewer-facing server endpoint (operators see servers on the Servers page) | Omitted | agent decision 2026-10-04 |
| (l) | Poster cards show copy count or best-copy line | Card responses carry no copy data | Show neither; detail page shows copies from `GET /items/{id}/versions` | agent decision 2026-10-04. Copies now come from `ItemDetail.copies` (M3, T3.7), with `/versions` as a fallback for an API without it |
| (m) | Continue watching shows progress | No progress data until M3 | Show a quiet placeholder | agent decision 2026-10-04. Superseded in M3 (T3.5): hero cards with progress; the section is not rendered when empty |
| (n) | Genre filter | Input with dropdown menu | Text input with suggestions | agent decision 2026-10-04 |
| (o) | Copies table with play actions | No actions until M3 (FR-CAT-013, FR-PLAY-005) | Plain table without play actions | agent decision 2026-10-04. Superseded in M3 (T3.7): radiogroup, Play and manual choice |
| (p) | Not on the canvas; the wireframe row in section 5 lists Edit access, Re-enrol link, Disable and Delete for every person, and "tabs" | People and Invites use the segmented selector (as for season tabs). Edit access is omitted for operators, who see every enabled library (FR-USR-005; the API returns `GRANTS_NOT_APPLICABLE`). Re-enrol link and Disable are omitted for people still `invited`, whose link is revoked from Invites. Disable becomes Enable for a disabled person. The last-operator protection (BR-8) is applied in the UI only when every person is loaded; the server's `LAST_OPERATOR` reason is shown otherwise | agent decision 2026-10-04 |

Identity of people and collections follows [ADR-0015](../adr/0015-people-and-collection-identity.md): the UI shows one person or collection even when several servers supply it, with no server label on person or collection pages.

## 9. Traceability

| Screen | SRS IDs |
|---|---|
| Library home | FR-CAT-004, FR-CAT-006, FR-CAT-008, FR-PROG-001 |
| Title detail + source picker | FR-CAT-005, FR-CAT-006, FR-CAT-013, FR-PLAY-002, FR-PLAY-005, FR-PLAY-010 |
| Servers | FR-SRV-001 to FR-SRV-007, FR-SYNC-002, FR-OPS-003, FR-OPS-004 |
| Sign-in, invite signup, first-run setup | FR-USR-001, FR-USR-002, FR-OPS-008, NFR-PRIV-001 |
| Search results, person page, collections browse, collection page | FR-CAT-004, FR-CAT-011, FR-CAT-012, FR-SYNC-008 |
| Movies / Shows browse | FR-CAT-002, FR-CAT-003 |
| Series detail | FR-CAT-005, FR-CAT-009 |
| Player overlay | FR-PLAY-001 to FR-PLAY-006, FR-PLAY-009, FR-PLAY-010, FR-PROG-001 |
| Settings | NFR-UX-001, FR-USR-006 |
| Operator: users and invites | FR-USR-003 to FR-USR-005, FR-USR-007, FR-USR-008 |
| Operator: sync status, health | FR-SYNC-006, FR-OPS-001, FR-OPS-003, FR-OPS-004 |
| Operator: match conflicts, curation | FR-CAT-007, FR-CAT-010 |
| All screens | NFR-A11Y-001, NFR-UX-001 |

| Capability | Screens |
|---|---|
| CAP-1 | Servers |
| CAP-3, CAP-4, CAP-5 | Library home, browse, search results, Title detail, Series detail |
| CAP-6, CAP-7, CAP-11 | Title detail, Player overlay |
| CAP-8 | Library home, Player overlay |
| CAP-9 | Sign-in, invite signup, first-run setup, Settings, Operator: users and invites |
| CAP-10, CAP-13 | Operator: sync status, health |
| CAP-12 | Operator: match conflicts, curation |
