# Cue HQ — Round 5 Design Direction (Final Pass + Projects Coherence)

*Context for the designer: Round 4 ("Cue-HQ-Build (3).html") passed review — all ten completion-brief sections are approved as designed. This round is (A) five specific finishing items found in rendered review, and (B) one new scope: bringing the Projects surfaces up to HQ's visual standard. Nothing else should change — do not rework approved frames.*

---

## Part A — Finishing items on the approved build

### A1. Fold the retired-Home modules into the DARK theme frames
**Problem found in review:** the dark desktop HQ frame and the dark 390px mobile HQ frame still show the older v3 deck. They are missing the four modules that the light frames gained in round 4.

**Do this:** update BOTH the dark desktop HQ frame AND the dark mobile (390px) HQ frame to include, exactly as the light versions have them:
1. The emphasized **"◆ YOUR NEXT MOVE"** card sitting at the top of the Needs-you lane.
2. The **"Queued & scheduled"** section — queued item rows plus cron/schedule rows with next-fire labels (e.g. "⟳ MON 8:00 · fires in 4 days", "DAILY · 7:00 each morning").
3. The **"Watching for you · Gmail · Slack · Calendar · +2"** line above the came-in strip.
4. The **Done-today artifact chips** with their OPEN affordance.

Use the established dark palette (the #1A2432-family surfaces with the brightened #5B86F0 accent). Keep ring-label text contrast at the improved level from v3 (the earlier low-contrast issue must not return).

**Acceptance:** a side-by-side of light vs dark HQ (desktop and mobile) shows identical module inventory, only theme differs.

### A2. Render BOTH mobile tab-label options
**Problem:** the mobile tab bar was only rendered with the first tab labeled "Today". We need to make a final naming call and can't from one option.

**Do this:** produce two otherwise-identical mobile HQ frames:
- Option 1: first tab labeled **"Today"** with the rings glyph.
- Option 2: first tab labeled **"HQ"** with the rings glyph.
Same for dark. Add a one-line rationale note under each (when would this label serve better).

**Acceptance:** four small frames (2 labels × light/dark) presented together for the decision.

### A3. Mark the "TIME BACK" chip as provisional
**Problem:** the HQ deck shows "TIME BACK ~9 hrs from 214 acts" as if live. The measurement system (the act/reversal ledger) is not built yet; the brief requires unclaimable numbers to be visibly provisional.

**Do this:** design the chip's **pre-ledger state**: either (a) a subtle "estimating" treatment (dotted underline / muted tone + tooltip "Cue starts measuring time back as it completes acts — this fills in over your first week"), or (b) hide the number and show "MEASURING TIME BACK…" until data exists. Pick one, show it in light + dark. The full-data state you already designed stays as the target state.

**Acceptance:** the deck has a defined look for day-1 users where no fabricated number appears anywhere.

### A4. Render ONE personal-fork onboarding step
**Problem:** the Step-0 fork ("What's Cue for?" Me / My work / My company) is designed, and the copy claims later steps adapt for personal users — but no adapted step is actually rendered.

**Do this:** render the **"Connect your world" step as a personal-mode user sees it** (user selected only "Me" at Step 0): no company language anywhere; sources framed personally (Gmail = "your inbox, triaged", Calendar = "your week, prepped"); the direction-docs upload either hidden or reframed as "anything you want Cue to know about you"; the suggested-first-mission chips personal (e.g. "Get my inbox under control", "Plan the Bali trip", "Stay on top of finances") with the same evidence-provenance treatment.

**Acceptance:** one full frame proving the fork actually changes the journey, not just Step 0.

### A5. Loading + error states (or an explicit waiver)
**Problem:** the coverage matrix requires loading/empty/error per key surface; none are designed.

**Do this (minimum viable set, 4 frames):**
1. HQ deck **loading** — skeleton treatment: ring placeholders shimmer, module headers present, no spinners-in-space.
2. HQ deck **degraded/error** — the daemon is unreachable: the deck renders with cached data + a quiet top banner "Reconnecting to Cue… showing your last state" (never a blank screen, never a modal).
3. Mission detail **loading** skeleton.
4. Came-in strip **error** ("Couldn't refresh what came in — Retry").
If you believe any surface genuinely doesn't need one, write a one-line waiver in the doc instead of silently skipping.

---

## Part B — Projects coherence pass (new scope, deliberately narrow)

**Why:** HQ now defines the product's visual bar (serif display heroes, mono microlabels, status-honest indicators, mission tags, the card language). Users will constantly cross the seam HQ → Mission detail → **Project (initiative) → task**, and the Projects surfaces were built functional-first. They must feel like the same product, one level deeper — this is a **restyle to the HQ language, not a redesign**. Keep all existing functionality and layout logic.

### B1. Projects home (grid of project cards, grouped by category)
Restyle to HQ language: serif page hero ("Projects" + a mono microlabel line, e.g. "INITIATIVES & AREAS · N ACTIVE"); project cards adopt the HQ card DNA (the emoji tile, title, category microlabel, per-status counts as quiet mono chips, most-urgent-next-task line, pin affordance) and show their **mission tag** when linked ("⟡ Close the $500K seed") with an unlinked state ("Standalone"). Pinned band styling consistent with HQ. Empty state: same editorial voice ("No projects yet — missions create them, or start one yourself.").

### B2. Project detail
Restyle: serif hero (emoji, title, category, mission tag → tap = go to mission); the **Context brief** and **Project knowledge** panels keep their function but adopt the HQ panel treatment (accent rail, mono section labels "CONTEXT BRIEF" / "KNOWLEDGE — Cue reads these"); the status board columns get the HQ status-tone system (same hues as ring states); task rows show source badges + live progress notes in the same style as HQ's agents-at-work rail. Task drawer: same treatment, plus its Move-to-project control styled like the correction reassign menu from §4 (one interaction language for "re-file this").
Mobile 390: stacked lanes as built, restyled. Light + dark.

### B3. One card language (small but important)
A single reference sheet: THE item-card anatomy used everywhere an actionable item appears (HQ needs-you, came-in strip, project board row, review queue, mission detail): source badge · title · mission/project tag · status/due chip · primary action. Design it once with its variants; note where each variant applies. This prevents the drift we currently have between surfaces.

### Explicitly NOT in scope (defer, don't design):
Create, Voice, Library, People/Trust, Intelligence hub tabs, Settings beyond §10, the constellation map, metric-% rings, workspace switcher build-out. The Agents org page is already designed (v3) — no changes.

---

## Deliverable format
Same single-artifact HTML as previous rounds, appended sections clearly labeled "ROUND 5". Coverage: every new/changed frame in light + dark; mobile 390 where the surface has a mobile presence (Projects home + Project detail + HQ states). Keep every approved round-4 frame untouched.
