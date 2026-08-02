# Cue — Final navigation & architecture brief
**2026-08-02 · supersedes all navigation guidance in v13–v20**
**Build target:** `packs/v21-surface-map` + `packs/v15-navigation-final` + `packs/v16-destinations` + `packs/v17-detail-surfaces`

---

## 1 · Answers to the questions you asked

### "People and Intelligence have no home"
- **People** is a **destination in the app sidebar** — a relationship surface (what Cue has learned about someone, in sentences; and the relationship state: *owe them a reply · waiting on them · going quiet*). It is **not** a Memory tab.
  **Sequencing:** ship it inside `Your Cue → Memory` as an interim tab. **Promote it to the sidebar when contact memories are non-zero and growing week-over-week** — not when the code ships. A prominent destination with 2 rows teaches people the slot is worthless.
- **Intelligence** is **renamed `Your Cue`** and becomes the single configuration shell. It absorbs Settings. Every one of its tabs survives — see §3.

### "The token ruling has a scope question — 800 call sites"
**Do not sweep.** I generalised from a mock palette; a five-step `--content-*` ramp that passes contrast is not a bug.

1. Every value used for **text** clears **4.5:1** on the grounds it appears on. Any number of steps is fine.
2. Any step that *can't* stays in the system but is **renamed to say so** — `--border-*`, `--ground-*`, `--divider-*`.
3. **Recede by size or weight, never contrast.**

**Do this instead:** rename the tokens so they carry their ground — `--muted-on-light` / `--muted-on-dark`. This exact error (light muted token on a dark ground) has recurred **six times** including in our own decision documents. It's a naming problem, not a discipline problem: as long as a bare hex is typeable anywhere, it will be typed onto the wrong ground.

### "Agents opens in its own container"
**Every surface inside Your Cue renders in the same shell with the same sidebar.** Skills and Library are already correct; Agents is the outlier.

### "The nav is creating two rows"
**The group is one column.** A two-column grid reads as a keypad, breaks vertical scanning, and truncates labels ("Watchi…"). Same left margin as HQ and Work.

---

## 2 · The app sidebar — five rows and a door

```
cue.                                ◧
[ ✎ Talk to Cue              ⌘N ]        ← filled row; ✎ starts a new conversation
◈ HQ                          7  ▾
    Confirm the 24-month position   10:30
    Resolve dinner conflict         tonight
    Approve AR-5182                 2d
    4 more in HQ ›
▤ Work                        5  ▸
PINNED / RECENT (5) / All conversations ›
──────────────
👤 People                   214        ← after extraction works
▦ Library                    48
──────────────
⚙ Your Cue                    ●
👤 Manav · Autonomous · $4.10
```

**Flat hierarchy, no indents.** Disclosure is a small `▾` on the **right edge after the count**, so nothing shifts horizontally on open. Expanded items are unindented — quieter type does the nesting, not position.

**Expansion rules:** three items max, always (then "N more ›") · HQ sorts by urgency, Work by what's live · only one section open at a time · **titles only, no buttons in the rail** · collapsed on first run, then remembered.

**Rail auto-collapses to a 52px icon strip the moment you enter a conversation** (`◧` or `⌘\` pins it open). This is what makes discoverability affordable.

### Why these five
| Test | Result |
|---|---|
| Do you go there and stay, daily? | Talk to Cue · HQ · Work |
| **Does it get richer on its own?** | People · Library |
| Do you only go there to change something? | → a leaf inside Your Cue |

**"Does the data accumulate" is a property you can check** — which is why it won't drift the way "does it demo well" did.

---

## 3 · Your Cue — one shell, 18 leaves, 5 groups

```
WHO CUE IS              Identity · Brand
WHO WORKS FOR YOU       Agents · Skills 98 · Plugins 10 · Marketplace 1288 · Connectors 9/500
HOW CUE REACHES YOU     Channels · Agent network · Cue Live
WHAT CUE KNOWS & SEES   Memory · Watching
WHAT IT DOES ALONE      Schedules · Guardrails · System access
RUNNING CUE             Models · Usage & spend · Workspace · Preferences
```

### These four are NOT the same thing — do not merge them
| | What it is | Lifecycle |
|---|---|---|
| **Skills** | 98 behaviours, categorised, create-your-own from chat | learned / authored |
| **Plugins** | 10 packages **pinned to a commit**, reviewed, uninstallable; adds tools, hooks, app surfaces | installed / pinned |
| **Marketplace** | 1,288 installables across 7 GitHub sources, per-source curation | browsed / installed |
| **Connectors** | 500 third-party services with live health | connected / authorised |

I collapsed these in an earlier round on label similarity. That was wrong — four distinct objects, four trust models.

**Cue Live is a subsystem, not a mode** — Look / Point / Take control / Stream, each with its own permission gate, plus a take-control switch and a streaming banner. Its own leaf.

**Connections is per-person channel verification** (guardian profile, verified Slack ID, revoke) — that data belongs on the **person's row in People**, not as a standalone page.

### The four real duplications to fix
About Assistant and Settings grew separately and overlap:

| In About Assistant | In Settings | Keep |
|---|---|---|
| Tools & Apps · 500 connectors | Integrations · same list | **Connectors** |
| — | Guardrails **and** Permissions & Privacy | **Guardrails** (checkpoints + agent scopes + autonomy + trust rules). System grants stay separate — macOS, not policy. |
| Workspace · file tree | Archive | **Workspace**, archive as a filter |
| (Usage standalone) | Budget & Spend | **Usage & spend** |

**Net −4 pages from 22.** Depth is fine for a product this size; duplication isn't.

### Contextual entry beats permanent links
Six leaves are also reachable from the moment you'd want them — **Agents** from an agent chip, **Guardrails** from a tier chip, **Schedules** from HQ's `↻` line, **Watching** from the pulse line, **People** from any name, **Usage** from the spend chip. A permanent link taxes every screen where you don't want it.

---

## 4 · The home canvas — exactly six elements

```
1. the mark + one serif line
2. the composer
3. up to 5 prompt chips
4. one sentence pill → points ↑ at the rail
5. — nothing
6. — nothing
```

**Remove:** the two needs-you cards · the third approval card · the four extra suggestion pills · the entire **PICK UP WHERE YOU LEFT OFF** row.

**The rule I failed to give, which is why more kept arriving:** *is this already visible somewhere else on this screen?* If yes, it doesn't go on the canvas. Needs-you is in the rail **and** in HQ; recent conversations are in the sidebar three inches left. The canvas was rendering the sidebar's contents twice.

---

## 5 · The three destinations (v16)

Each earns its click beyond the rail's three-item peek:
- **HQ earns it with *why*** — the thing each item belongs to, draft state, blocking count, calendar fit; plus day rail, delivered, and the Tier-3 lines.
- **Work earns it with *the counts*** — "1 needs you · 2 running · 9 total" with agents named. A ring alone is a dashboard tile.
- **Conversations earns it with *quotes*** — people find threads by remembering a sentence, not a title. Plus a `▤` thing chip. "Unattached · 12" doubles as the honest count of chats that never became work.

---

## 6 · Detail surfaces (v17)

- **Thing detail** — left column is work in state order; right rail is context that doesn't change while you work. **The charter sits under the title, not in `⋯`** — editing it re-steers the agents.
- **Skills** — installed before marketplace; run counts and reversals as receipts. **A permission-widening update is never silent:** *"v2.1 adds calendar write access"* → amber row + **Review change**, never auto-update.
- **Watching** — every source states what flowed through it today and how much became work. Carries the **no-op card** and **"connected but not watched"**.
- **Files** — grouped by thing with the agent who made each. **Library is the gallery; Files is the list.**

---

## 7 · The finding that changes priority

Contact extraction ran **697 times, all completed, and wrote nothing.** I had written that exact scenario in v17 as an *illustration of a rule*. It was live.

1. **Honest empty states aren't polish — they're instrumentation.** Every no-op card is a monitor a user reads for free. Ship it *with* each surface, not after.
2. **"Wrote nothing" must be a distinct outcome from "completed"** across every job, not just extraction. 697 completions were invisible only because completed-with-no-output looks identical to completed-successfully.

---

## 8 · Invariants (unchanged)

No raw enums · the composer is fixed furniture on HQ · the deck never grows (needs-you caps at 3 with "N of M") · never a fake number (`✓` / `!` / `◼` when there's no metric) · a no-op is not a success · archive never deletes and "done elsewhere" never credits Cue · Cue reports its own errors first, verbatim and first-person · **no colour-only state** — every state carries a glyph `‖ ◱ ✓ ↴ ◼ ○ ✨ ⧉ ⌗ ⏸`.

**Paused interactions are needs-you items** — in the list, the badge and the headline, sorted above everything else, glyph `⏸`, approve/decline inline. Not a separate lane.

**A calendar event is never work — but a calendar *conflict* is.** Calendar mints work only when it creates a decision: conflict, expiring hold, invite needing an answer.

---

## 9 · How to decide the next one yourself

1. **Sidebar or leaf?** Does the data accumulate on its own → sidebar. Do you only go there to change something → leaf in Your Cue.
2. **Which group?** Ask which question it answers: *who Cue is · who works for you · how it reaches you · what it knows · what it does alone · running it.* If it answers none, it probably belongs on an existing leaf.
3. **Is it a mode?** Something you *ask for* (create, voice, research) is a composer chip, not a page.
4. **Is it already visible?** If the same information appears elsewhere on the same screen, it doesn't get a second rendering.
5. **Merging test:** two things merge only if they share a **lifecycle**, not a label. Skills/Plugins/Marketplace/Connectors sound alike and share nothing.
