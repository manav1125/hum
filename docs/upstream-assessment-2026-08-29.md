# Upstream window 2026-08-16 → 08-28: complete assessment

Companion to `upstream-wave-g-2026-08-29.md`, which covers what was built.
This one covers **what was assessed and what it found**, because the first pass
got the method wrong and the correction is the more useful record.

---

## Method, and why the first attempt was wrong

The first pass read 615 commit **subject lines** and triaged ~40 as candidates.
Subject lines are not evidence — a `fix(windows)` commit routinely touches
shared code, and our tree has relocated files (`persistence/` → `memory/`) so
even path equality is a bad proxy.

Redone by bucketing every commit by the paths it actually touches, then
matching those paths against our tree by both path **and basename**:

| | |
|---|---|
| Commits in the window | 615 |
| Touch code we carry | 374 |
| Touch server / shared-package **source** | 298 |
| At least one touched file present here | **271** |
| Genuinely not applicable | 27 |
| Originally triaged | ~40 |

The filter was validated against two manual findings before being trusted: it
independently agreed that the embeddings EPERM fix **applies** and the worker
evictor fix **does not**.

---

## What the proper assessment found

Eight bugs we had (seven fixed, one reverted pending a decision), none of which the subject-line pass surfaced. Five of them
cluster: **an approval or a piece of state that is dead, or never delivered,
with nothing telling anyone.**

### The approval-delivery cluster

**Approvals raised in a queued turn were emitted into nothing.**
A message arriving mid-turn is queued and drained later. Only `processMessage`
binds the conversation-level sender to the hub; the drain bypasses it, so a
drained turn inherited the no-op the previous turn's cleanup left behind. The
`PermissionPrompter` reads *that* sender. Every approval-gated tool in a drained
interactive turn raised a confirmation into a void and auto-denied at the 300s
timeout.

This is a strong candidate for the root cause of the dropped-approval incident
that survived all three repair passes — those fire on state transitions, and
this never emitted at all. Our own tree already documented the mechanism: the
`/compact` drain carries a comment explaining `sendToClient` is a no-op after an
interactive turn, and works around it locally. Nobody generalised it.

**A restart left dead requests with live cards and silent requesters.**
Boot bulk-expired past-deadline requests including persistent kinds. That flip
fans out nothing — no card withdrawal, no requester notice. The request was dead
in the database while its card stayed clickable and the person waiting was never
told. The 60s sweep already owned that fan-out; boot was doing it behind the
sweep's back.

The bulk flip existed because readers treated `pending` as a claim of liveness.
Three now read the clock instead.

### The subagent pair

**Saving a watched file killed mid-task subagents.** Reload eviction decided on
`isProcessing()` alone, and async spawn leaves a parent idle between tool calls.

**And the first fix only moved it.** Marking the parent stale stopped the sweep,
then the rebuild-on-next-access disposed it and aborted the children anyway.
Same death, relocated from file-save to next touch. Caught only by reading the
follow-up commit — the single clearest argument for reading the whole set.

### Privacy and secrets

**A non-guardian on the first-party console is shown personal memory.**
*Found, fixed, then reverted — a decision is owed.* The gate blocks "remote and
untrusted" and treats `vellum` as not-remote. But `vellum` is the console a
trusted contact can sit in. Message history seventy lines away is gated on
guardian class alone, so the two predicates disagree on exactly that actor and
the permissive one decides what gets injected.

Switching the gate to read the class closes that, and denies more besides.
`fallbackTurnTrust` synthesises `{ trustClass: "unknown", sourceChannel:
"vellum" }` for any turn that never resolved an actor, so the same value stands
for two different situations: an unrecognised sender on a channel, and an
internal turn with nobody attached. Denying the first is the point; denying the
second silently drops NOW.md, PKB context and the memory blocks from ordinary
internal paths.

Separating them means the fallback must stop asserting a class it has not
resolved — a trust-model change whose blast radius reaches the admission floors
that also read `unknown`. That is a decision, not a port, so the change was
reverted rather than left half-understood on the branch.

Worth noting the loosening was itself deliberate: a comment records it, made for
prefix parity on reload. Parity survives either way, since both sides read the
same gate.

**Gateway log redaction had drifted off the canonical secret list.**
The gateway kept its own copy of the patterns while the shared list grew.
OpenRouter, Fireworks, Slack app tokens, Linear, Notion, PyPI, Perplexity,
Tavily and PEM private keys were all unredacted in gateway logs — and OpenRouter
is the production brain credential, so the format most likely to appear in a
provider log line was the one not covered. The list's own header already claimed
to be the single source of truth for log redaction; it lived where the gateway
could not import it.

### Delivery

**A Slack Socket Mode connection that stops delivering was undetectable.**
Not a disconnect — those recover. A socket that stays OPEN and delivers nothing.
No ping, no idle timer, no connect deadline; the only recurring timer in the
module was an hourly dedup sweep, and recovery waited on a `close` event a
half-open socket never fires. The readiness probe checks credentials and
`auth.test`, neither of which asks whether anything is arriving — so the product
reports Slack healthy throughout. Upstream measured eleven and a half hours.

`forceReconnect` already existed for half-open connections; it was only ever
triggered by the sleep/wake detector.

---

## Assessed and deliberately not adopted

- **Per-contact auto-approve threshold** (`65007aa1cf` + `c95fed6967`) — stores a
  per-contact ceiling and lets it lift sandbox bash for a named contact. An
  autonomy *widening*, against the post-rogue-send posture. A product decision,
  not a bug.
- **MCP tools defaulting to medium risk** (`bd79e07976`) — upstream measured
  connectors prompting on 89–100% of calls. Real usability problem, but it is a
  security-relevant loosening and belongs to the same family as the never-adopt
  entry about defaulting plugin MCP servers to low.
- **Flux managed voice** (`553dd112f3`, `48526e7162`, `9677123be2`) — SaaS-coupled,
  and the third voice architecture upstream has shipped since our fork.
- **Anthropic `pause_turn` resume** — 573-line refactor of a provider dormant here.

## Verified as already present

Refuse-delete-credentials-in-use, refresh-providers-on-credential-rotation, the
daemon port-occupied guard, and the conversation evictor in workers (ours runs
in-process, so upstream's fix does not apply).

---

## Decisions, resolved 2026-08-30

**Personal-memory gate — narrow reading, shipped.** Denies a resolved
`trusted_contact` on every channel; `unknown` on `vellum` stays admitted
because `FALLBACK_TURN_TRUST` synthesises that exact value for turns with no
resolved actor. Closes the reported hole with no blast radius on internal
paths. The broad reading still needs the fallback to stop asserting a class,
and that remains a separate trust-model change.

**Per-contact auto-approve threshold — not adopted.** Wrong order. This wave
found four controls that claimed to constrain and enforced nothing; adding a
*widening* control before the constraining ones are observed working in
production is backwards, and the rogue-send scar was precisely a trust path
clearing a gate it should not have. Revisit after this ships.

**MCP tools defaulting to medium risk — not adopted, and the measurement
reversed the recommendation.** Upstream's case is that connectors prompt on
89–100% of calls. Ours do not. Across 8,853 real invocations on prod
(2026-06-14 → 08-30):

| | total | low | medium | high | denied |
|---|---|---|---|---|---|
| MCP (`mcp__*`) | 800 | 785 | **0** | 15 | 30 (3.8%) |
| built-in | 8,053 | 6,852 | 713 | 488 | 922 (11.4%) |

Our MCP tools already resolve to **low** 98% of the time. Upstream's fix
raises a floor that is too high for them; applied here it would raise ours
from low to medium and *increase* prompting. We do not have their problem,
and adopting their fix would import it.

Where our friction actually is, from the same table: `bash` 563 denials of
2,467 (23%), `file_write` 194 of 734 (26%), `file_edit` 121 of 392 (31%).
That is the same shape as the earlier unattended-denials finding, and it is
a built-in-tool problem, not a connector one.

---

## Outstanding, in priority order

1. **In-turn approval prompts go to the shared room, not the guardian's DM**
   (`a6f6234169`). We have no `guardian-channel-delivery.ts`; needs re-homing.
   Adjacent to the group-room lane guard now shipped.
2. **`de25f3203b`** dangling concept-page links — silent structural corruption
   of the memory corpus. Upstream's version lives in a directory layout we do
   not share; a re-homing exercise rather than a port.
3. Slack threading and backfill correctness: `5f98f27583`, `74ca7860b2`,
   `650989bb65`, `acf2d3e401`, `0b33b4b2d6`. Deprioritised — Slack is not in
   use on this instance (see below).
4. **The remaining exhaustive `mock.module` factories.** 436 were fixed on the
   four modules that caused every import-time failure; roughly 2,600 remain on
   other modules. Each is inert until someone adds an export, then it breaks a
   suite silently.

### Closed

- **The personal-memory gate** — shipped narrow.
- **Retrospective no-findings loop** (`c17bbf8835`) — shipped. `WakeResult` now
  carries the loop's terminal exit reason, which it already computed and threw
  away, so the gate reads the run's shape instead of byte-matching a sentence.
- **Verification codes redeem in group rooms** (`e40ede5b8b`) — shipped, and
  the session is retired rather than merely refused. **The stated blocker was
  wrong**: `chatType` was already on the canonical event and already normalized
  by Slack, Telegram and WhatsApp.
- **`7cfc7e3bd9` classify-once** — **already true here.** `executor.ts`
  classifies before the gates and `classifyRisk` is LRU-cached on
  (tool, input, workingDir), so the permission checker's call is a hit. Our own
  `8d283faaec` reached upstream's behaviour independently. What remains of the
  upstream commit is refactor shape on a heavily diverged file, with no
  behavioural gain — declined.
- **`997697e0d2` needsAttention filter** — shipped. Applied in the query, with
  the predicate exported from the attention store rather than reconstructed.
- **`289c6eb188` character-bounded file reads** — shipped. The 2000-line cap
  bounded nothing on a single-line file and the on-disk guard is 100 MB;
  verified against the real tool, a 3 MB single-line file now returns 100 KB.
- **`498c008ea8` stale-lock** — shipped, and reshaped. Ownership is now decided
  by `kill(pid, 0)`, not a `ps` probe: the embed-worker scar is exactly a
  singleton guard that forked `ps`, and forking fails first under memory
  pressure. Age is kept as the PID-reuse escape hatch.
- **Plugin `config.json` lost across upgrades** (`dc2726327d`) — was already
  fixed during the wave (`0ac96f13b4`).
- **Channel readiness "is anything arriving"** — not built, on evidence. Prod
  holds zero Slack conversations and one inbound Slack event ever (2026-06-20),
  so a recency probe would report a silence that means nothing. The
  socket-liveness half self-heals within 10 minutes.

---

## Test integrity

The suite's failing count was partly fiction. 155 tests across ten files had
**never run once** — each threw at import because its own exhaustive
`mock.module` factory omitted an export its import graph needed, and each was
counted as a known baseline failure.

Full per-file runs, measured end to end:

| | failing files |
|---|---|
| branch, before this work | 84 |
| after the ten recoveries + 436-factory sweep | **66** |

apps/web: 568/568, including the two long-standing flakes. Gateway typechecks
and every touched suite is green.

One of the ten was self-inflicted and is the clearest illustration of the
hazard: adding `getConversationAgentId` to `conversation-crud` broke
`background-workers-disk-pressure`, and the earlier baseline-set diff missed it
because that file was already red for unrelated reasons.

---

## The pattern worth keeping

Six of the eight bugs share a shape: **a mechanism that had already been built
correctly somewhere, and a second path that did not use it.**

- `forceReconnect` existed — only sleep/wake called it.
- The expiry sweep owned the fan-out — boot expired behind its back.
- The evictor knew to protect live subagents — the reload path did not ask.
- `isRequestExpired` existed — three readers did not call it.
- `process-message` bound the sender — the drain did not.
- The secret list called itself the single source of truth — the gateway kept a copy.

That is not a coincidence, it is what divergence looks like from the inside. The
cheapest way to find the next one is to look for a correct predicate with fewer
callers than it should have.
