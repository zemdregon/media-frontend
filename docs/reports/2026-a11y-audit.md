# Accessibility audit, WCAG 2.2 AA (T5.7)

| | |
|---|---|
| Date | 2026-10-04 |
| Scope | NFR-A11Y-001 (WCAG 2.2 AA, player fully keyboard operable, captions), NFR-UX-001 (both themes meet contrast independently) |
| Build audited | the web app at this commit, served by the real Worker (`wrangler dev`) with a mock Jellyfin origin |
| Status | **No open WCAG 2.2 AA failures on the core journeys that automated and scripted checks can detect.** Manual assistive-technology testing has not been done and is listed under "What this audit does not cover". |

## 1. Method

Everything below is repeatable with `pnpm e2e`. The checks live in `apps/e2e/tests/ui-a11y.spec.ts` (new) and `apps/e2e/tests/journey.spec.ts` (axe on the setup screen added). The audit spec runs after the journey on the same database, signs in again with the operator's passkey, and drives Chromium (headless, 1280 x 720 unless stated).

| Technique | How | WCAG criteria it informs |
|---|---|---|
| axe-core 4.13 | Tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`, run once per theme by setting `data-theme` before the scan (TDD §6.6). Any violation fails the test. | 1.1.1, 1.3.1, 1.4.3, 1.4.11, 2.4.x, 2.5.8 (target size), 3.3.x, 4.1.2 and others axe covers |
| Accessibility-tree names | After every axe scan, the browser's full accessibility tree (CDP `Accessibility.getFullAXTree`) is read, and every button, link, text box, search box, slider, radio and checkbox must have a non-empty name. This is what a screen reader announces, and it covers icon-only controls. | 4.1.2, 2.4.6, 1.1.1 |
| Keyboard-only journeys | Playwright keyboard events only, no pointer: sign in, skip link, navigation, browse, open a title, play, open the audio and subtitles menu, change subtitles, close with Escape, stop with Back, resume dialog. At every Tab stop the test checks a visible focus ring (outline of at least 2 px), that the element is not covered by other content (`elementFromPoint`), and the order of labels. | 2.1.1, 2.1.2 (no trap), 2.4.3, 2.4.7, 2.4.11 (Focus Not Obscured), 3.2.x |
| Reduced motion | `prefers-reduced-motion: reduce` emulated. No element on five screens or in the player may have a running animation or a non-zero transition. A control run without the preference proves the probe can tell the difference. | 2.2.2, 2.3.3 (AAA, applied as house rule per UX §6) |
| Zoom and reflow | A 640 x 360 CSS-pixel viewport stands for 200 % zoom of 1280 x 720, and 320 x 256 for 400 %. No horizontal page scroll, nothing cut off at the right edge outside a scroll container, axe clean at 200 %. | 1.4.4, 1.4.10 |
| Target size | Every button, link and field in the header, navigation and page content is at least 24 x 24 CSS px (visually hidden radios are measured by their label). | 2.5.8 |

## 2. Screens and states covered

Each is scanned by axe in the dark and the light theme, with the control-name check. Test names are in the "Evidence" column of §3 and in `ui-a11y.spec.ts`.

- Signed out: sign-in (`journey.spec.ts`), setup, invite (no token and invalid token).
- Signed in, any user: home, Movies, Shows, Collections, title detail (movie), series detail, season detail, episode detail, person, collection, search results, search with no results, filtered browse, settings (including the saved-appearance status), page not found, item not found.
- Operator: Servers (server card with health panel, and the add-server form open), sync status, audit log, match conflicts (curation).
- Player: playing, audio and subtitles menu open, copy menu open, resume dialog, a title that cannot start (error frame), and at 200 % zoom.
- At 200 % zoom: home, title detail and the player (axe), and seven screens for reflow. At 400 %: five screens.

## 3. Findings

Severity follows axe impact and the effect on a keyboard or screen-reader user: **High** blocks or misleads a task, **Medium** degrades it, **Low** is polish or best practice. "Found by" says how the defect surfaced; "Evidence" is the test that now guards it.

| ID | Finding | WCAG | Severity | Found by | Status | Evidence |
|---|---|---|---|---|---|---|
| F1 | The player is a full-viewport overlay, but the navigation, search field and account link behind it stayed in the tab order. Shift+Tab from "Back" put focus on controls the overlay hides. Same for the resume dialog, which is `aria-modal` but did not make the page inert. | 2.4.11, 2.4.3, 4.1.2 | High | Design review of `Shell.tsx` and `Player.tsx` while writing the keyboard tests | **Fixed.** The skip link, navigation and header are `inert` on `/watch/*`. | `keyboard: the player is fully operable, focus never leaves it, and nothing traps`; `dialog: the resume prompt takes focus, is operable by keyboard, and does not trap` |
| F2 | Closing the audio and subtitles or copy menu with Escape unmounted the menu with focus inside it, so focus fell to the page start. | 2.4.3, 2.4.7 | Medium | Review | **Fixed.** Focus returns to the button that opened the menu. | `keyboard: change the subtitles from the menu, close it with Escape, focus returns` |
| F3 | Opening a menu left focus on its button, so a keyboard user had to tab through Copy and Fullscreen to reach it. The buttons also claimed `aria-haspopup="true"`, which announces a menu widget the panels are not. | 2.4.3, 4.1.2 | Medium | Review | **Fixed.** Focus moves into the menu (the checked option), and `aria-haspopup` is dropped in favour of `aria-expanded`. | same test as F2 |
| F4 | Left and Right arrows on a native radio in the subtitle menu were taken by the player's seek shortcut (the check looked for `role="radio"`, which native radios do not carry), so the radio could not be changed with those keys. | 2.1.1 | Medium | Review | **Fixed.** Native radios are excluded from the shortcut. | `keyboard: change the subtitles from the menu...` (Arrow keys change the selection and the clip does not jump 10 s) |
| F5 | The player menu is dark in both themes but used the active theme's tokens, so in the light theme its headings, outline buttons and copy-table header were dark grey on near black. | 1.4.3 | High (axe: serious) | axe, `color-contrast`, light theme, on the open menus | **Fixed.** `.player-menu` takes the dark token set locally. | `keyboard: change the subtitles from the menu...` (axe on both menus, both themes) |
| F6 | At 200 % zoom the title page scrolled horizontally (page 692 px wide in a 640 px viewport). The visually hidden labels in the copy-table rows are absolutely positioned and the table wrapper was not a positioned container, so they escaped its clip. | 1.4.10, 1.4.4 | Medium | The 200 % zoom test | **Fixed.** `.table-wrap` is `position: relative`. | `200% zoom (640 CSS px wide): screens reflow, controls stay reachable, axe stays clean` |
| F7 | The control bar's opacity fade ignored `prefers-reduced-motion` (the existing reduced-motion block precedes the player rules and lost on order). | 2.3.3 (AAA) | Low | Review, then the reduced-motion test | **Fixed.** | `reduced motion: no animation or transition survives prefers-reduced-motion` |
| F8 | At 200 % zoom the curation panel's provider-records table (operators, title page) and the audit log table scroll sideways but were not reachable by keyboard (axe `scrollable-region-focusable`). | 2.1.1 | High (axe: serious) | axe at 200 % on the title page, after the curation UI was merged | **Fixed.** The scroll containers are focusable named regions. | `200% zoom (640 CSS px wide): screens reflow, controls stay reachable, axe stays clean` |

Everything else the checks examined passed without a change: no axe violation on any screen or state in §2 in either theme, every control has a name, every Tab stop in the journeys showed a focus ring and was uncovered, the skip link works, navigation moves focus to the page, and Escape does not break playback. There are no open findings from the automated or scripted checks.

### Evidence summary (tests)

`apps/e2e/tests/ui-a11y.spec.ts`: `keyboard: sign in with the passkey button, in a sensible focus order`; `signed-out screens: sign-in, invite and its invalid state, setup`; `keyboard: the skip link comes first, then navigation, search and account, then the page`; `keyboard: browse Movies and open a title without touching the mouse`; `keyboard: the player is fully operable, focus never leaves it, and nothing traps`; `keyboard: change the subtitles from the menu, close it with Escape, focus returns`; `keyboard: stop playback with Back, and the session ends`; `dialog: the resume prompt takes focus, is operable by keyboard, and does not trap`; `axe, both themes: <screen>` for 20 screens; `axe, both themes: server list with the add form, libraries and health panel`; `axe, both themes: filtered browse, empty state and the settings theme control`; `reduced motion: ...`; `200% zoom ...`; `400% zoom ...`; `the player at 200% zoom: every control is on screen and focusable`; `target size: ...`; `the audit made no script errors`. `apps/e2e/tests/journey.spec.ts` adds axe on setup, servers, sync status, settings, sign-in, home, Movies, title detail, series detail, search, person, collections, the resume prompt and the player.

## 4. What this audit does not cover

Automated and scripted checks find roughly a third to a half of WCAG issues at best. These are **not** established by this audit and remain open work before the v1.0 release gate:

1. **Manual screen-reader testing.** Nothing was listened to with NVDA, JAWS, VoiceOver or TalkBack. Accessible names, roles and live regions are verified from the browser's accessibility tree, not from what a screen reader says, in what order, or how verbose it is. Priority checks: the player status and caption announcements, the poster-grid link names, the copy-table radiogroup, and the route-change focus move.
2. **Captions as rendered.** The mock origin serves no WebVTT file, so the audio and subtitles menu, the Captions button and the announcements are tested, but not the visual appearance of cues (size, contrast and position are the browser's, WCAG 1.4.3 for captions is the cue style). Test with a real text track.
3. **Real devices and browsers.** Chromium only (the passkey virtual authenticator is Chromium-only, TDD §5.1). Firefox, Safari, iOS and Android keyboard and touch behaviour, and browser zoom itself (the 200 % and 400 % checks resize the viewport), are unverified. Text-only zoom is not supported by the stylesheet, which sizes type in pixels; browser page zoom, which WCAG 1.4.4 accepts, is.
4. **Speech input, switch access, high-contrast and forced-colors modes.** Not exercised.
5. **Content judgements axe cannot make:** whether link and heading text is meaningful, whether error messages help, reading level, and whether the colour-and-text status patterns (UX §6) are understood.
6. **Origin-provided content**: artwork has no alt text by design (decorative, duplicated by the name row); titles, overviews and subtitle text come from the origin.
7. **2.5.7 Dragging Movements and 3.3.8 Accessible Authentication:** no dragging is used, and authentication is a passkey (no cognitive test), so both are met by design, but there is no dedicated test.
8. **The Plex-specific and curation flows beyond the screens listed in §2** (for example resolving a conflict) were not walked with the keyboard.

## 5. Re-running

```sh
pnpm build            # the e2e serves apps/web/dist
pnpm e2e              # journey, then the audit
```

Delete `apps/e2e/.state` first for a clean run. The audit spec reads the operator passkey that the journey spec writes to `apps/e2e/.state/handoff.json`, so it cannot run alone.
