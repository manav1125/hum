# Cue — the agent programme
**Design turn for code · 2026-08-10 · answers `BRIEF-2026-08-10-agents-and-open-work.md`**

```
cue-agent-programme.html    ← THIS TURN · design items 1 & 2, the noun question
cue-agent-pages.html        ← the running agent: index, detail, ledger, charter editor
cue-marketplace.html        ← the listing layer (built earlier — see note in §7)
cue-design-answers-v39.html ← the manifest Q&A this builds on
```
Open at full width — canvases, pan don't scroll. **The rendered HTML is the spec**; inspect inline styles for values.

---

## 0 · The one idea, and where it came from

**Your constraint produced it.** *"Never auto-route to an installed agent"* looked like a restriction; it's the shape of the whole programme. If an agent can't take work until granted, there is a period where it **claims without taking** — and that period answers four separate problems at once:

| Problem | What the trial does |
|---|---|
| Day one has no record (rule 1 forbids inventing one) | Gives it one, against **your** work, before it touches anything |
| A static pre-built agent underperforms — the template-gallery failure | The trial **is** the adaptation. Seeded or empty, same mechanism |
| Granting autonomy needs evidence | You approve **after** seeing what it would have done |
| A vendor's eval is their corpus | The trial is the same claim, tested on yours |

So: **a new agent doesn't start working, it starts watching.** Creation and install converge on it, which is the "one mechanism, seeded differently" you asked for.

---

## 1 · Design item 1 — the specialist, end to end

### S1 · Making one
"Make me an invoices agent" → **exactly three questions, then it stops.** Each exists because the answer *cannot be inferred from the owner's data*, and each maps to a field:
1. What counts as one worth its attention → **claims**
2. What should it never do on its own → **permanent prohibitions**
3. Is <this ambiguous case> a decision or a doing → **hand-back rule**

Then a readable thing: name · **claims** (sentence + deterministic tags) · **hands back, always** · needs to reach · **skills it carries: "6 of 98"** · runs (capability + rough weekly cost).

Two calls worth keeping:
- **"6 of 98 skills" is the sentence that justifies specialists** — the context-economy argument made visible exactly where someone would otherwise ask "why not just use Cue?"
- **The ✕ prohibitions are permanent, not tier-dependent.** A thing an owner said "never" about must not quietly become possible at a higher tier.

### S2 · Watching (the trial)
Day 6 of 7, **taking nothing, $0 spent**. Shows: *"It claimed 38 things this week and took none of them. You've checked 12 so far."* → **38 it claimed · 9 you said yes · 3 you said no · 26 you haven't looked**, with the individual claims inspectable and a **"Check five ›"** row.

**Every trial number is an act the owner performed — never an inference.** The 26 unchecked are reported as unchecked and counted for neither side: *"Cue handled them as usual and you didn't object — but not objecting isn't agreeing."* **Absence of objection is never scored as approval** — rule 2 (a no-op is not a success) applied to the owner's attention rather than the system's. A trial scoring itself on the owner's inattention would be a fake number in the most load-bearing position in the programme.

This costs the headline its impressive number and makes it a better argument: **an agent reporting it was only checked twelve times is more credible than one claiming 89%** — and it makes the reviewed fraction something the owner can improve, which is the behaviour we want during a trial. Hence the cheap **"Check five"** gesture: if agreement must be an act, the act has to be cheap or nobody performs it.

**The misses are the product.** Three wrong claims sharing one cause becomes one fixable sentence — *"all three were payments Xero hadn't caught up on; a 24-hour wait after any payment event fixes all of them"* → **[Add it]**. That's how a generic agent becomes *yours* without anyone writing a prompt.

Why it's acceptable as the default rather than an advanced mode: **matching is a string operation over work that already arrived**, so watching costs nothing and risks nothing.

### S3 · Granting
Headline: *"You checked 12 of its 38 claims. It got 9 right."* — with the unchecked remainder stated, and the choice offered honestly: check a few more, or decide on what you've seen.

**It asks, you give, and every withheld thing states its fallback.**
- Granted scopes: green, plain language, scoped ("internal and vendor addresses only")
- **Withheld: "it'll draft and hand back to you instead. Nothing breaks; it just stops one step earlier."**
- **Spend shows three numbers:** it asked $40 · you gave $20 · trial pace suggests ~$6. *A third party sets none of them.*
- Autonomy: Suggests / **Acts, tells you** / Acts in budget
- **"Keep it watching" is offered plainly.** If trial is only a gate you pass it's a wizard step; if it's a mode you can stay in, it's a trust instrument.

**The rule this encodes: a withheld scope must state what happens instead.** "Off" is a dead end the owner has to reason about; a described behaviour is one they can picture. Without that sentence, partial grants exist in the schema and nobody uses them.

### S4 · Handing back, and getting better
**Two handback kinds, and they must never merge:**
- **Charted** (amber, informational): *"Sterling disputed the amount — that's a decision, and it's charted to hand those back."* + "Cue picked it up 2 minutes later · nothing stalled"
- **Couldn't** (red, actionable): *"Xero returned nothing for four hours. This one isn't charted — it's broken."* + [Check Xero]

One number merging them is a no-op reading as a success.

**How it's changed** — append-only, with the outcome attached to each entry: *"Wait 24h after any payment event · you added it from the trial · **0 wrong chases since**"*, and the headline *"handbacks 4 → 1 a week."* This is the useful half of upstream's `level-up` **minus the part we shouldn't copy: every entry here is authored by the owner.** An agent editing its own harness needs a louder surface than a history list, and this isn't it.

## 2 · Design item 2 — the card at first meeting

**The empty record gets the most prominent card on the page**, not a hidden zero: *"It has done nothing for you yet, so there's nothing here to show. It starts by watching your work for a week — that's the record you'll judge it on."* **Rule 1 stops being a restriction and becomes the pitch.**

- **The vendor's eval is shown and demoted in the same breath** — "91% on 120 receipt cases · fieldwork.io's own test set" then *"their corpus, not yours. **Useful for ruling it out, not for trusting it in.**"* This is what stops eval scores becoming the store's star rating by another name.
- **The button is "Try it for a week", not Install.** Nothing is granted by trying; the scary decision moves to after the evidence.
- **It will ask for** — scopes previewed *before* commitment, each marked withhold-able, with "you set the real number" against its spend ask.
- **Cue-authored vs third-party: a source line, not a badge.** A gold "verified" mark invites the wrong inference — that we vouched for its judgement. What we can honestly say is who wrote it and **"instruction-only · no code ships"**. The real asymmetry stays behavioural: **third-party agents can't be granted above "acts, tells you" until they've worked a month.**

## 3 · The noun question — accepted, with one sharpening

> **"A skill is something Cue can do; an agent is someone who owns work."** Accept it. Clearest line anyone has written about this product, and it survives contact with every surface.

**Sharpening — make it a question the owner can ask themselves: *would you ever wonder how it's doing?*** You never wonder that about a verb. Same admission test as "owns a stream", phrased so it needs no jargon.

**And the visible consequence, so the noun teaches itself:** agents appear in a list of who works for you and their name is on work in HQ; **skills never appear anywhere except the moment they're used.** The vocabulary is carried by the surface, not a docs page.

**Store admission test:** a listing that can't name the stream it would own is a skill in the wrong aisle — checkable at submission, not a taste judgement.

## 4 · The naming collision to settle before build

**This brief uses *tier* for model capability; the shipped UI uses *tier* for autonomy** ("Tier 3 · acts in budget"). Two meanings, one word, **both on the same card**.

**Recommendation: autonomy keeps "tier"** — it's shipped, it's in the trust panel, it's what owners already read. **Capability takes the composer's existing Cue-branded words** ("Everyday", "Deep"), which also keeps provider names out by construction, per this round's ruling.

## 5 · One engine, four uses

Trial · the charter dry-run (agent pages G4) · the *"18 look like Ops's job"* suggestion · the store's "try for a week" are **all the same operation**: *match these conditions against real intake and show what they'd have caught.*

**Build it once, deliberately, as its own thing.** Its only requirement is that recent intake stays queryable by candidate conditions.

## 6 · Steal instruction-only — and say it on the card

Upstream's publishing rule (`SKILL.md` and `references/*.md` travel; executables never do) is right for us too, and **stronger stated than implied**: "no code ships" is a sentence an owner can act on. It's also the honest form of the trust badge we're declining to give.

## 7 · Note on the marketplace file

It was drawn before this brief landed, so it's the **listing layer** — correct in structure, and consistent with your "do not start there". Two amendments from this turn, cheap to apply:
- **Install → "Try it for a week"** on agent listings (skills/plugins/connectors keep Install/Connect — they don't own work, so they don't have a trial).
- The consent sheet becomes the **post-trial grant** (S3), not a pre-install gate. Its content is already right; it moves later in the flow.

The listing's "what people use it for" and "how it runs" sections stand as drawn — they're the depth that makes an agent adoptable rather than a wrapper.

---

## Suggested build order
1. **The matching engine** (§5) — everything else is a view over it.
2. **Manifest schema** — sentence + conditions + prohibitions + asks (scopes, spend, capability). v39 has the field-level rulings; the generalist gets one too, no conditions, lowest precedence.
3. **Trial + grant** (S2, S3) — the trust spine. Nothing routes until this exists.
4. **Running surfaces** — index, detail, ledger, handback split, change history.
5. **Store listing amendments** (§7).

## Still open from Part 4 of your brief
- **The responsiveness signal** — one build, three surfaces (valve's fourth stop · "quiet lately" · "you owe a reply"). Worth sequencing together, as you say.
- **Google Sheets health** — agreed with not patching. The honest third state is **"not actively checked"** with the reason in a tooltip; a blank cell reads as a bug, and a wrong "failed" is worse than both.
- **Guardrails coach-mark** — needs the live observation; no design change until it reproduces.
