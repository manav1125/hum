# Design Brief — OS X / Cue Live overlay (the desktop-control interaction model)

**Priority: highest.** This is a net-new interaction model with no upstream equivalent — Cue
co-present on your screen, about to act, asking permission, showing its work. Get this right and
it's a genuine differentiator.

## What Cue Live is today (context, don't redesign the parts that work)
A macOS overlay summoned by a hotkey. Three existing modes stay:
- **Guidance** — reads the UI element under the cursor, whispers a ≤10-word next move.
- **Look** — screenshot + your spoken question → a spoken answer, with `[POINT:x,y]` dots drawn on
  the things it's referring to.
- **Voice** — push-to-talk conversation, TTS replies.
- **Phone remote** — a viewer on your phone can pause/stop a running session.

## What's changing (why this brief exists)
"Act" is being rebuilt. Today it clicks raw pixel coordinates with only a prompt telling it to be
careful. It's becoming a **grounded, approved, verified loop**: Cue identifies UI elements by the
accessibility tree (not guessed pixels), each action is risk-classified and can require your
approval, each action is **verified after it happens** (did the screen actually change the way it
should have?), and the whole run is visible in Mission Control. **This needs an overlay visual
language it doesn't have yet.** That's your job.

## The states to design (one coherent overlay system)

**1. Intent / "about to act."** Before Cue performs an action, a calm pre-action affordance: what
it's about to do in plain words ("Click 'Export' in the toolbar"), the target highlighted on the
real screen (reuse the POINT dot grammar), and — for low-risk auto-approved actions — a brief
countdown-to-act the user can veto. This is the trust anchor: the user always sees the next move
before it happens.

**2. In-overlay approval.** For medium/high-risk actions (anything destructive, anything outside an
allowed scope), the action pauses for a decision *in the overlay* — no context-switch to the app.
Show: the action, why it needs approval (risk reason), and the decision set that mirrors our
approvals — Allow once / Allow for this session / **Always allow (with the scope, e.g. "in this
app" / "in ~/Desktop")** / Deny. The "Always allow + scope" chip is the magic moment — one tap and
the rest of the run flows unattended. Amber = needs-you per the taxonomy.

**3. Working / verify-settle.** While the loop runs: a compact progress state showing the current
step, a step counter ("Step 3 of ~8"), and the verify beat — a brief "checking it worked…" →
✓ settled / ↻ retrying / ‖ stuck states (the ActionVerifier detects "no visible effect" and
retries or asks). Honest when it's uncertain. This is where the "Cue is actually doing careful work,
not flailing" feeling lives.

**4. Pause / stop.** The run is pausable (from the overlay AND the phone remote — same control).
Paused state holds mid-run with a clear resume. Stop ends at the next safe boundary. Design both.

**5. Done / summary.** A short completion state: what was accomplished, a link into the conversation
(the run is a real conversation now), and — if files/system changed — what changed with an undo
path where one exists.

## The first killer app: desktop-organizer ("clean up my Desktop")
A guided flow, overlay-native. Design its states:
- **Inventory** — Cue scans (read-only) and shows a calm "looking through 84 items on your
  Desktop…" state.
- **Plan card** — the review-before-move: items grouped by category (Screenshots · Installers ·
  Documents · Duplicates), each with its proposed destination, counts, and total. **Move, never
  delete** — everything goes to `~/Desktop/Cue Archive/<date>/` and can be undone. Protected paths
  (dotfiles, ~/Library, app bundles) are visibly excluded. The user approves the plan (whole, or
  per-category), and the "Always allow in ~/Desktop" scope chip appears here.
- **Live progress** — moving, with per-category progress and a running "moved 40 of 84".
- **Done + undo** — "Tidied 84 items into Cue Archive · Undo" (undo replays the manifest).

## Contract & rules
- macOS overlay grammar: glass over the live screen, the Gravity ring as Cue's presence, SF Pro,
  the v3 state taxonomy (blue picked-up / pulse running / amber needs-you / violet review / green
  done / red only for true failure). Dark-first; the overlay floats over arbitrary screen content
  so it needs its own contrast floor (scrim behind text).
- **Everything here is backed by real capability** — the host-proxy substrate (computer-use,
  file ops, app control), directory-scoped trust rules, and the ActionVerifier all exist or are
  being ported. No fake affordances. The ONE thing to flag NEEDS BACKEND if you want it: a
  per-action "explain why" beyond the risk reason string.
- Reduced-motion: the pointing/verify animations need static-state fallbacks.
- Accessibility irony to honor: this overlay drives an assistant that reads the AX tree — it must
  not itself pollute the AX tree of the app underneath (it already renders as an overlay window;
  keep it AX-inert).

## Deliverable
Rendered overlay states (over a representative screenshot background), dark, at real macOS overlay
scale. The desktop-organizer flow as a sequence. Flag deviations with reasons.
