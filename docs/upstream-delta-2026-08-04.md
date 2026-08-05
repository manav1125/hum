# Upstream delta — vellum-ai/vellum-assistant → Cue (2026-08-04)

Follow-up to `docs/upstream-delta-2026-07-21.md`. Window: **2026-07-21 → 2026-08-03 (HEAD `f68e27b9dd`), 709 commits**,
plus backfill of pre-window items the last sweep missed. Sources: fresh upstream clone, releases page
(v0.10.9 → v0.11.1), voice-pipeline engineering blog, public roadmap, and a five-agent code dive
(voice / product / gateway-channels / core-loop / Cue-side inventory).

## Headline facts

- **Velocity holds:** ~350–410 commits/week. Six releases since our last sweep: v0.10.9 (Jul 14),
  v0.10.10 (Jul 16), v0.10.11 (Jul 21), **v0.10.12 (Jul 24 — "Voice Mode, live")**, v0.11.0 (Jul 28),
  v0.11.1 (Aug 1). **v0.11.0 and v0.11.1 shipped with no public release notes** — contents
  reconstructed below from the client version-gate table and the log.
- **CORRECTION to the 07-21 doc:** upstream has had WhatsApp since 2026-02-24 (`88a61e3e2d`) — it is in
  our shared ancestor; `gateway/src/whatsapp/` is the same lineage in both trees. We do NOT uniquely
  "lead on WhatsApp"; what's true is upstream barely invests in it (2 hardening commits this window)
  while their Slack got ~38 commits. The 07-21 claim "they have none, not planned" was wrong.
- **Migration counters:** workspace migrations now at **139**, persistence at **360**, gateway data
  migrations still at m0017 (new gateway DDL now rides drizzle-kit push, NOT m-migrations — see hazards).
- **Upstream's own history has holes at the release merges**: `820cf1504f` and `4e21df19f1` repair
  merge-back damage from the v0.11.0/v0.11.1 cuts. Don't trust clean bisects across 07-28 / 07-31,
  and don't diff against release tags (you can reintroduce reverted state).

## The releases (what they announced)

- **v0.10.9:** managed STT/TTS (Vellum-hosted, credit-billed, auto-defaults when no BYOK key);
  GPT-5.6 + prompt caching; mobile touch gestures; plugin marketplace consistency; channel trust
  floors surfaced; app capabilities (push messages, bundled files, live updates); `chat-complex-documents` skill.
- **v0.10.10:** plugins ship apps (library apps from plugins, `plugins~name~dir` id scheme);
  self-improving-skill cards in chat; Settings rebuild (Profile/Version/Appearance, 2FA, Danger Zone,
  Debug tab with terminal); provider-first Providers modal (legacy LLM resolution layer deleted);
  Baseten BYOK (Thinking Machines Inkling); outbound email attachments (Outlook + native).
- **v0.10.11:** "My Superpowers" (skills+plugins one page); managed-TTS voice picker; Kimi K3;
  retry button on last turn; inbound email attachments → workspace; plugin dependency install;
  schedule timezone defaults to user's zone.
- **v0.10.12:** **Voice Mode GA** (blog: cascaded STT→agent→TTS over one WS, front/strong dual model,
  speculative launch, progress narration, gapless synthesis); web search becomes a provider
  (`vellum` alongside Perplexity/Brave/Tavily/Firecrawl/Keenable — mode axis deleted); memory graph GA;
  bookmarks GA; billing restructure (Free/Mighty $30/Super $100/Ultra $200 + custom); Gemini 3.6 Flash;
  archived conversations in search; "Open in Slack".
- **v0.11.0 (reconstructed):** channel access controls (two-level cells), image-gen `vellum` provider,
  inference profiles V2, non-interactive voice turns, provider-first dispatch + migration 133,
  plugin ingress (gateway webhooks for plugins), memory-DB cutover wave 2, Superpowers/Library nav.
- **v0.11.1 (reconstructed):** code-defined read-only BYOK default profiles, subagent detail self-lookup,
  sidebar group icons, docs-site migration Phase 1 (Next.js in `clients/docs`, +35k lines),
  invoices CLI, Windows Electron shell bootstrap, Keenable search.
- **Roadmap:** in progress — **Teleport** (local↔cloud same identity; real flag-gated code exists:
  `clients/web/src/domains/settings/teleport/`, `runtime/routes/migration-routes.ts`, flag `teleport` off)
  and assistant-joins-meetings (**zero code yet**). Planned: iMessage. Explored: Android (already landing),
  incognito chats, multi-assistant, fine-tuning-on-you.

## Voice: the strategic finding

**Our WS-E port implements an architecture upstream has already deleted.** Their old
`decideEndpoint` front-model layer (which our flag-off `liveVoice.frontModel.semanticEndpointing` /
`spokenAcks` mirror) was replaced on 07-22 by the **unified front door** (`4dd58656fe`, `be16df3e63`,
`ff78929883`): there is no separate endpointing LLM call anymore. On a silence boundary the daemon
**speculatively dispatches the real answer leg**; the leg's leading token IS the verdict
(`[0]`=hold, `[1]`+bridge=escalate to strong model, anything else = the answer streams straight to TTS).
Rollback (`VoiceTurnHandle.discard()`) unwinds the persisted user message if speech resumes. Fail-open
commit at 1200ms. All voice flags were deleted upstream — the whole layer is unconditionally on.

Their stack at HEAD, vs ours:

| Capability | Upstream | Cue |
|---|---|---|
| VAD/endpointing | **Server-side** (energy gate + MediaTurnDetector + pre-roll ring) | Client-side (design decision in WS-E) |
| Endpointing intelligence | Speculative front-door launch (no separate decider) | Old decider design, built, flag OFF |
| Spoken acks | LLM-generated only (canned deleted); ack on slow-first-delta AND tool_use_start | Built + wired, flag OFF; **tool-use ack built but no call site emits it** |
| Progress narration | Audio-only via TTS-queue bypass; follows work not clock; injection-fenced | Absent |
| TTS | Server segmentation (eager 60-char first segment) + **2-job prefetch pipeline** | Segmentation yes (180-char), **no prefetch**; gapless playback client-side yes |
| Managed speech | Velay WS relay (Deepgram wire pass-through), auto-default, credit-billed | **Deliberately removed** — BYOK only |
| Voice surfaces mid-call | `minimize_room` after speech drains; latch on non-error tool_result | ui cards web-only; macOS ignores `card` frames |
| Approvals in-call | Sensitive-tool reach prompts user (45s timeout → guardian fallback); reveals room immediately | Present via `local-live-voice` approval mode |
| iOS | Dynamic Island Live Activity (dual driver: local + server-push APNs), Siri handoff, Action Button, WebKit-AEC echo route (do NOT activate own AVAudioSession — regression-guarded) | Capacitor wrap, no Live Activity |
| Android | Native audio-focus plugin + notification status surface + QS tile | Capacitor wrap only |
| STT | Multilingual code-switching (`multi` → nova-3), mid-session language re-dial, Gemini Live AUDIO-modality | BYOK Deepgram-class |
| Barge-in | 250ms sustained + 200ms gap tolerance + duty-cycle ceiling | 250ms client-side (same base number, no gap tolerance) |

**Decision this forces:** flipping our existing flags ships a design upstream abandoned. The unified
front door requires either (a) moving VAD server-side (their whole session state machine keys off
server-observed chunks) or (b) inventing a client→server speech-boundary frame with generation
semantics that the protocol doesn't have today. Recommendation in the program below.

Porting gotchas (from the deep dive): ack/narration "audio-only-ness" is enforced by the enqueue path
(`enqueueFillerPhrase` bypasses `assistant_text_delta` + rawText) — route acks through the delta path
and they persist to transcript. Barge-in constants encode the web client's 50ms PCM batching. The
front/strong split depends on a code-owned `latency-optimized` profile (`gpt-5.6-luna` pin;
BYOK resolves via intent table). iOS echo: TTS must render through
`MediaStreamAudioDestinationNode`+`HTMLAudioElement` (WebKit's voice-processing unit) with
post-capture `restartOutputRoute()`.

## Where Cue already has parity (verified in our tree, don't rebuild)

- **Web search as provider abstraction** — `assistant/src/providers/search-provider-catalog.ts` with
  managed/byok kinds and fallback order. We're ahead of the "mode toggle" era already. (Their new
  `vellum` + Keenable entries are SaaS/keyless additions we can mirror selectively.)
- **Memory graph UI** — `runtime/routes/brain-graph-routes.ts` + constellation view. Different impl
  (kind-colored lobes vs their hand-rolled canvas 3D-yaw concept graph), but the surface exists.
- **Bookmarks** — full stack (migration 242, CRUD, routes, wire types), macOS UI, flag `bookmarks` OFF.
  Missing only web UI.
- **Retrospective + self-authored skills** — retrospective engine + `auto-analyze` flag (OFF) +
  skill scaffold tools all present. Their deltas worth taking: scheduled **sweep** replacing
  disposal-trigger (`0bb410f304`), **user-activity gate** (`ff10e008e1` — big cost lever for
  tool-heavy autonomous turns), skill cards in chat, scripts/ persistence.
- **Crash recovery** — turn-recovery + interrupted-turn reconciler (resume gated on
  `conversations.resumeProcessingOnStartup`), client re-POST. Their deltas: monitor-process stale-flag
  sweep fenced on boot timestamp (`225dadbdc8`), **resume-on-interrupted-generation** (`ddca2df4fb` ⭐).
- **Tool aliasing** — `tools/tool-name-aliases.ts` with resolve + suggest, already consumed.
- **Anthropic prompt caching** — `providers/cache-control.ts` (1h ephemeral TTL).
- **Heartbeat AND the bigger cadence engine** — upstream heartbeat exists in our tree (enabled:false;
  theirs default-on with cap 10/day); our missions/watchers/playbooks/standing-agents/work-loop layer
  is far beyond their heartbeat. Keep leading.
- **Slack/Telegram/Twilio/WhatsApp channels** — all present and rich; Telegram inline keyboards,
  WhatsApp buttons, full calls stack.

## Where we're behind (the pull list)

### P0 — brain reliability for DeepSeek (small, near-standalone, take first)
1. **`6bd29cff2b` StreamContentShadow** — salvage malformed streamed tool-arg JSON into an error
   tool_result the model self-corrects in-turn, + one-shot corrective note on retry (breaks the
   identical-resend failure basin). Files: new `providers/anthropic/stream-content-shadow.ts`,
   `providers/retry.ts`.
2. **`03159facca` thinking-only max_tokens nudge** — when continuation follows a thinking-only stall,
   say "emit the tool call now", not the generic continue. Reasoning-model-specific; directly our class of bug.
3. **`ddca2df4fb` resume interrupted generation** — mid-stream provider death (decode timeout etc.)
   re-issues once instead of dying ten tool-calls into a task.
4. **`3c78ecf620` NaN token normalization** (the code half, not the migration) — NaN slips past `<=0`
   guards, poisons running totals, binds NULL. Audit our `recordUsage`.
5. **`37257a3aef`** tool-result spool threshold 8k→25k chars. Trivial.
6. **`fcfdd797e4`** SQLite planner statistics (PRAGMA optimize mask + post-migration analyze).
7. **Zod tool-input registry mechanism** (`39fd3b48e6`) — failed parse becomes a model-correctable
   ToolError; schema derived from the same Zod source as the advertised input_schema. Take mechanism +
   tranches for tools we have; re-baseline the drift guard.

### P0 — security (audit ours for the same holes, then port)
8. **`c10b47ce3e` prompt-section override = control-plane write.** Upstream's renderer resolves
   `<workspace>/prompts/system/<id>.md` overrides; before the fix a channel contact with a non-none
   cell could auto-approve a workspace write that silently replaces credential-security /
   non-guardian-boundary prompt sections. **Check our workspace-policy predicate covers our prompt
   override dir.** Privilege escalation class.
9. **`89ca052cbe` browser content fencing** — browser_snapshot/extract results wrapped in
   `<external_content>` (our browser tools shipped recently and likely return raw page text; the links
   list was unbounded upstream too).
10. **`b3a58fcc91`** sanitize untrusted slugs/errors in the memory-consolidation prompt.
11. **`c113671f3e` + `4d4e4b4e49`** credential-leak defense-in-depth: inline-secret CLI guard, ingress
    token-shaped-secret block, retroactive transcript scrub, plugin credential key patterns.
    Plus **`ecced08cbb`** Composer Secret Guard (`packages/service-contracts/src/secret-detection.ts`).
12. **Channel `/new` authorization hole** — upstream designed then reverted the fix (`19f67aa8ba`→
    `0bb8ab8cbf`): gateway-terminal commands (`/new`) bypass the `no_one` kill switch and admission
    floor on Telegram/WhatsApp/Slack. **We almost certainly share this hole. Implement independently**
    (their reverted design is the shape: fail-closed, floor applies even with flag off, silent denial).
13. **`60ae291c26` bug class:** config seed running before workspace migrations stamps schema defaults
    that make `if (key in config) return` migration guards bail (upstream: 8% of new assistants stuck
    on memory v2 forever). **Audit our seed/migration ordering** — same class as our own past seed bugs.

### P1 — channel robustness (clean ports)
- **`81ca593474`** orphaned Slack Socket Mode client at boot (double-start via watcher initial polls) —
  duplicate-delivery/resource bug we likely share.
- **`1df54975a6`** WhatsApp webhook Zod (pre-fix: one malformed timestamp crashed the whole batch,
  dropping valid messages). **`cb25910d05`** same for Telegram, **`3482421d98`** for Resend.
- **`af815e4654` + `eed69303ea`** shared retry/Retry-After + exponential-backoff utils.
- **`adcafb2b16`** Slack group DMs (MPIMs) were silently dropped entirely.
- **`4d8037eae4`** single SlackApiError class (dual-class instanceof bug collapsed all errors to generic).
- **`45cc60c86c`** permalink fallback, **`d8e8ac78d0`** channel-mention rendering.
- **`f5846d8ac5`** guardian cards rehydrate decided; **`82c9f62768`** Telegram cards withdrawn in place.
- **`89a766856d`** phone: below-floor inbound callers route to guardian approval instead of silent hang-up
  (matches our safety-floor philosophy — the guardian must know someone called).
- **`c39d632065`** inbound email attachments → workspace. **Verified gap in our tree**: our
  `resend-webhook.ts` declares `attachments?` in the payload type but `email/normalize.ts` never
  handles them. Their `gateway/src/email/attachments.ts` is the port.
- **Slack streaming** (`16c63cec1f`, pre-window) — chat.update-based progressive replies; we send
  single-shot only. Bigger lift, big UX delta on Slack-heavy usage.

### P1 — product quick wins (cheap, user-visible)
- **Retry button on last turn** (`b8c8414ca2` — one file upstream). We have nothing.
- **Bookmarks web UI + flip flag** — server is done in our tree.
- **"Summarize up to here"** (`9c253c5422` + `c69a68847a` tokenizer-accurate counts) — we only have
  whole-conversation `/compact`.
- **Quote reply** (`e4863787d4` GA'd) — absent in ours.
- **Email attachment outbound** for Gmail/native (`ab622f9ab6`, `f9f9f4d9fa`) — advertise in TOOLS.json.
- **Model catalog refresh** — we're a generation behind: no GPT-5.6 (Sol/Terra/Luna), Gemini 3.6 Flash,
  Kimi K3, Grok 4.5, Baseten/Inkling. Also take **`473f1b5a8f`** (`prompt_cache_key` for
  implicit-caching OpenAI models — their telemetry: 156k vs 35k uncached input tokens/turn),
  per-model quirks (Grok reasoning-effort ceiling `6b6658e2f4`, Inkling passthrough `b523e5c166`),
  and **`4539017607` request diagnostics** (per-request URL/model/connection/status/raw error body —
  would have shortened every provider outage we've had).
- **`chat-complex-documents`** — it's just an MCP-wiring skill for Unstructured Transform (no local
  OCR); single directory drop. Note it overlaps our OCR plumbing decision (extracted_text) — this is
  the zero-infra alternative.

### P2 — platform bets (projects, not cherry-picks)
- **Voice unified front door** (see above) — the real WS-E successor. Scope: server VAD (or boundary
  frame), speculative launch/rollback incl. user-message discard, progress narration, TTS 2-job
  prefetch, eager first segment. Our cheap interim wins: wire the existing tool-use ack call site,
  add prefetch, keep flags for the rest until re-platform.
- **Plugin apps + dependency install + publish-consistency** (`570b03a107` family, `ab50447d31`,
  `3231032471`) — our loader has none of the three; `plugins~` id scheme is a wire change.
- **Plugin ingress** (gateway webhooks for plugins, guardian-approved, HMAC-signed, exact-path,
  WS variant) — well-designed fail-closed system. **HAZARD: omit `9efc65cea1`** (exempts
  `signer:"vellum"` routes from guardian approval — in our fork the "vellum" signer is not a real
  platform secret; porting verbatim = authorization bypass).
- **Memory-DB cutover** (attached → dedicated `assistant-memory.db`, migrations 343–349/357–359,
  FK-cascade→hooks) — the structural fix for our 500MB-DB class of problem; take as one project,
  preserve the `dependsOn` graph when renumbering.
- **Discord channel** (`gateway/src/discord/`, 24 files) — their admission model (mention-only +
  operator-listed channels, empty list admits nothing) is worth stealing even if Discord isn't a
  Cue priority.
- **Advisor context pack** (`08d59ec3cd`) — consult gets live tool set, skill catalog, workspace tree,
  open docs, trust-gated NOW/PKB/recall; per-section time-bounded. Fits our advisor tier.
- **Memory ingestion** (`f82d69d8a8`) — ChatGPT-export + foreign-assistant memory.db importers +
  corpus-skim skill. Interesting onboarding/moat angle for Cue too.
- **Teleport-equivalent** — their local↔cloud migration routes align with our hybrid local-daemon plan;
  watch, don't port yet.

## Never merge blindly (updated)

Everything from the 07-21 list still stands (renumber workspace ≥103 — theirs now at 139; persistence
at 360 with intra-upstream duplicate numbers AND named `dependsOn` graphs — preserve edges, not
ordinals; gateway m0007+ table moves; wire-format changes; WorkOS/velay/credits; memory relocation).
New this window:

- **The ~25-commit "Single-source" wire refactor** (`ServerMessage` deleted, envelope renamed
  `AssistantEventEnvelope`, message-types deleted incl. the whole guardian-actions domain
  `237da6522e`, schedules wire protocol `34378f2b2a`, workspace wire protocol `c0e2c9ed77`).
  **Skip the series; build a small compat shim** (`message-protocol` re-exporting from `api`) so
  later event-touching cherry-picks apply. Any post-07-27 pick imports from `../api`.
- **`9efc65cea1`** plugin-ingress vellum-signer exemption (authorization bypass in our fork).
- **`eca09a557c`** guardian recovery from gateway actor tokens — assumes gateway-native contacts;
  structurally wrong for our assistant-DB contacts. Do not port.
- **`bd2aa0b1eb`** channel-cell → sensitive-tool gate composition — WIDENS what non-guardians can do
  in Relaxed/Full rooms and drops the gate's riskLevel param. Audit against our trust model first
  (our rogue-send history says default-deny).
- **`3a7b40a542`** removes `unmappedPolicy`/`defaultAssistantId` from gateway routing/config.
- **`0ace618d12`** IPC framing change — chunked responses truly stream; ignoring them hangs to timeout.
- **Gateway DDL now arrives via drizzle-kit push from `schema.ts`** (`speculative_root_at`,
  `plugin_ingress_approvals`) — if we pinned/replaced `pushSchemaNoPrompt`, these silently won't apply.
- **`7568a85c4e`** brace-style enforcement touches everything post-07-28 — expect diff noise.
- Migrations **351+352** are a create/drop pair for a reverted feature — skip both.
- Backwards-compat gates key on **assistant version strings** (`MIN_VERSION`) — our fork's version
  scheme will always-degrade or always-render; strip or re-key gates when porting client features.

## Where we still lead (don't regress chasing parity)

Multi-user/team control plane (HQ) · mobile v3 native UI · filing/arrivals/valve/signals ·
missions + watchers + playbooks + standing agents with spend caps (their heartbeat is a toy next to
this) · Cue Live screen observation · connector health · WhatsApp investment (shared lineage, our
attention) · marketplace-over-embeddings. Upstream has NO meeting-joining code and no iMessage yet.

## Suggested program

- **Wave A — DONE (2026-08-04, branch `cue/upstream-wave-a`, 10 commits):** all P0
  brain-reliability ports landed (spool 25k, planner stats, NaN tokens, thinking-only nudge,
  interrupted-generation resume, StreamContentShadow, Zod tool-input registry + filesystem tranche,
  browser `<external_content>` fencing incl. our fork-only send-control-guard labels; consolidation
  sanitize N/A — section absent in our fork). All three security audits found real issues, all fixed:
  control-plane workspace writes now classify high (the exposed path was guardian-trust background
  jobs, not channel contacts), the `/new`+Slack-mute admission bypass confirmed on 4 channels and
  closed fail-closed, and the pre-migration config-materialization bug was live (migration 140) and
  is fixed by suppressing config writes during the DB-migration pass. Known baseline (pre-existing,
  NOT from Wave A): `src/__tests__/checker.test.ts` fails 52 tests on this branch's base, and
  combined browser-dir runs carry config-loader mock pollution.
- **Wave B — DONE (2026-08-04, same branch, 10 commits):** webhook tolerant-Zod +
  shared retries + inbound email-attachment ingest (B-1); Slack group DMs / single
  SlackApiError / permalink fallback / mention rendering / socket generation-counting (B-2);
  guardian cards persist + Telegram in-place withdrawal + phone deny-gate hoist (B-3);
  model catalog refresh + Baseten + prompt_cache_key + request diagnostics, web mirror +
  regenerated SDK (B-4); retry button + bookmarks web UI, flag ON (B-5);
  chat-complex-documents skill (B-6); summarize-up-to-here end-to-end incl.
  context_window_usage event, flag ON (B-7). Also fixed the pre-existing checker.test.ts
  baseline (harness gap from bb2f211eb8; 131/0 now). Follow-ups noted in commits: Slack
  cross-surface card withdrawal, mobile long-press summarize entry, system_card polish,
  Velay/consumer migration onto exponential-backoff util.
- **Wave C — DONE (2026-08-05, branch `cue/upstream-wave-c`):** advisor context pack adapted
  to our loop-native consult (C-1); plugin dependency install + the catalog-consistency fix
  (8 plugins were browsable-but-404-on-install) + GitHub-source upgrades (C-2); memory
  ingestion — ChatGPT-export/foreign-DB importers, provenance frontmatter, ingest route/CLI,
  memory-corpus-ingest skill (C-3); voice periphery with VAD unchanged — TTS 2-job prefetch +
  eager first clause, audio-only progress narration (flag OFF), tool-use spoken ack wired
  (C-4); and the memory-DB split — migrations 324-328 relocate the graph cluster, activation
  state, telemetry/recall logs, v3 tables, and the memory job queue into a dedicated
  assistant-memory.db with idempotent crash-safe copies, cleanup-on-delete replacing FK
  cascades, and dual-family snapshots (C-5). Design context pack shipped alongside (brief,
  behavior reference, 23 upstream Storybook screenshots). DEPLOY NOTE: C-5's first boot
  copies the moved tables — daemon-off backup + quiet window. Deliberately deferred: the
  voice unified-front-door re-platform (design-gated), plugin ingress (signer footgun),
  Discord, Teleport, the llm_request_logs logs-DB split, and the registry/marketplace pin
  reconciliation (data drift flagged in C-2).
- Keep the Monday releases watch (schedule b12e1ba0-3d7d). Re-run the deep delta in 2–3 weeks;
  next sweep should check whether the `/new` authorization fix re-lands upstream and whether
  Teleport/meetings move.
