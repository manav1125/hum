# Upstream voice delta — v0.11.3 (2026-08-11)

Scope: vellum-assistant v0.11.2→v0.11.3 voice cluster (21 voice commits since
2026-08-01), triggered by the v0.11.3 release notes (camera in voice mode,
multilingual speech). Full-file analyses live in the session record; this doc
is the adoption ledger.

## What upstream shipped

| Feature | Commits | Mechanism (one line) |
| --- | --- | --- |
| Multilingual voice | `699c1c889f` `a386cf7dcf` `409182e2ca` `b89236fc58` | Deepgram `language=multi` on nova-3 (code-switching, 10-language roster); per-word language tags on stream events vote for a per-turn dominant language that drives the reply-language prompt line, TTS `language` hints (ElevenLabs `language_code`, xAI `language`), per-language voice overrides, and non-Latin sentence segmentation. `services.stt.language` defaults to `"multi"`; listening-language picker in Settings → Voice. |
| Camera in voice mode | `48a63d28d7` `639f7bc1cb` | Photo uploads over the ordinary attachment route; only the id crosses the voice WS (`attach_image` client frame). The daemon persists it immediately as its own user message ("here's a photo:") running NO turn — the next spoken turn's history simply contains the image, and their vision-capable brain sees it. Viewfinder is a mode of the room (video-only getUserMedia — never audio+video, which would break iOS AEC). |
| Echo-driven barge-in suppression | `9eaee435d7` | Server-side: rolling ≤10s TTS reference buffer; first above-threshold mic audio during the playback window is held and cross-correlated against the reference (threshold 0.65); match seeds an adaptive echo-energy EMA and is dropped before transcription; louder-than-echo or uncorrelated speech still barges. Guard stays 250ms. |
| Deepgram Flux turn detection | `b91b7a0aeb` | Spike, default-off: Deepgram's `/v2/listen` conversational endpoint (model `flux-general-en`) decides turn boundaries; four additive STT stream events; local VAD keeps barge-in duty. English-only; selecting the provider breaks workspace-wide batch STT. |
| Front-door consolidation | `92f668a1f5` `5650163a17` | Deletes the old two-model front-decision layer (endpoint decider + LLM acks) outright — unified front door is now the only verdict path; `voiceFrontDecision` callsite renamed `voiceProgressNarration`; migration 142. Second commit gates verdict tokens out of the shared hub stream. |
| In-call approvals | `ca2b5a122e` | Reuses the existing confirmation card; sensitive-reach tools go pending mid-call with a fixed spoken phrase + room minimize; **45s timeout auto-ALLOWS**. |
| Island/surface UI | `6dcf41717a` `b3413fb4b6` `351a4e2509` | Outcome-gated system-driven surface reveal (latched on successful ui tool_result, model reveal-marker retired); island controls (minimize vs end separated); `activity` server frame carrying a daemon-composed turn label for Lock Screen/island. |

## Adoption decisions

**ADOPTED (in progress this session):**
1. **Multilingual pipeline → cascade** (port, not merge — our fork predates all four commits). Deviations: no `vellum` managed STT provider (drop from every roster/set); skip the workspace migration (our configs never had the field; schema default suffices); skip escalation-bridge hunks (sit on the unmerged unified front door); settings UI ported to apps/web later as its own slice.
2. **Multilingual → gemini-live** (`4c13c85334`, our own work — upstream has no second engine): removed the hardcoded "user speaks English" instruction line and the `en-US` speechConfig pin; both engines now read `services.stt.language` ("multi" → omit the pin, Gemini auto-detects per utterance; pinned code → BCP-47 mapping). This line was WHY realtime translated other languages to English.
3. **Camera in voice** (next slice): port the final persist-immediately design (NOT the abandoned ride-the-next-turn v1). Our vision tier already reroutes image-bearing history to qwen3.6-flash — zero routing work on cascade. Gemini engine additionally feeds the frame natively (`realtimeInput.video`) since its session never rebuilds history. Fork-specific must-do: capability-advertise via the ready frame (NOT upstream's version gate — our client fails the session on unflagged error frames); fix apps/macos permissions.ts audio-only media grant (same bug upstream fixed); v4 uuids not v7.

**ADOPT SOON (queued):**
4. **Server-side echo classifier** (`9eaee435d7`) scoped to non-`echoSafePlayback` clients — upgrades our old-client stopgaps (15s cascade guard, gemini half-duplex mic gate) from "interruption disabled" to "interruption works", and closes the untreated ghost-transcription hole (assistant speech leaking into the transcript as a phantom user turn). Composes with our echoSafePlayback flag: flagged clients keep client-side AEC + 250ms guard; unflagged get the adaptive gate.
5. **`activity` frame** (`351a4e2509` concept) — we have none; matches our card-legibility direction and the iOS TestFlight build.
6. **Front-door hub-stream gate** (`5650163a17` concept) — precondition to ever flipping `liveVoice.frontDoor.enabled`; without it verdict tokens render in web/passive transcripts.

**SKIPPED, with reasons:**
- **Flux** — English-only spike, default-off upstream, provider-selection blast radius (breaks workspace batch STT). Two free ideas kept: additive turn-event STT contract shape; the single-anchor `endpointCommitLatencyMs` metric (useful for Classic-latency work).
- **Front-door consolidation** (`92f668a1f5`) as a cherry-pick — deletes files our flag-off fork still uses. Recorded as merge-planning input: on the next voice sync, take it wholesale with migration 142 instead of merging around it.
- **In-call approvals** (`ca2b5a122e`) — our V-3 frames are a superset; its **45s timeout-to-auto-allow is the guardian-bypass class behind our P0 rogue send** and must never be adopted. Only idea worth lifting later: the fail-closed workspace-boundary reach classifier, if mid-call prompt fatigue becomes real.

## Fork-safety notes hit this round

- Upstream migrations 141/142 fall in the never-merge range (≥103); re-author at our own next slot only if needed.
- `live-voice-photo.ts` upstream uses UUIDv7 — substitute v4 (wire-compat rule).
- Their new frames are additive; our client's fatal-on-unknown-error behavior makes upstream's optimistic-frame pattern UNSAFE here — always advertise new frames via the ready frame.
- Rebrand boundary: display copy in ported files says "Vellum" — rebrand; protocol ids stay.

## Non-voice v0.11.3 items (logged, not actioned)

Subagents consolidated to researcher/builder/advisor with platform guarantees;
plugin opt-in hourly auto-updates; schedules pinnable to inference profiles
(with dependent-schedule view before profile deletion); skill revision history;
per-avatar onboarding voices; sidebar/billing redesigns; daily credit limit
with proactive banner. Candidates for the next general upstream wave.
