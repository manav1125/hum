# Execution Brief: "Cue Live" — Real-Time Voice Conversation Mode

**Date:** 2026-07-09 · **For:** the build thread on the Cue repo
**Companion:** `docs/cue-live-voice-research.md` (full research + architecture + provider landscape).
**Prime directive:** **additive and gap-filling only.** Cue already contains a complete, dormant full-duplex live-voice engine that runs through the real agent loop (Claude + tools + memory). Do **not** rebuild it, and do **not** touch the existing "voice note" dictation mode. This brief turns the dormant engine on and completes the ~15% that's missing: a conversation loop, personality, context pre-seed, and end-of-session synthesis.

---

## 1. Originating ask

The founder wants Cue to "come alive" as a real conversationalist — a second mode alongside today's record→transcribe→action-items "voice magic" (which stays). In the new mode the user fully converses with Cue as assistant / therapist / partner-in-crime / co-founder; Cue has context on everything the user is working on plus their memories and relevant personal context, holds a real back-and-forth, and at the end produces actionable steps it can hand off to agents (or just updates memory) — closing the session like a good working session. Perplexity and Grok do the conversation well; OpenAI too — but they lack Cue's action layer and memory contextualization. Keep the existing mode; add the live mode.

## 2. Key finding that shapes the build

Cue already built the cascaded, bring-your-own-Claude voice architecture and left it dormant. The live conversation is meant to run **through the existing agent loop** (`voice-session-bridge.ts:startVoiceTurn()`), so the brain is Claude with all of Cue's tools and memory — which is exactly why Cue can do the action + memory layer that Perplexity/Grok/OpenAI can't. We are **not** adding a speech-native vendor (OpenAI Realtime/Gemini/Grok) — those lock reasoning inside their model and would throw away Cue's differentiator. We keep the cascaded pipeline: **Deepgram STT → Claude → ElevenLabs/Cartesia TTS**, all already abstracted by Cue's `live-voice` engine.

## 3. What EXISTS (do NOT rebuild — verified 2026-07-09)

| Piece | Files | Status |
|---|---|---|
| Full-duplex session engine | `assistant/src/live-voice/live-voice-session.ts` (`fullDuplex` flag, 120s idle), `protocol.ts` (`interrupt`/barge-in, `stt_partial/final`, `assistant_text_delta`, `tts_audio/done`), `live-voice-session-manager.ts` (`/v1/live-voice` WS) | Built, dormant |
| Voice turn → agent loop bridge | `assistant/src/calls/voice-session-bridge.ts` (`startVoiceTurn`, `setVoiceBridgeDeps`) | Built — **Claude brain + tools + memory already** |
| Streaming STT providers | `assistant/src/providers/speech-to-text/{deepgram-realtime,xai-realtime}.ts`, `config/schemas/stt.ts` | Built |
| Streaming TTS | `assistant/src/live-voice/live-voice-tts.ts`, `calls/resolve-call-tts-provider.ts` | Built |
| Web client audio | `apps/web/src/domains/chat/voice/live-voice/{pcm-capture,live-voice-client,tts-playback,live-voice-store,connection}.ts`, `live-voice-button.tsx` | Built |
| macOS hotkey + keys | `apps/macos/src/main/{cue-live-service.ts (⌥R `CUE_LIVE_RUN`),cue-live-ipc.ts (`cue-live:start-voice`),cue-voice-keys.ts}` | Built; renderer half unwired |
| Persona system | `assistant/src/prompts/system-prompt.ts:buildSystemPrompt()` (accepts persona override), `persona-resolver.ts` | Built; override wired but unused |
| Context fan-out | `assistant/src/memory/context-search/search.ts` + `sources/{memory,memory-v2,conversations,workspace}.ts` | Built |
| Handoff primitives | `runtime/services/action-item-work-items.ts:actionItemsToWorkItems()`, `work-items/work-item-store.ts:upsertWorkItem()`, `memory/graph/conversation-graph-memory.ts:insertMemoryNode()`, agent-store | Built |
| Existing dictation mode (KEEP) | `apps/web/.../voice/voice-dictation-surface.tsx` → `/v1/stt/transcribe` → `runtime/services/voice-intake.ts` → `actionItemsToWorkItems()` | Shipped — **leave untouched** |
| Feature flags | `meta/feature-flags/feature-flag-registry.json`, `assistant/src/config/assistant-feature-flags.ts` | Pattern to reuse |

## 4. Workstreams

WS1–WS4 are the core "make it a real conversationalist" build (P0). WS5–WS6 are polish/latency (P1). Each: gap → exact hooks → non-regression → acceptance.

---

### WS1 — Turn on the conversation loop behind a new flag (P0)

**Gap:** the engine supports `fullDuplex` but no client sets it, and there's no flag separating live-conversation from dictation.

**Build:**
1. New feature flag `voice-live` (assistant scope, `defaultEnabled:false`) in `feature-flag-registry.json`; gate via `isAssistantFeatureFlagEnabled("voice-live")`.
2. New config block `assistant/src/config/schemas/voice-live.ts` (Zod + defaults): `{ enabled:false, fullDuplex:true, idleTimeoutMs:120000, defaultPersona:"companion", sttProvider, ttsProvider, voiceId }`; register in `config/schema.ts`.
3. Web: a "Cue Live" entry (distinct from the existing "Voice note" button) that calls `LiveVoiceChannelClient.connect({ fullDuplex:true, mode:"live", persona })`. Reuse `live-voice-store.ts`/`live-voice-client.ts` — just pass the flag.
4. Daemon: `live-voice-session.ts` already loops on `fullDuplex:true`; confirm the loop-after-`tts_done` path and idle-timeout close are correct end-to-end.

**Non-regression:** the existing dictation surface and `/v1/stt/transcribe` + `voice-intake` path are untouched; `voice-live` OFF = today's behavior exactly; live mode is a separate entry point, not a replacement.

**Acceptance:** with the flag on, a user opens Cue Live, speaks, Cue replies in voice, the user interrupts (barge-in works), and the conversation continues turn-after-turn until the user ends it.

---

### WS2 — Personality / persona modes (P0)

**Gap:** `buildSystemPrompt()` accepts a persona override but the live path passes none, so there's no character.

**Build:**
1. Author 3 persona prefixes (markdown, alongside the existing persona/prompt templates): **Companion** (warm, curious, casual), **Reflective/Therapist** (calm, listening, reflective — *not* clinical advice; add a safety note to defer to professionals on crisis topics), **Co-founder/Operator** (direct, strategic, action-biased). Voice guidance in each: contractions, varied sentence length, backchannels, pacing 0.9-1.1×.
2. Thread a `persona` param from the client `start` frame (`protocol.ts`) → session → `voice-session-bridge.ts` → `buildSystemPrompt({ personaOverride })`. Default from `voice-live.defaultPersona`.
3. Optionally map each persona to a default `voiceId` (TTS) in config.
4. Web: a small persona picker on the Cue Live surface (Companion default).

**Non-regression:** persona override only applies in live mode; text chat and dictation personas unchanged. Absent/unknown persona → current default prompt.

**Acceptance:** switching persona audibly changes tone/voice; the reflective persona defers appropriately on crisis-adjacent topics; default is Companion.

---

### WS3 — Context pre-seed: the "briefing digest" (P0)

**Gap:** no fast function assembles "who you are + what you're working on + relevant memories" to seed the session; `context-search` does it dynamically per-turn, which is too slow to seed a low-latency voice open.

**Build:**
1. New `assistant/src/live-voice/build-live-briefing.ts:buildLiveBriefing({assistantId})` returning a compact markdown block: identity/about-you (from `memory/pkb/context.ts`), active projects + open work-items + missions (work-items/project/mission stores), today's + upcoming schedule (`schedule/`), and top-N relevant memories (`context-search` with a fast/low-latency variant or a cap). Keep it tight (aim ≤~2-4k tokens).
2. Inject it as a **cacheable system-prompt prefix** at session start (Anthropic prompt caching — mark the briefing + persona as a cache breakpoint) so time-to-first-token stays low and the prefix stays warm across turns (5-min TTL refreshes on use). Confirm the provider path (OpenRouter→Anthropic) passes cache-control; if not reachable, still inject (correctness first, caching as optimization).
3. Optionally kick a background "slow thinker" pre-fetch (dual-agent RAG pattern) so deeper context is warm if the conversation goes there — v1 can skip this and just use the briefing.

**Non-regression:** briefing is live-mode only; if assembly fails, log-and-continue with a minimal prefix (never block the session). No change to how text turns build context.

**Acceptance:** in a live session Cue accurately references the user's actual current projects, a scheduled item, and a known personal fact within the first exchange, with first audio still fast (<~1.5s).

---

### WS4 — End-of-session synthesis: action items, hand-offs, memory (P0)

**Gap:** dictation extracts action items via `voice-intake`, but a live conversation ends without synthesizing tasks/hand-offs/memory. This is the user's "close the session with actionable steps handed to agents + memory updates."

**Build:**
1. On session end (user ends, or idle-timeout close in `live-voice-session.ts`), run one **structured extraction** pass over the full timestamped transcript → typed schema `{ summary, action_items[], handoffs[{title, agentId?}], memory_updates[] }`. Reuse the `capture_voice_intake`-style forced-tool pattern from `voice-intake.ts` (generalize it rather than duplicate). Anchor relative dates to the session date; force rigid JSON.
2. Route outputs through existing primitives: `actionItemsToWorkItems()` (tag `source:"voice-live"`, idempotent on conversationId+title); assign hand-offs to agents via the agent-store/work-item owner; write `memory_updates` via `insertMemoryNode()` (or enqueue the existing retrospective memory job).
3. Emit a **session recap** to the client (new server frame or reuse `archived` payload) so the user sees "Here's what I'll do / remember" and can approve/edit before it commits — mirrors the Review-lane ethos. Respect Guardrails (autonomy/checkpoints) for anything that would auto-run.

**Non-regression:** live-mode only; reuses existing stores (no schema change beyond a `source` tag value); if extraction fails, the conversation + transcript are still saved (never lose the session). Don't double-mint with the dictation path.

**Acceptance:** after a live conversation that mentions 2-3 to-dos and a fact about the user, ending the session creates the corresponding work-items (some assigned to agents) and a memory update, shown in a recap the user can approve; declining the recap commits nothing.

---

### WS5 — ⌥R hotkey + macOS/native activation (P1)

**Gap:** ⌥R plumbing exists to the main process but the renderer-side listener is unwired (`cue-live-ipc.ts` `cue-live:start-voice` not consumed).

**Build:** wire the `startVoiceDispatcher` in `cue-live-service.ts` → `cue-live-ipc.ts` `cue-live:start-voice` → renderer handler that calls `LiveVoiceChannelClient.connect({fullDuplex:true, mode:"live"})`. Verify mic permission + `cue-voice-keys.ts` decryption path. (iOS activation is a follow-up; not in v1.)

**Non-regression:** ⌥R only starts live mode when `voice-live` is on; no change to existing hotkeys.

**Acceptance:** pressing ⌥R on macOS opens Cue Live and starts listening.

---

### WS6 — Latency & naturalness polish (P1)

**Build (from the research best-practices):** (a) stream Claude tokens into TTS sentence-by-sentence (confirm `live-voice-tts.ts` segments on sentence boundaries, first audio while Claude still generates); (b) emit a short **filler** ("let me check…") when a turn triggers a tool call, to mask tool latency; (c) tune **turn detection** toward semantic/model-based endpointing rather than a long fixed silence, with adaptive interruption to reject backchannel false-positives ("mm-hmm"); (d) ensure client-side **AEC** so Cue doesn't interrupt itself; (e) pick v1 TTS (ElevenLabs Flash v2.5 for expressiveness or Cartesia Sonic for speed/cost) via config.

**Acceptance:** measured end-to-end turn latency ~≤1s in a good network; interruptions feel clean; no self-interruption; tool calls don't produce dead air.

---

## 5. Global guardrails

1. **Additive only.** Keep the dictation "voice note" mode and its endpoints byte-for-byte. Live mode is a separate entry point + flag.
2. **Reuse the dormant engine** — extend `live-voice/*` and `voice-session-bridge.ts`; do not write a new voice stack or bolt on a speech-native vendor.
3. **Cascaded/BYO-Claude only** — the live turn must run through the existing agent loop so tools + memory + Guardrails all apply. No reasoning offloaded to a voice vendor.
4. **Feature-flag everything** (`voice-live`), verify OFF state = today's behavior with no new routes' side effects.
5. **Config schema pattern** — new `voice-live.ts` block with safe defaults; migrations (if any) additive, next index after the latest.
6. **Rebrand boundary** — display "Cue Live"; keep `vellum`/`live-voice` internal ids and existing protocol frame names.
7. **Secrets** — STT/TTS keys stay in the encrypted `cue-voice-keys.ts` path / Guardian-CES; never to the renderer or logs.
8. **Self-host + local-first parity** — live mode must work on the local Mac daemon; degrade gracefully if a provider key is absent (clear error, no crash). Test the `local:` owner principal.
9. **Guardrails integration** — end-of-session auto-actions respect existing autonomy/checkpoints; anything that would auto-run external actions goes through the recap/approval.
10. **Verification standard** — exercise the real `/v1/live-voice` WS with real audio; assert transcripts, barge-in, and that ending a session creates the expected work-items/memory (assert persisted state). Drive the real web surface; test against the prod URL, not the vite preview proxy (it 404s new daemon routes — known gotcha). Add a Cue Live check to `assistant/qa/prod-smoke.ts`. Rebuild the macOS SPA snapshot after web changes.

## 6. Sequencing & acceptance

| Order | Item | Done means |
|---|---|---|
| 1 | WS1 loop + flag | Multi-turn spoken conversation with working barge-in behind `voice-live`; dictation unchanged |
| 2 | WS2 personas | 3 selectable personas audibly distinct; Companion default; reflective persona safe on crisis topics |
| 3 | WS3 briefing | Cue references real current work + schedule + a personal memory in the first exchange; first audio <~1.5s |
| 4 | WS4 synthesis | Ending a session yields approvable work-items + agent hand-offs + memory updates via existing primitives |
| 5 | WS5 ⌥R | ⌥R opens Cue Live on macOS |
| 6 | WS6 polish | ~≤1s turns, clean interruptions, filler on tool calls, no self-interruption |

Report per-workstream: what changed, what was verified (with real-surface evidence — WS audio, persisted work-items/memory), what's unverified/risky. Numbered, low-fluff.

## 7. Provider defaults (v1)

STT **Deepgram** streaming (already wired; xAI realtime as fallback). Brain = **Cue's existing agent-loop LLM** — do not hardcode a model; use whatever `CUE_OPENROUTER_MODEL` resolves to (note: prod currently runs `deepseek/deepseek-chat-v3-0324` because the OpenRouter key is ToS-blocked from `anthropic/*`+`openai/*` — the cascaded design is model-agnostic, so this doesn't change the architecture, but don't assume Claude is reachable; the prompt-caching optimization in WS3 is Anthropic-specific and should degrade gracefully when the active model isn't Anthropic). TTS **ElevenLabs Flash v2.5** (expressive) or **Cartesia Sonic 3** (fast/cheap) — config-selectable. All swappable via the existing STT/TTS provider abstraction; no speech-native vendor. Full provider comparison + latency budget in `docs/cue-live-voice-research.md`.
