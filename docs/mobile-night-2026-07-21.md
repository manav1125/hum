# Mobile night — 2026-07-21

The overnight program after the 7-issue real-device report: fix the reported issues, then UAT every
mobile surface with a native-iOS lens, then fix what the UAT found. Two deploys shipped
(`b356771c64` wave, live image `deployment-01KY098YG7ED5XJ8D4KJH08Y25`).

## Wave 1 — the 7 device issues (deployed + verified)

1. **Status-bar overlap** → safe-area top inset on chat header, voice pills, template chooser,
   library detail, PageShell surfaces (+ review-queue/meeting/stub in wave 2).
2. **"No visible work" during long turns** → MobileLiveActivity: step headline, "Step N · elapsed",
   mini step-stream, honest escalation; turn-store activation fix; foreground reconcile +
   authoritative `isProcessing` settle for lost terminals; 120s watchdog with Check status.
3. **"Model can't see images"** → `llm.visionTier` (default ON): image rounds on a text-only brain
   reroute to a vision model. Prod runs `qwen/qwen3.6-flash` (probe-verified image+tools; the
   qwen2.5-VL default 404'd on tool-carrying rounds and was replaced). **Verified live 3×** — a
   real vision answer in chat.
4. **Decks unusable on mobile** → fit-to-width 1280×720 viewer with chevrons/swipe; wave 2 fixed
   generated decks' flex-basis pagination bug (slides 2+ were blank everywhere) + single-mount and
   skeleton for first paint.
5. **Logo dead-end** → upload from the phone in the brand studio (image picker → data URI);
   the Logos sheet links to Settings → Brand; the "No logos" copy turned out TRUE — the studio was
   fabricating preview wordmarks, now labeled honestly.
6. **Swipe-archive dead on device** → real-touch hardening (sticky 8px axis lock, row-level pointer
   capture, `pointercancel` never commits, callout suppression). NOTE: the user's screenshots
   predate the swipe deploy; UAT re-verified swipe+undo+long-press working — the earlier "no undo
   pill" was the 429 rate-limit storm, now fixed.
7. **"Tasks don't really run"** → parked is now visible + actionable: "○ parked" mark, 44pt ▶ Run
   on rows (real run endpoint), "K parked" in headers, session coachline, done rows deep-link to
   output. Full loop verified on prod: parked → ▶ → live card → review pager → approve → output.

## Wave 2 — the 5-cluster UAT fix wave (deployed + spot-verified)

- **Sideways-stuck viewport root cause**: aurora-backdrop's `inset:-20%` counted as scrollable
  overflow under `overflow:hidden`; programmatic scrolls wedged pages 14–89px sideways (chat,
  projects, all shells). Fixed at the primitive (`overflow:clip` + `contain:strict`) + page shells.
- **Chats reachable**: `/assistant/conversations` = full-screen v3 chats index (live-verified);
  ⋯→Chats wired; post-archive → index (never a stranger's conversation); Back falls to Today on
  deep links; styled 404; tab highlights fixed; "All work" + "Older chats" affordances.
- **Review queue**: newest-first, stale markers ("From 3 Jul — likely stale"), Today "See all N ›",
  400ms non-interactive beat after Approve (no accidental approve of the next real item).
- **Gateway**: `/onboarding/*` now serves the SPA (was raw `{"error":"Unauthorized"}`) — verified.
- **Trust honesty**: rules tap-to-cycle → state sheet + undo (footgun closed); Connections say
  "Linked — status reflects setup, not live health" (the API has no health signal; a probe is the
  real fix); settings contradictions reconciled; unknown settings paths → index; honest
  Notifications leaf; Advanced hidden; Debug hidden on cloud; local-time schedules; enabled-only
  counts; "vellum" → "Cue official".
- **Work-loop correctness**: authed-write burst limiter + client 429 retry; conversation boot drain
  capped at 3 pages (was 8, self-429ing); project archive cascades and archived projects appear
  under Done (live-verified); morning-brief dedupe/reconcile (no duplicate/contradictory
  narration); task-run context stamped `taskRunContext` + collapsed to a "Project context ›" pill;
  multi-line paste splits into tasks; stats exclude archived; parked vocabulary unified.
- Polish: sanitized live-activity headlines (no raw model thinking), hidden desktop scrollbars,
  template-chooser truncation fixes, next-move slot reservation, a11y names across rows/tiles.

## Missing screens — the design list (ranked for alpha)

1. ~~Mobile chats index~~ — built tonight (frame-21 grammar reused); design may want a bespoke pass.
2. **Identity mobile card** (linked from You footer; renders desktop today, now with a proper back row).
3. **Shared mobile header pattern** for desktop-shell pages (identity/contacts/marketplace/workspace)
   — interim back-row shipped; real adaptation needs design.
4. **Review-queue index/list view** + richer stale treatment (minimal fixes shipped).
5. **Connector health/detail surface** (needs the backend health probe first).
6. **Skill detail / install-confirm sheet** for marketplace Explore (Get is a naked button).
7. **Mission detail `/hq/:id` mobile frame** (undesigned; unverifiable — no missions on prod).
8. **Template chooser mobile pass** (names/badges/thumbnail crop rule; truncation band-aids shipped).
9. **Usage mobile layout** + trace states (timeout/error shipped; layout is desktop-ish).
10. **Today hero collapse** (whole-page scroll physics — current fixed hero + inner scroll reads web-y).
11. **Workspace on mobile**: hide-the-link decision or a minimal file view.
12. **⋯-menu theme segment** footgun (arrow-key/mis-tap commits a theme change; likely the
    "spontaneous light mode" report) — drop the segment or confirm on change.

## Backend follow-ups

- Connector health probe + last-error on `/v1/connector-apps` (unlocks honest "needs attention").
- HQ billing URL plumbed into client config for self-host billing.
- DSML leak: old DeepSeek-era tool-call markup renders as assistant prose in some historical
  conversations — needs a wire-text filter.
- `assistant config set` over CLI/IPC silently fails (RC=0, no write, no output) in non-TTY
  contexts — prod visionTier was set by direct config.json edit; fix the CLI path.
- Transient gateway IPC `classify_risk` failures during the UAT window (bash tool errored; ugly
  surface, no retry) — self-recovered; add retry + calmer copy.
- Memory People rail: duplicate degenerate "Manav" person cards (data hygiene).
- 3 duplicate "Gym Reminder" schedules (data; display fixed, dedupe-on-create pending).

## On-device verification checklist (needs a real iPhone)

- Swipe-archive + came-in triage under real WKWebView gesture arbitration (pointercancel timing).
- Long-press feel at 480ms vs iOS system behaviors; haptics.
- Sheet drag-dismiss; edge-swipe back; keyboard avoidance of composer + sheets.
- Real safe-area env() on notch/Dynamic Island devices (all fixes verified via simulated vars).
- Live Activities / Dynamic Island (wired, needs TestFlight build 202607191624+).
- Deck pinch-zoom feel (deliberately deferred; fit-to-width + chevrons + swipe shipped).

## Verified live on prod tonight

Vision image turns (3×) · chats index route · onboarding SPA serving · archived projects under
Done · parked ▶ run loop end-to-end · brief endpoint · healthz + new bundles (`index-BG7HjNHp.js`).
