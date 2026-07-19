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
- MAY: light re-tones per the rules above; longer lists; additional projects/memories/skills repeating designed card patterns; settings leaf rows.
- MAY NOT: new layouts, new colors, new copy tone, new state treatments, closed-circle logos, web-style cards. If a needed pattern isn't in this file, ask design.

## Build rules
Inputs ≥16px · targets ≥44pt · safe areas respected · animations transform/opacity only · prefers-reduced-motion → static frames + fades · haptics: .light on orbit/capture ticks, .medium on send/approve/deep-link, .success on completion blooms.
