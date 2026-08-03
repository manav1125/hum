# Answers to BRIEF-FOR-CODE §10 — Create's per-type stage two

**2026-08-03. To design, from code.** In reply to *"the one open question"*.

All five answered from what the pipeline actually supports, not from what it
could plausibly support. Where the answer is "this does not exist", that is
stated rather than designed around.

---

## 1 · Field list and kinds

The registry supports **`text · textarea · select · number · url · tags`**.

Your vocabulary maps one-to-one **except `metric`, which does not exist** —
there is no metric field type and no unit metadata anywhere in the template
layer. `number` is the honest nearest. If you want a real metric control,
specify what it carries (value, unit, period, comparison) and we will build it;
we did not want to quietly render a `number` and let the frame imply more.

**Typed field lists exist for 7 of 10 types:** Slides, Docs, Dashboards,
Research, Images, Video, Leads.

**Sheets, Canvas and Audio have no form templates at all.** Their stage two
today is a chip-question card — a question with two to four options, one marked
default — not a field form. So either those three get a chip-based stage two by
design, or somebody writes the form templates. **We would rather you chose than
have us pick.**

---

## 2 · Which fields pre-fill

**None today, and the connected-source half is not buildable at form-render
time.**

- **Brand Kit is real** and readable.
- **Memory is not usable as a prefill source.** It stores free-text
  `statement` / `subject` sentences with no key, value or unit. Producing
  *"MRR $38.4K · Growth 18% mom"* would mean parsing numbers out of prose and
  presenting them as retrieved facts.
- **Connectors cannot be read by the client, ever, at form-render time.** The
  client can see *whether* Sheets is connected; it can never see what is in it.
  Connector tools are withheld until the model calls `tool_search` mid-run.

Desktop reached this conclusion independently and left a note in
`create-sheet-form.tsx` saying it deliberately does not render your
**"PRE-FILLED FROM MEMORY"** badge, *because there is no real prefill source, so
the provenance label would be fake*. We agree, and the mobile build follows it:
the known block carries brand and memory statements **verbatim, with their
origin labelled**, and nothing is claimed as retrieved that was inferred.

**The consequence you should see in the frames:** with an empty known block,
Investor pitch asks **five questions, not two**. We got 8 → 5 by deferring
optional inputs. The last three need a typed fact store that does not exist.
Your "same completeness, a fifth of the typing" is right as a direction and
overstated as a number until that store exists.

---

## 3 · Style step — before, and it already is

The design contract is compiled from the gallery selection and prepended to the
prompt, so the look **must** be chosen before the run starts.

**But there is a contradicting second mechanism**, and this is the real finding:
several quick-start templates carry a *"Visual direction?"* chip question inside
their elicit set — i.e. **after** the fields. Two style pickers in one flow is
the actual defect, and it is ours, not a gap in your spec.

**Recommendation:** style stays in the gallery, and we delete those elicit
questions. Say the word and it is a small change.

---

## 4 · What Preview renders — the template skeleton

Three tiers exist, and only two are real:

- **Real thumbnails** exist for the 18 deck template specs, lifted from the
  actual decks.
- **A real structural skeleton** exists for Slides (the observed slide
  sequence) and Docs (the real section list).
- **A real generation as a preview does not exist.** Nothing emits a partial
  artefact, so there is nothing to render until the run completes.

So Preview is the **template skeleton**, and the disclaimer string is
non-optional in code — the skeleton cannot be rendered without saying what it
is. That is deliberate: a skeleton that looks like output is the same defect as
a brand profile assembled from defaults, which shipped here once and the owner
caught it.

One deliberate omission: we did **not** put the 18 deck thumbnails into the
mobile grid. That grid lists form and quick-start templates, a different id
space — a thumbnail there would be a picture of a different template.

---

## 5 · App Builder — neither, and not on Docs

**It is the backing skill, and it is not on Docs at all.**

`skillLabel: "App Builder"` belongs to exactly two modes, **Slides and
Dashboards**. Docs is "Document Writer". The desktop badge renders
`{activeMode.skillLabel}` beside the templates header, so it says "App
Builder", "Document Writer" or "Replicate" depending where you are.

**It reads like neither because it is a provenance badge naming the engine.**
Two clean options: rename it so it reads that way — *"Built with App Builder"* —
or drop it. We dropped it from the mobile cards rather than ship an ambiguous
label. If you want an App Builder **type**, that is a new mode, not a re-label,
and it needs its own template set.

---

## Seven things the generation pipeline cannot do

Listed because several of them constrain frames you have already drawn:

1. **No artefact ordinal.** No event carries `{current, total}`. **"Slide 7 of
   12" is not available** — J4's narration can say what step it is on, not how
   many remain.
2. **No partial artefacts.** Nothing renders until the run completes, so J4's
   "slides appear as they're made" is thumbnails-on-completion, not progressive.
3. **No filing destination at submit time.** Your line *"Filed onto Close the
   seed · in Library"* — the one you called the reason Create lives in Cue — is
   achievable **after** the fact, for outputs, not at the moment of submitting.
4. **No client-readable connector data** at form-render time (see §2).
5. **Create intent provenance is in-memory** and lost on reload, so remix falls
   back to the asset name.
6. **Skill routing is not enforced** — `template.skill` is display-only; which
   skill actually runs is left to the model.
7. **There is no Create entry point on the phone yet** beyond the ☰ menu, which
   still mounts the old sheet. Being fixed; noted so the frames are not read as
   already reachable.

---

## One thing we found while in here, which you should know about

Three templates instructed the model to **invent business figures**. The QBR
deck's prompt read *"Seed realistic placeholder figures where I haven't given
numbers"*; the metrics dashboard and the KPI dashboard app carried the same for
their data.

The word doing the damage is *realistic*. A bracketed `[revenue]` is a
placeholder; a plausible *"$38.4K, up 18% MoM"* is a fabrication that reads
exactly like a measurement, in a deck whose purpose is to be shown to other
people.

Fixed, and now guarded by a test over the template prompts. Flagging it because
**it bears on how you draw J4 and J5**: any frame that shows a populated chart
or a filled scorecard should show it populated from supplied figures, with the
unsupplied ones visibly blank. We would rather the frames model the honest
case, since the frames are what people build from.
