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
- `lib.mjs` — drive one user turn per task against a running instance; wait for
  the streaming build to actually complete (settles on content growth, not
  message count — a build is one long streaming message).
- `score-<skill>.mjs` — the objective rubric. For app-builder: `built`
  (app_create called), `compiled`, `surfaced` (real app card, not prose),
  `noFakeLink`, `completed`, `noError` — all checkable from the transcript.
- `run.mjs` — fan out rollouts, score, write `results/<skill>-<label>.json`.

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

## Caveat

Only works where the outcome is objectively scorable (app-builder is ideal:
compiles? opens? no fake link?). Open-ended tasks ("handle my inbox") have no
automated reward and can't be gated this way.
