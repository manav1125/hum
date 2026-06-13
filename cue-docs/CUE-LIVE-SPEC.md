# Cue Live — Technical & UX Spec

Companion to `design/cue-live-v0.4.html` and `CUE-LIVE-RESEARCH.md`. The desktop-presence
surface: a cursor companion that understands your screen, guides you, and can take control.
Design principles (from research): **AX-first, guide-first, memory-backed, self-hosted, consent-first.**

## 1. Architecture
```
┌ macOS native helper (extends the fork's vellum-mac-helper.app) ───────────────┐
│  • AX Reader        — Accessibility API: roles, labels, values, bounds (~50ms)  │
│  • Screen capture   — ScreenCaptureKit, per-window, ON DEMAND only              │
│  • Action layer     — CGEvent + AX actions (press / setValue), via MCP          │
│  • Overlay window    — transparent, click-through NSPanel: companion + highlights│
└───────────────┬───────────────────────────────────────────────────────────────┘
                │ IPC (existing daemon socket)
┌ Cue assistant runtime (vellum fork) ──────────────────────────────────────────┐
│  • Observation gate (local model): "is anything actionable here?"               │
│  • Reasoning (cloud model): guide vs act, next-move synthesis                    │
│  • Approvals / permissions (existing) · CES isolation (existing)                 │
│  • Memory write (8-type) + next-moves queue                                      │
└────────────────────────────────────────────────────────────────────────────────┘
```
**Tiered observation (cost + privacy):** AX tree first → local gate → screenshot only on
meaningful change / when summoned / when AX is blind (canvas apps) → cloud reasoning. Redact
secure text fields + user-flagged apps. Default posture: **AX-only, no screen images.**

## 2. The four modes
| Mode | What it does | Capture | Trust |
| --- | --- | --- | --- |
| **Companion** | Follows cursor, passive until summoned (hotkey/voice). Reads hovered element, offers next move. | AX only | lowest |
| **Scoped watch** | User points at one window/app/region; extracts action items + todos from just that. | bounded | low |
| **Always-on** | Whole screen, continuous. Visible light + one-tap pause. | AX + vision on change | high (opt-in) |
| **Take control** | State a goal; Cue drives. **Guided** (points, you click) → **Autonomous** (acts, you approve). | as needed | per-step approval |

Take-control reliability follows the benchmark reality: reliable on AX-rich apps (email, forms,
web, business tools), **guide-only** on canvas apps (Figma, video) until vision improves.

## 3. Key interactions (UX)
- **Summon:** global hotkey (clicky uses Control+Option) or voice ("Cue…"). Companion fades in by cursor.
- **Guide card:** anchored near the relevant element; "Next move" + [Do it] [Show me] [Not now].
- **Highlight:** draw the AX element's bounds with a Cue-blue ring + label (e.g. `AXTextArea · body`); optional "point" animation (clicky's `[POINT:x,y]` mechanic).
- **Take-control checkpoint card:** step progress bar, current step text, **[Stop] always wins**, [Pause], [Approve & send]. Guarded actions (send, pay, delete) force a checkpoint.
- **Consent indicator:** persistent menubar pill — mode + live light + pause. Mirrors the trust console.

## 4. Repo mapping (where it lives)
- **Native helper:** extend `clients/macos` + the packaged `vellum-mac-helper.app` (apps/macos) — AX reader, ScreenCaptureKit, overlay NSPanel, CGEvent. (Swift.)
- **Action layer:** expose desktop control as an **MCP server** consumed by `assistant/src/mcp` + `assistant/src/tools`; gate via `assistant/src/approvals` + `permissions`. Run credentialed bits through CES.
- **Observation gate:** small local model in the assistant runtime (providers abstraction).
- **Memory/queue:** write via existing `assistant/src/memory`; surface in the redesigned Home next-moves queue (v0.3).
- **UI/overlay styling:** Cue tokens from `design-library`; overlay is native (not the React app), but visual language matches.

## 5. Fork / borrow integration (all MIT)
- **clicky** — lift the overlay NSPanel + `[POINT:x,y]` cursor-fly + push-to-talk loop as the companion UX starting point.
- **macos-use / MacOS-MCP / Open Computer Use** — adopt as the MCP action layer (`list_apps`, `get_app_state`, `click`, `type_text`, `set_value`) instead of hand-rolling CGEvent plumbing.
- **Fazm** — reference (or embed) the AX-first reader + async pipeline for take-control.
- **Screenpipe** — pattern for local-first scoped-watch capture + on-device storage.

## 6. Privacy & safety (non-negotiable)
- AX-only by default; screen images require explicit opt-in per mode.
- Visible capture light whenever observing; one-tap pause; auto-delete raw frames (24h default).
- Never capture secure fields / flagged apps. Self-hosted: nothing leaves the user's cloud.
- Take-control: per-step approvals on side-effecting actions, global Stop, full audit in the trust console.

## 7. Build order (staged, ship the reliable wedge first)
1. **Companion (guide-only), AX-first** — overlay + summon + hovered-element understanding + next-move card. No control yet. (Borrow clicky overlay.) ← shippable wedge.
2. **Scoped watch → memory** — point at a window, extract action items into memory + queue.
3. **Take-control: guided** — highlight + point + "you click," with approvals.
4. **Take-control: autonomous on AX-rich apps** — MCP action layer + checkpoints.
5. **Always-on + vision escalation** — continuous, consent-gated; vision only when AX is blind.

## 8. Open decisions
- Native Swift overlay/AX (clicky/Fazm path) vs. bridging via the Electron app → **recommend native helper.**
- Build AX engine vs. embed Fazm vs. consume a macos-use MCP → **recommend MCP action layer + our own AX reader.**
- Which local model for the observation gate (cost/privacy/latency).
- Cross-platform later: Windows UIA, Linux AT-SPI (macOS first).
