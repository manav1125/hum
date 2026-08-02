# Cue work surfaces v3 — volume, the personal half, the double-click

One self-contained file: **cue-work-surfaces-v3.html**. 6 frames. Builds on v2 (missions on top, delivered-first ordering) and answers what happens at 20–40 open items across work *and* life.

## Core principle
**Work groups by why. Life groups by when.**
v2's mission ladder is right for work — every work item ladders to a goal. Personal life doesn't have missions: "renew the passport", "book the dentist", "mum's birthday" are time-directed, not goal-directed. Forcing them into a mission hierarchy makes Cue a project-management tool instead of an assistant.

**Life is a lens, not a level** — same items, same engine, different organising axis. No new colour: ⌂ glyph + warm card ground (#FAF7F2 light / #26221E family dark), already in the cream palette. Privacy falls out free — one lens boundary means "hide Life" is a single switch for screen-sharing and work exports.

## Four jobs at volume (the design brief for scale)
1. **Glance** — HQ, capped at 3. Never grows with volume.
2. **Triage** — one card at a time, keyboard-fast. A Monday pile is not a longer list.
3. **Hunt** — the ledger, properly navigable (collapse, filter, search, bulk).
4. **Finish** — completion must feel like something, or nobody returns tomorrow.

## Frames
- **X1 HQ · All lens** — 31 open, deck same height as at 3. Needs-you capped "3 of 6" + "Triage the rest ›". **Census/overflow bar** (6 need you / 9 doing / 7 waiting / 9 life) is the honest count and the ledger door. Below: Work by mission (rings) beside Life by horizon (This week / Soon / Someday). A life item can sit in needs-you on its warm ground — no separate app.
- **X2 Triage mode** — one card fills the screen; source quote, ✨ mission, **"Cue already did"** trust block, four keys (↵ / O / L / ⌫), next-up peek, explicit consequence-free exit. Work and life interleave by urgency.
- **X3 All work at 31** — collapsible mission groups, filter row (state + agent + time), ⌘F search, multi-select bulk bar, per-row ⋯ with the seven verbs, explicit **"Not on a mission yet"** bucket. ⌂ Life re-groups the same rows by horizon.
- **X4 Task detail (the double-click)** — five blocks answering: what · why it exists (quoted source + open thread) · what Cue did (incl. where it stopped and why) · the editable draft · **"If you send" consequence preview** in the right rail. Plus attachments, people, activity log, ◂prev/next▸ so detail is itself a triage lane.
- **X5 Cleared** — zero as a destination: completing ring with spring, "You're clear… go do something else", three tiles splitting credit honestly (**14 you cleared / 11 Cue finished / 2 missions moved**), and the anti-anxiety line "if anything lands, it'll be here — you don't need to check".
- **X6 Mobile** — lens segmented control, needs-you capped at 3, census bar, Life horizon peek, swipe-right = approve / swipe-left = archive, long-press = seven verbs, tap = X4 as a sheet.

## Rules this adds
- **The deck never grows** — needs-you caps at 3 with "N of M"; volume moves the census bar, not the page height.
- **Life is a lens, not a level** — ⌂ + warm ground, no new accent, one switch to hide.
- **Seven verbs everywhere** — Approve · Open · Later · Archive · Done elsewhere · File · Undo. Same set in triage, ledger ⋯, detail, mobile swipe/long-press.
- **Nothing is unfiled-invisible** — explicit "Not on a mission yet" bucket.
- **Approving is never blind** — source quote + what Cue did + where it stopped + editable draft + consequence of yes.
- **Zero is a destination** — designed clearing moment, credit split honestly. Silent completion is a retention bug.

## Schema cost
`domain: work | life` on the work item, plus an optional horizon field for life items. Everything else — grouping, collapse, filters, bulk, triage, detail — is rendering over data that already exists.
