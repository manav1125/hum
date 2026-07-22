# Cue Live — Real-Time Voice Conversation: Research & Architecture

**Date:** 2026-07-09
**Question:** How should Cue add a real-time, two-way voice *conversation* mode (a companion/therapist/co-founder that talks with you) — keeping the existing record→transcribe→action-items "voice magic" mode — with full context on the user's work + memories, and end-of-session synthesis into action items, agent hand-offs, and memory updates?
**Companion:** `docs/cue-live-voice-execution-brief.md` (the build hand-off).

---

## 1. Bottom line up front

1. **Cue already built the hard part.** A full-duplex live-voice engine exists in the repo, dormant: streaming STT, interruptible/barge-in TTS, a WebSocket protocol, and a bridge (`voice-session-bridge.ts:startVoiceTurn()`) that pipes a live voice turn **through the real agent loop** — i.e. Claude, with all of Cue's tools and memory. This is the correct architecture, already implemented. The work is to **turn it on and complete the last ~15%**, not integrate a voice vendor from scratch.

2. **Keep Claude as the brain → use a cascaded pipeline, not a speech-native model.** Speech-native models (OpenAI Realtime, Gemini Live, Grok voice) are lower latency (~200-300ms) but **lock reasoning inside the vendor's model** — you cannot use Claude, and you lose the text intermediary where Cue's tool-calling, memory injection, and action-extraction live. Cue's entire differentiator (context + actions + memory) lives in the brain, so the cascaded route (STT → Claude → TTS, ~900ms-1s) is the right default. This is what Cue already wired.

3. **The three real gaps are exactly the user's three asks:** (a) **personality** — pass a per-mode persona (companion/therapist/co-founder) at session start; (b) **context** — a fast "what you're working on + who you are" briefing digest to pre-seed the session (prompt-cached); (c) **end-of-session synthesis** — turn the conversation into work-items → agent hand-offs → memory updates, which the dictation path already does but the live path does not.

4. **Provider choice is a swap, not a rebuild.** Cue already has Deepgram + xAI realtime STT wired. For TTS/turn-taking quality, the two production-grade, self-hostable, BYO-Claude orchestration options are **LiveKit Agents** and **Pipecat** — but Cue's own `live-voice` engine already does the orchestration, so a provider swap is just STT/TTS module selection. Recommended v1 stack: **Deepgram STT → Claude (via OpenRouter) → ElevenLabs Flash or Cartesia Sonic TTS**.

---

## 2. The market map: speech-native vs cascaded

Every real-time voice product is one of two architectures. This is the pivotal decision and it's already made for us by Cue's differentiator.

| | **Speech-native (S2S)** | **Cascaded (pipeline)** |
|---|---|---|
| How | One model: audio in → reason → audio out | STT → your LLM → TTS, streamed |
| Examples | OpenAI Realtime (`gpt-realtime-2.1`), Gemini Live, Grok voice | ElevenLabs Agents, Deepgram Voice Agent, LiveKit, Pipecat, Vapi, Retell, Perplexity voice |
| Latency | ~200-300ms | ~900ms-1.4s (well-tuned ~900ms) |
| **Keep Claude as brain?** | **No — locked to vendor model** | **Yes** |
| Tools/memory/actions | Only via their function-calling; reasoning is theirs | Native — it's your own agent loop |
| Cost | $0.30/min (OpenAI) → ~$0.005-0.02/min (Gemini) | Predictable ~$0.01-0.17/min + your LLM |
| Transcripts | Yes (both turns) | Native |

**Why cascaded wins for Cue:** the text intermediary is where Cue lives. Cue's memory retrieval, work-item/agent tools, guardrails, and action extraction all operate on text through the agent loop. A speech-native model would make Cue re-implement all of that against a foreign model *and* give up Claude's reasoning. Industry consensus (Coval, Twilio, the production Twilio+Claude case study) is that cascaded "remains the correct architectural default" whenever you need your own brain, tools, and auditability. Perplexity and (per the user) the best BYO-brain conversational products use cascaded; Grok/OpenAI feel snappier precisely because they gave up model choice.

**Latency budget for a sub-1s cascaded turn** (Twilio's allocation, matched by a real Deepgram→Claude→ElevenLabs build at ~900ms avg):

| Stage | Target | Notes |
|---|---|---|
| STT | 350ms | Deepgram streaming; endpointing on transcript, not silence |
| Claude time-to-first-token | 375ms | Prompt-cache the memory/system prefix (below) |
| TTS time-to-first-byte | 100ms | ElevenLabs Flash v2.5 (~135ms) or Cartesia Sonic (~40-90ms) |
| Turn detection | 150-200ms | Semantic/model-based endpointing, not fixed 800ms silence |
| Network + orchestration hops | ~150ms | Collocate services; minimize hops |

The single biggest lever after streaming is **end-of-turn detection** — a fixed 800ms silence timeout "adds nearly a full second to every response." Use model-based/semantic turn detection with adaptive interruption handling.

---

## 3. Provider landscape (early 2026)

**Speech-native (great latency, but they own the brain — ruled out for BYO-Claude):**
- **OpenAI Realtime** — `gpt-realtime` GA Aug 2025; `gpt-realtime-2` (May 2026, 128k ctx, GPT-5-class reasoning); `gpt-realtime-2.1` (Jul 2026, configurable reasoning, −25% p95 latency). WebRTC/WebSocket/SIP, async + parallel function calling, dual-turn transcripts, ~200ms TTFA, $32/$64 per 1M audio tokens (2.1-mini $10/$20). Cannot substitute Claude in the S2S path.
- **Gemini Live** — native-audio, locked to Gemini, cloud-only, affective dialog + barge-in, token-priced. "Half-cascade" only rents its ears, not its brain.
- **Grok voice** — unified S2S, locked, sub-second, full-duplex.

**Cascaded / orchestration (keep Claude — the relevant set):**
| Provider | BYO-Claude | Self-host | Barge-in | Mid-convo tools | ~Latency | Pricing |
|---|---|---|---|---|---|---|
| **LiveKit Agents** | ✅ (plugin/endpoint) | ✅ full OSS | ✅ semantic + adaptive | ✅ + native MCP | pipeline, low | OSS + Cloud/infra + model |
| **Pipecat (Daily)** | ✅ LLM-agnostic | ✅ full OSS | ✅ auto-cancel | ✅ multi-agent | pipeline, low | OSS + $0.01/min Cloud |
| **Deepgram Voice Agent** | ✅ OpenAI-compat | ✅ on-prem (ent.) | ✅ during synthesis | ✅ async, no pause | tunable/low | ~$3-4.50/hr, BYO discount |
| **ElevenLabs Agents** | ✅ OpenAI-compat | ❌ cloud | ✅ | ✅ auto-injected | low | per-min tiers + LLM |
| **Hume EVI 3** | ✅ supplemental LLM | ❌ cloud | ✅ | ✅ config | ~300ms | ~$0.04-0.07/min, emotion layer |
| **Cartesia Sonic + Line** | ✅ LiteLLM (Anthropic default) | ⚠️ SDK OSS, CN cloud | ✅ | ✅ decorators | 40-90ms TTS | usage + platform |
| **Vapi** | ✅ custom endpoint | ❌ cloud | ✅ | ✅ | ~1-1.5s | ~$0.05 base → $0.13-0.31/min |
| **Retell** | ✅ custom (WS) | ❌ cloud | ✅ | ✅ | sub-500ms | $0.07/min all-in |

**Under the hood of what the user cited:** Grok = speech-native (locked). OpenAI = speech-native (locked). **Perplexity = cascaded** (on-device ASR → their choice of LLM incl. Claude → TTS) — confirming that the best BYO-brain conversational UX uses cascaded; they just lack Cue's action + memory layer. This is precisely Cue's opening.

**Component-model leaders (for the STT/TTS slots in Cue's own engine):** STT — Deepgram Nova-3 (~200-400ms, self-hostable), or xAI realtime (already wired). TTS — **ElevenLabs Flash v2.5** (~135ms TTFB, best expressiveness) or **Cartesia Sonic 3** (~40-90ms, emotion tags, cheapest, self-host-ish). Anthropic has **no native voice API** — every production Claude voice agent uses this cascaded shape.

---

## 4. The architecture patterns that make it good

1. **Stream tokens into TTS sentence-by-sentence** — first audio plays while Claude is still generating; cuts perceived latency 3-5×.
2. **Prompt-cache the memory/context prefix** — inject the big personalized payload (who you are + what you're working on + relevant memories) as a cacheable system-prompt prefix at session start. Anthropic prompt caching: up to 90% cost and 75-85% TTFT reduction; 5-min TTL that **refreshes on each use**, so it stays warm turn-over-turn in an active conversation. This is how you afford a large context without killing latency.
3. **Pre-fetch context into a fast cache (dual-agent RAG)** — a background "slow thinker" pre-loads likely-needed context (active projects, today's schedule, recent memories) into a rapid buffer so the foreground conversation reads memory in ~5ms instead of doing a 400ms live retrieval mid-turn. Cue's `context-search` already fans out to memory/workspace/conversations — wrap it as a session-start briefing.
4. **Filler speech masks tool latency** — "let me check…" makes a 1000ms tool call feel like 500ms. Emit a short filler when Claude starts a tool call during a turn.
5. **Model-based turn detection + adaptive interruption** — semantic endpointing fires before trailing silence; adaptive handling rejects ~51% of false barge-ins (backchannels like "mm-hmm") while catching true interrupts faster. AEC on the client so the agent doesn't hear itself.
6. **End-of-session structured extraction** — run one typed pass over the timestamped transcript producing a schema with three sections: **action items** (→ work-items), **hand-offs** (→ agent assignment), **memory updates** (→ graph). Force rigid JSON, anchor relative dates ("next Tuesday") to the session date.
7. **Persona via system prompt** — the whole personality lives in the system prompt: contractions, varied sentence length, backchannels, pacing 0.9-1.1×. Different modes (companion/therapist/co-founder) = different persona prefixes + optionally different voice.

---

## 5. What Cue already has vs. what's missing (verified 2026-07-09)

**EXISTS (dormant full-duplex engine — do not rebuild):**
- `assistant/src/live-voice/live-voice-session.ts` — bi-directional streaming STT + interruptible TTS, `fullDuplex` flag, 120s idle timeout.
- `assistant/src/live-voice/protocol.ts` — WS frames incl. `interrupt` (barge-in), `stt_partial/final`, `assistant_text_delta`, `tts_audio/done`.
- `assistant/src/calls/voice-session-bridge.ts` — `startVoiceTurn()` pipes a voice turn **through the real agent loop** (Claude + tools + memory). **This is the cascaded BYO-Claude architecture, already built.**
- `assistant/src/live-voice/live-voice-tts.ts` (streaming TTS), `live-voice-session-manager.ts` (`/v1/live-voice` WS route).
- Streaming STT providers: `assistant/src/providers/speech-to-text/{deepgram-realtime,xai-realtime}.ts`.
- Web client: `apps/web/src/domains/chat/voice/live-voice/{pcm-capture,live-voice-client,tts-playback,live-voice-store}.ts`, `live-voice-button.tsx`.
- macOS: `apps/macos/src/main/{cue-live-service.ts (⌥R CUE_LIVE_RUN),cue-live-ipc.ts ("cue-live:start-voice"),cue-voice-keys.ts (encrypted keys)}`.
- Current shipped "voice magic": `voice-dictation-surface.tsx` → `/v1/stt/transcribe` → `voice-intake.ts:generateVoiceIntake()` (`capture_voice_intake` tool extracts action items) → `action-item-work-items.ts:actionItemsToWorkItems()`. **Keep this mode as-is.**
- Persona system: `assistant/src/prompts/system-prompt.ts:buildSystemPrompt()` + `persona-resolver.ts` (accepts a persona override — wired, unused).
- Context: `assistant/src/memory/context-search/search.ts` (fans out to memory/workspace/conversations); work-items/agents/missions/schedule stores.
- End-of-turn handoff primitives: `actionItemsToWorkItems()`, `work-item-store.ts:upsertWorkItem()`, `memory/graph/conversation-graph-memory.ts:insertMemoryNode()`.

**MISSING (the build):**
- Client never sets `fullDuplex: true` → the conversation loop is off.
- ⌥R renderer-side listener unwired (`cue-live-ipc.ts` main→renderer half not consumed).
- No feature flag separating live-conversation from dictation; no voice config block.
- **No per-mode persona** passed at session start (companion/therapist/co-founder).
- **No fast "briefing digest"** pre-seeding the session with active work/schedule/memories (context-search isn't wired as a low-latency session-start pre-seed + prompt-cache).
- **No end-of-session synthesis** for live conversations (work-items + agent hand-offs + memory updates) — dictation has it; the live path doesn't.
- No filler-speech-on-tool-call; turn detection tuning; adaptive interruption.

---

## 6. Recommended shape for Cue Live

- **Two modes, one engine.** Keep "Voice note" (dictation → action items) untouched. Add "**Cue Live**" = the dormant full-duplex engine, turned on, running through the agent loop (Claude brain, tools, memory).
- **v1 stack:** Deepgram streaming STT → Claude via OpenRouter (existing agent loop) → ElevenLabs Flash or Cartesia Sonic TTS. All swappable; Cue's engine already abstracts the STT/TTS slots.
- **Personality:** ship 3 personas (Companion, Therapist/Reflective, Co-founder/Operator) as system-prompt prefixes + a default voice each; user-selectable at session start.
- **Context:** a `buildLiveBriefing()` that assembles identity + active projects/work-items/missions + today's schedule + top relevant memories into a prompt-cached prefix at session start; refresh warm across turns.
- **End-of-session:** on session end, one structured pass over the transcript → {action_items[], handoffs[], memory_updates[]} → `actionItemsToWorkItems()` + agent assignment + `insertMemoryNode()`; show the user a session recap they can approve/edit.
- **Keep it self-hostable & cheap:** cascaded on our own engine means no per-minute vendor tax beyond STT+TTS+Claude tokens (~$0.01-0.05/min), fits the Cue hosting-economics posture, and works local-first on the Mac.

Full build steps, exact hooks, and non-regression rules: `docs/cue-live-voice-execution-brief.md`.
