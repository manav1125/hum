# Cue — UX Design Spec (Claude Code handoff)

Companion to `cue-design-system.html` (open it for the visual reference). This maps the
redesign to the actual repo so Claude Code can build it. Brand tokens in `BRAND.md`.

## 0. The architecture that makes this cheap
One React app powers **three surfaces**:
- `apps/web/src` → the web app **and** the body of the macOS app (loaded into Electron via
  `apps/macos`) **and** the iOS app (wrapped by Capacitor via `apps/web` → `apps/ios`).
- Shared visual system: `packages/design-library` (`src/tokens.css` already on Cue palette;
  components in `src/components`).

So: **design once in `apps/web/src` + `design-library`, ship to all three.** Surface-specific
shells (Electron chrome, iOS native bits) are thin.

## 1. Foundations (do first)
- Tokens: already applied in `packages/design-library/src/tokens.css` (Cue accent, rings).
  Add component-level usage of `--accent-cue*`; audit hardcoded greens → keep only success.
- Type: DM Sans / DM Mono / Instrument Serif already bundled. Wordmark `cue.` lowercase,
  blue period. No new fonts.
- Build a small primitives pass in `design-library`: `Card`, `Nudge` (left-accent),
  `Chip`/`ChipButton`, `FocusCard` (ink), `SourceTag` (mono, by memory type), `VoiceOrb`.

## 2. Surface 01 — macOS desktop
- Shell: `apps/macos/src/main` (window chrome, menu, tray — already rebranded). No layout here.
- Layout (in `apps/web/src/root-layout.tsx` + routes): three-column —
  left **sidebar** (logo, nav: Today / Memory / Tasks / Connections; channel presence with
  live dots = one memory), center **conversation thread**, right **Now rail**.
- Now rail = three stacked blocks: `FocusCard` (“Next move”), “Cue noticed” `Nudge`s
  (blue = info, violet = promise/commitment), “From your last meeting” task list with
  `SourceTag`. Data: proactivity loop + memory + tasks.
- Composer: single field, “hold to talk” mic affordance (ink circle) → enters Voice mode.
- Routes to touch: `home-page-route.tsx` (Today), a new Memory route, `pages/`, `domains/`.

## 3. Surface 02 — web app
- Same React app; the only deltas are the shell (browser, not Electron) and a **Continuity**
  affordance in the rail (“Picked up from your Mac session”) to make one-memory visible.
- Memory page: cards per item with `SourceTag` colored by memory type (episodic, semantic,
  procedural, prospective, emotional, behavioral, narrative, shared) + confidence + provenance.
- Connections page: connect-once list (Gmail, Calendar, Slack, Notion, Linear…) with live state.

## 4. Surface 03 — mobile (iOS via Capacitor)
- Wrapper: `apps/ios/App` + `apps/web/capacitor.config.ts`. UI is the same React app in a
  responsive mobile layout (collapse three columns → tabbed: Today / Memory / Voice / Tasks).
- Three hero screens in the showcase:
  1. **Today** — “Next move” ink card, “Cue noticed”, tasks-from-last-meeting; bottom tab bar.
  2. **Voice mode** — full-bleed ink screen, `VoiceOrb` (pulsing rings) + equalizer, live
     transcript with the in-flight phrase in blue, `● listening` state in mono.
  3. **Meeting capture** — record header (timer), live transcribe strip, action items &
     decisions streaming in as left-accented cards (blue=action, violet=decision).
- Entry points: persistent mic in tab bar; “take into a meeting” = capture screen.

## 5. Voice mode (all surfaces)
- Component `VoiceOrb`: blue core + 2 expanding rings (`@keyframes pulse`, 2.6s, staggered),
  violet equalizer bars while the user speaks. States: idle → listening → thinking → speaking.
- Wire to `assistant/live-voice` + `calls/`; TTS provider is an open decision (see ROADMAP).
- Interaction: hold-to-talk (push) and hands-free (VAD) both supported; tapping the orb cancels.

## 6. Cross-device handoff (the differentiator)
- Nothing new in data — it's the existing single memory + multi-channel runtime. The design
  work is *making it visible*: a “picked up from your <device>” chip in the rail, and live
  presence dots on channels. Keep the same conversation/thread state across surfaces.

## 7. Motion & polish
- Animations: orb pulse, equalizer, streaming action-item cards (fade+rise 180ms), nudge
  enter. Respect `prefers-reduced-motion`.
- Corners 12–16px, one hairline (`--line`), soft elevation only on floating surfaces.
- Sentence case everywhere; DM Mono for timestamps/sources/states only.

## 8. Suggested build order
1. `design-library` primitives + token audit.
2. `apps/web` Today (three-column) — lands macOS + web at once.
3. Memory + Connections pages.
4. Mobile responsive layout + tab bar.
5. Voice mode component + live-voice wiring.
6. Meeting capture screen (leads into ROADMAP Phase 3).
