# Ship addendum — fold `cue/voice-replatform` into the Wave C deploy

For the release thread. Decision (Manav, 2026-08-06): voice ships into the main
app now and gets refined in real use.

## The one-deploy path

`cue/voice-replatform` contains ALL of `cue/upstream-wave-c` (including the
staged web-bundle commit and your three test-fix cherry-picks — identical
changes, they merge clean). **Rebuild the staged image from the
`cue/voice-replatform` tip instead of the wave-c tip** — same runbook
(docs/deploy/wave-c-deploy-runbook.md) applies unchanged, including the
daemon-off backup and the memory-DB split first-boot copy. One deploy delivers
both.

Everything voice-side is additive and gated:
- Server-VAD hands-free is negotiated per-session by new clients
  (`turnDetection: "server_vad"` on the start frame); old/stale clients and the
  Swift client keep byte-identical behavior. Client kill switch:
  `localStorage["cue.voiceServerVad"]="0"`.
- The speculative front door additionally requires
  `liveVoice.frontDoor.enabled` (config, default **false**) — leave it off at
  deploy; flip it later, after the credits + fast-model decision below.

## Prod checklist for voice to actually work

1. **OpenRouter credits** — the key on the machine is nearly exhausted
   (~hundreds of tokens affordable as of 2026-08-06). This fails ALL turns,
   text and voice. Manav tops up; nothing ships usefully before this.
2. `VELLUM_FLAG_VOICE_MODE` / the voice-mode feature flag — verify it's
   enabled for prod (the composer Voice button gates on it).
3. `DEEPGRAM_API_KEY` + `ELEVENLABS_API_KEY` — already present in the Fly
   machine env (verified 2026-08-06).
4. **macOS app rebuild** after deploy — the desktop app bundles a web
   snapshot; until rebuilt it runs the old voice client (safe: old client =
   old behavior, the daemon serves both).
5. Post-deploy watch: `metrics` frames on voice sessions —
   `dispatchToFirstDeltaMs` (front-door viability; 3.3s measured on
   DeepSeek locally, i.e. the 1200ms deadline fails open until a faster model
   fronts `voiceFrontDoor`), `endpointHoldCount`, and barge-in feel.

## Known refinement backlog (post-ship, in real use)

- Front-door model choice (fast TTFT) + flip `liveVoice.frontDoor.enabled`.
- Response latency: DeepSeek TTFT + generation dominates silence→speech time.
- V-1d detached barge-in continuation; V-4 mobile Live Activity; the `card`
  frame capability flag (Swift client); `update_config` in-call settings UI.
- Mic dead-silence self-check ships in this deploy (macOS TCC silence looks
  like a healthy-but-deaf room otherwise).
