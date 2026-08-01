# Implementation status — read this before building from this package

**This folder is the canonical copy of the design handoff.** It was delivered as a zip;
the zip is not the source of truth any more, this folder is. Do not go looking in
`~/Downloads` — there are two dozen similarly-named archives there and no way to tell
which is current.

**Read order:** `README.md` → `01-work-surfaces/WORK-SURFACES.md` → the addendum at
`01-work-surfaces/ADDENDUM/` (four decisions that amend §5, §9, §10, §13, §17 and §19)
→ `01-work-surfaces/canonical/cue-canonical.html`, which is the build target for HQ and
mobile Today.

The addendum patches the spec. Where they disagree, the addendum is newer.

---

## What is built (2026-08-01)

| Step | State | Where |
|---|---|---|
| 1 · Reorder HQ, delivered-first | **Built** | `apps/web/src/pages/hq/hq-deck.tsx`, `hq-page.tsx` |
| 2 · Honest empty states | **Built** | `EmptyState` in `hq-deck.tsx` |
| 3 · Auto-provision watchers | **Built** | `assistant/src/watcher/auto-provision.ts` |
| A1 · Contrast text legs | **Built** | `packages/design-library/src/tokens.css`, `apps/web/src/index.css`, `mv3.css`, `lib/hq-theme.ts` |
| 4 · Mission rings | Blocked on data — `RingsHero` exists and is correct; production has one mission and it is `abandoned` |
| 5 · Verbs + triage + ledger | **Vocabulary only** — `apps/web/src/pages/hq/work-vocabulary.ts`. Verbs exist as data; no keyboard handling, no triage mode, no row menu |
| 6 · Hand-off | Not started — needs `assignee_type`, `delegated_to`, leash record (§22) |
| 7 · Trust everywhere | Not started — `agent_acts` already carries `reversed` and `cost_cents` |
| 8 · Day rail, waiting, Later | Not started — needs calendar read, `waiting_on`, snooze storage (§22) |
| 9 · Rhythms, search, batching, weekly review | Not started — needs `rhythm`, decision record (§22) |
| 10 · Corrections, interruptions, a11y, data/exit | Not started — needs `act_correction`, interruption log (§22) |

The night's full ledger, including what went wrong and what was corrected, is
`docs/NIGHT-2026-08-01-design-implementation.md`.

---

## Open decisions — these block work, and they are the user's to make

1. **`awaiting_review` — "Needs you" or "Review"?** `07-autonomy-states` (implemented as
   `packages/design-library/src/components/work-state.ts`) says **Review**. `01 §3` says
   **Needs you**. It is the label on the deck's primary lane *and* the sidebar badge.
   `README.md` gives canonical precedence over the packs but is silent on 07. Both
   modules currently coexist with the conflict documented at the top of
   `work-vocabulary.ts`.
2. **Calendar sync strategy** — the watcher cannot establish a sync token. See the
   night ledger for the measured cause and three options.
3. **Missions** — production has one, `abandoned`. Data fix, or should abandoned
   missions keep a ring (design has the `blocked` tone)?
4. **`--mv1-amber` is `#C98A1B`** (2.9:1) and is not the system's needs-you bright
   `#B4770F`. **`--mv1-danger`** has no row in the A1 table. Both are hue decisions.

---

## Things the spec says that are already true in the codebase

Worth knowing before you build something that exists:

- `agents` carries `charter`, `tier`, `cap_cents`, `tool_scopes` — agents are already
  staff with charters and leashes.
- `agent_acts` carries `reversed`, `reversed_at`, `cost_cents`, `est_minutes_saved` — the
  weekly review's two credibility figures are queryable today.
- `work_items.completed_elsewhere` exists — the "Done elsewhere" verb has its column.
- `auto_filed_by` / `auto_file_confidence` exist — ✨ provenance and the
  below-confidence rule have their data.
- `assessment_*` columns exist — judgement transparency has a foundation.
- The watcher engine, scheduler, heartbeat and mission orchestrator all run today.
- **Settings → Schedules** already shows heartbeat, consolidation and retrospective with
  run history and "run now" — §10's "What Cue does" is a promotion, not a build.
