# Cue prod turn-latency decomposition — 2026-07-20

**Target:** https://manav.justcue.app (Fly `cue-manav-prod`, machine `48eed1ef1411e8`, shared-cpu-2x/4GB, iad)
**Method:** read-only sqlite over `llm_request_logs` / `trace_events` / `llm_usage_events` + 4 controlled QA-PERF turns (conversation `e14dd9fc-a2d3-4536-87f5-0ec6394da732`, key `qa-perf-20260720`, all messages tagged "QA-PERF … safe to delete") + the original QA-night smoke turn (`b97ef667-4969-477f-903a-1a546ad421f5`). No prod config was changed.

---

## TL;DR

The turn is not slow because of the agent loop, memory injection, or post-processing. It is slow because **every mainAgent LLM call ships ~93,000 prompt tokens — of which ~86-88k tokens are the JSON schemas of 207 tools** — and the pinned OpenRouter providers cache almost none of it (2-4k cached of ~93k). Prefill/TTFT therefore dominates: **4.7-8.6s warm, up to 48s cold**, for answers of 30-80 tokens. The measured "27.8s for 2+2" is ~25s server-side (of which ~9.3s was the LLM call and ~13s fresh-conversation preamble) plus up to 10s of smoke-harness poll quantization (it polls every 10s).

---

## 1. Decomposition

### The actual QA-night smoke turn ("What is 2+2? One word.", 27.8s reported)

Reconstructed from `trace_events` + `llm_usage_events` (request-log rows for that window were already retention-pruned):

| Phase | ms | % of 27.8s | Evidence |
|---|---:|---:|---|
| Client POST → user msg persisted | ~300 | 1% | POST rtt measured 350-520ms on probes |
| Pre-LLM preamble (fresh conversation: context assembly, memory retrieval, workspace git init) | ~13,200 | 47% | user msg `1784472190675` → provider-call start ≈ `1784472203900` (finish `213235` − `latencyMs 9280`) |
| LLM call (92,038 prompt tokens → 79 completion tokens, TTFT ≈ 8.6s of the 9.3s) | 9,280 | 33% | `llm_call_finished.latencyMs=9280`; first-token trace at `212599` |
| Post-processing (finalize msg, indexing, projections) | ~2,200 | 8% | `assistant_message 215157`, `message_complete 215476` |
| Smoke-harness poll quantization + network | ~3,000 | 11% | harness polls every **10s** (`assistant/qa/prod-smoke.ts:246`) |

Only 3,072 of 92,038 prompt tokens were served from provider cache. 76 of the 79 completion tokens were hidden reasoning tokens.

### Controlled probes (2026-07-20 ~02:37-02:46 UTC)

| Turn | Total (server) | Pre-LLM | LLM call(s) | Post | prompt_tokens | cached |
|---|---:|---:|---:|---:|---:|---:|
| TRIVIAL "3+3" (turn 1 of fresh conv) | 54.6s | 2.3s | **52.1s** (TTFT ≈ 48s — cold prefill) | 0.1s | 93,119 | ~0 |
| MEDIUM "why is the sky blue" | 8.0s | 0.8s | 7.1s (TTFT ≈ 4.7s) | 0.1s | 93,640 | 2,048 |
| TOOL (web_search) | 18.6s | 0.9s | 6.9s + 5.8s (2 rounds) + 4.7s tool | 0.1s | 94,671 + 95,039 | 4,096 |
| TRIVIAL "5+5" (warm) | ~6s | ~0.8s | 5.2s (`turn_timing agentLoopMs: 5198`) | ~0.1s | 95,699 | — |

Across 67 recent real LLM calls (mostly heartbeats): duration p50 = 5.3s, p90 = 23s, max = 53s. The recurring "~5s gap between tool_finished and the next llm_call_started" in traces is **not** a gap — `llm_call_started` is emitted at first streamed byte, so that gap IS the next call's TTFT.

**Typical warm simple turn (~8s):** ~10% preamble, ~88% LLM call (≈75% of the call is prefill/TTFT), ~1% post. **Round-trips: exactly 1** LLM call for a trivial turn (no forced skill_search/memory tool — disproven), plus 1 background `conversationTitle` flash call off the hot path.

### Where the 93k prompt tokens come from

Request payload for the MEDIUM turn: **347,463 bytes** (`llm_request_logs.originalBytes`; log stores first 128KB).

| Component | bytes | ≈ tokens | share |
|---|---:|---:|---:|
| Tool schemas — **207 tools** (`GET /v1/tools`) | ~301,000 | ~86-88k | **~93%** |
| System prompt (19 sections: SOUL.md, Memory, Communication, …) | 17,120 | ~4.4k | ~5% |
| History + `<workspace>`/`<turn_context>`/`<memory>` injections | ~11,400 | ~2-3k | ~2% |

Of the 207 tools, ~69 are `mcp__composio_*` (gmail/gcal/gdrive/gsheets/notion/slack/linear/github/airtable/hubspot), ~11 `computer_use_*`, ~9 `app_control_*`, ~9 `sequence_*`, ~11 `messaging_*`, plus documents/media/playbooks/schedule/etc. All 207 schemas go up on **every LLM round of every turn — including every heartbeat round** (heartbeat runs do 7-12 rounds × ~93k tokens ≈ $0.10-0.15/run at current pricing; observed mainAgent calls cost $0.013-0.027 each).

## 2. Config reality (no secrets — names/presence only)

- Machine env (`flyctl machine status -d`, values are config not credentials): `CUE_OPENROUTER_MODEL=deepseek/deepseek-v4-flash`, `CUE_OPENROUTER_FLASH_MODEL=deepseek/deepseek-v4-flash` (**main == flash → flash routing is currently a no-op**), `CUE_OPENROUTER_PROVIDER_ORDER=DeepInfra,StreamLake,GMICloud`, `ALLOW_FALLBACKS=false`, `REQUIRE_PARAMS=false`, `CUE_LOG_FULL_LLM_PAYLOADS=0`, `CUE_COMMITMENT_CAPTURE_CHANNELS=""` (empty). `ANTHROPIC_API_KEY`: present. `TAVILY_API_KEY`/`CUE_TAVILY_API_KEY`: present.
- `/workspace/config.json`: `llm.activeProfile=deepseek-v4-pro`; `llm.callSites.mainAgent.profile=deepseek-v4-pro` (model `deepseek/deepseek-v4-pro`, thinking disabled) — **but the env FORCE_OPENROUTER pin overrides it** (`config/llm-resolver.ts:238-242`), so mainAgent actually runs `deepseek-v4-flash` with the balanced/default profile's `effort=high`, `thinking.enabled=true`, `maxTokens=16000`. Usage rows confirm: `model=deepseek/deepseek-v4-flash`, `inference_profile=deepseek-v4-pro`, reasoning_tokens present (26-106/turn — thinking cost is currently small, not the whale).
- Streaming: request has `"stream":true` and tokens stream to SSE mid-call (`agent/loop.ts:1373-1393`) — streaming is already on; the smoke number measures completion, not first token.
- `memory.v2.enabled=true`, `ann_candidate_limit=null` (**unlimited** — sentinel 1,000,000 in `memory/v2/activation.ts:62`): whole-collection hybrid ANN scan + per-turn activation-log rows of hundreds of KB, but it runs under a hard retrieval budget inside the awaited USER_PROMPT_SUBMIT hook, and measured contextAssembly is ~0.8-2.3s — real but secondary.

## 3. Top 5 optimizations (ranked by expected saving × risk)

### 1. Shrink the tool payload: send a per-turn relevant tool set, not all 207 (expected: −3-5s warm, −40s cold, −85% token cost; medium risk)
~86k of 93k prompt tokens are tool schemas. Prefill time and per-call cost scale with them.
- Hook point exists: `createResolveToolsCallback` (`daemon/conversation.ts:634`) is invoked per round (`agent/loop.ts:1208`); core defs come from `getAllToolDefinitions()` (`tools/registry.ts:830`).
- Cheapest first cut: gate the ~69 `mcp__composio_*` schemas behind the already-shipped `COMPOSIO_SEARCH_TOOLS` meta-tool (schemas fetched on demand via `COMPOSIO_GET_TOOL_SCHEMAS`), and lazy-load `computer_use_*`/`app_control_*` (desktop-only) and `sequence_*` groups behind one loader tool each. That alone drops ~120 schemas ≈ 50-55k tokens.
- Target: a ~30-40 tool core set ≈ 12-18k prompt tokens → warm LLM call ~1.5-2.5s, cold prefill ~5s, mainAgent cost ~$0.002/call, heartbeat cost ÷5.
- Risk: the model must be able to discover a gated tool (one extra round when it needs one). This changes tool-availability mechanics — ship behind a flag and A/B against the skill-eval harness before default-on.

### 2. Provider pin for prompt-cache hits — same model, env-only (expected: −2-4s on warm repeat turns; low risk)
Cache reads are 2-4k of ~93k despite a byte-identical 90k+ prefix between rounds. Current pin `DeepInfra,StreamLake,GMICloud` (DeepInfra serves fp4; StreamLake has the worst uptime of all 18 endpoints at 96.97%). The **DeepSeek native endpoint** (uptime 99.99%, cache-read pricing published) does automatic prefix caching that reliably hits at this shape; DeepInfra lists `input_cache_read` pricing but our hit rate is ~3%.
- Mechanism already exists: `CUE_OPENROUTER_PROVIDER_ORDER` (set via `flyctl machine update --env` — remember this app has no Fly release, `secrets set` fails).
- Concrete experiment (needs user sign-off to touch prod env): try `DeepSeek,DeepInfra,GMICloud`, measure `llm_call_finished.latencyMs` + `cached_tokens` over a day. Do NOT set `REQUIRE_PARAMS=true` (known 404 trap).
- This is NOT a model change — same `deepseek/deepseek-v4-flash` weights, different host.

### 3. Stabilize the prompt prefix so caching can work at all (expected: enables #2's full win, −1-2s independently; medium risk)
The volatile `<workspace>` + `<turn_context>` + `<memory>` block is injected as the FIRST user message, ~18KB into the request, and changes every turn (timestamps, directory listing). Everything after it — including history — is cache-dead on every provider.
- Move the volatile runtime injections to the LAST user message (or a separate trailing message) in `applyRuntimeInjections` (memory-retrieval plugin, `plugins/defaults/memory-retrieval/hooks/user-prompt-submit.ts:360`), keeping system+tools+history as a stable prefix.
- Also: `buildSystemPrompt` re-renders (and re-reads workspace files) every turn (`daemon/conversation.ts:647-669`, `prompts/system-prompt.ts:366`) — memoize on inputs' mtimes; the `SYSTEM_PROMPT_CACHE_BOUNDARY` machinery (`prompts/templates/system-sections.ts:470`) only helps the Anthropic provider today.
- Risk: injection position can shift model behavior — run the skill-eval regression gate before shipping.

### 4. Cut fresh-conversation preamble (expected: −2-11s on first turns; low-medium risk)
Pre-LLM time is ~0.8s warm but 2.3-13.2s on a conversation's first turn (the smoke turn burned ~13s here — half its total). Suspects on the awaited path (`daemon/conversation-agent-loop.ts`): workspace git `ensureInitialized()` (`:612-619`), first-turn memory-v2 activation with `ann_candidate_limit=null` (unbounded Qdrant scan, `memory/v2/activation.ts:144`), and event-loop contention with heartbeat rounds on the 2-vCPU machine.
- Set `memory.v2.ann_candidate_limit` to a real bound (e.g. 256-512) — flagged last night for compute cost too; also shrinks the multi-hundred-KB `memory_v2_activation_logs` rows (biggest table per `memory/job-handlers/cleanup.ts:294`).
- Move git-init and any first-turn workspace scanning off the critical path (background with a ready-latch).
- Add `contextAssemblyStages` to the smoke output so this phase is tracked continuously (`turn_timing` line, `conversation-agent-loop.ts:1590-1607`).

### 5. Make flash routing real + reserve effort/thinking for turns that need it (expected: cost/latency headroom, not a direct simple-turn win; needs sign-off)
- Today `CUE_OPENROUTER_MODEL == CUE_OPENROUTER_FLASH_MODEL`, so the entire flash tier (28 call sites incl. `conversationTitle`, `heartbeatAgent`, triage) runs the same model as the brain, and the env pin silently overrides the user's `deepseek-v4-pro` mainAgent choice (`config/llm-resolver.ts:238-242` — the known FORCE_OPENROUTER trap). Decide the source of truth; if v4-pro is intended for mainAgent, the pin is currently a silent downgrade (which, note, is FASTER — surfacing this is a product decision, not a perf tweak).
- Effective mainAgent `effort=high` + `thinking.enabled` adds hidden reasoning tokens (76 of 79 completion tokens on the 2+2 turn!) — but at 26-106 tokens it costs only ~0.5-1s today. Tuning effort to `medium` for interactive chat is a real but small win and **changes answer behavior — do not ship without the user's sign-off**.
- The background `conversationTitle` call burns ~106 reasoning tokens per title on a flash-profile call site with `effort=low` configured but reasoning still emitted — worth a look, though it's off the hot path.

### Fix the measurement too
`prod-smoke.ts` polls every 10s, so it overstates turn latency by 0-10s (~5s expected). Poll at 1s (or read SSE) and log the `turn_timing` phases alongside — otherwise every optimization above will be invisible in the smoke numbers at the ±10s granularity.

## 4. What NOT to do

- **Do not change the brain model** — settled decision. Everything above keeps `deepseek/deepseek-v4-flash` (the #2 experiment changes only the serving host).
- **Do not lower `effort`, disable thinking, or trim SOUL/persona/memory sections without explicit sign-off** — those change answer quality/voice, and the measured win is small next to the tool payload.
- **Do not disable memory-v2 injection** to save its ~0.5-2s — it is the product's memory; bound it (`ann_candidate_limit`) instead.
- **Do not set `CUE_OPENROUTER_PROVIDER_REQUIRE_PARAMS=true`** (known 404 outage trap) and do not remove the provider pin entirely (`ALLOW_FALLBACKS=false` exists because open-weight hosts with small output caps caused the 2026-07-11 outage).
- **Do not naively drop tools with no discovery fallback** — a gated tool the model can't find is a silent capability regression; pair every removal with a loader/search meta-tool and run the skill-eval gate.
- Retention already prunes `llm_request_logs` aggressively (last night's smoke-turn rows were gone ~12h later) — don't lean on that table for long-horizon latency dashboards; use `llm_usage_events` + `trace_events`.

## 5. Raw evidence pointers

- QA-PERF conversation: `e14dd9fc-a2d3-4536-87f5-0ec6394da732` (key `qa-perf-20260720`) — archive/delete freely.
- Trace semantics gotcha (matters for anyone reading `trace_events`): `llm_call_started` fires at **first streamed byte**, not request start; true call duration is `llm_call_finished.attributes.latencyMs`; the provider-call start time ≈ the reserved assistant message row's `created_at`.
- Phase telemetry already built in: `turn_timing` log line (`daemon/conversation-agent-loop.ts:1590`) with `contextAssemblyMs`/`contextAssemblyStages`/`agentLoopMs`/`postLoopMs`; `llm_usage_events.raw_usage` has `cached_tokens` per call.
- Full pipeline map (entry `runtime/routes/conversation-routes.ts:2771` → `runAgentLoopImpl` `daemon/conversation-agent-loop.ts:241`; USER_PROMPT_SUBMIT hook chain `plugins/defaults/index.ts:263-277`) verified 2026-07-20; commitment capture is channel-path-only and backgrounded, title generation is `setTimeout(0)` fire-and-forget.
