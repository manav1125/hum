# skill-eval — scored rollouts + SkillOpt-style optimization for Cue skills

A small harness that turns a Cue `SKILL.md` into something you can **measure and
optimize**, the way Microsoft's [SkillOpt](https://microsoft.github.io/SkillOpt/)
does: run real task rollouts against a live instance, score them with an
objective rubric, then gate skill edits on whether the score actually improves.

It doubles as a **regression suite** — run it before/after any model swap or skill
change to see, in numbers, whether behavior got better or worse.

## Why

Cue's skills are natural-language markdown docs (external state for a frozen
model). This session we kept hand-editing `app-builder/SKILL.md` to stop DeepSeek
from narrating-then-stopping, faking builds, or writing dead links. This harness
replaces "eyeball it" with a scored loop.

## Layout

- `tasks/<skill>.json` — the task suite (prompt + `train`/`holdout` split).
  Suites: **app-builder** (does it build?), **tasks** (does the add reliably
  fire + confirm?), **web-research** (does it search + cite a real source?).
- `lib.mjs` — drive one user turn per task against a running instance; wait for
  the streaming turn to actually complete (settles on content growth + ends on a
  text block, not message count — a build is one long streaming message).
- `score-<skill>.mjs` — the objective rubric per skill, all checkable from the
  transcript. app-builder: `built`/`compiled`/`surfaced`/`noFakeLink`/`completed`/
  `noError`. tasks: `addCalled`/`confirmed`/`noError`/`noFakePlace`. web-research:
  `searchCalled`/`hasSource`/`answered`/`noKeyError`.
- `run.mjs` — fan out rollouts, score, write `results/<skill>-<label>.json`.
- `optimize.mjs` — automated **reflect + edit**: reads the failing rollouts,
  asks an optimizer LLM for ONE bounded SKILL.md edit, writes a proposal to
  `proposals/` for review + gating. Does NOT auto-apply (edits must be gated).

## Run

```bash
cd assistant/skill-eval
# baseline
node run.mjs tasks/app-builder.json --split all --label baseline
# ...edit the SKILL.md, redeploy the daemon...
node run.mjs tasks/app-builder.json --split all --label edited
# compare the two results/*.json percentages; keep the edit only if it went up
```

Config via env: `CUE_EVAL_BASE` (default `https://manav.justcue.app`),
`CUE_EVAL_TOKEN` (default: `~/.cue/qa-actor-token`).

## The SkillOpt loop, applied here

1. **Rollout** — `run.mjs` executes each task, records the transcript.
2. **Reflect** — read the failing transcripts; find the concrete failure mode
   (faked the build, skipped app_refresh, wrote a `sandbox:/` link, stalled).
3. **Edit** — a _bounded_ change to `SKILL.md` (a "textual learning rate" — small
   edits, not rewrites, so working rules survive).
4. **Gate** — re-run and keep the edit only if the held-out score improves.

The optimizer that proposes edits can be a human, a strong model, or Cue itself.
The point SkillOpt makes — and that this harness lets us test on _our_ tasks —
is that a hardened skill can lift a cheap runtime model's reliability by a
model-tier's worth, without paying frontier prices at runtime.

### Automating the reflect + edit (optimize.mjs)

```bash
node run.mjs tasks/app-builder.json --label baseline   # 1. rollout + score
node optimize.mjs app-builder --label baseline          # 2. LLM proposes a bounded edit -> proposals/
#    ...review the proposal, apply it to the SKILL.md, redeploy the daemon...
node run.mjs tasks/app-builder.json --label edited      # 3. gate: keep only if the score rose
```

Optimizer model via `CUE_EVAL_OPTIMIZER_MODEL` (default `deepseek/deepseek-v4-flash`).
Point it at a stronger model for bigger gains (SkillOpt: a stronger optimizer wins).
The human stays in the loop at the apply+gate step on purpose — per **SkillLens**,
~25% of skill edits cause _negative transfer_ (they make the agent worse), and an
LLM judge picks the better of two skills only ~46% of the time. So: never ship an
ungated edit, and **re-gate every skill after a model swap** — that's exactly when
a skill can silently stop transferring.

## Caveat

Only works where the outcome is objectively scorable (app-builder is ideal:
compiles? opens? no fake link?). Open-ended tasks ("handle my inbox") have no
automated reward and can't be gated this way.
