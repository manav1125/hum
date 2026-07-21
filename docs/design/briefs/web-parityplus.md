# Design Brief — Web / desktop HQ (serif): Parity+ surfaces

Desktop keeps the **serif HQ** direction (NOT the mobile v3 native grammar — that split is
deliberate; see the mobile brief for the phone versions of these same features). Same honesty rule:
no affordance the backend can't honor; flag NEEDS BACKEND. These are the large-canvas counterparts
to the mobile Parity+ surfaces plus the things that only make sense on a desktop.

## 1. Plugin marketplace + detail (desktop HQ)
The full browse experience for the multi-repo plugin registry (indexed like skills):
- **Marketplace** — category-organized grid/list, search over the registry, filters (official /
  community / by surface-type: adds-tools / adds-apps / adds-channels / memory), install counts,
  source repos. This is where curation is visible — official vs community, pinned commit, reviewed
  badge.
- **Plugin detail** — full page: description, the declared surfaces (tools/hooks/routes/apps/skills
  it contributes), consent (what it will be able to do), source repo + pinned commit + version
  history, install/enable/disable, and — if it ships an app — a preview affordance for that app.
- **Publish path** (light, can be NEEDS BACKEND for alpha) — how a developer submits a repo to the
  registry (PR-based). Design the "submit a plugin" entry even if the flow is a doc link for now.

## 2. Watchers + Playbooks board (desktop)
The full management surface (mobile is the compact version):
- A board of watchers (source, interval, health, recent hits) and playbooks (trigger → action,
  autonomy, priority, last-fired). Create/edit inline. Show the autonomy-vs-global-dial
  relationship. Watched hits and playbook outputs tie into the HQ activity lanes.

## 3. Phone channel + call transcripts (desktop)
- **Setup** — the desktop version of connecting Twilio (SID/token/number, receptionist persona),
  serif grammar.
- **Call transcripts** — inbound/outbound calls rendered as conversations: who called, duration,
  transcript, extracted action items (→ work items), a "call back" affordance. This is a real new
  content type — design how a phone call reads in the HQ.

## 4. Desktop-control consent & plan cards (web)
Cloud conversations can drive the user's Mac (file ops, terminal, app control, computer use). On the
web, design the **consent and plan surfaces** for that:
- **Plan card** — when Cue proposes a multi-step action on the user's machine (e.g. organize files,
  run a task across local files), a review card: the steps, the target scope, move-never-delete
  framing for file ops, and the approve / approve-with-scope / deny decision set (mirrors our
  approvals + directory-scoped trust rules — "Always allow in ~/Desktop").
- **Live run** — the run streaming its verified steps (the web view of the same loop the Cue Live
  overlay shows), with pause/stop.
- **Which Mac** — when multiple paired machines exist, the target picker + honest "not connected"
  state when the Mac is offline.

## Contract
Serif HQ grammar, the shared state taxonomy (colors mean the same across platforms), real endpoints
only. These surfaces share data with their mobile counterparts (one backend, two skins) — keep the
vocabulary identical (a "watcher" is a watcher on both; a plugin's consent rows read the same).

## Deliverable
Rendered desktop frames in the serif HQ grammar, light + dark. Flag deviations + NEEDS BACKEND.
