# Create — the current spec, and the seven thin surfaces
**For code · 2026-08-15**

```
v29-create-corrections/   ← READ FIRST. Supersedes parts of v27.
v27-create-flow/          ← the base flow, with v29's copy edits already applied
```

---

## 1 · The missing spec — it exists, and your grep found the right exposure

**v29 (2026-08-03) is the correction to v27.** It never reached your repo; that's on our side. There is no v30+ Create respec — **v27 as amended by v29 is the current and final spec.** Nothing else is pending.

You were right that this is load-bearing. v29 changes behaviour, not styling:

| What v29 changes | Where it likely bites your code |
|---|---|
| **J3 → N1**, **J4 → N2**, **new N3** (chip stage two) | the stage stack — three frames replaced, one added |
| **Chip stage two applies to Video, Canvas, Audio — and explicitly NOT Sheets** (it already has elicit sets) | `create-spine.ts` routing: a type-conditional branch v27 didn't have |
| **Prefill badge withdrawn** → verbatim known-values with labelled origins; **five questions, not two** | the Fill stage's whole model, and any field-count copy |
| **Two style pickers deleted** (the gallery shows the look; a chip only names it) | elicit sets for those types should not exist |
| **Preview label splits in two** — Slides & Docs "See the outline"; everything else "What's in it" | a per-type label, not one string |
| **App Builder stays dropped** | the tile list |
| **J1/J2 copy corrections** (four exact replacements — filing destinations and a connector-content claim) | template card labels; `8 fields` → `5 questions`, `6 fields · Sheets` → `needs Sheets connected` |

**On `create-types.ts` specifically:** v29 doesn't renumber the tiles, but it does drop App Builder and changes which types carry a chip stage. **Diff the tile list and the per-type stage flags**, not just the order.

**On `create-spine.ts`:** the "v27 rule as a pure state machine" comment is now wrong by one branch — stage two is conditional on type, and Sheets must skip it.

### The invariant v29 introduced — worth propagating past Create
> **Cue may draft *words* it hasn't been given. It may never draft *numbers* it hasn't been given.**

Prose is inferable; measurements aren't. `[revenue]` is a placeholder; *"$38.4K, up 18% MoM"* is a fabrication that reads like a measurement. **Blank is a legitimate output**, announced before building, needing no apology on the artefact. This extends to research summaries, QBRs and dashboard tiles — anywhere a figure appears, it came from somewhere or it's blank.

### One question still open from v29
**Images: 4 templates, 0 elicit sets** — same shape as Video, lower cost per mistake. Chip set, or do the prompts carry enough? Asked 3 Aug, never answered.

---

## 2 · The seven thin surfaces — ruled per row

The rule: **either the mock loses the metric, or the metric earns a ticket.** The wrong outcome is a comp that stays aspirational and quietly makes every build look incomplete.

| # | Surface | Missing | Ruling |
|---|---|---|---|
| 1 | **Memory** — "applied N times" | count is null daemon-side | **Ticket — and it's the same ticket as v29's typed fact store.** This is the one row where the metric is load-bearing: a memory that can't say it was used can't be pruned, trusted, or defended. One store fixes this, dashboard citations and the fabricated-figures invariant at once. **Until it lands, the mock loses the line** — not a dash, absent. |
| 2 | **Review pager** — "IN YOUR BRAND ✓" | outputs carry no brand metadata | **Ticket, small.** The claim is binary and the Brand Kit already knows what was applied — this is a flag written at generation, not a metric. It's also the payoff for the whole Brand surface; without it Brand Kit is a settings page nobody can verify. |
| 3 | **Watch live** — Redirect | no endpoint | **Ticket — and I'd promote it.** Per the mobile rulings: stop and take-over are blunt, and redirecting mid-flight is what an owner actually wants while watching. **Take the budget from step-detail persistence**, which I ruled against. |
| 4 | **Identity** — Working style row | no config key | **Mock loses it, permanently.** Already ruled in Round 4.1: if it means the autonomy dial, that lives on the You root and duplicating it is worse than dropping it. Remove from the comp so it stops resurfacing. |
| 5 | **Skills** — per-skill runs / reversals / spend | no per-skill data source | **Mock loses runs and spend; ticket *reversals* only.** Three numbers is a dashboard nobody asked for. **Reversals is the one that changes a decision** — it's the honest counterweight to an install, and it's the same shape as the agent record. One number, not three. |
| 6 | **People** — "you owe a reply" | needs question detection | **Ticket, but sequenced third.** Already scoped in v38: it's the same responsiveness signal as the valve's fourth stop and "quiet lately". **One build, three surfaces** — and this is the least urgent of the three, so it rides along rather than leading. |
| 7 | **Watching** — complete census | API caps at 200 | **Mock keeps it, and the cap is the design.** The surface already says the cap out loud, which is correct and better than a silent truncation. **The fix is the sentence, not the number:** "showing the 200 most recent" is honest; "200 sources" would be a lie. No ticket — this row is already right. |

**Summary: 4 tickets (one large, three small), 3 comps corrected.** The large one — the typed fact store — is the only structural item, and it was already on the roadmap from v29.

### The pattern across the seven
Five of these are a metric a comp invented because a card looked empty without one. **The generalisable fix is that an empty card is a layout problem, not a data problem** — the surfaces that survived this audit best (Watching, Review) are the ones that said what they didn't have instead of leaving a hole where a number should be.
