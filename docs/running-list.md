# Cue — running list to alpha (living doc, updated 2026-07-21)

Legend: ✅ proven working · 🟡 shipped, not yet proven/activated · 🔧 needs build/fix · 👤 needs you · 🎨 needs design

## Cue Live — interaction model (decided 2026-07-21, user)
**Purpose:** Cue watches your screen/life to *capture tasks & todos* and *help complete them* — ambient chief-of-staff, not a remote-desktop tool.
**Model:** watch and take-control are NOT exclusive modes. **Watch runs ambiently** (background, opt-in, time-bounded → files captured todos into Came-in, parked). **Take control is invoked conversationally — by voice OR text, like asking Claude.**
**Already true in code:** voice turns carry `userMessageInterface:"macos"` (live-voice-session.ts:797) and `macos` is the interface that unlocks host-proxy computer-use — so voice AND text can both reach the proven computer_use path. No new invocation plumbing needed.
**Still to do:** (a) Cue Live "act" re-platform off the old pixel loop onto the grounded computer_use tools; (b) mode UX must stop being an exclusive radio picker (watch = ambient toggle, take-control = always-available on request, trust-dial capped); (c) live proof of a voice-asked take-control driving the screen.
**Precedent/trust:** consented screen control is established (Claude computer use et al). The only hard rule: never ship copy that contradicts what the product does — the "no frames leave your Mac" line is being rewritten in the same change as streaming (user chose real streaming + input relay).

## Proven working (evidence in hand)
- ✅ Desktop-organizer on the Mac (plan/apply/undo, move-never-delete) — docs/mac-verification-2026-07-21.md
- ✅ Computer-use on the Mac (helper read live screen + wrote to TextEdit; 19+82 tests)
- ✅ Plugins registry live on prod (ships + flag on + search returns real entries)
- ✅ Crash recovery, connector health, vision routing, filing, brief, deploys 1–4 healthy

## Shipped but NOT yet proven / activated
- 🟡 **Advisor** — wired on kimi-k3 but the gate was too narrow (keyed on static tool risk; bash=Medium so destructive shell never triggered it). FIX in flight to fire on per-command-high bash. Re-test after deploy.
- 🟡 Send-path turn-finalize deferral — flag OFF, unmeasured. Enable + measure.
- 🟡 Watchers/Playbooks — deployed; no real watcher has fired end-to-end yet. Needs a live watcher run.
- 🟡 Voice endpointing/spoken-acks — flag OFF pending device QA (mic).
- 🟡 Organizer live-mirror — renders; live progress needs a stdout-emission hook (small).

## Needs build / fix (mine)
- 🔧 **Cue Live "act" re-platform** onto the proven computer_use path (currently the old pixel loop) + native overlay UI to the locked design.
- 🔧 **Advisor gate breadth** (in flight).
- 🔧 **Plugins: replace the vellum seed catalog with a Cue-curated set** (mechanism works; content is upstream examples).
- 🔧 Organizer live-mirror emission hook.
- 🔧 Chrome extension: browser-execution.ts still points at the old vellum CWS URL (fix post-item-creation); feedback endpoint unserved.

## Needs design (🎨 — brief: docs/design/briefs/discovery-and-clarity.md)
- 🎨 Cue Live control-vs-viewer clarity (highest — the "it did nothing" confusion)
- 🎨 Capability discovery / first-run for the new powers
- 🎨 Plugins mental-model + Cue-curated catalog framing

## Needs you (👤)
- 👤 Twilio creds (SID + auth token + number) → activates the phone channel
- 👤 Create the Chrome Web Store item (zip + icon + copy staged; sideload works meanwhile)
- 👤 TestFlight: ASC contact phone + reviewer demo story → submit Beta App Review
- 👤 Wave-1 invite emails
- 👤 **Rotate the ANTHROPIC API key** (exposed earlier, still unrotated)
- 👤 Voice device QA (needs a real mic session)

## Known backend gaps flagged for follow-up
- Connector health probe exists but Composio only exposes "linked" not live health (real probe = future)
- DSML history leak filter (old DeepSeek markup in some transcripts) — sanitizer shipped, verify coverage
- Plugin install `inspect` uses marketplace.json (provenance layer) while browse uses registry.json (by design; consistent for the UI)
