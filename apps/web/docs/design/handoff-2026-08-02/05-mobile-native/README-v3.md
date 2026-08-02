# Cue for iPhone — V3 handoff (supersedes the earlier mobile files)

One self-contained file: **cue-mobile-v3.html** — open in a browser at full size. All 24 frames are live-rendered with their real animations; several are interactive (Today's Send/Approve, Morning Brief tap-through, Voice mic toggle). The rendered file IS the spec — inspect inline styles for exact values. Do not re-imagine anything.

## Frame index
Core: 1 Today (interactive) · 2 Voice · 3 Project detail · 4 Dynamic Island + Lock Screen
Ritual: 5 Morning Brief (tap-through story) · 6 Projects
Create/Chat: 7 Create sheet · 8 Chat
You: 9 You/trust HQ · 10 Memory · 11 Connections
Light exemplars: 12 Today · 13 Morning Brief · 13b Chat
Flows: 14 Onboarding connect + payoff · 15 Triage swipes · 16 Review · 17 Watch live
Trust: 18 Skills + consent sheet · 19 Brand kit · 20 Rules + make-a-rule
Index/states: 21 Chats · 22 First-morning empty · 23 Offline
Voice/meetings: 24 Voice results (live cards mid-conversation) · 25 Meeting capture (live extraction)
Onboarding full: 26 Step 1 welcome/identity · 14 Step 2 connect · 27 Step 3 autonomy pick · 28 Step 4 finish
Trust deep: 29 Failure exemplar (only red) · 30 Installed-skill manage · 31 Act ledger + act detail · 32 Agents manage (charter/pause/re-charter)
Create studio: 33 Fill & build fielded form (pattern for all 18 desktop forms) · 34 Canvas image edit (marquee + action tiles) · 35 Video style sub-tabs · 36 Reference "make it look like this" chip
Thread + docs: 37 In-thread voice orb (decision: BOTH — Voice tab full-duplex AND per-conversation orb; voice turns = italic 🎙 bubbles) · 38 Doc editing (decision: conversational edits on mobile — select region + tell Cue; deep edits via always-present "Continue on desktop" handoff; same pattern for generated apps)
Setup: 39 Channel setup (Telegram 3-step token + live verify; re-skin for WhatsApp/email) · 40 Schedule editor (plain-language chips + time, cron as mono footnote) · 41 Project brief + knowledge pane · 42 Structured new-project sheet
HQ filing: 43 Batch "Add tasks" sheet (multiline → live-parsed rows; per-row assignment — confident suggestion pre-filled "✓ tap to change", ambiguous open chips + ＋New project, default "Leave unfiled — Cue will sort it"; parked footnote: shield + "nothing runs or spends until you say so") · 44 Auto-file provenance (✨ pill "auto-filed → X" + "Move ›"; re-file sheet with 🧠 "Moving teaches Cue"; below-confidence = amber "?" stays in triage) · 45 Dismiss vs done-elsewhere (quiet ✕ archives, never completes; row collapse + glass undo pill 5s with "Cue learns from what you skip"; "Done elsewhere" in task sheet = green ✓ complete, ledger-honest "not Cue's work")
Gap round: 46 Batch partial failure (sheet stays open; ✓ summary line + red draft rows with reason, "Retry N failed" / "Keep in draft") · 47 Undo×sheet stacking RULE: pill promotes to top-anchored capsule below the Island, timer extends to 8s, stays above all scrims/sheets — never suppressed · 48 Row density RULE at 390px: rows keep only chevron; ✕ → swipe-left 88pt Archive (full-swipe commits); DUE merges into metadata line; long-press = context menu · 49 Fill&build url kind (https:// affix, live reachability dot, paste normalization) + tags kind (removable chips + memory-suggested dashed chips) · 50 Dictation into batch add (waveform + live italic transcript; >1.2s pause commits utterance as parsed row with spring pop; in-progress row dashed + pulse) · 51 Light token input rule: #F2F3F7 inset on white card, hairline border — never a dark well · 52 Cue Live mobile DECISION: remote-viewer, not a dead-end card — live status, watched-screen minimap, extraction stream, Pause/Stop; capture stays macOS-only and says so

## Design DNA (non-negotiable)
- SF Pro (system font) only. Large-title physics, ‹ back chevrons, sheets with grabbers, floating glass tab bar (Today / Projects / + / Voice / You) with raised center +.
- Real materials: cards are rgba glass + backdrop-blur over a drifting aurora — never flat hexes.
- The Cue mark = open ring (dasharray 707/236 on r150, rotate 42°) + blue dot. NEVER a closed circle or letter C. The ring is the heartbeat: Today hero orbit, Voice mic, tab icon, Island glyph.
- Accent #3D6EE8 everywhere; red reserved for true failure only.
- State taxonomy: ↴ picked up (blue) · pulse = running (blue) · ‖ needs you (amber #E0A64B dark / #B4770F light) · ◱ review (violet #A79FF0/#534AB7) · ✓ done (green #6FD69A/#277E41).
- Real app logos on connectors/onboarding — never letter monograms.

## Dark ↔ Light rules (frames 12/13/13b are the exemplars — extrapolate the rest mechanically)
- bg #0A0C12 → #F2F3F7 · card rgba(28,32,44,.72) → rgba(255,255,255,.85) · text #F4F4F6 → #17171C · muted #9A9AA8 → #5A6672
- Ring stroke #F4F4F6 → #17171C (dot stays #3D6EE8) · microlabels #7FA3F2 → #2B53C4 (AA)
- Glows → soft shadows; aurora opacity halves; borders rgba(255,255,255,.1) → rgba(0,0,0,.06)

## What Claude Code may extrapolate vs not
- MAY: light re-tones per the rules above; longer lists; additional projects/memories/skills repeating designed card patterns; settings leaf rows; connector detail leaf (from frame 11's rows); Today later-in-day greeting variants; chat create-run done state (creating card → ◱ review handoff per taxonomy).
- MAY NOT: new layouts, new colors, new copy tone, new state treatments, closed-circle logos, web-style cards. If a needed pattern isn't in this file, ask design.

## Build rules
Inputs ≥16px · targets ≥44pt · safe areas respected · animations transform/opacity only · prefers-reduced-motion → static frames + fades · haptics: .light on orbit/capture ticks, .medium on send/approve/deep-link, .success on completion blooms.
