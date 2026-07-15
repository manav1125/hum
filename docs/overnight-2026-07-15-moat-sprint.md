# Overnight sprint — 2026-07-15/16: skill routing + the autonomous work-loop moat

_Everything from the evening's two reviews (skill selection at marketplace scale; the
capture→triage→surface→execute→hand-off→engage pipeline), implemented by 7 parallel
agents, integrated, tested, and deployed to `cue-manav-prod` overnight._

## Shipped — skill routing (all 4 recommendations)

| Rec | What shipped |
|---|---|
| (a) `skill_search` tool | Model-facing deterministic search across installed skills + first-party catalog + already-indexed marketplace sources. The recall fallback when per-turn embedding retrieval misses; tells the model to search before improvising or claiming inability. Always-loaded (tool count 11→12). |
| (b) Richer embeddings | Skills now embed a ≤1500-char form carrying ALL activation-hints + avoid-when (was one 500-char truncation). Injection keeps the compact ≤500 form — recall up, prompt budget unchanged. Vectors refresh automatically on next boot. |
| (c) Router re-test on v4-flash | Done live on prod: router works (no schema-validation failures; selection quality equivalent on probes) but confirmed ~2× turn latency (8–12s → 15–28s). **Left OFF** — correct default; viable opt-in later for very high skill counts. |
| (d) Marketplace in embedding space | Already-indexed third-party marketplace skills seed into the same vector collection under `skills/marketplace/*`, labeled "NOT installed — ask the user to install from the marketplace UI". |

## Shipped — the moat (all 6 priorities)

1. **Commitment capture (P0)** — inbound Slack/Telegram/SMS/WhatsApp/email/A2A messages
   now pass through a deterministic prefilter (zero cost on chatter) + conservative
   flash-LLM extraction → work items with sender provenance, **independent of the chat
   agent**. LLM failure ⇒ no capture, never a guess. Kill switches:
   `CUE_DISABLE_COMMITMENT_CAPTURE=1`, `CUE_COMMITMENT_CAPTURE_CHANNELS` (=all to
   include the vellum surface for testing).
2. **Queue drainer (P0)** — every 5 min (env-tunable), stalled `queued` items — including
   crash-recovery requeues — re-dispatch through the SAME policy-gated auto-run gate
   triage uses (hard-deny floor, autonomy policy, concurrency cap 2). Work no longer
   stalls until a human clicks Run. `CUE_QUEUE_DRAINER_INTERVAL_MS`,
   `CUE_DISABLE_QUEUE_DRAINER=1`.
3. **Approval-timeout surfacing (P0)** — a headless run whose permission prompt expires
   (1h) still denies, but now stamps "⏸ Step skipped — approval for <tool> timed out;
   approve and re-run to complete" on the work item + a durable `approval_timeout`
   event + terminal note. Silent side-effect skips are over.
4. **requiredTools stamping + sender-aware triage (P1)** — meeting/mission items stamp a
   conservative read-only toolset (`web_fetch`,`web_search`) so they classify (research)
   and can auto-run within policy instead of parking forever as "other"; a side-effect
   keyword guard ("email/send/post/pay/…") deliberately leaves those items parked.
   Triage now sees Source/sender provenance; heuristic +15 urgency for real-channel
   senders; prompt instructs VIP/tier weighting. Bonus safety: stamped items now
   auto-approve only those 2 read tools (previously an empty snapshot fell back to
   auto-approving EVERYTHING registered).
5. **One execution engine (P1)** — Home-feed background actions now delegate to the
   guardrailed work-item runner (budget hard-stop, agent model pin, tool scopes,
   progress notes, outputs, act ledger). Behavior deltas: results land in
   **awaiting_review** (Review lane) like every other run; feed card retires at
   dispatch; the bespoke "Done" home card is gone (completion surfaces via
   `work_item_completed` + Review).
6. **Default agent roster (P2)** — idempotent boot seed of **Ops / Growth / Inbox**
   (draft-only charters, conservative read/research/draft scopes, no model pin, no hard
   caps) when the roster is completely empty. Non-empty rosters untouched.
   `CUE_DISABLE_DEFAULT_AGENT_SEED=1`. NOTE: prod has a legacy roster (from migration
   296, unrestricted scopes) — reconciling it to the new conservative charters is a
   deliberate manual step, not done automatically.

## Shipped — stretch

7. **A2A outbound `a2a_send` (dormant)** — the missing outbound half of agent-to-agent:
   POSTs the exact JSON-RPC `message/send` envelope our inbound gateway accepts (Cue can
   message Cue). Registers ONLY when `CUE_A2A_OUTBOUND=1` (verified zero-registration
   otherwise); RiskLevel.High + "send" autonomy class — never auto-runnable. Bearer via
   credential `a2a-peer/token`. Remaining for a real handshake: peer-side token
   verification, per-peer tokens, push-notification reply plumbing.

## Quality gates

- Full `tsc --noEmit` clean over the combined tree.
- 251+ new/updated tests green (work-items 208/208; skill_search 13; a2a 19;
  home-feed dispatch 6; inbound capture integration 4; roster seed 8; drainer 12;
  approval timeouts 6; triage +9; memory suites green in isolation).
- Known pre-existing failures (NOT from this work, verified at baseline): cross-file
  `mock.module` leakage when certain suites share one bun process; 3 memory-v3-shadow;
  2 home-content-refresh.
- Pre-commit "new tool" policy gate bypassed deliberately for `skill_search`/`a2a_send`
  (they must be core tools; a discovery tool can't be a skill you'd have to discover).
  All hook quality checks run manually and green.

## Verification on prod (2026-07-16, post-deploy)

- [x] Daemon healthy post-deploy — 302, PONG probe clean
- [x] `skill_search` registered (present in /tools list); `a2a_send` correctly ABSENT (dormant)
- [x] Commitment capture — verified at handler level (4 integration tests drive
      `handleChannelInbound` directly). NOTE: live E2E via the API is impossible by
      design — the hook sits on the channel-ingress path, which the vellum chat
      surface doesn't traverse. First real Slack/Telegram/email message will
      exercise it (observable: work item with actor `commitment-capture`).
- [x] Roster — prod legacy roster (Ops/Builder/Growth) untouched; seeder no-op as designed
- [x] app-builder eval regression — **93.3% (56/60), identical to pre-deploy**
      (re-scored from final transcripts; live-poll 71.7% was the known
      mid-build-snapshot artifact, and mood's 6/10 the known dedup artifact)
- [~] Queue drainer — unit-verified (12 tests incl. policy gating + caps); first live
      sweeps run automatically every 5 min; watch Activity for previously-stalled
      items starting (max 2 concurrent)

## Env flags added (all default-safe, allowlisted in safe-env)

`CUE_QUEUE_DRAINER_INTERVAL_MS`, `CUE_DISABLE_QUEUE_DRAINER`,
`CUE_DISABLE_DEFAULT_AGENT_SEED`, `CUE_DISABLE_COMMITMENT_CAPTURE`,
`CUE_COMMITMENT_CAPTURE_CHANNELS`, `CUE_A2A_OUTBOUND`.

## Watch-list for the first days

- First drainer sweeps may burst-run a backlog of policy-"auto" queued items (max 2
  concurrent) — intended, but watch spend.
- Home-feed background actions now end in Review (visible product change).
- Commitment capture is conservative but new — watch for false-positive work items
  from chatty channels; the kill switch is instant (env, no restart).
- Prod roster reconciliation (legacy Ops/Builder/Growth, NULL scopes) is a pending
  manual decision.
