# Cue iOS — Mobile Fidelity & Native-Feel Gap Audit

_Read-only audit. Date: 2026-07-18. Scope: the Cue iOS app's screens vs. their finished designs and vs. native-app expectations._

## Architecture reality (read this first)

The Cue iOS app is a **Capacitor / WKWebView that loads the web SPA** (`apps/web`). There is **no separate native screen set** — every "screen" is a responsive web route rendered at the phone breakpoint (`useIsMobile()` = `max-width: 767px`, `apps/web/src/hooks/use-is-mobile.ts`). So "make it feel like an iOS app" is **not** a rewrite; it is (a) making each route's mobile layer match its design, and (b) closing a small set of **app-wide** web-isms that a WebView exposes by default.

"Native feel" here concretely means:
- **Fullscreen under the notch/home-indicator** via `viewport-fit=cover` + `env(safe-area-inset-*)` and the `capacitor-plugin-safe-area` bridge. **This is already correctly wired** (see below) — it is not the problem.
- **No web-isms**: no gray tap-highlight flash, no long-press text-selection/callout on chrome, no rubber-band scroll-chaining on fixed headers/tab bar, momentum scroll on content, no 300ms tap delay, no hover-dependent UI.
- **Tactile response**: touch-down press states (scale ~.98) + **haptics** on commit actions.
- **Native transitions** on pushes (chat/detail), not hard DOM swaps.

Two things dominate the findings:
1. **A thin layer of global web-isms is unaddressed** — and these are exactly what read as "mobile web." They are **single, high-leverage fixes** that improve every screen at once.
2. **Two design generations coexist.** There is a dedicated **mobile design book** (`~/Downloads/CUE_design_extracted/mobile-handoff/Cue Mobile.dc.html`, the true mobile contract: DM Sans headlines, a 4-tab `Today · Tasks · Voice · You` IA, next-move split-button cards, hold-to-talk Voice, Meeting capture) — and a **newer HQ / desktop-v0.3 direction** (Instrument-Serif editorial heroes, a 5-item `Today · Projects · ✳ · Voice · You` bar, HQ rings, Projects). Some screens are faithfully built to the mobile book; others were improvised to the HQ direction with **no mobile mock**. Several desktop `design/surfaces/*.dc.html` mocks are outright **stale** (Account = password/Google login superseded by OAuth/magic-link; `Agents.dc.html` = A2A pairing, implemented by a different file). "You have designs for every screen, I don't think you've integrated them all" is accurate — but the deeper issue is that the designs themselves are not one coherent set.

**What is already good (don't re-do):** safe-area insets (`root-layout.tsx:264-282`, `runtime/native-safe-area.ts`, `capacitor.config.ts` `contentInset:"never"`); `viewport-fit=cover` + `user-scalable=no` (`apps/web/index.html:10`); theme-color for both schemes; the dark-v1 `--mv1-*` token layer maps the mobile book's palette **exactly** (`apps/web/src/index.css:57-88` vs README §1); the branded boot splash; keyboard-rise handling in chat.

---

## Surface-by-surface

| Surface | Impl | Fidelity vs mock | Native-feel gaps | Integrated? | Priority |
|---|---|---|---|---|---|
| **Today / HQ** | `pages/hq/hq-page.tsx` | **Med** — correct tokens/fonts, but improvised against `Home.dc.html`; drops the day-rail + "while you slept" recap; **no mobile branch** (CSS auto-fit only) | Rings-hero is a **fixed 176px in a non-wrapping flex** → crams at 390px (`hq-page.tsx:208-223`); serif hero hard-coded 34px, no shrink (`:586`, `:241`); header row not stacked (`:1403-1471`); **the book's aperture animations live only in the retired `home-elevated-route.tsx`, not HQ** | Current-gen, but no mobile mock | **P0** (it's the landing screen) |
| **Projects** | `pages/projects/projects-page.tsx` | **High** vs design system (no direct mock — `Workspace.dc.html` is a file browser) | Best-adapted of all: real `isNarrow` branches, single-column grid, shrunk serif (`:432-434,494`). Exception: `all-work-page.tsx` has **no** mobile branch (`:105-149`) | Yes | P2 (all-work only) |
| **Create** | `domains/create/create-view.tsx` | **Med-High** (no direct mock — `Library.dc.html` is the output gallery) | Strong: horizontal-scroll mode picker w/ momentum + hidden scrollbar (`:432-443`), stacked templates. Gaps: h1 fixed 34px; quick-start grid un-branched (`:603`) | Yes | P2 |
| **Chat** | `domains/chat/components/mobile-chat-view.tsx` | **Med-High** — reuses live `Transcript` so tool/step chips, approval card, error card, streaming caret all preserved & retinted | **Strong native feel**: back-‹ header (not hamburger), keyboard-rise via `useVisibleViewport` composer lift (`:195-204,342-351`). Gaps: **designed "new conversation" serif-greeting + suggestion-cards state is unbuilt** (renders `Transcript` unconditionally, `:334`); header drops the live `· ready/responding` status label; title at **9px** is near-illegible (`:312`) | Yes | **P1** |
| **Voice** | `domains/chat/voice/voice-mode-surface.tsx` → `voice-dictation-surface.tsx` | **High** — the immersive `MobileVoiceTakeover` is **fully built** (aperture orb, waveform, transcript, 3-circle mic dock). _Correction to prior belief: it is NOT just a "not enabled" empty state._ | Strong: full-bleed `fixed inset:0`, safe-areas, home-indicator gutter. Gaps: **dead unreachable "Voice mode isn't enabled" panel** (`voice-mode-surface.tsx:414-460`); an **un-designed Realtime/Classic engine toggle shipped to users** (`:378-412`) | Yes | P2 (cleanup) |
| **Cue Live** | `domains/intelligence/cue-live-page.tsx` | **N/A on iOS** — gated to Electron (`runtime/cue-live.ts:13`); iOS renders only a static "macOS desktop feature" `UnavailableNotice`. The rich panel is desktop-only, `gridTemplateColumns:"…280px"`, no mobile collapse | The one rendered element is a chrome-less centered card — placeholder, not a designed screen | No (mobile) | P2 (decide the story) |
| **You / Channels** | `domains/intelligence/channels-agents-page.tsx` → `YouMobilePage` (`:334`) | **Low-by-design** — purpose-built mobile branch; intentionally drops the desktop `Channels.dc.html` hero art / stat row / active-vs-available tiers into one flat `ChannelRow` list | **Reference implementation**: real mobile layout, 44px targets, safe-areas, live/error/empty states. This is how the others should feel | Yes | P2 |
| **Memory** | `domains/intelligence/memories-page.tsx` | **Med-High** — cards are a near-exact port (`memory-row.tsx` copies the mock color triplets, DM Mono type label, serif headline) | Real stacked column + pinned provenance rail. Gaps: 8 type-filter chips `flex-wrap` to ~4 rows pushing cards below the fold; provenance **hidden until a memory is tapped**; Edit/Forget are 11.5px tap targets; forget/error washes hardcoded hex (off-theme in dark) | Yes | P2 |
| **Connectors** | `domains/intelligence/connectors-page.tsx` | **Med (desktop) — worst offender at 390px** | **No mobile branch at all** (no `useIsMobile`/media logic). Non-wrapping hero squeezes the serif headline beside a fixed button column (`:355-466`); native `<select>` crowds search (`:533-554`); **not theme-aware — hardcoded light hex palette** (`C` obj `:41-54`) renders **light-on-dark** in the app's dark shell | Functionally yes, visually desktop-only | **P0** |
| **Agents** | `pages/hq-agents/agents-org-page.tsx` | **Low — wrong mock.** `Agents.dc.html` (A2A pairing) is implemented by `agents-page.tsx`, **not** the org page. Org page has no mock | Has `isNarrow` branch (single-column). But **`window.confirm()` on retire** (`:658`) is a jarring browser dialog; ⋯ menu is an absolute popover, not a native sheet | Yes | P2 |
| **Skills** | `components/skills/skills-tab.tsx` + `skill-detail-mobile.tsx` | **High** — explicitly "a faithful translation of `Skills.dc.html`"; inline hex palette, serif hero, tip banner. Dedicated full-screen mobile **detail overlay** with its own action bar + safe-areas | Genuinely native. Gaps: **category filter unavailable on mobile** (rail hidden, no replacement `:449`); mock's 44px filter button unbuilt; serif hero fixed 24px crowds 390px | Yes | P2 |
| **Settings** | `domains/settings/settings-layout.tsx` + `pages/general-page.tsx` | **Med** — structure good, content diverged | **Strong native feel**: `SidebarShell` is a proper two-page push (list → detail w/ back arrow, `sidebar-shell.tsx:47-60`), not a crammed table. Gaps: flat `DetailCard` stack with **no DM-Mono section eyebrows**; General page bears almost **none** of the mock's Appearance/Behavior rows (Accent swatches, Reduce-motion, Default-landing, Proactivity slider all absent) | Yes | P1 |
| **Onboarding** | `domains/onboarding/pages/*` | **Mixed** — `hatching-screen` High; `welcome` Med (2 CTAs vs mock's 1); `privacy` ≠ the mock's hosting panel; **the mock's "Cue is awake / active·ready" summary is unbuilt** | Uses design-library controls + `StepIndicatorDots` when native. OK | Yes | P1 |
| **Sign-on (native shell)** | `apps/ios/App/App/public/index.html` | **High** vs the current "Gravity" brief (`docs/design/mobile-signon/DESIGN-HANDOFF.md`) — orbital motion, dark splash, `.justcue.app` suffix, magic-link. Hand-built, native-feeling | Good | Yes | — |
| **Sign-on (web self-host connect)** | `lib/self-hosted/cue-connect-screen.tsx` | **Low** — a plain **light** centered form; none of the Gravity kinetic system; also diverges from stale `Account.dc.html` | Responsive but generic; first-impression screen | Yes | P1 |
| **Account** | (none) | **Low** — `Account.dc.html` (password + Google SSO) is **superseded** by the OAuth/magic-link model; no such screen exists | n/a | Design casualty | P2 (retire the mock) |
| **Meeting capture** | `domains/meeting/meeting-capture-page.tsx` | Mobile-aware (has `isMobile`). Book §3.6 screen — not deeply audited here | — | Partial | P2 |

---

## Cross-cutting native-feel fixes (highest leverage — one change, whole app)

These are the gaps that most make the app "feel like mobile web." Several are **explicit requirements of the mobile design book** ("No pinch-zoom, no rubber-band on fixed chrome, no long-press selection on UI chrome, momentum scroll on content" — README §1) that are currently **unmet**.

1. **Haptics are a no-op stub.** `apps/web/src/utils/haptics.ts` exports `haptic.{light,medium,success,error}` — every one is an empty `/* no-op until Capacitor is integrated */`. It is already **imported and called at ~14 sites** (composer submit, pull-to-refresh, conversation actions, open-app, command palette…). So the call sites exist and fire — they just do nothing. **Fix: implement the wrapper against `@capacitor/haptics`** (already a dependency, `package.json`). This is the single clearest "not native" gap and a ~20-line change that lights up the whole app.

2. **No `overscroll-behavior` anywhere** (grep: 0 hits). Fixed chrome (headers, tab bar) rubber-bands and scroll-chains — a classic web tell the book explicitly forbids. **Fix: `overscroll-behavior: none` on the app shell + scroll containers.**

3. **No global tap-highlight / touch-callout / user-select reset.** `index.css` has no `-webkit-tap-highlight-color`, `-webkit-touch-callout`, or `user-select` rules; only `cue-mobile-tab-bar.tsx` sets `WebkitTapHighlightColor` per-element. Everywhere else you get the **gray iOS tap flash** and **long-press text-selection/callout on UI chrome**. **Fix: a small global reset** (`* { -webkit-tap-highlight-color: transparent } `; `-webkit-touch-callout:none` + `user-select:none` on chrome, opt back in for message/memory text).

4. **No press-state feedback.** No `:active`/`active:scale`/touch-down handlers on cards or rows (book asks for "card press scale .98"). Combined with #1, taps have no tactile or visual acknowledgement. **Fix: a shared pressable primitive (scale .98 + `haptic.light()`).**

5. **Primary UI fonts load from a CDN.** `index.html:18-20` pulls **DM Sans + DM Mono from Google Fonts** over the network (FOUT + offline/cold-start failure), while Instrument Serif is correctly self-hosted (`@font-face` in the design-library CSS). **Fix: self-host DM Sans/Mono too** so the brand type never falls back to system on a cold WebView.

6. **No route/push transitions.** No `AnimatePresence`/`viewTransition` at the route layer — tab and push navigation are hard DOM swaps. Tab changes should stay instant (book), but chat/detail **pushes** should slide. **Fix: a lightweight push transition on the conversation/detail routes.**

7. **Status-bar style is static.** No `@capacitor/status-bar` plugin; style is fixed by `Info.plist` + `theme-color` meta and won't flip on a runtime dark/light theme change. Low priority (app defaults dark) but real if light theme ships.

8. **The book's offline / cold-start screen is unbuilt.** README §3.8 wants a "Cue may be waking up. Your data is safe." + single **Retry** screen (the backend cold-starts). Only the boot splash exists; there is no offline/error takeover. **Fix: build the offline/retry state.**

9. **Tab bar background stops at the safe-area line.** The bar sits inside the shell's `padding-bottom: env(safe-area-inset-bottom)`, so its material doesn't extend under the home indicator — a thin `--surface-base` strip shows below it. Minor; extend the bar bg into the inset with content padded up.

---

## Recommended fix sequence (max perceived-native improvement first)

**Phase 1 — global web-ism sweep (S, ~1 day, touches every screen).** Items 1–4 above: implement the haptics wrapper; add `overscroll-behavior:none`; ship the global tap-highlight/callout/select reset; add a pressable primitive (scale .98 + light haptic). This is the highest ROI in the whole audit — it changes the felt quality of every tap on every screen without touching any layout.

**Phase 2 — the two broken-at-390px screens (M, ~1–2 days).**
- **Connectors** (P0): add a mobile branch (wrap the hero, replace the native `<select>` with a touch filter, single-column) **and make it theme-aware** (swap the hardcoded light `C` hex for `--mv1-*`) so it stops rendering light-on-dark.
- **HQ / Today** (P0, the landing screen): add a real mobile branch — wrap/stack the 176px rings-hero, shrink the 34px serif on narrow widths, stack the header row — and **restore the aperture animation** (port `cueLook/cuePing/cueBar` from the retired `home-elevated-route.tsx`) so the primary screen has life.

**Phase 3 — first-impression + highest-traffic polish (M, ~2 days).**
- **Chat** (P1): build the designed "new conversation" greeting state (serif hero + suggestion cards + quick chips); restore the header live-status label; bump the 9px title to ≥10.5px.
- **Web self-host connect** (P1): apply the Gravity kinetic system (the native shell already has it — port the look) so the first screen a self-host user sees isn't a plain light form.
- **Settings General** (P1): add the mock's DM-Mono section eyebrows and the missing Appearance/Behavior rows (Accent, Reduce-motion, Default-landing, Proactivity).

**Phase 4 — cleanup + reconciliation (S–M).** Delete the dead "Voice mode isn't enabled" panel and decide whether the engine toggle ships; replace `window.confirm()` on Agents retire with the styled dialog; add a mobile category filter to Skills; fix Memory's chip-wrap + tap-to-reveal provenance; tune `all-work-page` for narrow widths; self-host DM Sans/Mono; add the offline/retry screen.

**Phase 5 — design reconciliation (planning, not code).** The root cause of "not all integrated" is that the **mobile book and the HQ direction disagree** (4-tab `Tasks` vs 5-item `Projects`+`Create`; DM-Sans headlines vs Instrument-Serif heroes) and several desktop mocks are stale (Account, Agents). Before more per-screen work, get one refreshed mobile design set that reflects the shipped IA (HQ, Projects, Create, the raised ✳) and formally retires the superseded mocks — otherwise fidelity work chases a moving/contradictory target. Also decide Cue Live's mobile story (build a mobile view or keep the honest "open on Mac" notice) and Meeting capture's priority.

---

### Doc accuracy note
`apps/ios/MOBILE-DESIGN-IMPLEMENTATION.md` is **stale**: it describes a 4-tab `Today · Tasks · Voice · You` bar, but the shipped bar (`components/cue-mobile-tab-bar.tsx`) is the 5-item `Today · Projects · ✳ Create · Voice · You` (Today→`/hq`, Projects→`/projects`, You→`/channels`). Treat the code, not that doc, as current.
