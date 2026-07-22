# Design brief — Cue mobile sign-on

**For:** Claude Design (or any designer). Self-contained — no repo access needed.
**Deliverable:** high-fidelity mobile screens for the sign-on flow below, dark + light, ready for a developer to build to.

---

## 1. What Cue is

Cue is a personal AI chief-of-staff. Each customer ("owner") runs their **own
private instance** of Cue at their own web address (e.g.
`cue-manav.justcue.app`). There is **one** Cue app on the App Store / Play
Store; when you sign in, it connects you to *your* instance and remembers it.

This brief covers the **first screens a new person sees** — signing in. It is
the app's first impression, so it should feel calm, trustworthy, and effortless.

## 2. The one job

Get the owner from "just installed the app" to "inside my Cue" with the least
possible friction. The method (fixed — please design to it):

1. Enter your **email**.
2. We email you a **secure sign-in link**.
3. **Tap the link** → the app opens straight onto your Cue.
4. Next launch, it remembers you and goes straight in.

No passwords. No usernames. No web address to type (except an optional fallback).

## 3. Screens to design

Design each as a full mobile screen (iOS reference: 393×852pt, but must adapt to
any size). Account for the notch/Dynamic Island at top and the home indicator at
bottom (safe areas). Provide **dark (primary)** and **light** for each.

**A · Sign in (email entry)** — the landing screen.
- Cue brand mark + "Sign in to Cue".
- One short reassuring line.
- Email input (focused, keyboard-ready).
- Primary button: send the link.
- A quiet, secondary text link to the fallback ("Enter your Cue address instead").

**B · Check your email** — shown right after they tap send.
- Confirmation that a link was sent, echoing the **email address** back.
- A sense that the app is now waiting (a subtle live/pending indicator).
- Secondary action: **Resend link** (disabled during a short cooldown, then enabled).
- Tertiary: **Use a different email** (returns to A).

**C · Connecting** — a brief held moment after the link opens the app.
- Brand mark + a calm loading state.
- "Connecting to your Cue…" and, subtly, the instance address.
- This is transient (1–3s); design it so a slightly longer wait still feels fine.

**D · Errors** — design the shared error pattern + these three cases:
- **Link expired** — links last 15 min. Primary action: send a new one.
- **Email not recognised** — no Cue is registered to that email. Suggest checking
  the address or contacting whoever set up their Cue.
- **Offline** — no connection. Retry.
- Errors state plainly *what happened* and offer *the one tap that fixes it*. No
  apologies, no jargon, no dead ends.

**E · Enter your Cue address (fallback)** — reached from A's secondary link.
- For people who already know their address (power users, testers).
- Single input hinting `cue-you.justcue.app`, a connect button, and a way back to
  email sign-in.

## 4. Brand & visual direction

Cue is **dark-first**, quiet, and modern — closer to a focused productivity tool
than a consumer social app. Restraint over decoration. One accent, used sparingly.

**Color tokens (use these exact values; derive states from them):**

Dark (primary):
- Background `#0B0B0F` · Surface `#16161D` · Surface-2 `#1D1D26`
- Border `#2A2A35` · Text `#F4F4F6` · Muted text `#9A9AA8`
- Accent `#3D6EE8` (Cue blue) · Accent text `#FFFFFF`
- Success `#4BB57A` · Error/danger `#E5675B`

Light:
- Background `#F6F6F8` · Surface `#FFFFFF` · Surface-2 `#F0F1F4`
- Border `#E2E2E8` · Text `#17171C` · Muted `#6A6A76`
- Accent `#3D6EE8` · Error `#C4372B`

Rules:
- **Accent blue is the only brand color.** Reserve red strictly for errors.
- Neutrals carry a faint cool (blue-leaning) bias — avoid dead grey.
- Give the light theme equal care; re-tone, don't naively invert.

**Type:** the platform system font (SF Pro on iOS / Roboto on Android) is correct
and authentic — no custom webfont. Establish a clear scale: a confident screen
title (~24–26px, tight tracking), 15–16px body, 12–13px labels/captions with a
little letter-spacing on uppercase. Inputs must be **≥16px** (smaller text makes
iOS zoom on focus).

**Mark:** a placeholder "C." tile was used in the reference. If a real Cue app
icon/wordmark exists it should be used — otherwise propose a simple, ownable mark.

## 5. Copy (starting point — refine for tone, keep it plain and warm)

- Sign in: **"Sign in to Cue"** / "Enter your email and we'll send you a secure sign-in link."
- Button: **"Send sign-in link"**
- Fallback link: "Enter your Cue address instead"
- Check email: **"Check your email"** / "We sent a sign-in link to **{email}**. Open it on this phone and you'll drop straight into your Cue." · pending: "Waiting for you to tap the link" · "Resend link" · "Use a different email"
- Connecting: **"Connecting to your Cue…"** / "Getting things ready."
- Expired: **"That link expired"** / "Sign-in links last 15 minutes for your safety. Send yourself a fresh one." · "Send a new link"
- Not recognised: **"We couldn't find a Cue for that email"** / "Double-check the address, or ask whoever set up your Cue." 
- Offline: **"You're offline"** / "Connect to the internet and try again." · "Retry"
- Manual: **"Enter your Cue address"** / "Use this if you already know your Cue's web address." · input hint `cue-you.justcue.app` · "Connect" · "← Back to email sign-in"

## 6. Constraints & must-nots

- **No "Vellum" anywhere.** (Cue was formerly Vellum; no legacy branding may appear.)
- Runs inside a mobile WebView — no hover-dependent affordances; everything works by tap.
- Accessible: visible keyboard focus, legible contrast in both themes, respect reduced-motion, tap targets ≥44pt.
- Motion is minimal and purposeful (a gentle pending pulse, a spinner) — nothing flashy.
- No stock illustration clutter; if an icon is used (e.g. envelope on "Check your email"), keep it simple and on-brand.

## 7. What to hand back

- The five screens (A–E) + the three error cases, in **dark and light**.
- The shared components pulled out: input, primary/secondary button, error banner,
  pending indicator, brand mark — with their states (default / focus / disabled / error).
- Redlines or tokens are welcome but optional; a clean Figma or high-fidelity mock
  set is the core deliverable.

## 8. Reference

A rough first-pass mock of all six screens (dark + light) exists as an
interactive page — ask the requester for the link. Treat it as a **starting
point for layout and copy only**, not a visual bar to match; the goal is to
raise it.
