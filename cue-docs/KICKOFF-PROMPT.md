# Claude Code — kickoff prompt for Cue

Set the model to **Claude Fable 5 (`claude-fable-5`)** in Claude Code before you start.
Open the forked repo folder in Claude Code, drop the `cue-handoff` bundle contents into it, then
paste the prompt below.

---

## Paste this into Claude Code

```
You are building "Cue" — a personal AI assistant — on a fork of vellum-ai/vellum-assistant
(my fork: https://github.com/manav1125/hum). This is a rebrand-and-extend of an existing
TypeScript + Swift monorepo, NOT a greenfield build.

Model: stay on Claude Fable 5 for this project.

First, read these handoff docs (I've added them to the repo as `cue-docs/`, with design mocks
in `design/`, logos in `assets/cue/`, and `cue-rebrand.patch` at the repo root):
1. cue-docs/CUE-BUILD-HANDOFF.md  ← the master plan; read this fully first
2. cue-docs/ROADMAP.md, BRAND.md, FUNCTIONALITY-MAP.md, DESIGN-SPEC.md
3. cue-docs/CUE-LIVE-RESEARCH.md, CUE-LIVE-SPEC.md, CUE-INFRA-SPEC.md
4. Open the design/*.html mocks (design-book is the complete screen reference) for the visual target.

Then do Phase 0 / step 1 only, and STOP for my review before going further:
  a. Confirm you understand the build sequence and the cross-cutting invariants in
     CUE-BUILD-HANDOFF.md §4 (gateway-only ingress, CES for credentials, provider abstraction,
     notification signals, memory provenance gates, feature-flag registry, single-source design tokens).
  b. Run ./setup.sh per the repo README and get the macOS app building/running locally.
  c. Apply cue-rebrand.patch (git apply cue-rebrand.patch). If it doesn't apply cleanly, tell me
     what conflicted — do NOT force it.
  d. Run `bun test` and the build; report what passes/fails. The rebrand updated tests in lockstep,
     so the suite should stay green.
  e. Launch the app and confirm it shows the Cue brand (name "Cue", blue accent, focus rings,
     aperture avatar where applicable).

Rules for the whole project:
- Build to the locked design system (design-library tokens + the mocks). Don't invent new visual
  language; for long-tail screens follow existing design-library components and the design book.
- Don't break the invariants in §4. Don't blanket find/replace "vellum" — the deep identifier
  rename (BRAND.md deferred list) is its own later phase.
- Work in small PRs; keep tests green; update tests alongside source.
- Ask me before anything destructive (force-push, deleting data dirs, mass renames) and before
  starting each new phase.

After step 1 is green and I approve, proceed through CUE-BUILD-HANDOFF.md §6 build sequence:
design-library primitives → v0.2 surface redesign (Home→Chat→Intelligence→…) → mobile → v0.3
flagships → Cue Live → deep rename → deploy.

Start now with step 1a (read the docs and summarize the plan back to me).
```

---

## Notes
- The bundle's README explains the folder layout; commit `cue-docs/`, `design/`, `assets/cue/`,
  and `cue-rebrand.patch` into the repo so everything is version-controlled together.
- If Claude Code can't see Fable 5 in the picker: update Claude Code Desktop to the latest version,
  then reselect Fable 5 (known, fixed issue).
- Keep this prompt handy to re-anchor a new Claude Code session: "re-read cue-docs/CUE-BUILD-HANDOFF.md
  and continue the build sequence from where we left off."
