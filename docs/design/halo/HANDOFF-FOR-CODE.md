# Cue Halo — MASTER HANDOFF FOR CODE · 2026-08-30

**Read this first.** Seven design files, one product: the Halo wearable's companion experience inside Cue on iOS. Everything below is binding; the rendered HTML in each file is the spec (inspect inline styles for exact values). Where a file conflicts with an older one, the newer file wins — conflicts already found are resolved in §5.

## 1 · The product in one line
**A diary that writes itself, answers questions, forgets on command — and hands the work to Cue.** Standalone Halo must be worth wearing with no Cue subscription; Cue is the upgrade that turns memory into staffed work (never a gate — see the funnel contract).

## 2 · The seven files, in read order
| File | Layer | What it settles |
|---|---|---|
| `cue-halo-onboarding.html` | **H** | Unbox → pair → permissions → first wear |
| `cue-halo-mobile-v2.html` | **V** | Core surfaces: Day, episodes, weekly patterns (V3 receipts rule) |
| `cue-halo-experience.html` | **E** | The premium layer: sky clock, sun path, the dock, day-close ritual, episode story page, motion/gesture/haptics contract (E5), + Bee adoptions (live strip, verb chips, takeaways, ☰ templates) |
| `cue-halo-complete.html` | **F** | Bee parity: days gallery, suggestions queue, ask-your-life, spoken notes → Cue Notes, device page, coverage map |
| `cue-halo-standalone.html` | **G** | The standalone product: people, places, diary search, transcript reader, **the funnel contract (G5)** |
| `cue-halo-retention.html` | **R** | Hour one, the two lockscreen rituals, share card, 10-second settler, person timeline, Island/watch states |
| `cue-halo-final-round.html` | **S** | Relive player, forgetting, etiquette, partial days, multilingual, closing rulings |

## 3 · Build order (each phase shippable)
1. **H + V + F5 device page** — pairing, the Day, hardware truth. Include the **R1 hour-one states** from day one: the first build a tester opens must handle 1 episode + empty shelves.
2. **E layer on top** — sky clock gradients, sun path, the dock animation. This is where "sexy" lives; do not ship phase 1's flat version to real users without it.
3. **F2 queue + F4 notes + G3 search + G4 transcripts** — the daily-use spine.
4. **R2 pushes + S1 relive player** — the retention rituals (evening push gated on charger-contact trigger).
5. **G1/G2/R5 people & places, F1 days gallery, R3/R4 share & settler.**
6. **S2/S3/S4/S5 trust set** — forgetting, etiquette, gaps, languages. **Must land before public beta**, App Store review will probe exactly these.

## 4 · Animation & native-feel contract (E5, binding — this is the "sexy" part)
- **Shared-element transitions everywhere.** The Today tile's arc *expands into* the Day cover; an episode bead *becomes* the episode page header; the proposal card *flies into* its mission dock. Nothing ever just appears. Use matched-geometry (`matchedGeometryEffect` / UIViewController custom transitions), 280–360ms, spring damping ~0.82.
- **The sun path is one drawing, six sizes:** Island stub → Today tile edge → Day cover → recap → share card → watch complication. Same arc geometry scaled, never redrawn differently.
- **The sky clock:** every surface is lit by the hour it describes — gradients come from the clock, never inferred mood. Interpolate between the keyframe gradients in E1; transitions over 2s when a surface's hour changes.
- **The dock (E2):** ✓ lifts the card (scale 1.03, shadow deepens), spring-flies it to the mission dock, count ticks, ring pulses once, `.medium` haptic, undo pill 5s. This is the signature interaction — build it exactly.
- **Haptics map:** `.light` selection/swipe-reveal · `.medium` accept/send/hand-off · `.success` completion blooms only · `.error` real failures only. **Never on scroll, never on appear.**
- **Motion timings:** 240ms standard / 180ms dismiss / 280ms sheet / 320ms shared-element. Reduced Motion → 80ms crossfades, zero translation.
- **Gestures:** tap = open · long-press = act (reassign speaker, bookmark, mark) · swipe = dismiss/triage. Story grammar in the relive player (tap sides, hold to pause). Every screen has swipe-back.
- **Typography:** SF Pro for UI, Instrument Serif *only* for verdict lines and pull-quotes (the "written about you" voice), DM Mono for microlabels. Never mix serif into controls.

## 5a · S6 rulings (answers to code's four gaps, 2026-08-30)
1. **Verdict writing rules** — observation, never a grade. Four registers by day shape: outcome / texture / thin / gap-scoped. Banned: scoring words, apology, any sentence that fits every day. Fallback is inventory ("4 conversations, nothing that needed keeping"), never generic poetry.
2. **Chapters** — target 5–9 beads, hard cap 12 (per-day re-threshold, never splits a ⚑); never pad thin days; <5-min beads render at 70%.
3. **"Draft it" opens the composer** with the real draft (agent runs immediately); Send or park fires the dock — never a file-a-ticket path. Slow path: "drafting…" + notification.
4. **Arc grammar** — lived = solid warm · not-yet = fine dotted 18% · gap = dim solid 14% + caption; glow head at the now-point.

## 5 · Conflicts resolved (newer ruling wins)
- **Button grammar (F5 vs S2), unified:** click = ⚑ mark · double-click = ✦ note · **hold 1s = record on/off** (single buzz) · **hold 3s = off the record** (double buzz + LED dark). F5's map is updated in the file.
- **Bee adoptions supersede** E1's original quiet listening line (now the live strip) and E4's ⋯ (now the ☰ template chip).
- **Gap grammar (S4) supersedes** any earlier plain "not worn" treatment: three distinct absences — not worn (dim + caption) / off the record (dashed, chosen) / forgotten (blank, permanent).

## 6 · Invariants — violating any of these is a bug
1. **Nothing files without acceptance.** Proposals wait; ✕ teaches; low-confidence waits behind the fold (F2).
2. **Never fake a number, never guess into a gap.** Patterns carry "based on N hours"; absence states its reason ("you didn't wear me until noon"); no sentiment prose ever.
3. **Provenance everywhere:** the ◉ heard-pill (quote · time · place) follows every extracted thing into Cue — HQ, missions, chat, People.
4. **The timer never claims a live mic** — it counts recorded segments ("as of 3 min ago").
5. **Audio is discarded at understanding.** The relive "hear it" chip exists only pre-sync, no exceptions.
6. **Privacy spine (G5):** on-phone names/transcripts · per-person exclusion · no GPS (phone location + user labels only) · local search · reassign teaches, never rewrites.
7. **No guilt, ever:** no streak flames, no shame pushes on unworn days, quiet hours respected.
8. **Funnel rule:** never cripple, always preview — "✦ Cue could draft this" opens one real watermarked preview, ≤3/week.
9. **Tokens:** `--muted-on-dark #9A9AA8` on dark grounds; fills carrying white text use text variants; reserved: recording `#E5675B`, watching `#FF9F45`.

## 7 · Backend/firmware asks (collected from all rounds)
Charger-contact event (R2) · click-pattern detection incl. 1s/3s holds with distinct haptics (§5) · un-synced buffer depth API (F5) · two-voice detection + retroactive skip (S3) · proposal recall on episode delete (S2) · retention windows as settings (S2) · language detect per utterance + owner-language takeaways + embedding search (S5) · lock-screen widget / Island intent with <3s to listening (R4) · Live Activity content states (R6) · share rendering on-device, redaction before raster (R3).

## 8 · QA checklist before any TestFlight
Hour-one flow with exactly one episode → first catch appears ≤30 min · day with zero catches shows the honest fallback · partial day renders gap captions · off-the-record span visible on Day + LED dark + Island ◌ · delete ladder all four rungs, undo toast once, never double-confirm · settler answers from lock screen in one breath · evening push fires on charger contact · share card defaults: names hidden, places as counts · every screen: swipe-back works, Reduced Motion honored, hit targets ≥44pt.
