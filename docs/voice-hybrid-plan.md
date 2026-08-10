# Voice hybrid — speech-native front, Cue brain behind

Decision (Manav, 2026-08-10): real-time conversation is the point. The cascade
cannot get there (measured: 40KB/~10k-token prompts, 6.7s speech-end→first-audio
with speculation + acks + tight VAD; floor ~2.5-3s). The speech-native engine
(gemini-live) IS real-time but shipped as a demo: 3 tools, no web, no memory
recall, no tiles, fragile lifecycle. The hybrid finishes it: instant native
conversation + Cue's full tools/memory/tiles — the data moat OpenAI/Grok voice
doesn't have.

## Target experience

- Sub-second conversational responses (native audio model, no cascade in the
  hot path).
- Mid-conversation tool pulls render as tiles (the shipped voice-cards
  pipeline) while the voice narrates them.
- Deep work escalates to the DeepSeek brain in the background
  (run_deep_task exists); the result is announced and shown when ready.
- Sensitive actions still ride the approval flow (V-3 frames) — the native
  model gets no free sends.
- The cascade engine stays as the fallback engine and the deep brain.

## Workstreams

**H-1 · Voice toolset bridge** (the core): replace the 3 hand-rolled
declarations in gemini-live-tools.ts with a curated ~15-tool voice surface
mapped to the REAL executors: tasks/schedule/contacts/messaging/followups
(the cascade's preactivated set), web search, memory recall, get-work-items,
plus `ui_show` for tiles. Compact voice-sized schemas (realtime session config
can't carry 36k tokens of registry). Execution goes through the existing tool
execution layer with its permission checks; anything gated → the approval
frames, spoken with the fixed phrase (V-3 machinery, engine-agnostic on the
wire).

**H-2 · Tiles + memory in the native engine**: emit `card` frames from the
gemini session's tool results (same wire the cascade uses — client is already
engine-agnostic); keep buildLiveBriefing at session start and add on-demand
memory recall as a tool.

**H-3 · Lifecycle hardening**: the ~20s drops — reconnect with session resume,
1007 config-reject handling, idle keepalive, the same synthetic-driver test
rig pointed at the gemini engine (audio in/out over our WS is unchanged).

**H-4 · Default flip + QA**: engine default → gemini-live once H-1..H-3 pass
the synthetic rig + Manav's device QA; the post-replatform migration marker
already supports flipping defaults without stomping deliberate choices.

## Constraints

- Prod GEMINI key exists (voice-only usage per the brain-tier decision) —
  verify quota/model access for the Live API early (H-0 smoke).
- Never say Google/Gemini in-voice (identity block exists).
- OpenRouter key is ToS-blocked from openai/*; OpenAI Realtime would need a
  fresh key — Gemini Live is the zero-new-keys path.
- The cascade keeps working untouched; all hybrid work is additive on the
  gemini-live engine behind engine selection.
