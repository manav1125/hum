# Cue mobile sign-on — design handoff

Two self-contained HTML files (open in any browser):

## 1. cue-signon-screens.html — the screen set (source of truth for UI)
Concept: **"Gravity"** — the user's scattered tools spiral in and lock into orbit around the Cue ring.
All screens live-animated, dark (primary) + light:

- **S Splash** — 4 app chips + 3 motes fall into two counter-rotating orbits while the ring draws itself (exact icon geometry, dasharray 707/236, rotate 42°). Kinetic type beats: "Your inbox. / Your meetings. / Your commitments. / One Cue." Filaments fade in from chips → core after capture. 9s, tap-to-skip; warm launches cut to a settled orbit (~0.8s).
- **A Sign in** — orbital system idles dimmed above a glass sheet; email input focused; sheen sweep on primary.
- **B Check email** — the link is a comet orbiting the envelope (2.6s period). Primary: **Open Mail**; Resend disabled w/ countdown then accent-outline.
- **C Connecting** — hyperspace streaks converge; determinate ring sweeps closed around the true Cue mark; cycling status lines (Verifying ✓ / Waking your agents / Picking up where you left off); at 100% a bloom expands past the bezel = crossfade into app.
- **E Manual address** — `cue-you` + fixed `.justcue.app` suffix, mono type.
- **D1 expired** (decayed dashed orbit, red state, blue fix) · **D2 not recognised** (empty motionless orbit, email echo + Edit) · **D3 offline** (whole system frozen — motion pausing IS the message; red only on slash).

## 2. cue-signon-prototype.html — the flow contract (interactive)
One phone plays the full journey: splash → sign-in (tap field: auto-type; orbit accelerates 30s→9s period + glow flare while typing) → send → Open Mail → notification banner → deep link → hyperspace (4.4s) → **"You're in, Manav."** → Connect your tools.
Left panel = **sensory track**: live haptic/sound log. Map 1:1 to:
- soft tick (UIImpactFeedbackGenerator .light) — each orbit capture, address complete
- medium impact — dot pop, link sent, deep link open
- success (.success notification) + optional soft chime — bloom/entry
Pointer parallax over the phone = gyro spec (CoreMotion, far layer ×0.5, near ×1.1, clamp ±8px, 250ms ease-out).

## Build rules
- Tokens: dark bg #0B0B0F / splash #030306, surface #16161D, border #2A2A35, text #F4F4F6, muted #9A9AA8, accent #3D6EE8; light bg #F6F6F8, surface #FFF, border #E2E2E8, text #17171C, muted #6A6A76, error #E5675B dark / #C4372B light (errors ONLY).
- System font (SF Pro / Roboto). Inputs ≥16px (iOS zoom), targets ≥44pt, safe areas respected.
- All animation transform/opacity only (compositor). Blurred auroras are static textures that move — never animate blur radius.
- prefers-reduced-motion: orbits/auroras/shimmer freeze to composed mid-state, rises → 200ms fades, sweep → plain determinate ring, bloom → simple crossfade. Nothing communicated by motion alone.
- No "Vellum" anywhere. WebView-safe (no hover dependencies).
- Landing after connect is honest: name only (from the account), no fabricated activity. CTA → onboarding connect-tools step.
