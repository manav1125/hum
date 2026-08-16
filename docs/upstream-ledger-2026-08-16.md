# Upstream ledger — vellum-ai/vellum-assistant → Cue (2026-08-16)

Decision document. Supersedes nothing; it **reconciles** the three prior delta docs
(`upstream-delta-2026-07-21.md`, `upstream-delta-2026-08-04.md`, `upstream-delta-2026-08-11-voice.md`)
against what is actually in the tree, and covers fresh the window those docs do not:
**`v0.11.3..upstream/main` = 182 commits, 2026-08-07 → 2026-08-14** (tip `c0c2f8d0ce`; release
tag `v0.11.4-staging.1` = `87d81cd7f9`).

## How to read the confidence marks

| Mark | Meaning |
|---|---|
| **[tree]** | Verified by reading our source or `git log` on this branch. Trust it. |
| **[up]** | Verified by reading the upstream commit/diff. Trust it about *upstream*. |
| **[inf]** | Inferred from a delta doc or a commit subject, not confirmed in code. **Check before acting.** |

Two entries in Part 2 are marked **[inf]** and flagged as such in place. Everything in Part 1 is **[tree]**.

## Headline facts

- **Divergence:** 1,051 commits ours vs **3,371** upstream since fork point `63127a2cc0` (2026-06-13). [tree]
- **We are much more current than the brief assumed.** Several items the brief listed as *outstanding* or
  *unknown* are already in the tree, ported within the last four days — the LUM-3135/LUM-3161 actor-trust
  wave, the ATL-1197 iframe-egress CSP, the memory-buffer trio, and marketplace-only plugin auto-update.
  Continuous porting (32 commits since 2026-08-09 name an upstream port) has quietly absorbed most of
  the v0.11.4 window. See Part 1 §H.
- **Upstream's fresh window is not for us.** Of 182 commits, **82 are `web` scope and 27 are i18n
  translation**; only 4 are `fix(security)`, 3 `fix(voice)`, 3 `fix(assistant)`. The core loop got ~14
  commits. This is a UI/localization release. [tree, from `git log` scope histogram]
- **Upstream shipped zero commits to Slack, Telegram, WhatsApp, email, phone or Discord** in the window.
  Their channel investment has moved wholesale to *plugin-as-channel*. Their iMessage bet is an
  out-of-tree plugin — there is nothing to port. [up]
- **Migration high-water:** ours workspace **106**, memory/assistant **328**, gateway data-migrations
  **m0004**. Upstream: workspace **145**, persistence **366**, gateway still m0017 with new DDL riding
  drizzle-kit push. The ≥103 collision range is live and we are consuming it. [tree]
- **Release v0.11.4 has no release notes** — `87d81cd7f9` is a version bump only. Contents are the
  181 commits behind it. Do not wait for notes on the next one either. [up]

## Three corrections to things we believed

**1. `46d64df40d` is not what the never-adopt list says it is.** [tree]
It is **`chore: GA trust rules v3 — remove v1/v2, canonicalize names` (2026-04-26)** — a pre-fork commit
that is **already an ancestor of our HEAD** (`git merge-base --is-ancestor 46d64df40d 63127a2cc0` → true).
It has nothing to do with the 45-second auto-allow. The only place that mechanism exists upstream is
`VOICE_APPROVAL_TIMEOUT_MS = 45_000` in `assistant/src/calls/voice-session-bridge.ts`, introduced by
`ca2b5a122e` and nowhere else (`git log -S'APPROVAL_TIMEOUT'` over the whole post-fork range returns
exactly one commit). Our tree has no such constant. **Delete the phantom sibling from the list; keep
`ca2b5a122e` banned.** Carrying a wrong hash forward is how the ban gets ignored when someone checks it.

**2. "We lead on watchers/playbooks" is a second WhatsApp-class error.** [tree]
Both trees have `assistant/src/watcher/` and `assistant/src/playbooks/` — it is **shared-ancestor code**,
exactly like WhatsApp was. The 07-21 doc had this right (it listed watchers/playbooks under *where they
lead*); the 08-04 doc flipped it without evidence. What is defensible: we have invested in it since the
fork (29 files vs their 17; 18 of our own commits touching those two dirs), and `missions/`, `valve/`,
`work-items/`, `ledger/`, `guardrails/` on top of it are genuinely ours. Claim the **superstructure**,
not the base. Corrected in Part 4.

**3. "We lead on team/multi-user" overstates it in the other direction.** [tree]
Cue has **no multi-user model at all** — one instance per person. `hq/` is a provisioning, token-minting
and billing control plane for separate single-owner instances; upstream has WorkOS orgs and
`organization-store.ts`, which is a real multi-tenant membership model we deliberately do not want.
These are different products, not a lead. Reframed in Part 4.

---

# Part 1 — Completed from upstream

Everything below is verified in this tree. Grouped by area; one line each plus the evidence.

## A. Security & authorization

| What | Evidence [tree] |
|---|---|
| Control-plane path writes classify **high** | `assistant/src/permissions/control-plane-paths.ts` (dirs `prompts/ users/ channels/ tools/ routes/`; SOUL/IDENTITY/VOICE/BOOTSTRAP/NOW/HEARTBEAT.md) → `permissions/checker.ts:295` → `gateway/src/risk/file-risk-classifier.ts:167` `isControlPlanePath`, `riskLevel:"high"` at :357 and :433 |
| Channel `/new` admission authorization, fail-closed | `gateway/src/channel-command-authorization.ts` — decision table in the header docblock, 5s `LOOKUP_TIMEOUT_MS` → **deny**, silent deny (no membership oracle). Callers `webhook-pipeline.ts:61`, `slack/socket-mode.ts:451`. **Unconditional — no flag.** Covers **5 channels**, not 4: telegram, whatsapp, twilio-sms, email (resend/mailgun/generic), slack |
| Browser/tool results fenced | `context/post-turn-tool-result-truncation.ts:133` emits `<external_content source="tool_result">`; browser forge guard `tools/browser/send-control-guard.ts:338-348` |
| Config seed no longer pre-empts migrations | `withSuppressedConfigDiskWritesSync` at `config/loader.ts:835`, wrapped over the whole migration loop at `memory/db-init.ts:641`; commit `076e07ef38`. Docblock names the live instance (migration 140 / `llm.pricingOverrides`) |
| Composio auto-provision risk level | `09519ba13e` stops writing `defaultRiskLevel:"low"`; backfill `workspace/migrations/106-normalize-auto-provisioned-composio-risk-level.ts` (`4b6669e337`) |
| **Actor-trust wave (upstream LUM-3135 + LUM-3161)** | **`4a097b7edb` (2026-08-12)** — `QueuedMessage.trustContext` captured at enqueue (`daemon/conversation-queue-manager.ts:44-46`, docblock reproduces upstream's reasoning verbatim); regression test `buildPassthroughBatch refuses to coalesce two channel senders`. **This is fresh-window work already done.** |
| **Visual-iframe navigation egress (upstream ATL-1197)** | **Already ported.** `apps/web/index.html:43` `Content-Security-Policy: frame-src 'self' https://www.ventureverse.com https://*.ventureverse.com`; Electron side `apps/macos/src/main/csp.ts:25-28`; regression suites `apps/web/src/utils/frame-src-csp.test.ts` + `apps/macos/src/main/csp.test.ts` |
| Plugin auto-update restricted to curated pins (upstream `d1a3f49aec`) | `assistant/src/plugins/auto-update.ts:20-40` — cites `upstream d1a3f49aec / ATL-1239` by name; `not-in-marketplace` is not an upgradable status |
| Daemon privilege drop | `78c735a92c` `CUE_DROP_DAEMON_PRIVILEGES` + `e275df39fe`, `f6f22e91ae`, `9245392c1e`, `caf842d4d2`, `b34626bcff`. Ours, not upstream — the answer to the `/proc`-environ/bash-path secret exposure |

## B. Brain / LLM robustness

| What | Evidence [tree] |
|---|---|
| StreamContentShadow tool-JSON salvage | `providers/anthropic/stream-content-shadow.ts:61`, wired `anthropic/client.ts:1346` |
| Thinking-only max_tokens nudge | `plugins/defaults/max-tokens-continue/hooks/post-model-call.ts:62` `MAX_TOKENS_THINKING_ONLY_NUDGE_TEXT` ("Produce the tool call or the reply text now"), gated on `isThinkingOnlyStall` at :101 |
| Resume interrupted generation | `e5c34c4cd3` → `agent/loop.ts` + `agent-loop-resume-interrupted.test.ts`. Distinct from the daemon-restart reconciler at `daemon/interrupted-turn-reconciler.ts:115` |
| Zod tool-input registry | `tools/tool-input-schemas.ts` single source for validation + advertised `input_schema`; `parseToolInput` :261 called from `tools/tool-approval-handler.ts:595`; derivation `tools/shared/zod-tool-schema.ts` |
| Tool-result spool 25k | `context/post-turn-tool-result-truncation.ts:18` `THRESHOLD_CHARS = 25_000` |
| NaN token normalization | **Landed, but not where the brief says.** Not in `recordUsage` (`providers/usage-tracking.ts:36-88` has no NaN handling). It is `normalizeTokenCount()` at `daemon/conversation-usage.ts:29` (`0001977a06`) plus an independent guard at `usage/pricing.ts:17` |
| Model catalog refresh | `providers/model-catalog.ts`: `gpt-5.6-sol/terra/luna` (:321/:348/:375), `gemini-3.6-flash` (:540), Kimi K3 (:787, :1193), `x-ai/grok-4.5` (:1042), `baseten` (:1416). `prompt_cache_key` → `providers/types.ts:206-214`. Diagnostics → `providers/request-diagnostics.ts` |
| ChatGPT-subscription provider identity | `runtime/routes/chatgpt-subscription-auth-routes.ts`, `cli/commands/inference-providers.ts` |

## C. Memory

| What | Evidence [tree] |
|---|---|
| Memory-DB split | migrations `324`–`328` in `memory/migrations/`; dedicated connection `memory/db-connection.ts:124`, slot `memory/db-singleton.ts:38` |
| Memory ingestion | `skills/chatgpt-import/scripts/parse-export.ts`, `apps/web/src/components/memory-import/`, `skills/memory-corpus-ingest/scripts/parse-agent-memory-db.ts`, CLI `cli/commands/memory/memory-ingest.ts` |
| 3D memory map | `eb70c146f5` (concept graph, 3,501 lines, `apps/web/src/domains/intelligence/components/concept-graph/`) + `d0eaca0d01` (Map beside List). **No "phase" markers exist anywhere** — see Part 2 note |
| Qdrant snapshot-path hardening | `576faf6a86` → `memory/qdrant-manager.ts:60` `QDRANT__STORAGE__SNAPSHOTS_PATH`; suite `memory/__tests__/qdrant-spawn-paths.test.ts` |
| **Buffer delimiter forgery fix** (upstream `f8dd56b2e8`) | **Already ported.** `memory/buffer-format.ts` `CONTINUATION_INDENT`; the docblock states the threat ("a stored fact could forge extra entries") |
| **Injected-buffer cap + elision markers** (upstream `9b473bf88d`/`e1f0f78619`) | **Already ported.** `memory/v2/static-context.ts:53,120-158` — bound is `consolidation_max_buffer_lines`, entry-boundary trimming, attributable markers |
| Migration 229 guard | `1d80141db9` on `memory/migrations/229-delete-private-conversations.ts` |
| sqlite3 busy timeout | `f5b361b591` → `memory/db-async-query.ts:161` `PRAGMA busy_timeout` |

## D. Voice

| What | Evidence [tree] |
|---|---|
| Multilingual voice | `config/schemas/stt.ts:74` `services.stt.language` **defaults `"multi"`**; `language=multi` at `stt/daemon-batch-transcriber.ts:89`; dominant-language vote `stt/language-metadata.ts:34` → `live-voice-session.ts:2698`; TTS hint `tts/providers/elevenlabs-provider.ts:242`; settings picker `b4942fb6d4` |
| Camera in voice | `attach_image` frame `live-voice/protocol.ts:10,229,688-716`; **capability advertised on the ready frame** (`attachImage:true`, `live-voice-session.ts:1149`) not a version gate; `live-voice-photo.ts` |
| Voice turn telemetry | `b54c573204` → `gemini-live-session.ts` +115 with `gemini-live-turn-telemetry.test.ts`. **Scoped to the gemini-live engine only** |
| The four voice defects | `421f157aa7` carries three (answer-first prompt `gemini-live-session.ts:154`; thread context `live-voice-thread.ts` `buildLiveVoiceThreadContext`; native-audio language drift `gemini-live-client.ts:88`); `7724429fb2` is the fourth (turn dying at teardown releases the caller) |
| Server-side echo classifier (upstream `9eaee435d7`) | `c44cfbce64` → `live-voice/echo-classifier.ts`; scoped to non-`echoSafePlayback` clients at `live-voice-session.ts:811-817` |
| Front-door flag | `config/schemas/live-voice.ts:230-234` `liveVoice.frontDoor.enabled` **default `false`** — and blocked, see Part 2 |

## E. Channels, plugins, schedules

| What | Evidence [tree] |
|---|---|
| Inbound email attachments | `gateway/src/email/attachments.ts` `ingestEmailAttachments`, wired at `mailgun-webhook.ts:401` and `resend-webhook.ts:473` |
| Guardian cards persist + withdraw in place | `ff77a1ff96` |
| Timed approval grants | `runtime/conversation-approval-overrides.ts:25` `DEFAULT_TIMED_DURATION_MS = 10*60*1000`; `tools/permission-checker.ts:527` |
| Skill revision history | `runtime/routes/skill-history-routes.ts` (git-backed, `lastUsedAt`-only commits filtered) + `apps/web/.../skills/skill-revision-history.tsx`; on mobile via `baaa11a2ee`-line commit `baa44eab11` |
| Plugin schedules pinnable to inference profiles | `schedule/plugin-schedule-declarations.ts:131` `inference_profile`, mapped :221, reconciled `plugin-schedule-reconciler.ts:306`, applied `scheduler.ts:360,476,611,634` |
| MCP OAuth via shared gateway callback | `webhooks/oauth/callback` present under `assistant/src/mcp` |

## F. UI / web

| What | Evidence [tree] |
|---|---|
| Retry button on last turn | `chat/transcript/latest-turn-row.tsx:72` `onRetryLatestTurn`, `retryRowKey` :107 restricts to last non-streaming row |
| Bookmarks | flag `bookmarks`, client-side gate `bookmark-toggle.tsx:22`; backend `runtime/routes/bookmark-routes.ts`, `memory/schema/bookmarks.ts`, migration `242` |
| Summarize-up-to-here | `SUMMARIZE_UP_TO_HERE_FLAG` at `runtime/routes/conversation-management-routes.ts:95`; boundary snap `daemon/summarize-boundary.ts`; `context_window_usage` asserted in `__tests__/compaction-events.test.ts:487` |
| Skill-recommendation + channel-showcase cards | `tools/ui-surface/definitions.ts:128-130`; prompt wiring `prompts/templates/system-sections.ts:273,494`; client `chat-route-content.tsx:767` |
| Desktop companion | `apps/web/src/domains/companion/` + Electron host `apps/macos/src/main/companion-window.ts`. Self-described "slice 1" |
| Refcounted body scroll lock | `apps/web/src/hooks/use-body-scroll-lock.ts` — module-level `lockCount`, `restoreValue` captured by first holder only (`6855e2a5fe`) |

## G. Exports / documents

Four export fixes in the window, not two: `d48700ffa8` (numbers breaking in wide tables), `e2b7c512c0`
(an unopened spreadsheet cell rewriting data), `79f31b37e1` (number broken in half), `36afac47e6` (house
style on plain document export). Plus the format expansion: `d2aed5b44d` (PNG/HTML/Markdown/Word/Excel),
`702ce6fac7` (editable PPTX), `357d9f7814` (send-to destinations). Create-surface fixes are **four**, not
two: `ca78607883`, `0030c9abc1`, `5d6dd7ed10`, `b82dcb4fe1`. [tree]

`@tiptap/extension-table` is in `apps/web/package.json:62` and registered — upstream's GFM-table
corruption bug (`cdc6111774`) does not apply. [tree]

## H. Three items from the brief that need correcting

1. **App-bundler 5MB cap** — removed, but **not by upstream `76df6b720b`**, which is *not* an ancestor of
   HEAD. It went via our own `9146ebca82` ("a generated app that draws a chart could never resolve
   chart.js"), which deleted `MAX_PACKAGE_SIZE_BYTES`. `bundler/package-resolver.ts:31` now reads "There
   is deliberately no unpacked-size cap". Same outcome, different provenance — matters only if someone
   later tries to `git cherry-pick` the upstream sha and finds it conflicts. [tree]
2. **NaN token normalization** — landed, wrong location remembered (see §B).
3. **3D memory map "phases 3-4"** — there are no phase markers in the code. `grep 'phase [1-9]'` across
   `domains/intelligence/` returns nothing; the only TODO is `constants.ts:43` about a brand colour ramp.
   The phased-roadmap framing lives in a design doc, not the tree. Treat "phases 3-4" as a planning
   fiction until someone re-derives what is actually missing from the surface. [tree]

## I. A negative result worth recording

Upstream `5bbd521ef7` fixes a **runaway log-prune loop** when `llmRequestLogRetentionMs` is `0`
(~57 enqueues/sec, each spawning a sqlite3 subprocess, 2.2 GB of log in a day). Our
`memory/jobs-worker.ts:1118` has the same asymmetric guard (`!== null`, where sibling jobs use `> 0`),
so it looks like we share it. **We do not.** Our scheduler gates the entire cleanup pass behind one
`enqueueIntervalMs` check (`jobs-worker.ts:1104`) plus enqueue dedup in the jobs store; upstream's
runaway came from a per-job `isDue(job, retention)` that collapses to always-true at 0. Our default is
1 hour, not 0. **Checked, does not apply.** Recorded so the next sweep does not re-raise it as a P0.
A one-line `> 0` consistency change is still defensible hygiene; it is not urgent. [tree]

---

# Part 2 — Outstanding, ranked

Ranked for **one owner, his own instance, his daily driver** — not upstream's priorities. Cost is
engineering size; "buys" is what changes for Manav.

### 1. Reasoning-tag filter on the TTS path (upstream `89fc1ac19f`) — **S**

**What:** a stateful streaming `ReasoningTagFilter` that strips `<think>`/`<thinking>` spans from the two
TTS feeds (`calls/call-controller.ts` ttsBuffer, `live-voice/live-voice-session.ts` ahead of
`extractSpeakableSegments`), holding partial tags back across delta boundaries. Raw text still goes to
persistence, transcript and display.

**Buys:** reasoning models on OpenAI-compatible endpoints emit chain-of-thought inline on `text_delta`
when the profile has not set `parseThinkTags`. **Our brain is DeepSeek V4 via OpenRouter — exactly that
configuration** — and `parseThinkTags` defaults to `false` at
`providers/openai/chat-completions-provider.ts:370` with **no call site in our tree setting it true**
[tree]. If our OpenRouter route ever returns inline tags rather than `reasoning_content`, the assistant
reads its own inner monologue aloud with the onset delay that implies. This is also the neighbourhood of
open voice defect **#60**.

**Depends on:** nothing. **Confidence the bug bites us: MEDIUM** — OpenRouter normally surfaces DeepSeek
reasoning in `reasoning_content`, which we handle separately. **Verify with one real DeepSeek voice turn
before porting.** But the filter is cheap insurance either way and cannot regress a stream that has no tags.

### 2. Fork skips unfinalized rows (upstream `89870752e4`) — **S**

**What:** `forkConversation` (`memory/conversation-crud.ts:850`) copies rows without checking `finalized`.
A fork taken mid-turn copies a `finalized=0` row whose `{ref}` points at a delta file the source turn then
deletes; the copy takes the column default `finalized=1`, so crash recovery never scans it.

**Buys:** removes a class of **permanently empty, unrepairable message**. Cheap, self-contained.

**Depends on:** nothing. Our `forkConversation` has no `finalized` guard — confirmed absent [tree].

### 3. Voice front door — unblock, then decide — **S now, L later**

**What:** two separable things that the 08-11 doc conflated.
- *Now (S):* the **front-door hub-stream gate** (upstream `5650163a17` concept) — **DONE 2026-08-16**
  [tree]. It was the stated precondition for ever flipping `liveVoice.frontDoor.enabled`; without it,
  verdict tokens rendered in web and passive transcripts, so the flag was not merely off but
  **unflippable**. Now built as `createFrontDoorStreamGate` in `assistant/src/calls/voice-triage-escalate.ts`,
  wired into the hub broadcast at `assistant/src/calls/voice-session-bridge.ts` (`broadcastLegEvent`).
  The flag is **still off** — what remains before flipping is real-device QA on endpointing feel and
  escalation-bridge audio, which is a judgement call, not a defect.
- *Later (L):* the actual re-platform. Upstream `92f668a1f5` **deletes `live-voice/front-decision.ts`**
  [up] — the file our flag-off `frontModel.semanticEndpointing`/`spokenAcks` layer is built on. Take
  `92f668a1f5` + migration 142 **as one unit or not at all**; merging around it strands our layer.

**Buys:** either finish the thing or stop paying to carry it. Right now we pay and get nothing.

### 4. `activity` server frame (upstream `351a4e2509` concept) — **S–M**

**What:** a daemon-composed turn label for the Lock Screen / island. **NOT FOUND in our tree** [tree] —
the server frame union at `live-voice/protocol.ts:248-534` has only `tool_activity` (from our own
`a575ef91f3`), which is a different thing. Still sitting in the 08-11 doc's "ADOPT SOON" bucket.

**Buys:** the card-legibility bridge for desktop-control approval and the iOS TestFlight build. Of the
three items that doc queued, the echo classifier is the only one that actually got picked up.

**Depends on:** must be advertised via the ready frame, not a version gate — our client fatals on unknown
frames.

### 5. Mobile long-press → summarize-up-to-here — **S**

**What:** summarize-up-to-here is wired end-to-end but its only entry point is
`message-hover-actions.tsx`, which has no touch path [tree]. The mobile long-press affordance already
exists for bookmarks ("long-press any message to keep it here",
`chat/conversations-index-page.tsx:840`), so this is adding an item to an existing gesture menu.

**Buys:** the feature he paid for becomes reachable on the device he uses most.

### 6. Admission-floor rank as a shared contract (upstream `90149a238f`, contract half only) — **S**

**What:** hoist `TRUST_CLASS_RANK` + `meetsAdmissionFloor()` into a shared package so runtime and gateway
cannot drift. **Absent in our tree** [tree] — we have the fail-closed `/new` authorization
(`gateway/src/channel-command-authorization.ts`) but no shared rank contract.

**Buys:** *"a floor added to one table without a rank in the other silently admits everyone"* is
**precisely our guard-polarity failure mode** — the allowlist that excluded everyone and silently filed
mail from known people. Take the contract, skip the plugin-ingress machinery around it.

### 7. Default plugin surface in conversation-running workers (upstream `f7182d110d`) — **S, audit first**

**What:** memory-jobs and schedule workers run real agent conversations in their own processes but
register no plugins, so the image-fallback vision-recovery never runs there: an image-bearing
retrospective window on a text-only model fails `vision_unsupported` forever, the cursor never advances,
and **derived memory stops forming from that conversation's first image onward**.

**Buys:** this is the *ran, aborted, reported success* class again — the sidechain-timeout family. Silent
permanent memory loss is the worst failure shape we have.

**Confidence: [inf].** I confirmed we have the worker split (`memory/jobs-worker.ts`, `schedule/`) and
found no plugin registration in them [tree], but I did **not** confirm we have the image-fallback plugin
or that our workers hit the same path. **Audit before porting** — the audit is most of the value.

### 8. MCP OAuth: dynamic client registration reuse (upstream `34893d79ac`) — **S**

**What:** the shared gateway callback route is already in our tree [tree]; the missing half is reusing
DCR across attempts and withholding it only when the redirect URI or authorization server changed.

**Buys:** more third-party MCP servers actually connect on a self-hosted box. Low urgency, unblocks later work.

### 9. Calendar skill retrieval hints (upstream `33e6f3f471`) — **S, likely already covered**

Upstream's calendar skills described only scheduling *into* the calendar, so "help me plan today" matched
nothing and the agent planned over an existing meeting. Our `skills/google-calendar` and
`skills/outlook-calendar` **do** carry day-planning language [tree]. Listed only so the next sweep does not
re-raise it. **Probably closed.**

## Previously-deferred items — still relevant?

| Item | Verdict |
|---|---|
| **Plugin ingress** | **Still deferred, and the case has got stronger for skipping.** Absent from our tree [tree]. Upstream grew it substantially this window (`20c3e050f1`, `90149a238f`, `1d2506d745`, `c133b5c814`, `7065e2a6d9`) and it is genuinely the best-designed thing in the release — but it is an **L** project that pays off only if we want plugins-as-channels, and we already have first-class Slack/Telegram/WhatsApp/email. **Take item 6 above and leave the rest.** |
| **Discord** | **Close it.** Absent from our tree; upstream shipped **1** Discord commit in the window and their new-channel path is now the plugin substrate, not `gateway/src/discord/`. The admission idea worth stealing is now item 6, not the Discord directory. |
| **Teleport** | **Close as "watch" — no movement.** Zero upstream commits. Note the plumbing is already in our tree as shared-ancestor code (`runtime/routes/migration-routes.ts`, `gateway/src/http/routes/migration-proxy.ts`, `config/sanitize-for-transfer.ts`, flag registered in both flag registries) [tree]. Nothing to port; nothing to do. |
| **Logs-DB split** | **Close it — obsoleted on our side.** We already have `memory.cleanup.llmRequestLogRetentionMs` (default **1 hour**, capped at 365d, `config/schemas/memory-lifecycle.ts:160`) *and* a pluggable ClickHouse backend (`memory/llm-request-log-store.ts`, `llm-request-log-source-clickhouse.ts`) [tree]. Retention config already solves the 500MB-DB runaway the split was designed for. Doing the split now buys structure, not relief. |
| **Memory map phases 3-4** | **Ill-defined — do not schedule it.** No phase markers exist in the code (Part 1 §H.3). If the surface is lacking something, re-derive it from the surface, not from a phase number. |
| **Slack cross-surface card withdrawal** | **Still open.** `ff77a1ff96` shipped guardian-card persistence and Telegram in-place withdrawal; the Slack cross-surface half was explicitly noted as a follow-up and no `withdraw` path exists in `gateway/src` [tree]. Low value at one owner — you see the card on the surface you are looking at. |
| **Voice front door** | See item 3. Split into "unblock" (do) and "re-platform" (decide). |

## New from the fresh window, logged but not recommended

`18855c9c17` `<channel_capabilities>` dedupe — **already covered** by our injection-stripping pipeline
(`context/strip-injections.ts:98` lists it in `RUNTIME_INJECTION_PREFIXES`, applied from `agent/loop.ts`
and `daemon/conversation-runtime-assembly.ts`) [tree]. Different mechanism, same outcome.
`cdc6111774` GFM tables — does not apply (§G). `9214dd72e7` document-append dedupe — our documents path
already handles it [tree]. `24d68a2995` approval-budget unification — we already read
`permissionTimeoutSec` [tree]; upstream's version times out to **deny**, so it is safe, but there is
nothing to take. The sidebar section index, the i18n cutover, the design-library work, `289776e76f` pod-health
gating, and everything ChatGPT-subscription-related: **skip** — SaaS-shaped or pure churn.

---

# Part 3 — Never adopt

**This list is the point of the document. It must survive into the next session.**

## Authorization bypasses

| Commit | Why never |
|---|---|
| **`ca2b5a122e`** | `VOICE_APPROVAL_TIMEOUT_MS = 45_000` in `assistant/src/calls/voice-session-bridge.ts`: a pending sensitive-tool approval resolves after 45s **the way the channel resolved everything before it prompted** — i.e. guardian auto-allow. **This is the exact rogue-send class that burned us in July.** Verified [up]: it is the only timeout-to-auto-allow in the entire post-fork range (`git log -S'APPROVAL_TIMEOUT'` → one commit), and our tree has no such constant. ⚠️ **The `46d64df40d` "sibling" does not exist** — that hash is a pre-fork trust-rules-v3 GA commit already in our ancestry. Do not carry the phantom forward. Worth lifting from this commit and *only* this: the fail-closed workspace-boundary reach classifier (it passes `conversation.workingDir` and fails closed when there is no boundary), if mid-call prompt fatigue ever becomes real. |
| **`9efc65cea1`** | Serves `signer:"vellum"` plugin-ingress routes **without guardian approval**. In our fork "vellum" is not a real platform secret, so porting verbatim is a straight authorization bypass. |
| **`6650ddae52`** — **NEW, add to the list** | Plugin-declared MCP servers **default to `low` risk**, so their tools run **without prompting** under the default auto-approve threshold. Upstream's justification is a curated SHA-pinned marketplace acting as the review step — **a control our fork does not have** — and their own commit message records the gap: *a plugin installed off-marketplace straight from a GitHub URL gets the same default, with no install-time provenance to curation-gate on* [up]. This is the third member of the `9efc65cea1` / `bd2aa0b1eb` family and the most dangerous for us, because it lands one week after we shipped migration 106 to remove **exactly this pattern** for Composio. The underlying "plugin MCP servers never actually connect" fix is a real bug fix: if you take it, **invert the default to `high`** and keep `useStoredCredentials:false`. |
| **`bd2aa0b1eb`** | Composes the channel permission cell into the sensitive-tool gate — **widens** what non-guardians can do in Relaxed/Full rooms and drops the gate's `riskLevel` param. Against our post-rogue-send default-deny posture. |
| **`eca09a557c`** | Recovers the guardian from gateway actor tokens — assumes gateway-native contacts. Structurally wrong for our assistant-DB contacts. |

## Structural / wire

| Item | Why never (or never blindly) |
|---|---|
| The ~25-commit **"Single-source" wire refactor** | `ServerMessage` deleted, envelope renamed `AssistantEventEnvelope`, guardian-actions domain deleted (`237da6522e`), schedules (`34378f2b2a`) and workspace (`c0e2c9ed77`) wire protocols. **Skip the series; build a compat shim** (`message-protocol` re-exporting from `api`). **Status update:** the churn has **stopped** — the fresh window touches `packages/service-contracts` once, `ipc-contract` once, `gateway-client` twice, with no envelope work [up]. The shim recommendation still applies to pre-window picks; no new pressure. |
| **Workspace migrations ≥103; gateway m0007+** | Renumber, never merge. Upstream is at workspace **145** (142 consolidate-voice-front-door, 143 codex-model-id, 144 stranded-subscription-profiles, 145 profile-bindings) and persistence **366**. ⚠️ **Upstream renumbers before merge and the commit prose goes stale** — `366-chatgpt-subscription-row-identity`'s own message calls it "Migration 363" [up]. Never trust a migration number quoted in upstream text. |
| **Gateway DDL via drizzle-kit push** | New table `inbound_seen_events` arrives in `gateway/src/db/schema.ts`, **not** an m-migration [up]. If we pinned or replaced `pushSchemaNoPrompt`, it silently will not exist. Same class as the 08-04 warning. |
| **UUIDv7 / requestId-merge / flat-content** wire changes | Our client fatals on unknown frames. Substitute v4. **New frames this window to watch:** `acp_auth_required` (new file `assistant/src/api/events/acp-auth-required.ts`), `plugin` added to the canonical channel union in `packages/service-contracts/src/channels.ts` (an **enum widening** — our trust floors and filing switch exhaustively on channel id), and `endpointDecisionSource` widened to `"front-door"｜"provider"` [up]. Any partial adoption must advertise via the ready frame. |
| **Their memory relocation** | Upstream memory is at `assistant/src/plugins/defaults/memory`; ours stays at `assistant/src/memory` [tree]. Confirmed still divergent. |
| **WorkOS / velay / credits / managed-connection** | SaaS-coupled. Includes the fresh window's abandoned-checkout credit modal, credit banners, managed-callback-over-Velay routing, Stripe-through-Electron-CSP, and the onboarding funnel work. |
| **`3a7b40a542`** | Removes `unmappedPolicy` / `defaultAssistantId` from gateway routing. |
| **`0ace618d12`** | IPC framing change — chunked responses truly stream; ignoring them hangs to timeout. |
| **`d117cd4253`** — **NEW** | Deletes `canonicalAssistantId` in every form, on the reasoning that the daemon is single-tenant and always answers `self`. **Our HQ provisioner is the one place where "which assistant" is not trivially `self`** [up]. Any cherry-pick touching channel binding or guardian request ids after this commit assumes single-tenant. |
| **`551e75c1bc`** — **NEW** | Removes the sidebar's lazy background/scheduled backlog machinery and narrows `isKnownCategoryKey` to `channel:` keys, dropping persisted `"background"`/`"scheduled"` keys on load. Our Mission Control / work-loop surfaces lean on background-run visibility. If we ever take the section-index family, this is the piece that silently stops pre-loading those backlogs [up]. |
| **`7568a85c4e`** | Brace-style enforcement — diff noise on everything post-07-28. |
| Migrations **351 + 352** | Create/drop pair for a reverted feature. Skip both. |
| **`MIN_VERSION` client gates** | Key on upstream assistant version strings; our scheme always-degrades or always-renders. Strip or re-key. |

## History hazards

Upstream's release merges keep losing work and repairing it after the fact: `820cf1504f` and `4e21df19f1`
at the v0.11.0/v0.11.1 cuts, and now **`fdde3ee6db` "restore the work the v0.11.3 back-merge reverted"**
[up]. **Do not bisect across `cf80ee1f80`, and never diff against a release tag** — you can reintroduce
reverted state.

---

# Part 4 — Where we lead

Checked, not assumed. The WhatsApp error taught us this section lies by default.

| Claim | Verdict |
|---|---|
| **Cue-only subsystems** | **HOLDS, strongly.** Upstream has **zero files** in any of: `filing` (1), `arrivals` (14), `valve` (7), `work-items` (50), `missions` (5), `create` (5), `guardrails` (10), `ledger` (5), `library` (2), `tasks` (6), `calendar` (6), `brand` (4), `agents` (4), `cue-live` (2). [tree, `git ls-tree upstream/main` vs `find`] |
| **Filing / arrivals / valve / signals** | **HOLDS.** No upstream equivalent at all. |
| **Missions / standing agents / work-loop** | **HOLDS.** Upstream's nearest thing is `heartbeat` (4 files, cap 10/day). Ours is a cadence engine with spend caps. |
| **Watchers / playbooks** | **CORRECTED — shared ancestor, not ours.** Both trees have `watcher/` and `playbooks/`. We have extended them (29 files vs their 17; 18 of our own commits since fork), they have too. Claim the superstructure above, not this base. |
| **Cue Live screen observation** | **HOLDS.** Zero upstream matches for screen observation of any spelling. Ours is 2 files and dormant — a lead in concept, not in shipped capability. Be honest about which. |
| **Connector health** | **WEAK.** `credential-health`: ours 2 files, theirs 1. Not a moat. Drop the claim or substantiate it from behaviour rather than the tree. |
| **Marketplace-over-embeddings** | **HOLDS, narrowly.** Upstream has a plugin marketplace CLI (`cli/lib/plugin-marketplace.ts`, `plugins/marketplace.json` — shared lineage). We have that **plus** a skills marketplace: `assistant/src/skills/marketplace`, `runtime/routes/marketplace-routes.ts`, `apps/web/src/pages/marketplace/`. Their skill search runs on `persistence/embeddings/`; ours on `skills/catalog-search.ts`. Real, but narrower than the phrase implies. |
| **First-party channels** | **NEWLY TRUE, and this one is a genuine gain.** Upstream shipped **zero** commits to Slack/Telegram/WhatsApp/email/phone/Discord in the fresh window; their channel strategy has moved to plugin-as-channel and their iMessage bet lives out of tree [up]. The 08-04 doc's P1 channel-robustness pull list (Wave B) is likely the **last** we will get from them on first-party channels. |
| **Team / multi-user (HQ)** | **RECAST.** We have **no multi-user model** — one instance per person. `hq/` is a provisioning/token-minting/billing control plane; upstream has WorkOS orgs and `organization-store.ts`, a real membership model we deliberately rejected. Different products. State it as *"single-owner instance provisioning, which upstream does not have"* — because `hq` genuinely has no upstream counterpart — and stop saying "multi-user". |
| **Mobile v3** | **UNVERIFIED — design-level.** Both trees ship native iOS + Android (theirs adds `clients/windows`, which we lack). This is a claim about design fidelity, not code presence, and cannot be settled from the tree. Manav's call. |
| **Meeting-joining, iMessage** | **We lead on neither, and neither do they.** Upstream still has zero meeting-joining code; iMessage exists only as an out-of-tree plugin. Nothing to chase. |

---

# Part 5 — Recommendation

## The situation

The fork is in better shape than the brief assumed. We are not behind; we are **current and paying
carrying costs**. Upstream's newest release is 45% web churn and 15% translation, they have stopped
investing in the channels we actually use, and their two most interesting systems this window
(plugin-as-channel, the entries config model) are answers to problems a single-owner instance does not
have. The delta doc cadence has done its job: continuous porting absorbed the security wave, the memory
work and the CSP fix within days, without a wave.

So the right move is **not another catch-up wave**. It is to stop tracking upstream so closely and spend
the attention on the two places where our own tree is quietly costing us.

## What I would do, in order

**1. Close the voice front door — decide, do not defer again (item 3).**
*Status 2026-08-16: the gate is built and the flag is now flippable (see item 3). What is still owed is
the flip decision itself, plus the "later (L)" re-platform call at the next voice sync.*
This is the single biggest waste in the tree. We carry a built, flag-off front-model layer that cannot be
turned on (the hub-stream gate does not exist), built on a design upstream has now **deleted the file
for**. Every voice sweep since 07-21 has re-litigated it. Two honest options: build the hub-stream gate
(S) and flip the flag, or delete the layer and take `92f668a1f5` + migration 142 wholesale on the next
voice sync. **I would build the gate** — it is small, it makes something we already paid for usable, and
it keeps the wholesale merge as a later choice rather than a forced one. What I would *not* do is leave
it in the current state for a fourth sweep.

**2. Ship items 1, 2, 4, 5, 6 as one small batch — half a day, no deploy risk.**
Reasoning-tag TTS filter (verify first), fork-skips-unfinalized, the `activity` frame, mobile long-press
summarize, admission-floor rank contract. All S, all self-contained, all things he touches daily. Nothing
here needs a runbook, a quiet window or a backup — unlike Wave C. The admission-floor contract in
particular is cheap insurance against the guard-polarity failure we have already had once.

**3. Run item 7 as an audit, not a port.**
Whether our memory-jobs and schedule workers silently stop forming derived memory after a conversation's
first image is a 30-minute question with a bad answer if it is yes. The audit is worth more than the code.

**4. Close the standing backlog explicitly.**
Discord, Teleport, the logs-DB split and memory-map "phases 3-4" should come **off** the list — closed
with the reasons in Part 2, not carried forward as guilt. Plugin ingress stays off unless the product
wants plugins-as-channels, and it does not.

**5. Change the watch cadence.**
Drop from a full delta every 2–3 weeks to **once a month**, and narrow the scope: security commits,
`assistant/src` core-loop commits, and voice. Skip `clients/`, i18n, billing and onboarding entirely.
Keep the Monday release watch as the tripwire. The evidence for this: 182 commits produced **nine**
candidates for us, and **five of those were already in our tree** by the time I checked.

## What I would not do

- **No Wave F.** There is no coherent wave in this window. Batching these into a ceremony adds a merge,
  a deploy and a QA round for nine small fixes that can land individually on `cue/voice-replatform`.
- **Not plugin ingress, not Discord, not the sidebar section index, not i18n.** The first is an L-sized
  bet on a channel model we do not want; the rest are upstream solving upstream's problems.
- **Not `6650ddae52` as written.** If plugin MCP servers ever matter, take the connection fix with the
  risk default inverted to `high`. Our curated-marketplace review step does not exist, and we removed this
  exact pattern from Composio eight days ago.
- **Not the front-door re-platform as a project right now.** Build the gate; leave the re-platform as a
  decision for the next voice sync, when `92f668a1f5` can come in whole.

## The one thing to check before acting

Item 1's premise. `parseThinkTags` is `false` and unset everywhere in our tree, which is the *condition*
for the bug — but whether OpenRouter actually hands us inline `<think>` spans for DeepSeek V4, rather than
`reasoning_content`, I did not verify. **One real voice turn settles it.** If it comes back clean, the
filter drops to hygiene and item 2 becomes the batch's headline.
