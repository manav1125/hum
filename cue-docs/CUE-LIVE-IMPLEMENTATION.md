# Cue Live — Implementation Plan (repo-mapped)

Concrete build breakdown for the desktop-presence "clicky-type" companion, mapping
`CUE-LIVE-SPEC.md` + `CUE-LIVE-RESEARCH.md` to this repo. Ordered by the spec's
staged build (§7): ship the **reliable wedge** first, add control later.

> Status (2026-06-14): NOT YET STARTED in code. Design + research specs exist;
> this is the execution plan. The native overlay/AX/CGEvent work needs a running
> macOS session to verify, so it must be built+run iteratively, not blind.

## Where it lives in the repo
| Layer | Repo location | Language | Notes |
| --- | --- | --- | --- |
| Native helper (AX read, overlay, capture, CGEvent) | extend `apps/macos/resources/vellum-mac-helper.app` (built by `apps/macos/scripts/build-mac-helper.sh`) + `clients/macos` | Swift | The helper already compiles + signs in the pack. Add AX reader + overlay NSPanel here. |
| Action layer (list_apps/get_state/click/type/set_value) | new MCP server under `assistant/src/mcp` consumed by `assistant/src/tools` | TS (calls helper over the existing daemon socket) | Borrow `macos-use` / `MacOS-MCP` tool surface instead of hand-rolling. |
| Observation gate | `assistant/src/providers` (small local model) | TS | "is anything actionable here?" — cost/privacy gate before cloud reasoning. |
| Approvals / checkpoints | reuse `assistant/src/approvals` + `assistant/src/permissions` + CES | TS | Guarded actions (send/pay/delete) force a checkpoint. Already exists. |
| Overlay UI styling | match `design-library` tokens (native, not React) | Swift | Cue-blue ring + guide card; mirrors the trust console. |
| Surface in app | next-moves queue / Home Now rail (already built) + a trust/consent menubar pill | React | Memory writes flow through `assistant/src/memory`. |

## Stage 1 — Companion (guide-only), AX-first  ← shippable wedge, build first
Goal: summon a companion by the cursor, read the hovered element via AX, show a
"next move" card. **No control yet.** This is the safe, reliable wedge.

1. **Overlay NSPanel** in the helper: transparent, click-through, always-on-top,
   joins all Spaces. (Lift clicky's overlay panel + `[POINT:x,y]` cursor-fly.)
2. **Summon**: global hotkey (clicky uses Control+Option) + voice ("Cue…"). The
   helper already registers global shortcuts (`src/main/global-shortcuts` in the
   Electron side) — add a Cue-Live hotkey that IPCs the helper to fade in.
3. **AX reader**: `AXUIElementCopyElementAtPosition` for the hovered element →
   role, label, value, bounds (~50ms). Redact secure text fields.
4. **Guide card**: anchored near the element — "Next move" + [Do it][Show me][Not now].
   Do-it is disabled in Stage 1 (guide-only).
5. **Highlight**: draw the element bounds with a Cue-blue ring + mono label
   (e.g. `AXTextArea · body`).
6. **Consent pill**: persistent menubar item — mode + live light + one-tap pause.

Verify: AX targeting on AX-rich apps (Mail, Safari forms, business tools); the
ring tracks the element; Stop/pause work; secure fields never read.

## Stage 2 — Scoped watch → memory
Point at one window/app/region; extract action items + todos from just that into
`assistant/src/memory` (8-type) + the next-moves queue. Pattern: screenpipe's
local-first scoped capture; on-device storage; AX-only by default.

## Stage 3 — Take control: guided
Highlight + point + "you click", with `approvals`. Still no autonomous actions.

## Stage 4 — Take control: autonomous on AX-rich apps
Wire the MCP action layer (`click`/`type_text`/`set_value` via CGEvent + AX
actions). Per-step approvals on side-effecting actions; **global Stop always wins**;
guarded actions (send/pay/delete) force a checkpoint card (step bar + [Stop][Pause]).
Reliable only on AX-rich apps; **guide-only on canvas apps** (Figma, video).

## Stage 5 — Always-on + vision escalation
Whole-screen, continuous, consent-gated. AX tree first → local gate → screenshot
only on meaningful change / when summoned / when AX is blind. Visible capture
light; auto-delete raw frames (24h default). Self-hosted: nothing leaves the
user's cloud.

## Non-negotiables (carry through every stage)
- AX-only by default; screen images require explicit opt-in per mode.
- Visible capture light whenever observing; one-tap pause; global Stop.
- Never capture secure fields / user-flagged apps.
- All credentialed actions run through CES; full audit in the trust console.

## First PRs (suggested)
1. Helper: overlay NSPanel + summon hotkey + AX-at-point read + highlight ring (Stage 1, no card logic).
2. Helper↔daemon IPC contract for "hovered element" + "show guide card".
3. Assistant: observation gate stub + guide-card content synthesis (reuse next-move logic).
4. MCP action-layer skeleton (read-only: `list_apps`, `get_app_state`) — no CGEvent yet.
5. Menubar consent pill + trust-console wiring.
