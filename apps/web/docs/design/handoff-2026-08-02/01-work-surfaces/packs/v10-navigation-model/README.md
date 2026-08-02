# v10 — the navigation model (2026-08-02)

Answers four challenges to v9's tab structure. Two land and change the design.

## HQ is *when*. Work is *what*.

| | ◈ HQ | ▤ Work |
|---|---|---|
| Cuts | **across** all things | **into** one thing |
| Shows | only what's true today | everything, urgent or not |
| You come to | **clear** | **dig in** |
| It | empties | never empties |

**Defended:** these are not two dashboards. Removing either forces the other to lie — HQ would have to show non-urgent work, or Work would have to guess your priorities. Every tool already has this split: inbox/folders, Today/projects, my-issues/board. One empties, the other doesn't.

## Navigation — two levels, never three
```
▤ Work                                  the list of things
  └ Renew Acme                          the room: tasks, artifacts, people, spend
      └ Confirm the 24-month position   the task
```
**It is NOT Work → mission → project → task.** There is no mission level to click through. Two taps to anything, from either surface (HQ → task, or Work → thing → task).

If Cue later groups things under one goal, that grouping is a **collapsible header inside the Work list** — you still tap the thing beneath it, never the header. It adds no depth. That's the whole reason grouping is an offer rather than a level.

## What changed

**Improved — Work rows now show the room behind the door.** Every row carries **"1 needs you · 2 running · 9 total"** plus the agents on it. A ring and a status word alone is a dashboard tile; counts and agents make it a doorway. This was the correct criticism — the earlier frame read as a portfolio summary.

**Improved — the detail screen is drawn.** It was implied and never shown, which is why "where's the actual work?" was the right question. Contains: charter quote · needs-you · Cue-is-doing (with queued) · artifacts made · waiting-on · people · done + spend · Ask-Cue scoped to this thing.

**Conceded — the Work/work collision.** "Work tab, filtered to Work" was nonsense. Renamed to **Professional / Personal** — the owner's own phrasing, pairs correctly, collision gone. The `⌂` glyph, warm ground and horizon grouping all survive; only the word moves.

## Professional / Personal — where the classifier lives
```
thing (project / ongoing)
  domain: professional | personal   ← lives here
  charter, agents, budget
work item
  inherits domain from its thing
  unattached → carries its own
```
Already how the build works (`domain` shipped on projects, which is why "move a project from personal to professional" is the open request). Moving the container moves everything inside it.

**A grouping can never span domains** — otherwise "hide Personal" would half-hide a group and the screen-sharing promise breaks.

## Supersedes
- v9 N6 Work-tab frame → the version here (rows carry counts + agents)
- "Work / Life" as filter labels → **Professional / Personal** everywhere
- v3's `domain: work | life` → `domain: professional | personal`, on the container
