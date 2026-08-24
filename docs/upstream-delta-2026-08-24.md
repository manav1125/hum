# Upstream delta — 2026-08-24

`c0c2f8d0ce..upstream/main` = **298 commits, 2026-08-14 → 2026-08-24** (tip `0b02d01663`).

This is exactly the unreviewed range: both `upstream-ledger-2026-08-16.md` and
`upstream-four-features-2026-08-17.md` read upstream at tip `c0c2f8d0ce`, so nothing here
overlaps them.

**Research only — no code was merged, cherry-picked, or written.**

## How to read the confidence marks

Same convention as the ledger and the four-features doc.

| Mark | Meaning |
|---|---|
| **[tree]** | Read in our source on `cue/voice-replatform`. Trust it about us. |
| **[up]** | Read in the upstream tree at `upstream/main`. Trust it about upstream. |
| **[prod]** | Queried against the live instance `cue-manav-prod`. Trust it about our data. |
| **[inf]** | Inference. **Check before acting.** |

---

# 1. The companion

Read first because a live session is working on the companion now. The headline is not a
feature list — it is that **upstream and we have moved in opposite directions**, and that
is worth knowing before more is built either way.

## 1.1 The divergence, stated plainly

**Upstream shipped the companion to everyone.** `64e3eead68` (2026-08-20) deletes the
`companion-surface` flag outright. The tray preference is now the only thing that decides
whether the surface appears, and the surface is introduced with a four-beat coachmark tour
the first time a user meets it. [up]

**We classify the companion as legacy and have already replaced it.** From our own
`desktop-surface-flags.ts`: [tree]

> The legacy always-on orb, **which the corner replaces**. Yields to the corner whenever
> the corner is on.

`isCompanionEnabled()` returns `false` whenever `isCornerEnabled()` is true, and the
comment explains why the yield is unconditional: the stored flag is sticky, so an install
that switched the companion on before the corner existed would otherwise run both panels
at once the day the corner shipped.

So the two products answer the same question differently:

| | Upstream | Cue |
|---|---|---|
| The surface | Always-on companion, GA to everyone | Corner: one exchange summoned with ⌥C, then finished |
| The other one | — | Companion, explicitly legacy, force-off when the corner is on |
| Gate | No flag; tray preference only | `desktop-corner` / `desktop-companion` client flags |

**This is a decision to make, not a bug to fix.** Upstream betting on an always-present
creature and us betting on a summoned, transient surface are coherent, different products.
The reason it matters right now is that the companion code the other session is touching is
on the losing side of our own bet, and roughly a fifth the size of upstream's:

| | Ours [tree] | Upstream [up] |
|---|---|---|
| macOS window | `companion-window.ts` 316 | `companion-window.ts` 1249 |
| Renderer surface | `companion-page.tsx` 204 | `companion-surface.tsx` 1640 |
| Bridge / mirror | `companion-bridge.ts` 60 | `use-companion-mirror.ts` 265 |
| Introduction | — | `companion-intro.tsx` 284 |
| **Total** | **580** | **3438** |

If the plan is to invest in the companion, upstream has done ~6× the work and the sections
below are worth mining. If the plan is the corner, most of this is reference for the
*class* of bug a floating always-on-top surface has, which the corner has too.

## 1.2 The five bugs a floating surface has, and how upstream fixed them

These are worth reading even on the corner path: every one is a property of an
always-on-top, frameless, drag-by-its-own-body window, which is exactly what the corner is.
[up] for all five.

<!-- generic-examples:ignore-next-line — reason: 5640545962 is an upstream commit SHA that happens to be all digits, not a phone number -->
**An abandoned drag bricks the surface** (`5640545962`, JARVIS-1539). The surface is its own
drag handle, so a press on the avatar is a grab until the hand moves. That press ended only
on `mouseup` on the canvas or the pointer leaving it — and neither event reaches the window
when the button comes up over *another app*. A fast drag outruns a window moved one IPC
message at a time, so the release lands where the page is not. The press then never ends:
every later move is read as a drag frame, the surface chases a pointer with no button held,
and the first move after the pointer returns carries the whole distance travelled in
between. Hit-testing never resumes either, so the window stays clickable across a canvas
many times the size of the pill and **swallows presses meant for whatever is behind it**.

**A custom avatar cannot drag it** (`4e9f21339f`, JARVIS-1547). The two avatar branches
render different things — a composed creature of SVG and divs, or a bare `<img>` for an
uploaded avatar. An image is natively draggable, so pressing one starts the platform's own
HTML5 image drag, which takes the pointer and ends the mousemove stream the surface's drag
runs on. Fix needs **both** `draggable={false}` and `-webkit-user-drag: none`, because
WebKit honours the CSS on paths where it ignores the attribute.

**It could not be dragged to the top of the screen** (`c634722e1d`, JARVIS-1548). Confirmed
against the window server rather than guessed: macOS declines any window origin above the
top of the work area, whatever the window level. With the avatar pinned to the centre of a
584pt canvas it could never get closer to the top than half of it — it stopped 270pt short,
and the clamp was asking correctly and being overruled. The canvas only ever needed the
card's height on the side the card grows into, so it is asymmetric now.

**Growing leftward teleported it** (`db9392ef4e`, JARVIS-1582). Dragging toward the right
edge made the surface jump, spuriously highlight controls, and stop responding to drags.
Growing leftward is two halves — anchor by the right edge, and mirror the row so the avatar
lands on the point main positioned the window by. An earlier refactor wrapped the avatar and
body in a row of their own, so `flex-row-reverse` on the surface had a single in-flow child
and ordered nothing. The avatar drew 128pt from where main believed it was, and up to 316pt
in the card.

**The introduction leaked click-through** (in `64e3eead68`). The intro card is hit-tested as
part of the surface, so a pointer resting on it leaves the window clickable. Skip, "Got it",
and an incoming call all remove the card from under that pointer *without a mouse-move*, so
nothing recomputed the hit-test and the window stayed clickable across the whole canvas.

**The pattern across all five:** an always-on-top window that is wrong about its own
geometry or hit-test does not merely look wrong, it **eats the user's clicks in other
applications**. Three of the five failed that way. Any of our floating surfaces — companion
or corner — should be checked against that specific consequence. [inf]

## 1.3 The two ideas worth stealing regardless of which surface wins

**Show a turn in flight on the surface** (`659e3eaaaa`, JARVIS-1540). Upstream's creature had
its working pose wired to a live-voice session's phase *and nothing else*, so every turn that
was not a call left the avatar sitting inert, and the only way to learn whether anything was
happening was to open the card and read it. The window that owns the conversation now
publishes whether a turn is in flight, and the surface draws it as a ring travelling around
its own edge — travel rather than another pulse, because the resting surface already has a
pulsing glow and the two must read as different things from the corner of an eye. [up]

**Approvals raise the app window** (in `f2f4714da6`) — **this one is ours to take.** Upstream's
reasoning, verbatim in spirit: a confirmation is the one thing the assistant cannot get past
on its own, and the card that answers it is drawn in the app's window. The turn that raised it
need not have started there — a message typed on the companion is sent from a surface floating
over whatever the user is actually working in, and a scheduled run is started by nobody at all.
In both cases the request lands in a window that is behind something else, and **the assistant
reads as having gone quiet when it is in fact waiting.** Their fix routes the confirmation
handler through the same `ensureMainWindowVisible` seam the voice first-run card already uses.

This is a candidate root cause for the open item in `cue-approval-delivery-recovery`: an
approval that was delivered, never seen, and outlived three repair passes because every one of
them fires on a transition a stuck user never makes. If the card was rendered into a window
behind another app, every server-side check would correctly report it as delivered. **[inf] —
worth checking directly before believing it**, but it fits the shape of what we saw.

## 1.4 Two smaller judgement calls upstream made

**Arrive at medium, not large** (`f2f4714da6`). "The default is the size an uninvited guest
turns up at" — `large` is an 88pt disc landing on top of whatever the user was working in.
A stored choice is never overridden. [up]

**Drop the call timer** (`9225cd4997`). The running call drew an elapsed clock, "which made
the surface read like a phone call that was costing something". The status line and working
ring already say what is happening; the clock only said how long you had been on the hook
for it. [up]

## 1.5 What I would tell the companion session

1. **Check the strategic question first.** Our tree says the corner replaces the companion.
   Upstream just made the companion GA. Whichever way that lands, both surfaces should not
   be built at once, and our flag logic currently guarantees the companion loses.
2. **Take §1.2 as a checklist for the corner**, not just the companion — abandoned drag,
   native image drag, top-of-screen clamp, mirrored-growth anchoring, and hit-test recompute
   after removing an overlay. Three of those five ended in stolen clicks.
3. **Take the approvals-raise-the-window change on its own merits**, independent of which
   surface wins. It is small, it is in a seam we already have, and it may be the open half of
   the dropped-approval investigation.

---

# 2. Risk and permissions — one bug here is ours today

## 2.1 The audit trail records a placeholder risk level on every gate denial

Upstream `7cfc7e3bd9` (LUM-3159, LUM-3165). Their description of the bug is a description of
our code: [up]

> The executor seeded `riskLevel = "low"` and only replaced it inside `checkPermission`,
> which runs after the gates. Every audit row written before that point carried the
> placeholder … Byte-identical bash calls therefore audited as `denied low` when a gate
> blocked them and `allow high` when they got past it.

**We have it.** [tree] In `assistant/src/tools/executor.ts`:

| Line | What happens |
|---|---|
| 65 | `let riskLevel: string = RiskLevel.Low;` — the placeholder |
| 136 | that placeholder is passed into `checkPreExecutionGates(...)` |
| 211 | `riskLevel = permResult.riskLevel;` — the real value, *after* the gates |
| 219 | permission denials ledger from here, so they carry the true level |

So the split is precise: **denials from the permission checker are honest; denials from the
pre-execution gates all record `low`.**

It is visible in production. [prod]

```
denied rows by risk_level:   medium 409 | high 345 | low 75

the 75 low ones, by tool:    COMPOSIO_MULTI_EXECUTE_TOOL 13,  bash 12,  skill_load 9,
                             recall 5, notifications_send 4, file_read 4, app_open 4 …
```

**Why those particular rows matter.** A denied `COMPOSIO_MULTI_EXECUTE_TOOL` is the Composio
proxy path — the one the model actually reaches Gmail through, and the one
`requiresHumanApprovalForAction` **parks at the pre-execution gate**. Those thirteen rows are
the rogue-send guardrail built after the Alibaba incident doing exactly its job, recorded as
low risk. The twelve `bash` rows are the network-egress guard, same story. The audit trail
systematically understates the danger of precisely the actions we most want a record of, and
"what did Cue block, and how serious was it" cannot be answered from this table today.

**This does not retract the connector-outage evidence.** The `high denied` rows quoted in
`106-normalize-auto-provisioned-composio-risk-level.ts` came through `checkPermission` and
carry real classifications. The blind spot is the gate path, which is a different set of rows.

Upstream's fix also introduces an explicit `unclassified` value for when classification cannot
complete (aborted, gateway unreachable), rather than letting that case read as a level. The
permission check still requires a classification and fails closed. That distinction is worth
keeping if we take the fix. [up]

## 2.2 Risk classification centralized — a real architectural fork

`65dc2a024a` (LUM-3326) puts one `classify_risk` contract in `packages/gateway-client`, has
the gateway validate the request and the daemon validate the response and fail closed, and
**deletes the daemon-side mirror**. `7026d0e8ca` (LUM-3327) follows it: every allowlist ladder
now comes from the gateway, the daemon's per-tool strategies and its URL normalizer are
deleted, and the canonical normalizer moves to `@vellumai/service-contracts/url-normalization`
so both sides agree by construction. [up]

We went the other way this month, adding `gateway/src/risk/connector-risk-classifier.ts`
deriving risk per operation from the verb in the tool name. [tree] Ours is not wrong — it
solved a live outage that a single per-server number could not, in either direction. But it
means upstream's risk subsystem and ours now diverge structurally, and every future upstream
risk change will be harder to read across. Worth a deliberate decision rather than drift.

# 3. The invariant worth adopting even though the bug is not ours

`650989bb65` (LUM-3419): Slack history backfill called `addMessage` with the raw body, so
content that channel ingress refuses — a message carrying a credential — was written verbatim
the first time a DM bound to a conversation, reproducing secrets the sender issued weeks
earlier. Upstream's own `runtime/AGENTS.md` already stated the rule; backfill was simply a
third writer nobody had brought under it. [up]

**We do not have this hole.** [tree] We have `checkIngressForSecrets`
(`assistant/src/security/secret-ingress.ts`) wired into `signals/user-message.ts`, the inbound
stage `secret-ingress-check.ts`, and `conversation-routes.ts` — and no Slack history backfill
writer exists in our tree to bypass it.

What is worth taking is the **stated invariant**, because this failure shape is the one that
keeps recurring for us: the arrival floor running on one leg, the allowlist guard whose
polarity excluded everyone, the arrival relevance gate that did not exist before work-item
creation. All three were a gate that a second code path walked around. Our
`assistant/src/runtime/AGENTS.md` does not currently state a mirroring rule. [tree]

# 4. Trust, credentials, approvals

- **`f5b334c70a` / `b94dbf2e92` — personal-memory gate moved into effective-capabilities.**
  It had re-derived `resolveTrustClass(...) === "guardian"` instead of reading the named
  `canAccessMemory` capability, and being written as a negated channel conjunction rather than
  capability-or-channel, it had drifted out of step with the capability it was supposed to
  mirror. [up] Relevant to the standing ruling that Cue may read everything it knows including
  memories: upstream is drawing that boundary by trust class and arrival channel, and had a
  live drift bug from expressing it twice.
- **`1ae37bb102` — plugin credentials scoped to the plugin's own service.** Ownership is now
  field *or* service matching the plugin name, so a plugin namespacing its own service
  (`imessage/api_key`) can read its key while `openai/api_key` from another plugin stays out of
  scope. [up] Adjacent to our `${credential:service/field}` work.
- **`8370a4ef48` — refuse to delete credentials in use by an LLM connection.** [up]
- **`a6f6234169` — a guardian's own gated prompt is addressed to the guardian**, delivered to
  their bound chat rather than the shared room the turn runs in. [up]
- **`9ee8f20dd9` — a down gateway is unavailable, not a spent token.** Token refresh mapped any
  non-zero CLI exit to 401, so a cold reopen offered "Wake & Repair" for an assistant that only
  needed a plain wake. Connection-refused and 5xx now stay 503; a real 401 stays 401. [up] This
  is the fail-open rule in another costume — an outage must not be reported as a credential
  problem.
- **`fcf0423fcd` — abort startup when the runtime HTTP port is occupied**, matching the
  duplicate-daemon exception already in our `assistant/CLAUDE.md`. [up]

# 5. Voice

- **`4a50ce8fb1` — pin image-bearing voice legs to an image-capable profile.** A photo taken
  mid-call persists inline and is re-sent on every later turn, so the escalated leg answers it
  on whatever `callAgent` resolves to — a profile about to change to a model that *rejects*
  images, failing the whole leg rather than degrading it. Non-front-door legs whose history
  carries an image are pinned to `latency-optimized`, and not pinned at all when that target
  cannot take an image either. [up] Same family as our photo-turn failure; worth checking our
  vision-tier routing against the *re-sent on every later turn* detail specifically.
- **`f531bae4f2` — keep the STT stream open when the provider owns turn-end** (JARVIS-1538).
  [up] Adjacent to the deaf-after-barge-in class we just closed on the client.
- **`e60a5fb3d6` / `f2f4714da6` — Fn chords stop toggling voice mode by default**, with a
  desktop Off option. [up] They hit the same accidental-activation problem we did with the mic
  latching on with nobody holding it.
- **`c41a0c661c` — voice picker inline in chat**; **`b08a978c1a` — voice mode bound to a global
  Talk shortcut.** [up]

# 6. Inference and prompts

- **`feat(config)` — GLM 5.2 is the shipped pin for the managed Balanced profile**, repointed
  from `gpt-5.6-luna` to `accounts/fireworks/models/glm-5p2`, so a managed install lands there
  when LaunchDarkly is off, unreachable, or serving control. `latency-optimized`, `chatgpt` and
  BYOK `openai` stay on luna. [up] We already run glm-5.2 at the advisor tier.
- **`feat(prompts)` — the `01-delegate-subagents` system-prompt section is deleted.** It shipped
  in every conversation including heartbeats and scheduled runs, telling the model delegation was
  "your default, not a last resort" and that "an unnecessary subagent is cheaper than serialized
  work". Upstream's verdict: that framing drives excessive spawning and token burn, and the
  guidance belongs in the subagent skill where it is discoverable on demand. [up] Directly
  relevant to our own prompt weight and the tool-schema pruning work.
- `feat(inference)` — Ollama connections can set a custom server URL; A/B test on the Balanced
  profile's model; several fixes for custom OpenAI-compatible providers (reasoning_content
  round-trip, empty assistant-turn backfill, `tool_choice` omitted in thinking mode for strict
  endpoints). [up]
- **`fastcrw` as a `web_fetch` and `web_search` provider.** [up]

# 7. Platform and product

- **Windows is now a real client**: attended desktop presence, native dictation with escape
  cancel, app menu in the title bar, computer use in local dev builds, Windows auth and
  Tailscale in the CLI, permission applicability reporting. Not our platform, but it is where a
  visible share of upstream's effort went this week. [up]
- **iOS**: a Shortcuts action to send a message to a specific chat (LUM-3230), and deep-link
  provenance so intent-originated prompts auto-send (LUM-3281). [up] Adjacent to our magic-link
  hand-off work.
- **Channels**: each channel declares how visible a conversation is; stored channel metadata is
  normalized on read (LUM-3331); **a channel reports whether its socket is actually receiving**,
  and Slack Socket Mode detects its own dead connection. [up] That last pair is the honest-status
  problem we hit when every connector surface reported healthy while eight MCP servers 401'd.
- **Conversations**: `GET /v1/conversations` filtered to foreground rows (LUM-3323) and a
  `needsAttention` filter (JARVIS-1541) built on the same `unseenAttentionStateConditions` the
  unread count and section index already use, "so every reader of 'needs attention' agrees" —
  and applied through one helper shared by list and count so a page and its `hasMore` describe
  the same set. [up] Directly comparable to our needs-you badge.
- **Web**: 115 commits, of which only ~15 are i18n or Figma-matching. The rest is substantive —
  per-conversation delete, inline assistant switcher, billing reorganised into Payment
  Methods / Credits / Invoices, the mobile attach sheet handing off to the native picker,
  paired-devices list and revoke behind a flag, conversation forking behind a staff flag, a
  timeline for Earlier activity, and sidebar section caches windowed for performance
  (LUM-2444). [up]
- **Flags GA'd**: assistant-switcher and web-remote-ingress gates removed; plugin-schedules on
  by default. [up]

# 8. Verdict

| | Item | Why |
|---|---|---|
| **Take** | §2.1 risk placeholder on gate denials | Ours today, verified in prod, and it degrades the audit trail behind the guardrail built after a real incident |
| **Take** | Approvals raise the app window (§1.3) | Small, uses a seam we have, candidate root cause for the open dropped-approval item |
| **Consider** | §5 image-bearing voice legs | Same family as a defect we hit; check the re-sent-every-turn detail |
| **Consider** | §6 delete the delegate-subagents prompt section | Prompt weight and spawn discipline |
| **Consider** | §3 state the ingress-mirroring invariant in our AGENTS.md | The bug is not ours; the recurring failure shape is |
| **Decide** | §1.1 companion vs corner | Upstream GA'd what our flags call legacy |
| **Decide** | §2.2 risk centralization | We forked deliberately; acknowledge it or converge |
| **Ignore** | Windows, i18n, Figma-matching web work | Not our platform or not our design system |

## 8.1 What was done on 2026-08-24, and what was found instead

**Done.**

- **§2.1 risk placeholder — fixed** (`8d283faaec`). Classification moved ahead of the gates;
  the gate handler records `riskLevel` and never compares it, so the audit row changed and no
  decision did. A classification that cannot complete now records `unclassified` rather than
  resolving to a level. Two regression tests, and the lifecycle-events mock for `classifyRisk`
  now honours the abort signal the real function honours on its first line.
- **§3 ingress-mirroring invariant — recorded** (`44d8f62a42`) in `runtime/AGENTS.md`.

**Investigated and found already covered — no work needed.**

- **§5 image-bearing voice legs.** `assistant/src/agent/vision-tier.ts` already routes on the
  exact property upstream's fix turns on, and states it outright: the trigger is scanned "over
  the FULL history, not just the trailing message, because providers serialize every historical
  image into the request … An image pasted three turns ago still breaks a text-only model
  today." It also declines to re-route when the resolved model is not *known* text-only, which
  is upstream's own second-commit caution ("don't pin when the pin target can't take an image
  either") arrived at independently. Ours is the more general form: it covers every agent
  round, not only voice legs. [tree]

**Found, and left as decisions rather than taken.**

- **§6 the delegation framing is ours too.** Not as upstream's `01-delegate-subagents` section —
  we carry the same sentence inside `01-parallel-tool-calls`
  (`prompts/templates/system-sections.ts:462`), including the exact clause upstream removed:
  "an unnecessary subagent is cheaper than serialized work". Upstream's grounds for deleting it
  were that it ships in every conversation including heartbeats and scheduled runs and drives
  excessive spawning and token burn. That is plausible for us — context overflow is a known
  ceiling here — but it is a global change to how the agent behaves and its effect cannot be
  measured from a code read. **Recommend removing the delegation sentence and leaving the rest
  of the parallel-tool-calls section intact.** [tree]
- **Approvals raising the window — the gap is narrower than upstream's, and real.** We already
  call `ensureVisible()` from `notifications.ts`, but only on the notification's `click` and
  `action` handlers: the window is raised once the user has *already noticed*. Upstream raises
  it when the confirmation is raised. For the dropped-approval case — where the user never saw
  it — ours does not help, and a `toolConfirmation` notification that is missed or dismissed
  leaves the card in a window behind everything. **This is a focus-stealing behaviour change,
  so it is a product call, not a bug fix.** [tree]
