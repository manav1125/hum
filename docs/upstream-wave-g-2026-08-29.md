# Wave G — upstream port + Teach + agent hand-off

Branch: `cue/upstream-wave-g` (off `cue/voice-replatform`). Not merged, not deployed.

Written overnight 2026-08-29. Every claim below was verified against the tree
rather than inferred from upstream's commit messages; where something did not
apply to us I say so.

---

## The through-line

Four separate controls in this product read as ON in the UI and enforced
nothing. That is most of the answer to "the agent stuff isn't working well",
and it is a pattern worth naming because it will recur:

| Control | Where it lapsed | Now |
|---|---|---|
| Trust-rule directory scope | UI offered a "Where" picker; the engine matches on (tool, pattern) and the gateway dropped the field | Picker removed, gateway refuses a narrow scope with 400 |
| Agent tool scopes | Applied to the in-memory conversation only; the evictor or a restart silently restored the full tool set | Persisted on the conversation, re-applied on every hydration |
| Agent tier | Stored, editable, displayed; read by nothing | Gates the auto-run decision |
| Agent paused | Stored, editable, displayed; read by nothing | Gates the auto-run decision |

The shape is always the same: a setting the owner reaches for *precisely* to
constrain something, wired to nothing. A control that reads as off while the
behaviour stays on is worse than no control, because the owner stops watching
the thing they believe they turned off.

---

## Upstream port (window 2026-08-16 → 08-28, 615 commits)

Ported, each with tests:

- **Provider error normalization.** The OpenAI SDK keeps only the `.error` key
  of a parsed body and renders the unparseable as "(no body)" — which is why an
  OpenRouter rejection reached us as bare `"Provider returned error"` with the
  real cause stranded in `metadata.raw`. Raw bodies are now captured and a
  semantic `ProviderErrorReason` derived from them. Two past outages were slow
  to diagnose for exactly this reason.
- **DeepSeek thinking-mode `tool_choice`.** Thinking mode rejects *any* explicit
  `tool_choice`, including `"auto"` — the API default. Compaction and main-agent
  turns both sent one.
- **Duplicate `tool_use` ids.** We had no id normalization at all. A repeated id
  ran the call twice and owed two `tool_result`s for one id, which Anthropic and
  OpenAI both reject.
- **Two permanent-wedge bugs**: blank assistant content (now unconditional, not
  opt-in per adapter) and oversized content parts (now classified as overflow so
  the recovery ladder runs). Both matter because the bad request lives in
  history — every retry resends it and compaction hits the same rejection.
- **Truncated JPEGs.** Our byte-sniff gate passed them: a truncated JPEG keeps
  its SOI header. Now walks marker structure to a terminal EOI.
- **Chat-template 400s, reason-driven retry, Gemini `$ref` guard, reasoning
  replay** on the generic OpenAI-compatible adapter.
- **Embed worker EPERM.** `reclaimStaleWorker` read "exists but owned by someone
  else" as "gone", dropped the PID file and spawned a replacement beside a live
  ~500MB worker. Same leak as the `ps`-fork scar, from the other direction.
- **Mid-turn actor repointing** (LUM-3220). The send route wrote the trust slot
  on arrival, then awaited, then asked whether a turn was already running — so a
  message arriving mid-turn had already repointed that turn's actor.

### Cost accounting was wrong in both directions

`deepseek/deepseek-v4-pro` — the prod brain — had input at 0.435 against a real
0.579 (**understated a third**) and carried no `cacheReadPer1mTokens`, and
`pricing.ts:338` falls back to the full input rate when that is absent, so
cached reads were billed at 0.435 against a real 0.048 (**~9x over**).

Separately, `z-ai/glm-5.2` is `DEFAULT_ADVISOR_FALLBACK_MODEL` and **was not in
the catalog at all** — every advisor fallback call has been completely uncosted.

24 of 68 shared OpenRouter models were stale. All four catalog copies moved
together. These are live third-party prices; this is a snapshot, not a feed.

### Checked and deliberately skipped

- **Conversation evictor in workers** — our memory worker runs in-process in the
  daemon, which already starts the evictor. Not applicable.
- **Daemon port-occupied guard** — we already have `portHeldByAnotherDaemon()`.
- **Anthropic `pause_turn` resume** — a 573-line refactor of a provider that is
  dormant for us (no credits).
- **Torn conversion-cache half** of the JPEG fix — guards a macOS `sips` cache we
  do not have.
- **`7cfc7e3bd9` classify-once** — a 254-line refactor of `permissions/checker.ts`,
  which is heavily diverged here. Left for a dedicated pass; it is the highest-value
  thing still outstanding.

---

## Teach — learn a skill by being shown one

`teach_skill` (start / status / stop), wired into the `skill-management` skill.

The observation driver already existed and its own header already described this
product; it just had no second consumer. It now takes an `isArmed` predicate and
a `sink` instead of hardwiring the ambient work-item pipeline.

**A demonstration is its own session, not a mode on the ambient one.** Ambient
capture has extraction budgets, digest dedupe and item caps tuned for sampling a
working day. A demonstration wants every step in order, including the repetitive
ones, because the order *is* the procedure. Sharing the session would have
deduped away the repetition that makes a workflow a workflow, and filed a todo
per step for something the owner is doing on purpose.

The bounds are the product, not a safety afterthought: owner starts, owner
stops, 30-minute ceiling a caller cannot raise. Those three are also what make
the signal good — the start and stop label where the workflow begins and ends.
Expiry retires the demonstration rather than discarding it.

`stop` returns the transcript plus authoring guidance, so the same turn writes
the skill via `scaffold_managed_skill` — which already carries the permission
check and the approval card. A background job that woke later would put the
draft somewhere the owner is not; here it lands in the conversation they just
had, where a correction is a reply.

Only skill authoring and `ask_question` are permitted during synthesis: being
watched is consent to have a skill written, not consent to act on what was on
screen. Frames are never retained.

---

## Agent hand-off — what was actually broken

The substrate was fine. Work item → agent (by assignee) → budget check → tool
scopes → model pin → run conversation all worked. Four things around it did not:

1. **`task_list_add` had no `assignee` field.** From chat you could never route
   anything to a roster agent — every task landed unassigned or on the hardcoded
   "Inbox". The roster existed and nothing could reach it.
2. **The agent's identity was never written down.** Model pin, tool scopes and
   charter lived on the in-memory conversation, so the evictor or a restart
   returned a plain conversation. Replying to an agent reached generic Cue.
3. **Tier enforced nothing.**
4. **Paused enforced nothing.**

Now: `agent_roster` reports who exists (and whether they are paused, near cap,
or scoped away from the work); `task_list_add` takes a validated `assignee` —
an unknown name is **refused** with the roster listed, not absorbed into the
unrestricted house assistant; `agent_id` is persisted on the conversation
(migration 333) and re-applied on every hydration; the charter is rebuilt into
the system prompt each turn; tier and pause gate the auto-run decision.

The tier sits *alongside* the global dial rather than under it — an agent held
at draft must not act even when the workspace is Autonomous, since that setting
is the reason the owner staffed it that way.

End-to-end loop that now works: `agent_roster` → `task_list_add` with assignee →
tier-gated run → "See the work" → reply reaches that agent with its scopes,
model pin and charter intact.

---

## Verification

Full assistant suite (1863 files) run on this branch and on `5240d29300`, the
commit the branch starts from, and the failing-file sets diffed:

- baseline: **86** unique failing files
- this branch: **84**

The two fewer are `base-url-route-validation` (14 SSRF/provider-gate tests that
had never run) and `registry` / `inline-command-runner`. Nothing fails on this
branch that does not fail on baseline, except one file that passes reliably
per-file across repeated runs and is a combined-run ordering flake.

The diff caught two real regressions I would otherwise have shipped:
`openai-provider` asserted the SDK constructor options exactly and broke on the
new fetch wrapper, and the binding lookup put a throwing DB read on the
conversation-construction path. Both fixed; the second was a robustness bug in
its own right, not just a test failure.

apps/web: 566/568 files, the two known flakes. Gateway trust-rule suites green.

---

## Two things you should know

**A repo-wide test condition, not caused by this branch.** ~300 test files use
exhaustive `mock.module` factories on `config/loader` — the exact antipattern
`assistant/CLAUDE.md` forbids, which deletes every export the factory does not
name for every file that runs after it. I fixed the three in
`base-url-route-validation.test.ts` and recovered **14 SSRF and provider-gate
tests that had never run once**. The rest is real work and separately scoped.
Per-file is the trustworthy signal; I baselined every combined-run failure
against a worktree at the pre-change commit.

**A NUL byte** in `cue-live/observation-capture.ts`, used as a digest field
separator, made the file read as binary to grep and diff. Same class as the
`db-snapshot.ts` one. Fixed.

---

## Still outstanding

- `7cfc7e3bd9` — classify each tool invocation once, before the gates. Highest
  value remaining; needs care because our `checker.ts` is diverged.
- `289c6eb188` — bound file reads by characters instead of lines (context
  blowout protection on single huge lines).
- `de25f3203b` — report and repair dangling concept-page links. Real value
  (silent structural corruption in the memory corpus), but upstream's version
  lives in `plugins/defaults/memory/substrate/`, a layout we deliberately do not
  share. It is a re-homing exercise rather than a port, so I left it rather than
  invent our half of it unattended.
- `997697e0d2` — `needsAttention` filter on `GET /v1/conversations`.
- The exhaustive-mock cleanup across ~300 test files.
- **Not started:** the Grok-style hand-off/converse surface as a *UI*. The
  server-side loop works now, but there is no dedicated place to see your agents
  working and talk to them — that is a design question, not a bug, and I did not
  want to invent a surface overnight.
