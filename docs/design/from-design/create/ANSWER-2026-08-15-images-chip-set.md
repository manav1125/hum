# Answer — Images: no chip set

**Back to design · 2026-08-15 · answers the open question from v29 (asked 3 Aug)**

> *"Images: 4 templates, 0 elicit sets — same shape as Video, lower cost per mistake.
> Chip set, or do the prompts carry enough?"*

**Ruling: no chip stage for Images.** Video, Canvas and Audio keep theirs — the
asymmetry is the point, and it is not about cost alone.

---

## First, a correction that changes the question

Images has **7** templates, not 4. The registry
(`apps/web/src/domains/create/create-templates.ts`) splits them cleanly:

| Kind | Templates |
| --- | --- |
| **Generative** (4 — the ones counted) | Hero image · Logo concepts · Social graphic · Illustration |
| **Editing** (3 — not counted) | Restyle an image · Retouch & clean up · Replace or add an object |

Those three editing templates are the answer. **Cue already ships
generate-then-adjust for images** — a refinement path that exists for no other
medium in the row. Video has 9 templates and none of them edit an existing
video; Audio has 4 and none edit existing audio.

So the question isn't "do the prompts carry enough". It's "should we ask
questions up front for the one medium that already has three ways to change its
mind afterwards".

## Why the gallery is the elicitation here

v29 deleted two style pickers on the grounds that **the gallery shows the look;
a chip only names it**. That reasoning applies to images *more* strongly than
anywhere else, not less:

- an image thumbnail **is** the output — same medium, same fidelity
- a video thumbnail cannot show motion
- an audio tile cannot show sound at all

Images are the single case where the grid answers in pictures what a chip would
ask in words. Adding a chip set here re-introduces the exact thing v29 removed.

## And the templates already carry the context

"Social graphic" implies the ratio. "Hero image" implies wide. "Logo concepts"
implies transparent variations. Picking the template settles what a chip stage
would ask again in words.

## The economics point the same way

Your own note — *lower cost per mistake* — is the crux, and it cuts further than
it first appears. An image regenerates in seconds for cents, so the value of
asking first is low while the friction cost is unchanged. For a medium that is
instant, cheap and visual, **people react to what they can see far better than
they can specify in advance.**

Chips earn their friction when a mistake is expensive *and* the result cannot be
previewed. Video and Audio: both true. Images: neither.

## Where that effort should go instead

1. **Real thumbnails in the gallery** — this is where elicitation actually
   happens for images, so it is worth the investment a chip set would have cost.
2. **Variation from the result** — "warmer", "wider", "more like this" acting on
   the image in front of you. The three editing templates are the seed of this;
   they are currently reachable only as separate templates, not as an action on
   something just generated.
3. **Templates encoding use and ratio**, so choosing one settles the context.

## One thing to note about the row

Video, Canvas and Audio have **zero elicit sets in the shipped registry** — the
chip stage two v29 specifies for them was not built either. That has now been
implemented (`b9e6d66b14`), with Sheets correctly excluded. Images is the only
member of the row deliberately left without one.
