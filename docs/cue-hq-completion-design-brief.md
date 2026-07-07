# Cue HQ — Completion Design Brief (Round 4)

*Follow-up to the locked v3 "Cue-HQ-Build" design. This brief covers everything remaining to make HQ the ONE surface and to complete all screens/flows. Deliverables: desktop 1440 + mobile 390, light + dark, all states, in the established design language (serif display, mono microlabels, status-honest rings, `--mv1` token system).*

---

## 0. Governing decision (settled — design to this, don't reopen)

**HQ replaces Home. There is no separate Home.** One landing surface that adapts by mode and mission count:

| User | Mode default | What HQ shows |
|---|---|---|
| Personal / "help me work better with AI" | Observe | **Pulse layout**: daily brief, came-in (auto-filed), needs-you, suggested missions, capture bar. No rings until they want one. |
| Operator / assistant-first | Assist | Pulse or rings; everything drafts, review queue is the heartbeat. |
| Founder / company | Autonomous | **Rings deck**: missions in motion, agents at work, decisions waiting. |
| Mixed (most real users) | Per-mission override | Rings for company missions, personal areas stay Observe — same screen. |

The v3 pulse + rings + leash dial already express this. What was NOT yet designed is the **folding**: the old Home (command center) has content with no home in v3 yet, and the old surface must retire without loss.

---

## 1. HQ-as-Home: the content folding (highest priority)

Map every old-Home module into HQ explicitly — design the final deck with ALL of it placed:

| Old Home module | Where it lives in HQ |
|---|---|
| Greeting + "N running · N standing · N done today" | Rings-hero headline (exists in v3) / pulse greeting |
| Your Next Move hero | **Missing** — place as the top item of Needs-you, styled as the one emphasized card ("YOUR NEXT MOVE" microlabel). Don't lose this — it's the "already knows your next move" promise. |
| Needs-you / approvals | Exists (mission-tagged) ✓ |
| Running now / in motion | Agents-at-work rail ✓ |
| Up next / queued & watching | **Missing** — a compact "Queued" strip or collapsible section below Needs-you; on pulse it's a simple list. |
| Scheduled (cron agents) | **Missing** — fold into the same "Queued & scheduled" section (one row per schedule with next-fire time). |
| Watching (watchers/connected sources) | **Missing** — a quiet "Watching" line in the came-in strip header ("Watching Gmail · Slack · 2 more") linking to Connections. |
| Done today / recently done | Daily-brief "handled overnight" + a "Done" collapsible ✓/partial — make the celebration visible (artifact chips). |
| Suggested prompts / template widgets | Pulse "suggested missions" + capture-bar placeholder rotation. Retire the template grid or fold the top 3 into pulse. |
| Impact (hrs saved, budget) | Spend chips exist ✓; hrs-saved returns when the act-ledger ships (design the slot, mark provisional). |
| Chat/conversations | Unchanged — the sidebar thread list and capture bar cover it. |

Also design: **the rail after retirement** — "HQ" replaces "Home" as item #1 (one icon, no duplicate), and the **switch-over moment** for existing users (first open after the update: a one-time 2-panel "Home grew up → this is HQ" orientation, dismissible, no tour-fatigue).

## 2. Mobile: HQ takes the first tab

Decision needed executed, not debated: the **Today tab becomes HQ** (same adaptive pulse/rings surface). Keep tab order Today-position/Projects/+/Voice/You; label recommendation: **keep "Today" label with the rings glyph** (familiar word, new brain) — but render both label options for a final call. Design mobile HQ fully: rings deck at 390 (v3 has it) PLUS the folded modules from §1 (next-move card, queued strip, watching line) in the mobile stack, light + dark.

## 3. Onboarding — verify the fork, then final

v3's 5-step flow is approved. Two additions:
1. **Step 0 fork: "What's Cue for?"** — *Me / My work / My company* (multi-select chips). Sets workspace mode default (Observe/Assist/Autonomous), seeds category defaults, and tunes the copy of every later step (a personal user should never see "your company's direction"). If v3 already has this implicitly, make it explicit.
2. **Post-skip re-entry**: the HQ setup meter exists; design the *resume* screen (which steps remain, one-tap continue).
States: personal-fork variant of each step; company variant (exists).

## 4. Inbound → mission correction (trust-critical flow)

When capture auto-files an item onto a mission/project, the user must be able to correct it in one gesture, everywhere the item appears (came-in strip, needs-you, mission detail):
- Item card affordance: source badge + "filed to 🚀 Seed round" tag → tap tag = reassign menu (missions/projects list + "not a task" dismiss).
- A correction teaches: subtle confirmation "Got it — I'll file similar asks to Ops next time."
- Design the **unfiled state** too (triage confidence low): item sits in came-in with a "File to…" prompt rather than guessing.

## 5. Progressive-trust ceremony

The moment an agent earns/requests more autonomy:
- Trigger card (in needs-you): "Builder wants to send the weekly update without asking — based on 34 approved drafts, 0 reversals."
- The grant sheet: exact scope being granted (verb + channel + budget), evidence panel (acts/reversals/samples), Grant / Keep asking / Never (feeds never-lines).
- The receipt: where granted permissions live and how to revoke (agent card trust panel — exists; link the loop).
States: request, granted-confirmation, revoke flow.

## 6. Mission lifecycle states

- **Achieved**: celebration card (outcome + what it took: cycles, outputs, spend, timeline) + archive-to-retrospective. This is the emotional payoff screen — make it shareable-grade.
- **Abandoned/paused**: calm, judgment-free states with "what happens to linked work" clarity.
- **Drifting**: no progress N cycles → a nudge card ("Stuck on X — replan, step in, or pause?").

## 7. Sprint-output artifact cards

Previewable deliverable cards for Mission detail + daily brief: doc/deck/sheet/image/video thumbnail, title, agent, mission, one-line "why it exists," actions (open, approve, share). Grid on mission detail ("Outputs"), inline chips in the brief. (Outputs API is being built — design freely.)

## 8. Notification copy system (spec, not screens)

One page: the sentence patterns for push/lockscreen/brief lines per event type (cycle report, output ready, decision needed, budget stop, mission achieved, drift nudge) — voice: calm operator, outcome-first, never alarmist. Include grouping rules (max N pushes/day → digest).

## 9. Workspace switcher (design now, ship later)

The `app.cue.hq/northwind` pattern: a minimal company/workspace switcher (top-left identity block → dropdown: workspaces + personal + "New workspace"). Single-workspace v1 renders it as just the identity block.

## 10. HQ settings

Inside existing Preferences: defaults for cadence, budgets, workspace mode, quiet hours for pushes, and the never-lines editor (company panel exists — decide if it moves here or stays a panel; recommend both entry points, one surface).

---

## Coverage matrix required (per deliverable)
Every screen: desktop + 390 / light + dark / loading + empty + error. Flows 4–6: each state named above.

## Feasibility notes (so design doesn't over- or under-promise)
- Exists now: missions CRUD/cycles/events, mode dial, budgets + hard-stop, never-lines, capture→triage→auto-file, projects+knowledge, live progress notes, review lane, push.
- Being built (design freely): outputs/artifacts API, act/reversal ledger, connect-time quick-scan, email brief.
- Not yet (design provisional slots only): metric-linked ring %, hrs-saved provenance, multi-workspace.
