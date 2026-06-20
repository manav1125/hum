# Display-only UI — backlog to wire once core functionality lands

During the design-fidelity pass (translating `design/surfaces/*.dc.html` to React), some
mock elements had **no backend yet**. Per the honesty rule we rendered them faithfully to
the design but **display-only** (no fake-interactive controls, no fabricated data). This
is the list to revisit and wire to real backends in the core-functionality phase.

## Cue Live (`apps/web/src/domains/intelligence/cue-live-page.tsx`)
Wired today: enable toggle, summon hotkey, "Allow Cue to act" (take-control), accessibility-
trusted state, voice-key entry (AssemblyAI/ElevenLabs), goal runner, **Auto-run goals (DONE
2026-06-20 — real CRUD persisted in electron-store, runs via the existing `runGoal` executor;
no Swift needed)**.
Remaining — need **native Swift + a packaged macOS build** to actually behave (the TS pref
layer alone would persist-but-not-act = the "looks wired but isn't" trap; hold until the Swift
work is done). Scoped in this session (see the Cue Live build-path investigation):
- **Mode select** — Scoped watch / Always-on / Take control. `CueLiveStatus` has no `mode`
  field. The capture-policy *behaviour* (scoped one-window capture; always-on continuous +
  light) does not exist in Swift today — new native capture pipelines (CUE-LIVE-SPEC stages 2 & 5).
- **Configurable hotkeys** — Summon is Swift-hardcoded (keyCode 49); ⌥P/⌥esc monitors don't
  exist. Persisting a binding has no effect until Swift matches accelerators dynamically
  (`cuelive.setHotkeys` RPC + dynamic matching in CueLive.swift).
- **Voice bindings** — Read-selection-aloud (⌥R) needs a new Swift monitor + AX selected-text
  read → existing `speak`. Hands-free (VAD) has **no** engine in CueVoice.swift at all (push-to-
  talk only today) — a substantial native audio/wake-word build.
- **Take-control posture** — "Pause before sending/purchases" + "How it sees" are posture copy
  (no settings store yet).

## Connectors / ConnectorDetail (`connectors-page.tsx`, `connector-detail-page.tsx`)
Wired today: connector list, connect/disconnect, per-tool **enable** toggle (real binary
allowlist → hot-reloads the MCP server).
Display-only — need backend:
- **Tri-state permission pills** (allow / ask / never) are derived from tool-name verbs and
  are presentational. Composio's only primitive is the enable boolean — no ask/never policy.
  Need a real per-tool policy model to make them interactive.
- **Per-account email / last-synced / "expired" status** — not in the contract.
- **MCP server cards** (the mock's filesystem/vellum-oauth examples) — no MCP-server list
  API; only the real dashed "+ Add an MCP server" affordance is shown.

## Contacts (`apps/web/src/domains/contacts/`)
Wired today: contacts, channels (verify/revoke/disconnect), invites, real interactions/
last-touch/channel-count stat tiles.
Display-only / omitted — need backend:
- **Open commitments** + **recent-interactions timeline** cards (mock) — no commitment or
  per-interaction-event data in the gateway. Omitted rather than faked.
- Meetings / "since last touch" tiles — omitted (no source).

## Impact (`apps/web/src/domains/intelligence/impact-page.tsx`)
Wired today: hours saved, task count, by-day sparkline, by-category bars, recent highlights
(all from `home/impact`).
Display-only / omitted — need backend:
- **"96% approved without changes"** and **"▲18% more than last week"** (mock) — no approval-
  rate or week-over-week delta fields. Replaced with a real derived mins/task stat; delta omitted.

## Memory (`apps/web/src/domains/intelligence/memories-page.tsx`)
Wired today: real memories, kind counts, confidence, reinforced count, Forget (delete),
Edit (patch statement).
Display-only — need backend:
- **SOURCES detail** shows the available fields (sourceType, scope, first/last seen,
  reinforced N×). The mock's richer per-source list ("chat · 'keep it short' — May 3") needs
  a provenance/source-event store.

## LibraryDetail (`apps/web/src/domains/library/library-detail-page.tsx`)
Left as the real app-viewer (loads + renders the user-built app). The mock is a **marketplace**
detail (rating, installs, version, permission matrix, screenshots) — none of those fields exist
for user apps. Those map to the Directory/Plugins marketplace surfaces, not user apps.

---
Convention going forward: keep rendering missing-backend elements as faithful **display** (or
omit) — never a fake-interactive control or fabricated metric. Wire each as its backend lands.
