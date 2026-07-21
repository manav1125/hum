# Cue Live "act" → computer_use_* re-platform (WS-H)

## Where it stands

Cue Live's full-auto "act" loop today (`cue-live-service.ts`, the auto-run added
around the summon-goal flow) is a **self-contained vision loop**: it screenshots,
`POST /cuelive/act` returns one raw-pixel `{type,x,y,text,key}` action
(`cuelive-routes.ts` → `handleAct`), and the Electron side runs it via the
mac-helper's `cuelive.performAction`. It has none of the real agent's safety or
grounding: no AX-element targeting, no `ActionVerifier`, no per-action approvals
or trust rules, no step caps beyond its own counter, no Mission Control record.

The daemon **already** has the full computer-use agent path: the `computer_use_*`
proxy tools (`assistant/src/tools/computer-use/definitions.ts`), the
`HostCuProxy` that emits `host_cu_request` and grounds AX elements
(`assistant/src/daemon/host-cu-proxy.ts`), per-action approvals + directory-scoped
trust rules, and Mission Control visibility. What was missing was the **executor**
on the desktop — now built (`executors/host-cu-executor.ts`) and pending only the
Swift helper (see `native/mac-helper/PORT-NOTES.md`).

## The re-platform (do this after the Swift `computeruse.perform` lands)

Replace the bespoke act loop with a **real conversation turn**:

1. **Summon-goal → message, not `/cuelive/act`.** When the user summons Cue Live
   with a goal ("take control and do X"), instead of entering the local
   screenshot→`/cuelive/act`→`performAction` loop, send a normal message to the
   connected assistant (`requestAssistantRoute` already reaches local+cloud) that
   instructs the brain to accomplish the goal on the desktop using the
   `computer_use_*` tools. The brain runs the real agent loop; each tool call
   becomes a `host_cu_request` → `host-cu-executor` → `computeruse.perform` →
   observation, exactly like a chat-initiated computer-use session.
2. **Keep the Cue Live moat.** Summon hotkey, POINT overlay, look/guidance, and
   phone-remote pause stay as-is. Generalize the existing remote pause/stop
   (`cuelive-session.ts`) so it pauses **any** host-proxy run, not just the local
   act loop — the daemon already gates each `host_cu` step, so a pause that makes
   the next approval auto-deny (or holds the turn) ends the run cleanly.
3. **Overlay subscribes to the turn's tool events.** The overlay draws its states
   (below) from the turn's `host_cu_request` / approval / result event stream
   (via the SSE the app already consumes), not from `/cuelive/act` replies.
4. **Retire `/cuelive/act`** (and `handleAct` + `cuelive.performAction`) once the
   overlay is switched over. `look` and `guidance` routes stay — those are the
   co-present teaching layer and are unaffected.

## Overlay states → event mapping (per `docs/design/parityplus/cue-live-overlay.html`, LOCKED)

The native overlay (mac-helper `CueLive.swift` `showCard`/`highlight`, driven from
`cue-live-service.ts`) renders these states. Each maps to an event the turn
already emits:

| Overlay state | Driven by |
| --- | --- |
| **intent** ("about to do X") | `host_cu_request` seen → show `reasoning` + the pending action before it executes |
| **approval** (approve/deny in-overlay) | `confirmation_request` for the `host_cu` tool → in-overlay approve routes to `POST /v1/confirm`; "Always allow in <dir>" writes the directory-scoped trust rule |
| **working / verify** | request in flight → result posted; ActionVerifier's verify→settle→observe surfaces as the progress/settle sub-states |
| **paused** | remote pause (`cuelive/session/pause`) or a held approval |
| **done** | `computer_use_done` / turn completion → summary |
| **retry / stuck** | ActionVerifier `blocked` (loop detected / step cap) or an `executionError` result → the stuck affordance |
| **organizer plan / progress / done** | the `desktop-organizer` skill's plan card + `apply` progress (host_bash step results) |

## Status / honest flags

- **Not implemented in code yet** — this is the seam + plan. It is gated on the
  Swift `computeruse.perform` executor landing (PORT-NOTES.md), and it edits the
  Cue Live act path (`cue-live-service.ts`) + retires `/cuelive/act`. Both need a
  Mac to verify end-to-end (helper TCC + live overlay).
- **Overlay states** are a **native UI pass** — the design is LOCKED, the
  event→state mapping is specified above, but drawing them to the design in
  `CueLive.swift` (card layouts, transitions, the approve/deny + "Always allow in
  <dir>" chip) is dedicated native work, not done here.
- The daemon substrate, approvals, trust rules, and Mission Control visibility are
  already in place, so the re-platform is wiring + native UI, not new backend.
