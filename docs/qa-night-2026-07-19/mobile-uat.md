# Mobile v3 UAT — overnight acceptance pass (2026-07-19)

Task #6 of QA night. 390×844, dark default + light spot-checks, real prod data.
Driven through the vite dev server (`web-vs-prod`, :5200 → prod daemon) plus a
direct-prod tab (`manav.justcue.app/assistant/?cueToken=…`) for voice/WS tests.
All writes were QA-NIGHT-prefixed and self-cleaned (project deleted via API,
auto-run task archived, QA chat archived).

Environment caveats: the browser pane has no microphone (mic-denied paths tested
instead of live duplex); pointer drags select text instead of touch-swiping, so
swipe gestures (review pager paging, row swipe actions) could not be exercised;
offline takeover could not be triggered (synthetic `offline` event ignored — needs
real network loss); reduced-motion untestable per brief.

## Per-surface verdicts

| Surface | Verdict | Notes |
|---|---|---|
| Today (home) | PASS w/ issues | Cards, ⋯ menu, avatar fine. Stale "Next Move" data (#12), static timestamp (#26) |
| Morning Brief (/brief) | PASS w/ issues | 3 beats render + tap-through + "Start my day" works. Review CTA mis-routes (#3), day-ahead beat unsorted/"4 meetings" copy (#20) |
| Projects list | PASS w/ issues | Cards, counts, Done filter render. Blank-screen entrance delay (#1) |
| New-project sheet | PASS | Created "QA-NIGHT delete me" (icon/color/category chips all render) |
| Project detail | PASS w/ issues | Brief edit+persist ✓ (laggy refresh), quick-add ✓, Ask-about renders. **No task archive affordance** (#6), **no project delete/rename** (#7), quick-added task auto-ran (#2) |
| All-work | PASS w/ issues | All 3 groupings (Status/Project/Due) + counts work. Row tap mis-routes into pager (#4), duplicate rows (#23) |
| Came-in | PASS | Clean "All caught up." empty state (no items to swipe — swipe UX untested) |
| Review pager | ISSUES | Opens, browse-only respected. **Raw markdown body** (#5); paging not reachable via pointer (verify swipe on device); Approve/Redo/chips present |
| Watch-live | NOT TESTED | No running work item existed at test time |
| Chat | PASS w/ issues | Send→reply fast (~3s), title updates, /status works, tune sheet, ⋯ actions, doc overlay + selection→quote + handoff row all work. Double header (#8), /status hanging spinner (#9), orphan empty bubble after Stop (#27) |
| Chats index | PASS | Timestamps, search filter work |
| Voice (idle + mic-denied, prod) | PASS w/ issues | Graceful "Cue can't hear you" + Enable-mic CTA; in-thread orb enters/exits cleanly with denied-state bar. Tab bar disappears on Voice (#10), "voice active" while mic dead (#25), CLASSIC chip unexplained (#24) |
| Create page + sheet (+) | PASS | All 10 modes, quick-starts, gallery search+filter chips (All 18/Pitch/…), video Live-action/Animated sub-tabs, fill&build form composes, paste-URL reference chip ("1 reference riding"), canvas tiles (Inpaint/Outpaint/Restyle/Remove BG/Upscale/Create new). Serif headline inconsistency (#19) |
| You | PASS | Dial states render (didn't change mode), track record, all rows |
| Memory | PASS w/ issues | Search (1,421), 4 segments; People nearly empty/dupe owner cards (#21), person card routes to legacy People page (#13), ⌘↵ hint on mobile (#22) |
| Connections | PASS | 7-live grid, Gmail detail sheet, Telegram bad-token error path works (raw JSON in copy, #16) |
| Rules | PASS | AUTO/ASK chips render (not toggled); make-a-rule sheet opens/cancels; count copy mismatch (#28) |
| Guardrails scopes + checkpoint | PASS | 4 agent scope cards + chips; checkpoint sheet opens/cancels |
| Skills | PASS w/ issues | Explore/Installed·49/Sources, consent sheet ("Before it can run") opens/cancels. "Vellum" rebrand leaks (#15), long blank entrance (#1) |
| Agents | PASS | Cards expand: charter, acts/spend, Re-charter, Pause/Adjust/Retire. "Adjust scope" lands on Rules root not the scope card (#29); /assistant/agents URL redirects home (#30) |
| Ledger | PASS w/ issues | Day groups, expand-act (cost, Reversible/Reverse, work item ›). **~25-30s load** (#11); no filter chips found (#31) |
| Brand kit | PASS | Clean empty state + Add-your-brand CTA |
| Settings index + leafs | PASS w/ issues | Index, Appearance, Sounds, Voice, AI models, Schedules, schedule editor open/cancel. "Running on llama3.2" wrong (#14), schedule TZ mismatch (#17), Voice leaf loses tab bar (#32) |
| Offline takeover | NOT TESTED | Not drivable in this environment |
| Onboarding (welcome) | ISSUE | Renders, but the signed-in tab bar shows on the pre-auth screen (#18) |
| Light theme | PASS | Spot-checked Today, Projects, Rules, Chat — all clean, no contrast breakage |
| Console | PASS | No console errors across the entire sweep (only vite HMR noise) |

## Ranked issues

### P0
None that hard-block the alpha build, but #2 is the closest call — triage it first.

### P1
1. **Entrance animation leaves screens looking empty for 5–15s** — Projects,
   All-work, You, Memory, Skills, Agents, Agent scopes: data is in the DOM but
   invisible (staggered fade never fires until some later trigger). The single
   most pervasive quality problem; every list surface looks broken/hung on first
   load. (Repro: cold-navigate to /assistant/projects or /assistant/skills.)
2. **Quick-added project tasks silently auto-queue and auto-run.** "QA-NIGHT task
   do not run" went queued→running within ~1 min of Add and spent $0.01. No
   confirmation, no visible signal at add-time that a background run will start
   (dial = Autonomous). Trust hazard for alpha users adding notes-as-tasks.
3. **Brief "Review" CTA lands in an empty conversation** (routes to the item's
   conversation, which renders as "New conversation" with no content) instead of
   the review pager.
4. **All-work row tap opens the review pager at item 1 of 26**, not the tapped
   item (tapped "Send Q3 invoice…", got "Organize the user's activities…").
5. **Review pager renders raw markdown** (`##`, `**bold**`, `---` literals) in
   the result card — the flagship review ritual reads as debug output.
6. **No way to archive/remove a task from mobile** — task sheet has Run/Due/
   Labels/File-to only; no archive, and row swipe does nothing (spec called for
   quick-add + archive).
7. **No project manage actions on mobile** — project-detail ⋯ opens the global
   menu (Chats/Search/Settings/Logs); rename/archive/delete impossible (QA
   project had to be deleted via API).
8. **Chat + Voice carry the legacy desktop banner** (hamburger/home/search +
   "New conversation" title) stacked above the v3 header — double chrome on core
   v3 surfaces.
9. **/status leaves a hanging "Still working…" turn** (34s+ until manually
   stopped) after its instant local output; hung-turn family.
10. **Voice screen drops the bottom tab bar** with no ✕/back of its own — you
    exit via the legacy banner only; feels like a trap after entering from the
    tab bar.
11. **Ledger takes ~25–30s to load** (`/acts` + `/acts/summary` on prod are that
    slow); loading copy cycles the whole time.
12. **Stale Next Move** — top recommendation is the expired "HK LP trip Jul 6-10
    … Review BEFORE Monday" task (9+ days old), and it duplicates the Review
    card below it.
13. **Memory person card routes to the legacy serif "People" page** rather than a
    v3 person sheet; the flow Memory→person→edit crosses two design systems.
14. **Settings → AI models says "Running on llama3.2"** — actual brain is
    deepseek-v4-flash (confirmed by /status). Wrong fact on a settings surface;
    also no profile radio is selected anywhere.
15. **"Vellum" rebrand leaks** in user-facing skill descriptions ("…into Vellum
    by inspecting…", "Import conversation history from ChatGPT into Vellum").
16. (P1/P2 boundary) **Telegram bad-token error dumps raw API JSON**
    (`{"ok":false,"error_code":401…}`) into the sheet copy. Error path itself
    works.
17. **Schedule editor timezone mismatch** — "Daily at 06:00 PM" shows
    `cron 0 18 * * * · next run tomorrow 2:00 AM`; cron is UTC while the picker
    pretends local. Users can't trust the "next run" line (and possibly the
    actual fire time).
18. **Onboarding welcome screen shows the signed-in tab bar** (Today/Projects/+/
    Voice/You) on a pre-auth screen.

### P2
19. Create page + People pages keep serif-HQ headlines ("What do you want to get
    done?", "The people Cue knows.") — inconsistent with v3 native type on mobile.
20. Brief day-ahead beat: events unsorted (8:00 after 20:30) and "4 meetings
    today" counts Travel/Dinner/bed-time as meetings.
21. Memory People segment: only the owner, listed twice (guardian/contact), card
    body repeats "guardian"; owner's own card says "Cue hasn't learned anything
    about Manav yet" despite 1,421 memories. (Known memory-extraction backlog.)
22. Person add-a-fact shows the desktop "⌘↵ to save" hint on mobile.
23. Duplicate rows in All-work ("Review On2Cook secondary exit opportunity" ×2)
    and three duplicate "Gym Reminder" schedules — data hygiene.
24. Voice screen "CLASSIC" chip has no explanation or visible alternative state.
25. Chat header claims "voice active in this chat" while the mic is unreachable.
26. Next Move timestamp is static-ish ("2m ago"/"just now" regardless of real
    recency of the recommendation).
27. Stopping a turn leaves an orphaned empty assistant bubble.
28. Rules header says "4 standing rules" above six category rows — count doesn't
    match what the eye sees.
29. Agent card "Adjust scope" lands on the Rules root instead of that agent's
    scope card; agents subtitle "spend · measuring…" reads unfinished.
30. /assistant/agents (and Chats "Not found" page at /assistant/conversations —
    bare unstyled 404, no link back) — dead-end routes.
31. Ledger has no visible filter chips (spec expected filters).
32. Settings → Voice leaf drops the bottom tab bar (other leafs keep it).
33. Consent/checkpoint sheets are readably translucent mid-animation (content
    behind bleeds through for a beat).
34. Composer "Add attachment" opens the native picker and left the page shifted
    horizontally + keyboard inset stuck (env-confounded — verify on device).
35. Brief beats and Today cards occasionally take a long beat to fade in after
    navigation (same family as #1, milder here).
36. Sounds: master switch ON while every individual event is OFF — default combo
    reads broken.

## What was verified working (highlights)
- Chat round-trip on prod data is fast (~3s), slash-command autocomplete, tune
  sheet (access tiers + model profiles), conversation ⋯ actions, doc overlay
  with selection→quote chip and the desktop-handoff row.
- Create is the strongest surface: 10 modes, per-mode quick-starts, fill&build
  forms, style-reference paste-URL chip, video sub-tabs, canvas tile set.
- Guardrails stack: rules chips, make-a-rule sheet, checkpoint sheet, agent
  scopes, agents (charter/pause/retire), act ledger with reverse affordance.
- Connections grid + detail sheet + Telegram error path; Skills consent sheet;
  Brand kit empty state; Schedules list/editor; light theme; zero console errors.

## Cleanup ledger
- Project "QA-NIGHT delete me" — deleted (API, 200).
- Work item "QA-NIGHT task do not run" — auto-ran (one $0.01 act on the ledger),
  then archived via PATCH.
- Conversation "QA-NIGHT ping 2" — archived in-app.
- Telegram token was never saved (validation 401 path only). No rules, modes,
  checkpoints, approvals, or real items touched.
