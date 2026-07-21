# Design Brief — Mobile (v3): Parity+ surfaces

Same v3 contract as rounds 1–4.1 (SF Pro, glass over aurora, floating tab bar, Gravity ring,
taxonomy is law, ○ parked mono, ≥44pt, dark-first + light re-tones, real logos, honesty rule:
never draw an affordance the backend can't honor — flag NEEDS BACKEND instead of faking). Continue
frame numbering after round 4.1. The HTML is the spec.

## 1. Plugins surface (You cluster)
Cue is gaining a plugin system: third parties ship *behavior* (tools, hooks, routes, workspace apps,
skills) as GitHub-repo packages, discovered through a **multi-repo registry indexed like skills**
(same embedding-space search). Design:
- **Plugins leaf** — Explore / Installed rails (reuse the Skills page grammar), each plugin card:
  real app-style icon, name, one-line, source badge (Cue official / Community), install count if
  present. Search reads the registry.
- **Plugin detail sheet** — REUSE the skill-detail-sheet grammar we shipped (frame 57): description,
  "WILL BE ABLE TO" consent rows derived strictly from the plugin's declared surfaces/capabilities
  (tools it adds, connectors it needs, whether it has workspace apps/routes), source repo + version
  + pinned-commit, official/community badge. Install confirm before anything runs. A plugin can
  contribute an **app** (interactive panel) — show that it will appear, don't mock the panel itself.
- **Untrusted install** — installing from a raw GitHub URL (not the curated registry) gets a
  distinct "unreviewed — you're trusting this repo" warning state.
- Honesty: what the plugin can do comes from its manifest only; no invented capabilities.

## 2. Watchers + Playbooks (the event-driven layer)
Cue's missions are cadence-based (they sweep on a clock). Watchers + Playbooks add the *event*
layer. Design a surface (likely under You or a new tab-accessible screen — propose the placement):
- **Watcher card** — a monitor on a real source (Gmail / Outlook / GitHub / Google Calendar /
  Linear): what it watches, poll interval, last-checked, last-hit, on/off. New-watcher sheet picks
  source + filter. Watched hits flow into the Came-in lane.
- **Playbook card** — a trigger→action rule: "When <watcher/channel event> → <action>" with an
  **autonomy dial** (Auto / Draft / Notify) and a priority. New-playbook sheet: trigger picker,
  action, autonomy. Autonomy is capped by the global dial (a playbook can't be more autonomous than
  the user's trust setting — show that relationship).
- These integrate with guardrails (autonomy) and filing (playbook outputs become work items).

## 3. Desktop-organizer — mobile view
The desktop cleanup runs on the paired Mac, but the user can approve and watch from their phone.
Design:
- **Plan approval card** — the same review-before-move plan (categories, destinations, counts,
  move-never-delete, "→ Cue Archive"), approvable whole or per-category from the phone.
- **Live + done** — progress mirror + "Tidied 84 items · Undo". Honest that execution is on the Mac
  ("Running on your Mac · MacBook Pro") — the phone is the remote, mirroring the Cue Live pattern.

## 4. Phone-channel setup sheet
Cue is getting a phone number (Twilio + ElevenLabs receptionist — inbound calls answered, outbound
calls placed, transcripts become conversations). Design a setup sheet in the Telegram-setup grammar
(frame 39 — 3 steps, validates-before-store, honest about what's real):
- Connect Twilio (the user provides account SID + auth token + number — mask the token like
  Telegram's token well), pick the number, set a greeting/receptionist persona line, done.
- A "how it behaves" honesty line: answers as your receptionist, transcribes, files action items,
  asks before anything irreversible.
- Post-setup: a small "Phone" channel row (like Email/WhatsApp) showing the number + a link to call
  transcripts.

## Deliverable
Rendered 390px frames, dark + light where new colors appear, numbered after 4.1, README updated.
Flag deviations with reasons. NEEDS BACKEND where a drawn thing outruns the backend.
