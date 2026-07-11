# Cue — QA/UAT Review & Backlog (2026-07-11)

_Prod: `cue-manav-prod` / manav.justcue.app. Reviewed after the voice sprint +
the brain model churn. Brain = **DeepSeek** (deepseek-chat-v3-0324 via OpenRouter);
voice = **Gemini Live** (gemini-3.1-flash-live-preview)._

## QA/UAT results — what's working (verified this pass)

| Area | Status | Evidence |
|---|---|---|
| **Chat brain (DeepSeek)** | ✅ Works | Substantive, context-aware replies (pulled real priorities: Gmail/Slack auth, AEF fund) |
| **App builder (agentic)** | ✅ Completes | Counter + Pomodoro builds ran multi-step tool loops → `file_write` → final "here's your app". The Gemini "empty → nothing" is gone. |
| **Voice (Gemini Live)** | ✅ Connects | `ready` frame, key resolves independently of the brain now |
| **Voice → saved thread** | ✅ Works | Transcript persisted, first-person recap, auto-title, surfaced in history |
| **Web search (Tavily)** | ✅ Works | Real sourced results ("Lewis Hamilton won… [Wikipedia]") |
| **Tasks / work-items** | ✅ Works | Voice `add_task` → queued to-do (not auto-run); shows in Activity → Queued |
| **Activity / Agents / Schedules** | ✅ 200 | API health OK |
| **Memory** | ✅ Present | memory_graph_nodes + jobs tables active |

## RESOLVED — total chat/build outage (root cause: 64000-token output default)

**Symptom:** every chat + agentic turn failed intermittently/totally — 400 "provider
rejected the request", empty `[]` bubbles, "AI provider returned a server error",
404 "no endpoints found". Looked like model/provider churn; it was one config bug.

**Root cause:** `llm.default.maxTokens` defaults to **64000** (`schemas/llm.ts:325`).
That's correct for Claude/Gemini (200k+ context) but every open-weight DeepSeek
provider on OpenRouter caps `max_completion_tokens` at ~16000 (StreamLake 16000,
DeepInfra 16384, Novita 16000) and Novita's whole context is 64000. Reserving 64000
for output → `6.7k input + 64k output = 70.7k > provider limit` → the provider 400s
(context overflow) or 5xxs (output cap). Because OpenRouter load-balances across the
pool, the failure mode varied by which provider caught the request, which is why it
looked random. Cheap direct calls succeeded only because they routed to a healthy
provider with a tiny payload.

**Fix (live, no rebuild):** `assistant config set llm.default.maxTokens 16000` on the
prod machine. Fits all three providers with ample context headroom; unpins routing.

**Supporting fix (shipped):** env-driven OpenRouter provider routing —
`CUE_OPENROUTER_PROVIDER_ORDER` / `_ALLOW_FALLBACKS` / `_REQUIRE_PARAMS` (read in
`openrouter/client.ts buildExtraCreateParams`) so a self-host can pin routing to
large-context healthy providers without a rebuild. Prod set to
`ORDER=DeepInfra,StreamLake,Novita, ALLOW_FALLBACKS=true`. **Do NOT set
`REQUIRE_PARAMS=true`** — it filtered out every endpoint (404) because Cue's full
payload advertises params not all providers list.

**Brain model:** landed on **`deepseek/deepseek-chat`** (maintained alias; large
context; clean content + tool calls). Ruled out this session: `deepseek-chat-v3-0324`
(providers degraded/incompatible), `deepseek-chat-v3.1` (hybrid-reasoning → empty
content through Cue's path), `kimi-k2` (context window too small for Cue's payload).

**The ceiling (still the real decision):** this OpenRouter key can only reach
open-weight models — `anthropic/*` = "no endpoints", `openai/*` + `google/*` =
ToS-prohibited. For Claude-class quality + reliable agentic follow-through, add a
**direct Anthropic API key** (Cue has a first-class Anthropic path) — that ends the
whole model saga. DeepSeek stays the best available until then, but still narrates-
then-stops on some agentic turns.

## Known bugs / regressions (this backlog)

### P0 — app-builder open (PARTIALLY FIXED this session)

**Shipped:** (1) `app_refresh` now surfaces the inline Open card on a clean compile
(`auto_opened:true`) — the multifile flow (create-scaffold → file_write → refresh)
no longer depends on the model also calling `app_open`. (2) Skill guardrail + web
`isNonNavigableAppLink` widened to forbid/neutralize hallucinated app addresses
(`preview://`, single-slash `sandbox:/preview/<id>`, `![](…)` image embeds).

**Still open (deepseek-specific):** the weak brain sometimes stops after `file_write`
without calling `app_refresh` at all, then writes a fake link — so no card AND a dead
link. The `app_refresh`→card fix only fires if the model refreshes. Fully deepseek-
proof would need a `file_write`-under-`apps/src` side-effect that compiles + surfaces
the card automatically, or a stronger brain. Backlog: auto-surface on app-file write.

### P0 (historical) — app-builder: apps build + serve but don't OPEN from the client
_Investigated the "3D Game Bali Motorbike" thread._ The app **`bali-bike-buddies`**
(appId `c65902f3-ff30-442f-b23e-05997f8575b6`) built fine: valid compiled Preact
bundle on disk (`/workspace/data/apps/…/dist/`), and it **serves cleanly**
(`/v1/apps/:id/dist/index.html|main.js|main.css` all HTTP 200). So the app is real
and works server-side. Two things break the user experience:
- **The model hallucinated a fake link** in chat: `[…](preview://app/bali-motorbike-adventure)`.
  `preview://` is not a real scheme — clicking it in macOS falls back to the
  conversation URL. The model (esp. DeepSeek) must NOT write app links at all;
  apps open via the app surface card / Library → `/v1/apps/open-bundle` →
  `vellumapp://` window (macOS) or the web `library/:appId` route.
- **The proper "open app" affordance** (surface card / auto_open) either isn't
  surfacing or its open action misroutes to the conversation. _This is the real
  client bug — in the macOS bundle-open flow (`bundle-flow.ts`/`app-protocol.ts`)
  or the web app-surface card._
- **Over-promising:** the sandbox builds 2D web (Preact), not true 3D games. The
  model should scope "3D game" requests honestly (offer a 2D interactive build)
  rather than claim a game and produce a directory listing.
- **Workaround for now:** open built apps from the **Library**, not the chat link.

### P0 — correctness / just-introduced
1. **Empty `[]` assistant bubble before agentic turns.** A spurious empty assistant
   message is persisted before the real tool call/text on build turns. Cosmetic
   (blank bubble), the flow completes — but looks broken. _Root: agent-loop
   placeholder/streaming persistence. Investigate `conversation-agent-loop`
   message creation._
2. **Gemini 3.x is incompatible as the brain** — DO NOT re-enable. 3.x models
   (3.1-pro, 3.5-flash) require a `thought_signature` echoed on every tool call;
   Cue doesn't round-trip it → HTTP 400 on the 2nd tool turn → empty responses.
   This caused today's "nothing works" outage. Fix = add thought_signature
   preservation to the OpenAI-compat provider (unlocks strong Gemini 3.x). Until
   then, brain must stay on DeepSeek or a 2.5 model.

### P1 — model strategy (the real quality question)
3. **DeepSeek is slow (~30–50s/turn) and wanders on trivial lookups** (looked in
   Slack for a task list). Strong on building (what you care about), weak on
   speed + simple reasoning. **Decision owed:** stay on DeepSeek, or add an
   **Anthropic key → Claude** (fastest *and* strongest — the real fix), or invest
   in the Gemini-3.x thought_signature fix to use your existing Gemini billing.
4. **Task-based model routing** (optional): pro/strong model for build/agentic,
   fast model for chat/voice — needs the FORCE_OPENROUTER pin made call-site-aware.

### P1 — voice (your "review tonight")
5. **Barge-in echo** — on with a sustained-speech guard + raised threshold; may
   still false-trigger on some speakers. Needs real per-device AEC tuning (or a
   headset). Toggle off per-device: `localStorage cue.voiceBargeIn=0`.
6. **App-builder "not visual/appealing"** — builds now *complete*, but verify the
   visual quality bar on DeepSeek (your 3D-game complaint was partly "there's no
   3D engine" — the builder is 2D web; set expectations or add a stronger visual
   scaffold/templates).
7. Voice engine toggle (Classic/Realtime) is a dev affordance — decide the default
   + whether to expose it in real UI.

### P2 — feature backlog (pre-existing)
8. **Twilio phone-calling** — stack is built (ConversationRelay through the agent
   loop), not configured. You're setting up the Twilio account (~1–2 days); then
   I wire creds + number + ingress end-to-end.
9. **⌥R native macOS voice** (#29) — dormant Swift lift (mode capture / VAD /
   dynamic hotkeys).
10. **Paperclip budget hard-stop** (WS1) — engine built, inert/undeployed. Wire
    the run-boundary enforcement + deploy.
11. **Render deprecation** — Render still live as rollback; retire once confident
    on Fly.
12. **Empty-state CTAs + first-run tooltips** (#17) across surfaces.
13. **iOS App Store submission** (#81) — past TestFlight.

### P2 — infra hardening
14. **FlyDriver 412 retry** (#82) on volume-host capacity.
15. **Daemon supervision** (#83) — OOM currently leaves a gateway-only zombie.
16. **thought_signature round-trip** (from #2) — the proper unlock for Gemini 3.x.

## Recommended next 3
1. **Pick the brain** (P1 #3) — this is the single biggest lever on your daily
   experience. If you'll add an Anthropic key, Claude ends the whole model saga.
2. **Kill the empty-bubble bug** (P0 #1) — small, makes builds *look* as reliable
   as they now *are*.
3. **Voice review** (P1 #5–7) — as planned tonight.
