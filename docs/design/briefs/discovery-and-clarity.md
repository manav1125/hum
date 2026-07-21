# Design Brief — Capability discovery + Cue Live clarity + Plugins model

Three related surfaces, all about making the new powers understandable. Same platform grammar as before (mobile v3 / serif HQ / macOS overlay). Honesty rule throughout.

## 1. Cue Live — resolve the control-vs-viewer confusion (HIGHEST)
**The problem (real user report):** opened Cue Live in the web Intelligence tab, tried to run it, "it basically just [did nothing / showed a gate]." **Why:** Cue Live's actual screen control lives in the **macOS desktop app** (needs Accessibility + Screen Recording grants) and is summoned by a hotkey. The web Intelligence tab is a *control panel + remote viewer* — it cannot itself take over the computer. Today the page shows a permission-gate / "SOON" / remote-viewer state depending on context, which reads as broken.

Design a coherent Cue Live entry that never leaves the user confused:
- **On web (not the Mac app):** a clear explainer state — "Cue Live runs on your Mac. Open the Cue desktop app to let Cue see and act on your screen." + what it does (guide / look / take control) + a "this is the remote viewer" framing when a session IS running on the Mac. Not a dead permission gate.
- **On the Mac app:** the permission-grant flow (grant Accessibility + Screen Recording → then the modes light up), the three modes (Companion passive-until-summoned / Look / Take control), the summon hotkey, and — when "Take control" runs — the overlay states from the locked cue-live-overlay.html (intent → approval → verify → done). Make the *grant-then-it-works* path obvious.
- The moment-of-first-use: a user should understand in one screen that Cue Live = "Cue on your actual Mac screen," how to turn it on, and that the phone/web is the remote.

## 2. Capability discovery / first-run
New powers are invisible if users don't know they exist. Design a lightweight discovery layer:
- A "What Cue can now do" surface (first-run and/or a persistent "Explore" entry) introducing: organize/clean your Mac (desktop-organizer), watch your inbox/GitHub/calendar (Watchers), trigger→action rules (Playbooks), extend Cue with Plugins, drive your browser (extension), answer your phone (phone channel), and Cue Live.
- Each = one line of what it does + one tap to set up. Honest about what needs the Mac app / a connected account / creds.
- Mobile v3 + a desktop HQ equivalent.

## 3. Plugins — make the model legible
**The problem (real user report):** "plugins seem limited and all connected to vellum; do they have to be installed or are they auto-open?" Two things to fix in design:
- **Explain the model on the surface:** a plugin is third-party code you **install** (it pins a reviewed commit) that adds tools/automations to Cue — it is NOT auto-enabled and NOT open by default; you choose to install, and can disable/remove. Add a one-line "what is a plugin?" explainer + the install→enabled→disable lifecycle made visible (the current 66/67/68 + W1/W2 frames show install but not the mental model).
- **Catalog framing:** the seed catalog is currently upstream (vellum-ai) example plugins — for alpha we curate a **Cue** set. Design the "official (Cue) vs community" curation framing so it doesn't read as "all vellum." (Backend note for eng, not design: replace the seed registry with Cue-curated plugins.)

## Deliverable
Rendered frames per platform; flag NEEDS BACKEND where relevant. The Cue Live clarity frame is the priority.
