# Cue Parity+ — three surfaces, one backend

Three self-contained files, one per platform brief. Each is the spec — inspect inline styles. Shared vocabulary across all three (a watcher is a watcher; a plugin's consent rows read the same; the state taxonomy colors mean the same thing everywhere). Honesty rule throughout: no affordance the backend can't honor — NEEDS BACKEND is flagged on-frame where a drawn thing outruns capability.

═══════════════════════════════════════════
## cue-live-overlay.html — OS X overlay (HIGHEST PRIORITY)
The desktop-control interaction model. Dark, glass over the live screen, at real overlay scale, rendered over a representative desktop.

**Five states (one coherent system):**
1. **Intent / about-to-act** — plain-words intent, target lit with the POINT dot, veto countdown for low-risk auto-approved actions. The trust anchor: you always see the next move first.
2. **In-overlay approval** — medium/high-risk pauses in the overlay (no context-switch): action + risk reason + Allow once / Allow session / **Always allow (with scope)** / Deny. The scope chip ("in ~/Desktop") is the magic moment. Amber = needs-you.
3. **Working / verify-settle** — step counter + the verify beat (✓ verified / ↻ retrying / ‖ stuck). "Checking it worked…" is the differentiator. Includes 3b retry + stuck branches.
4. **Pause / stop** — holds mid-run (overlay AND phone remote, same control); Stop ends at the next safe boundary.
5. **Done / summary** — what happened, link into the conversation (the run IS a conversation), artifact + Undo where one exists.

**Desktop-organizer flow** (first killer app): A inventory (read-only scan) → B plan card (per-category approve, move-never-delete to ~/Desktop/Cue Archive/<date>, protected paths excluded, scope chip born here) → C live per-category progress → D done + undo (replays the manifest).

**System rules block** (frame s6): contrast floor (own scrim per surface), ring = presence, POINT dot colors (blue intent / amber approval), AX-inert, reduced-motion fallbacks.
**NEEDS BACKEND:** per-action "explain why" beyond the risk-reason string (the one flagged item). Everything else = real host-proxy / AX-tree / ActionVerifier.

═══════════════════════════════════════════
## cue-mobile-parityplus.html — iPhone, frames 66–73 (continues v3 numbering)
Same v3 contract (SF Pro, glass over aurora, taxonomy law, ○ parked, ≥44pt, real logos).

- **66 Plugins leaf** — Explore/Installed (Skills grammar), surface-type filter chips, real-icon cards + official/community badge + install count; dashed "Install from GitHub URL" row.
- **67 Plugin detail** — frame-57 skill-sheet grammar: consent rows derived strictly from manifest (tools/connectors/apps/routes), pinned commit + version, "an app will appear" note (panel not mocked), install confirm.
- **68 Untrusted install** — distinct red-edged warning sheet for raw-URL installs; names the repo, "Cue hasn't reviewed this," manifest reach, risk carried in the button label.
- **69 Automations leaf** — Watchers (teal: source/interval/last-hit/on-off, real logos) + Playbooks (violet: trigger→action + AUTO/DRAFT/NOTIFY chip). **Placement decision: You-cluster leaf, not a new tab** (power-user config; outputs already surface in Came-in/work lanes).
- **70 New playbook** — trigger→action→autonomy→priority; **autonomy capped by global dial** (Auto locked 🔒 with a line pointing to You→Trust).
- **71 Desktop-organizer remote** — the plan approvable from the phone, honest "RUNNING ON YOUR MAC · MacBook Pro" (mirrors Cue Live).
- **72 Live mirror + done** — progress mirror + "Tidied 68 · Undo"; never claims the phone did the work.
- **73 Phone channel** — Twilio setup in frame-39 grammar (3 steps, token masked + instance-only promise, receptionist persona line, "how it behaves" honesty line); post-setup a Phone row joins Connections.

═══════════════════════════════════════════
## cue-web-parityplus.html — desktop HQ, serif grammar (deliberately NOT mobile v3)
Instrument Serif display, DM Mono microlabels, DM Sans body, ink on #F4F3EF, blue #3D6EE8. macOS window chrome.

- **W1 Plugin marketplace** — category rail + registry search + curation filters (official/community/by surface-type), install counts + source repos on cards; "Submit a plugin" PR path in sidebar (NEEDS BACKEND, doc-link for alpha).
- **W2 Plugin detail (full page)** — description, declared surfaces (tools/apps/connectors/hooks), consent panel (same ✓ / ‖ vocabulary as mobile), source + pinned commit + version history, app-preview affordance, install/enable/disable.
- **W3 Watchers + Playbooks board** — two columns: watchers (source/interval/**health dot**/hits, incl. a reauth state) + playbooks (trigger→action, autonomy chip, priority, last-fired). Global-trust banner makes the autonomy-vs-dial relationship explicit; create/edit inline.
- **W4 Call transcript** — a phone call as an HQ conversation: caller, direction, duration, transcript (caller + Cue-as-receptionist), extracted items typed by owner (↴ action / ◈ decision / ◷ context) → work items; Call back + File all. (Setup = serif mirror of mobile Twilio sheet, not re-shown.)
- **W5 Desktop-control consent** — plan card (steps, read/write scope, move-never-delete, approve / **approve-with-scope "Always allow in ~/Documents/Q2"** / deny — directory-scoped trust), live run (web view of the overlay loop, verified steps, pausable), which-Mac target picker with honest offline "not connected · Wake" state.

═══════════════════════════════════════════
## Shared taxonomy (all surfaces)
blue picked-up · pulse running · amber needs-you · violet review · green done · red only for true failure. Trust vocabulary: Observe/Assist/Autonomous global dial caps everything downstream (playbooks, Cue Live actions). Scope chips ("Always allow in <path/app>") are the one grant gesture, worded identically on every surface. Move-never-delete + undo-via-manifest for every file operation.
