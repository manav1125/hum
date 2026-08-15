# v29 — Create corrections (2026-08-03) · answers §10, supersedes parts of v27

Code answered the open question and three of my frames claimed things the pipeline can't do. **Read this before building v27.**

## Decisions on the five questions
| Question | Decision | Why |
|---|---|---|
| `metric` field | **Use `number`** | Don't build it yet. A metric control is only worth having once a typed fact store exists to fill it. |
| Canvas · Audio · **Video** | **Chip-based, authored** | **Sheets is out** — it already has elicit sets, so grouping it was my error. **Video is in and it's urgent:** 9 templates, 0 elicit sets, on the type where a wrong guess burns a full render. Drawn in **N3**. |
| Prefill badge | **Withdrawn** | My error. Replaced with verbatim statements + labelled origin. **Five questions, not two.** |
| Two style pickers | **Delete the elicits** | The gallery *shows* the look; a chip only names it. Choosing from pictures beats choosing from words. |
| Preview | **Two labels** | "Outline" over-promises on eight types. **Slides & Docs → "See the outline"** (a real skeleton exists). **Everything else → "What's in it"** — describes inputs and settings, which is all there is. |
| App Builder | **Stay dropped** | A provenance badge naming an engine is for us, not the user. Reinforced by constraint 6 — we can't guarantee which skill ran. |

## The three redrawn frames
- **N1 · Fill** (replaces J3) — known block is **verbatim with origins** ("from Brand Kit", "you told me · Jul 28"). Carries the line that earns more trust than any prefill would: *"I don't have your numbers, so I'll leave them blank rather than invent them."* Empty metric boxes show `—` and state what happens if skipped. Filing line removed from the CTA.
- **N2 · Building** (replaces J4) — no ordinal, no fake thumbnails. **A step list that checks off** from real events, elapsed time instead of an estimate, and *"nothing to look at until then."* This is better than what I drew: a count makes you wait, a description lets you leave.
- **N3 · Chip stage two** (new) — **Video**, three chips: format · length · voiceover. Carries the reason: *"Nine templates, no questions today — so a wrong guess burns a full render."* Canvas and Audio follow the same shape. **Sheets excluded — already has elicit sets.**

## Authoring order for elicit sets
**Video (9 templates, 0 sets) → Canvas (3, 0) → Audio (4, 0).** Images also has 4 and 0 — open question whether image templates carry enough in the prompt or need a fourth chip set.

## The seven constraints, applied
1. No ordinal → N2 narrates the step only.
2. No partial artefacts → step list, not progressive thumbnails.
3. No filing at submit → **"✧ files onto" moves to the delivered card**, where it's a receipt not a promise.
4. No connector reads → template cards say **"needs Sheets connected"**, not "pulls from Sheets".
5. Remix loses intent → fine; chips are type-scoped.
6. Skill routing not enforced → reinforces dropping the badge.
7. No phone entry point yet → **v27 J1 is the target, not the current state.**

## NEW INVARIANT — from the fabricated-figures find
**Cue may draft *words* it hasn't been given. It may never draft *numbers* it hasn't been given.** Prose is inferable; measurements aren't. A bracketed `[revenue]` is a placeholder; *"$38.4K, up 18% MoM"* is a fabrication that reads like a measurement.

- **Frames model the honest case** — supplied figures filled, unsupplied ones visibly blank.
- **Blank is a legitimate output**, announced before building, and needs no apology on the artefact.
- **Extends past Create** — research summaries, QBRs, dashboard tiles. Anywhere a figure appears, it came from somewhere or it's blank.

## Corrections to BRIEF-FOR-CODE
- **v27 J3 → N1 · J4 → N2 · new N3. J5 and J6 stand.**
- **J1 and J2 required constraint-3/4 copy edits** — they carried pre-submit filing destinations and a connector-content claim. Exact replacements, now applied in `v27-create-flow/`:

| Frame | Was | Now |
|---|---|---|
| J1 suggestion card | `✧ Close the seed · 8 fields` | `Series A structure · 5 questions` |
| J2 Investor pitch | `8 fields · ✧ seed` | `5 questions` |
| J2 QBR deck | `6 fields · Sheets` | `needs Sheets connected` |
| J2 Product launch | `6 fields · ✧ Halo` | `4 questions` |

  Field counts also now match N1's "5 questions" — a card labelled "8 fields" opening a five-question screen was its own small dishonesty.
- §4 rule 1 rewritten: Cue states what it knows **with sources** and asks the rest — the "fifth of the typing" claim is **withdrawn**.
- §4 rule 3: filing line is a **delivery** receipt, not a submit-time promise.
- §10 closed.

## Two questions back
1. **Typed fact store — agreed, roadmap it.** Your framing is better than mine: it's not a Create feature, it's what lets People say *"applied 14 times"*, lets a dashboard tile cite its source, and makes the fabricated-figures invariant **enforceable rather than instructed**. One store fixes three surfaces.
2. **Images — 4 templates, 0 elicit sets.** Same shape as Video but lower cost per mistake. Chip set, or do the prompts carry enough?
