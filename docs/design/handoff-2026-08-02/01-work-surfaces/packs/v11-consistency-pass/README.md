# v11 — consistency pass (2026-08-02)

v7–v10 read as a set rather than a sequence. Four findings; one was a collision introduced in v9.

## The settled vocabulary
| Word | Means |
|---|---|
| **thing** | What you're trying to get done. Finishing or ongoing. Holds the charter, agents, budget. |
| **task** | One piece of work inside a thing. What the eight verbs act on. |
| **goal** | An optional header grouping 2+ things. **Offered, never imposed.** This is what "mission" becomes. |
| **professional / personal** | The domain, on the thing. Tasks inherit. Goals can't span it. |

**Retired words:** `mission` (→ goal, label only) · `project` (→ thing in UI copy; table name can stay) · `All work` (→ Work → Everything) · `Life` (→ Personal).

## Findings

**1 · Two surfaces were both called Work.** The v10 tab (list of things) and v3's "All work" ledger (flat list of tasks). Renamed the tab in v9 and never checked what else owned the word — the same mistake as the Work/Life filter collision one turn earlier, which suggests **"work" is too generic to be a proper noun in this product.**
  **Fix is a merge, not another rename.** Work gets two views: **Things** (default, containers) and **Everything** (the flat ledger with filters, search, bulk select, and the "Not in anything yet" bucket). Grouping headers in Everything are the same things listed in Things, so the two views are provably the same data. One tab, one word, one destination — and the ledger stops floating in the nav.

**2 · Desktop still said Missions.** v10 was phone-only, so the two platforms disagreed about the information model — worse than either being wrong alone. Sidebar reconciled: **Talk to Cue · HQ · Work** at the top (matching the phone's three tabs), then Things/Everything nested under Work, then the deeper surfaces the phone links out to (Agents, Rhythms, People, What Cue does, Trust & guardrails).

**3 · The grouping had no noun.** "Group these three into a ___?" → **goal**. Plainer than mission, literally what it is, needs no explanation.

**4 · Work had no day one.** Every v10 frame showed a populated account. New frame **C2**: teaches the word "thing" in a sentence rather than a tooltip, offers two starts, and does the move only Cue can — **reads what's already arriving and proposes three candidates with evidence counts** ("Acme · 14 emails"). Closing line stays honest: Cue is useful before you do this, just less organised.

**Smaller, carried into copy:** v9's recruit screen retitled `New mission` → **New thing in Work**. An un-comprehended arrival can't be classified, so **domain is unset, not defaulted** — guessing Professional would leak a personal item into a shared export. HQ's census link now points at Work → Everything.

## Process rule added
**A rename is only finished when nothing else answers to the old word.** Both collisions this week came from reusing a word that was already load-bearing. Check before naming any surface.

## Checked and deliberately unchanged
Three tiers still hold · Personal keeps horizon grouping (one doorway row → This week / Soon / Someday) · the eight verbs are unaffected (tasks didn't move) · Rhythms stays its own surface (it generates tasks into things but isn't one) · Cue Live, Create, Agents, People remain deeper surfaces · **the six mobile gaps from INDEX.html are still open** (interruption budget, search, reasoning panel, rhythms, data/exit, multiplayer).

## Net effect
One destination fewer, one fewer word to learn, and both platforms now describe the same model. The only genuinely new frame is Work's day-one state; everything else is subtraction.
