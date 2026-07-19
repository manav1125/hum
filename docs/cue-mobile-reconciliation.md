# Cue mobile — design reconciliation map

> **SUPERSEDED FOR MOBILE (2026-07-19): mobile now follows the v3 native
> spec — `docs/design/mobile-v3/` (README + `cue-mobile-v3.html`).** The
> serif "HQ direction" below no longer applies on mobile: mobile surfaces
> convert to the SF-Pro/glass/aurora `--mv3-*` system
> (`apps/web/src/mobile-v3/` — TabBarV3 + the converted Today are live;
> remaining screens convert per the v3 frame index). **Desktop keeps the
> serif HQ direction unchanged** — this document still governs desktop and
> any mobile screen not yet converted to v3.

_Date: 2026-07-19. Companion to `docs/cue-mobile-fidelity-audit.md` (Phase 5)._

## The decision

Converge every mobile surface on the **shipped HQ direction**, and retire the
older "mobile book" generation:

- **Tab bar** — the 5-item `Today · Projects · ✳ Create · Voice · You`
  (`apps/web/src/components/cue-mobile-tab-bar.tsx`) is canonical. The older
  4-tab `Today · Tasks · Voice · You` is retired.
- **Typography** — Instrument-Serif editorial hero titles for screen headers
  (as on Today/HQ, Projects), DM Sans body, DM Mono eyebrows. Serif applies to
  the screen's hero title only — never body text or control labels.
- **Tokens** — the theme-aware `--mv1-*` layer (`apps/web/src/index.css`). No
  hardcoded light hex that would render light-on-dark in the app's dark shell.

## Foundation (verified conforming — do not re-touch)

- `components/cue-mobile-tab-bar.tsx` — already the 5-item HQ bar; `--mv1-*`
  material; per-element tap-highlight reset. **No 4-tab remnant anywhere in the
  app** (grep confirms no "Tasks" nav tab).
- `domains/activity/theme.ts` — the shared HQ palette (`C` → all `--mv1-*`),
  `serif` (Instrument Serif) and `mono` (DM Mono). Screens importing it are
  token-compliant by construction.
- `index.css` — `--mv1-*` token layer (theme-aware; light literals under light,
  dark-book hexes under dark/velvet); the native-feel reset (tap-highlight,
  `overscroll-behavior`, `.cue-pressable`); haptics wrapper is implemented.
- `pages/hq/hq-page.tsx` + `domains/intelligence/connectors-page.tsx` — just
  fixed in prior commits; re-verified conforming (serif heroes, `--mv1-*`,
  mobile branches). **Read-only references — not touched.**

## Surface-by-surface

| Surface | File | Status | Change |
|---|---|---|---|
| **Today / HQ** | `pages/hq/hq-page.tsx` | ✅ Conforms | none (just fixed; verified) |
| **Projects** | `pages/projects/projects-page.tsx` | ✅ Conforms | none — `useIsMobile` branches, serif hero, activity/theme tokens |
| **All-work** | `pages/projects/all-work-page.tsx` | ◻︎ Conforms (tokens/serif via `GroupHeader`); no `useIsMobile` branch | none this pass — narrow-width polish is a follow-up (P2) |
| **Create** | `domains/create/create-view.tsx` | ✅ Conforms | none — `useIsMobile`, local `serif`, `C`→`--mv1-*` |
| **Chat** | `domains/chat/components/mobile-chat-view.tsx` | ⚠︎→✅ Fixed | **built the new-conversation greeting state** (serif hero + suggestion cards); `--mv1-*` throughout |
| **Voice** | `domains/chat/voice/*` | ✅ Conforms | none (dead-panel/engine-toggle cleanup is Phase-4, out of scope) |
| **Memory** | `domains/intelligence/memories-page.tsx` | ⚠︎→✅ Fixed | serif hero already present; **tokenized the hardcoded light-red Forget / error-state palette** → theme-aware `--mv1-danger` |
| **Memory row** | `domains/intelligence/memories/memory-row.tsx` | ◻︎ Mostly conforms; `kindColors` triplets are light literals | left as follow-up — per-kind accent hues are a near-exact mock port; converting risks regressing the faithful cards (P2) |
| **You / Channels** | `domains/intelligence/channels-agents-page.tsx` | ⚠︎→✅ Fixed | **hero title DM Sans → Instrument Serif**; `green` literal → `--mv1-green`. Channel-brand icon hexes (Slack/Gmail) left intentionally — brand marks, theme-invariant, on always-dark `--mv1-chip` tiles |
| **Agents** | `pages/hq-agents/agents-org-page.tsx` | ✅ Conforms | none — serif hero + activity/theme; `TILE_BG` is a documented deliberately-dark glyph tile (both themes). `window.confirm()` on retire is a Phase-4 native-feel follow-up |
| **Skills** | `domains/intelligence/components/skills/skills-tab.tsx` | ⚠︎→✅ Fixed | **`const C` light-hex palette → `--mv1-*`** (was rendering the light mock on the dark shell); hero title `#fff` → `--mv1-t1`; card `#fff` → `--mv1-card`; native primitives (`cue-pressable` + `haptic.light`) on the hero/empty-state buttons |
| **Skill detail** | `domains/intelligence/components/skills/skill-detail-mobile.tsx` | ✅ Conforms | none — all semantic tokens, no hex |
| **Settings** | `domains/settings/settings-layout.tsx`, `settings/pages/general-page.tsx` | ◻︎ Design-library system (not the editorial-serif look) | left as-is — these are `SidebarShell`/`DetailCard` design-library screens; theme-aware by construction. The audit's missing General rows (Accent/Reduce-motion/Proactivity) are content build-out (P1), not a direction conflict |
| **Connectors** | `domains/intelligence/connectors-page.tsx` | ✅ Conforms | none (just fixed; verified) |
| **Onboarding** | `domains/onboarding/pages/*` | ◻︎ Design-library / Tailwind system | left as-is — welcome/privacy/hatching use design-library typography and mirror the Swift native funnel; not editorial-serif hero screens. No hex / no direction conflict |
| **Meeting** | `domains/meeting/meeting-capture-page.tsx` | ⚠︎→◻︎ Partially fixed | **desktop hero DM Sans → Instrument Serif**; the mobile `const D` dark palette is intentional full-bleed dark shell but not theme-aware — flagged as follow-up (P2) |

Legend: ✅ conforms · ⚠︎ diverged (fixed this pass) · ◻︎ acceptable / follow-up.

## What changed this pass

1. **Chat greeting state (Chat P1)** — the HQ direction's chat entry, previously
   unbuilt. Empty conversations now render a serif editorial greeting hero over
   tappable suggestion-starter cards (reusing the same daemon greeting + starters
   the desktop empty state uses), instead of an empty transcript.
2. **Skills palette** — the marquee light-on-dark offender; the whole screen now
   follows the active theme.
3. **Serif heroes** — Channels ("Reach Cue anywhere") and Meeting hero aligned
   to the editorial-serif direction.
4. **Memory danger palette** — theme-aware.
5. **Native primitives** — `cue-pressable` + `haptic.light()` on the Skills
   buttons touched this pass.

## Deliberate non-conversions (not bugs)

- **Brand-mark hexes** (Slack `#4A154B`, Gmail `#EA4335`, WhatsApp `#25D366`,
  Telegram `#229ED9`) on `--mv1-chip` tiles — brand identity, theme-invariant.
- **`--mv1-chip`** is dark in both themes by design (dark glyph tiles).
- **`TILE_BG` / agents glyph tiles** — documented fixed-dark tiles.

## Follow-ups (left for a later pass, honestly noted)

- `memory-row.tsx` `kindColors` triplets → theme-aware tokens (P2; risk to the
  faithful mock port).
- `meeting-capture-page.tsx` mobile `const D` dark palette → `--mv1-*` (P2; large
  file, intentional dark shell — only wrong under the light theme).
- `all-work-page.tsx` narrow-width `useIsMobile` branch (P2).
- Settings General content rows (Accent / Reduce-motion / Default-landing /
  Proactivity) — content build-out (P1), not a direction conflict.
- Phase-4 native-feel cleanup: Agents `window.confirm()` → styled dialog; Voice
  dead "not enabled" panel + engine toggle.
