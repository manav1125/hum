# Cue iOS — Mobile Design Implementation Status

Implementation of the `CUE Mobile.dc.html` design book (dark v1 + light parity)
into the Capacitor/WKWebView app. The iOS app renders the web SPA (`apps/web`),
so "mobile screens" = the SPA's responsive mobile layer, themeable + native-aware.

Design source: `~/Downloads/CUE_design_extracted/mobile-handoff/` (book + README).

---

## ✅ Done & verified (in the iOS Simulator + typecheck + production build)

| Area | What | File(s) |
|---|---|---|
| **IA / tab bar** | Bottom bar rebuilt to the design's **Today · Tasks · Voice · You** (Chat is now a push, not a tab). Active = brand accent, inactive dimmed. | `apps/web/src/components/cue-mobile-tab-bar.tsx` |
| **Brand type** | Loaded **DM Sans + DM Mono** (the app referenced them inline everywhere but never loaded them → fell back to system). Now the brand type renders app-wide. | `apps/web/index.html` |
| **Dark v1 default** | Native (Capacitor) app now defaults to the **dark** design by default; an explicit user theme choice still wins. Both the pre-React flash guard and the React resolver updated. | `public/theme-init.js`, `src/domains/settings/utils/theme-preferences.ts` |
| **Native feel** | Pinch-zoom + double-tap zoom disabled (`user-scalable=no, maximum-scale=1`); `theme-color` set for both schemes. | `apps/web/index.html` |
| **Tasks screen** | Mobile `/next-moves` rebuilt to the design: `WORKING ON · {project}` groups, the **fixed status taxonomy** pills (Working/Triaging/Done/Approve), bottom `APPROVAL NEEDED` callout, empty + loading states. All actions preserved (complete / open→thread / approve via the same handlers). | `src/domains/next-moves/next-moves-page.tsx` |
| **You hub** | Mobile "You" tab rebuilt: "Reach Cue anywhere" hero, **Channels** rows (icon · name · desc · green status dot, real connect/disconnect via the same hooks), **Memory & config** rows linking to the real memory/settings routes. No fake data, no credential fields. | `src/domains/intelligence/channels-agents-page.tsx` |
| **Branded splash** | Native LaunchScreen image replaced with the Cue **C-aperture on ink gradient** (no more white launch flash); LaunchScreen bg set to ink. | `App/Assets.xcassets/Splash.imageset/*`, `App/Base.lproj/LaunchScreen.storyboard` |
| **Boot splash** | In-SPA ink+aperture splash (`boot-splash.js`) paints immediately and self-removes when React renders — closes the white-blank gap while the SPA loads from a cold backend. CSP-safe (external script, CSSOM styles). **Verified showing + clearing in the sim.** | `apps/web/public/boot-splash.js`, `apps/web/index.html` |

**Quality gates:** `tsc --noEmit` → 0 errors. `bun run build` → success. The two
screen rebuilds were done in isolated git worktrees, function-preservation
verified, then integrated (0 lines of existing code lost) and re-typechecked.

**Visual verification:** iOS Simulator (real mobile viewport) confirmed the new
tab bar, dark v1 theme, brand fonts, chat + composer, and the boot splash →
app handoff. (The desktop browser cannot drop below ~desktop width, so Tasks/You
mobile branches were verified by typecheck + design-token conformance, not a
screenshot — see "Verify on device" below.)

---

## 🟡 Today (Home) — already designed, inherits the wins
`/home` → `HomeElevatedRoute` was already built to the brand (DM Sans/Mono inline,
the split-button from #42/#43, an 880px mobile collapse). With fonts now loaded +
dark default, it should render well on mobile. **Not re-touched** (low risk to a
1000+ line hero screen). Verify its mobile rendering on device.

---

## ⏳ Remaining (refinement — recommend doing with on-device verification)
- **Voice** hold-to-talk (the *enabled* immersive screen) — currently shows the real
  "not enabled" empty state; the enabled state couldn't be exercised (voice isn't
  configured on this assistant). Restyle once voice is enabled on a device.
- **Chat** push polish — works + is dark; the design's back-‹ header (vs the current
  hamburger header) and tool/step-chip styling are nice-to-haves. Composer
  keyboard-rise is already handled by `use-visible-viewport` / `use-composer-keyboard`.
- **Light parity** — the app's existing light theme applies; the design's *exact*
  light tokens aren't mapped (dark is v1 default, so this is secondary).
- **Meeting capture** screen (§3.6) and the design's CSS keyframe animations
  (cueLook/cuePing/cueBar…) — not yet ported.
- **Default landing** — the app opens to the last chat; the design's default tab is
  **Today**. Consider defaulting the native app to `/home`.

---

## 🚧 Blockers (outside this work)
- **Apple PLA** — archive is blocked until you accept the updated Program License
  Agreement at developer.apple.com (you-only). Then re-run the archive.
- **Render daemon → DeepSeek** — the deployed backend still needs the BYO OpenRouter
  wiring so chat works in a shipped build (the "pair on it" item).

The work is on the `cue/handoff-bundle` branch, **uncommitted** (working tree) for
your review.
