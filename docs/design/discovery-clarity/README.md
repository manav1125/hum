# Cue — Capability discovery + Cue Live clarity + Plugins model

One self-contained file: **cue-discovery-clarity.html**. Three sections, priority on §1. Same grammar as shipped (mobile v3 / serif HQ / macOS). HTML is the spec — inspect inline styles. NEEDS BACKEND flagged on-frame.

## §1 · Cue Live clarity (priority)
- **L1 — Web idle:** explainer, NOT a gate. Header pill states the truth ("control runs on your Mac"); Look/Guide/Take-control explained in plain words; right rail = the 3-step turn-on path (open app → grant Screen Recording + Accessibility → ⌥Space) + honest "no session" viewer stub. "Open desktop app" deep-links (NEEDS BACKEND), falls back to Download.
- **L2 — Web session live:** SAME route becomes the remote viewer — blue-pulse "Live on \<device name\>" (running is blue; green means done), mirrored screen, rail with Start screen / Take over and the locked overlay's Pause / Stop, plus the verify beat (✓ verified · ↻ retrying · ‖ stuck). Web steers, never holds grants. **BUILT** (2026-07-21): opt-in ~1–2 fps still-frame stream over the daemon (`cuelive/session/{checkin,stream,frame}`, frames in memory only, never persisted) + input relay through the existing host computer-use path (`cuelive/session/{takeover,input}`), capped by the global trust dial. Not a WebRTC video mirror — see the honest gap list in the build report.
- **L3 — Mac grant flow + modes:** grant-then-works — one permission ✓, next is the single lit action, honest that macOS asks directly. Then modes light up (Companion passive-until-summoned / Look / Take control) with ⌥Space shown. "Take control" runs the locked cue-live-overlay.html states (intent→approval→verify→done) — no rebuild.
- **L4 — Mobile first-use:** one screen teaches the model — Mac↔phone diagram, plain claim, honest "no session / needs Mac app" state, "Send setup link to my Mac". Becomes the remote viewer (Round-4 frame 52) when live.

## §2 · Capability discovery
- **D1 — Mobile "What Cue can now do":** 7 powers, each = icon + one line + one action; action tells the truth — "On ✓" / "Set up" / "Browse" / "Learn" with amber "needs Mac app / needs setup" caveat. Full-screen at first-run, then persistent at You → Explore (never nags).
- **D2 — HQ discovery:** same content, serif-HQ 3-col grid; amber caveats inline; CTA verb matches state.

## §3 · Plugins model
- **P1 — HQ Marketplace:** one-line "what is a plugin?" explainer banner (install vs auto-open answered on-surface); tabs lead with **Cue official · 12**, Community opt-in, Installed — kills "all vellum" read; card lifecycle Install → Enabled (green border + pinned commit + disable toggle). Backend: seed registry → Cue-curated (NEEDS BACKEND).
- **P2 — Mobile lifecycle:** the 3 states stacked unmissably — Install (blue) / Enabled (green border, pinned @commit, live toggle + usage + Remove) / Disabled (dimmed, installed-but-off). Explainer banner; Cue-official tab leads; footer states the three verbs.

## Honesty rules (footnote in-frame)
Web never gates Cue Live · discovery names the cost before you tap · plugins are opt-in with disable/remove always present · NEEDS BACKEND: app deep-link/handoff, Cue-curated registry. (Web live-stream + input relay: built — opt-in, indicated on the Mac, stoppable from both sides, frames never persisted.)
