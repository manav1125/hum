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

## Known bugs / regressions (this backlog)

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
