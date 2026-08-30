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

Eight bugs we had, none of which the subject-line pass surfaced. Five of them
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

**A non-guardian on the first-party console was shown personal memory.**
The gate blocked "remote and untrusted" and treated `vellum` as not-remote. But
`vellum` is the console a trusted contact can sit in. Message history seventy
lines away is gated on guardian class alone, so the two predicates disagreed on
exactly that actor and the permissive one decided what got injected.

The loosening was *deliberate* — a comment recorded it, done for prefix parity
on reload. Parity still holds; both sides now agree at deny.

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

## Outstanding, in priority order

1. **Retrospective no-findings loop** (`c17bbf8835`). A run that correctly
   concluded there was nothing to save only counted if its reply was
   byte-identical to `"Nothing new to save."`. Any other phrasing was recorded a
   failure, the cursor never advanced, and the window re-queued **forever**.
   Upstream measured 55 of 73 correct replies failing this way in one workspace
   day; with an open-weight brain ours is likely worse. Not a quick fix: the safe
   version reads the *shape* of the run (text reply, no memory write attempted,
   loop ended on the model-driven stop), which needs the terminal exit reason
   plumbed through `WakeResult`. The cheap 2-of-3 version would advance the
   cursor over windows a truncated run never reviewed, which is silent data loss.
2. **Verification codes redeem in group rooms** (`e40ede5b8b`). A guardian code
   pasted into a Slack channel or Telegram group redeems there after being shown
   to everyone, and stamps that room as the guardian binding. We carry no
   conversation-shape signal on inbound events at all, so the normalizers need
   plumbing before a lane guard can exist. Guardian-binding hijack path.
3. **`7cfc7e3bd9` classify each tool invocation once, before the gates.**
   254-line refactor of `permissions/checker.ts`, heavily diverged here.
4. **In-turn approval prompts go to the shared room, not the guardian's DM**
   (`a6f6234169`). We have no `guardian-channel-delivery.ts`; needs re-homing.
5. **Channel readiness should ask whether anything is arriving** — the socket
   half is fixed; the reporting half still answers from credentials + auth.test.
6. **Plugin config.json lost across upgrades** (`dc2726327d`) — host-owned runtime
   state overwritten by the pin.
7. **`289c6eb188`** bound file reads by characters, not lines.
8. **`de25f3203b`** dangling concept-page links — silent structural corruption of
   the memory corpus. Upstream's version lives in a directory layout we do not
   share; a re-homing exercise rather than a port.
9. **`498c008ea8`** local-mode ownership-verified stale-lock breaking — same
   family as the embeddings EPERM fix.
10. Slack threading and backfill correctness: `5f98f27583`, `74ca7860b2`,
    `650989bb65`, `acf2d3e401`, `0b33b4b2d6`.

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
