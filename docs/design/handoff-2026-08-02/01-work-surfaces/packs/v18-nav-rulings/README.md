# v18 — four rulings back to build (2026-08-02)

## 1 · People and Intelligence — the one-line confirmation
**People → a tab inside Memory.** Not a sidebar item. "Who I work with" is something Cue *knows*, and 95% of real entry is clicking a name elsewhere.

**Intelligence → dissolved. It was never one thing.** Delete the container, keep every tab:

| Intelligence tab | Now lives |
|---|---|
| Identity | Memory |
| Memory | Memory |
| People | Memory (a tab) |
| Plugins | Skills — a plugin is a skill with a vendor |
| Tools & Apps | Skills |
| Marketplace | Skills (the Explore tab) |
| Channels & Agents | split — channels → Watching, agents → Agents |
| Connections | Watching (connected vs watched, one page) |
| Cue Live | Watching (it's a source) |
| Workspace | Library (files are artefacts) |

**Why:** "About Assistant" groups by *what the engineer built*. The CUE group groups by *what the user is asking* — who works for me / what can they do / what runs / what does Cue know / what has it made / where does it come from. **There is no eleventh question, so there's no eleventh page.**

## 2 · Tokens — you were right, I scoped it wrong. **Do not touch 800 call sites.**
I named `#9A9AA8`/`#6B6B60` from the **mv1/mv3/hq mock family** and wrote it as though it governed the system. A five-step `--content-*` ramp that passes contrast **is not a bug.** The ruling was never about step count — it was about four instances of a 2.4–3.1:1 value carrying text.

**Correct scope — audit once, fix only failures:**
1. Every value used for **text** clears **4.5:1** on its grounds. Any number of steps is fine.
2. Any step that *can't* stays in the system but is **renamed to say so** — `--border-*`, `--ground-*`, `--divider-*`. Not deleted, just not called "content".
3. **Recede by size or weight, never contrast.**

> **Note on the fifth recurrence.** This exact error appeared in v18 itself — 10 nodes used the light-theme `#6B6B60` on the dark canvas (3.21:1), including the parentheticals that justify the Intelligence routing. Fixed. The pattern across five packs is always the same: **a light-theme muted token applied to a dark ground.** The durable fix isn't vigilance, it's naming — `--muted-on-light` / `--muted-on-dark` rather than a bare hex, so the ground is in the token name and the mistake becomes unwritable.

Net effect: probably a rename of one or two steps, not a sweep.

## 3 · One shell, sub-tabs inside it (frame R1)
- **Agents must not open its own container.** Every CUE surface renders in the same shell with the same sidebar — Skills and Library are already correct.
- **The eleven Intelligence tabs become sub-tabs inside the six destinations.** Skills carries *Installed / Explore / Plugins / Tools & apps / Sources*. **Six sidebar rows, unlimited depth beneath.**
- **The sidebar is one column.** The two-column CUE grid in the build reads as a keypad, breaks vertical scanning, and truncates "Watchi…". Same left margin as HQ and Work.

## 4 · Home canvas — exactly six elements (frame R2)
```
1. the mark + one serif line
2. the composer
3. up to 5 prompt chips
4. one sentence pill → points at the rail
5. — nothing
6. — nothing
```
**Remove from the current build:** the two needs-you cards · the third approval card · the four extra suggestion pills · the entire **PICK UP WHERE YOU LEFT OFF** row.

**Why each:** needs-you is in the rail *and* in HQ — a third instance is the overload · the extra pills duplicate the prompt chips one row above · recent conversations are **already in the sidebar three inches left.** The home screen currently renders the sidebar's contents twice.

**The test my earlier direction was missing:** *is this already visible somewhere else on this screen?* If yes, it doesn't go on the canvas. I said "six elements" without saying why, so more kept arriving.
