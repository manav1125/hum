# Meeting Capture — backend build scope (v0.3 §01)

Maps the meeting-capture flow (design `cue-design-v3-worldclass.html` §01 + the built
surface `apps/web/src/domains/meeting/meeting-capture-page.tsx`) onto the existing
daemon. **Most primitives already exist** — the net-new work is meeting-specific
orchestration on top, not new infrastructure.

## Target flow
Start capture in a meeting → record audio + live-transcribe → extract action items &
decisions live → on stop, generate a recap (summary, action items by owner, decisions,
people & tone) that writes into the 8-type memory with `source = this meeting`.

## What already exists (reuse as-is / extend)

| Capability | Status | Where | Notes |
| --- | --- | --- | --- |
| Recording lifecycle (start/stop/pause/resume/status + file attachment) | **Complete** | `assistant/src/runtime/routes/recording-routes.ts`, `daemon/handlers/recording.ts` (`handleRecordingStart/Stop`, `finalizeAndPublishRecording`) | Records **screen/window video** via the macOS client; **no audio in-daemon**. |
| STT — streaming + batch | **Partial→reuse** | `assistant/src/stt/stt-stream-session.ts` (`SttStreamSession`), `runtime/routes/stt-routes.ts` (`stt_transcribe`, `stt_transcribe_file`) | Full streaming STT exists; client must stream audio chunks (daemon has no mic). |
| Mic streaming pipeline | **Partial→reuse** | `assistant/src/live-voice/*` (`live-voice-session.ts`, protocol, archive) | Client→WS audio frames→STT→live transcript already works for voice mode. Reuse the transport; drop the turn-taking/TTS. |
| 8-type memory extraction | **Complete→customize** | `assistant/src/memory/graph/extraction.ts` (`buildGraphExtractionSystemPrompt`), `extraction-job.ts` | Generic extraction → customize the prompt for action-items(→prospective)/decisions(→narrative/semantic), tag `source=meeting`. |
| Contacts store | **Complete** | `assistant/src/contacts/*` | Look up attendees by name/email. No conversation↔participant link yet. |
| SSE event broadcast | **Complete** | `assistant/src/daemon/assistant-event-hub.ts` (`broadcastMessage`) | Stream live transcript + captured items to the open surface. |
| Home feed / recap framing | **Partial** | `assistant/src/runtime/routes/home-feed-routes.ts`, `home/*` | Reuse the FeedItem + SSE pattern to surface the recap; recap generation itself is net-new. |

## Net-new to build

1. **Capture-session model** (`meeting_sessions`): `{ id, conversationId, title, startedAt, endedAt, recordingId?, attendees: [{name,email,contactId?}], status }`. Either a new table or `meeting` metadata on the conversation. *(small)*
2. **Simultaneous audio + screen capture** (client): extend the macOS recording path to also capture an **audio** stream and feed it to `SttStreamSession`; on web, capture mic via `MediaRecorder` and stream chunks. *(client work — the biggest lift; macOS first)*
3. **Live extraction worker**: on a debounce over the streaming transcript, run an LLM pass to pull **action items** (owner + text) and **decisions**; broadcast each as a card via the event hub (matches the design's streaming blue/violet cards). *(medium)*
4. **Recap generator** (new route, e.g. `POST /v1/meetings/{id}/recap`): on stop, run the customized extraction prompt over the full transcript → `{ summary, actionItems:[{text,owner,done}], decisions:[], people:[{name,tone}], tone }`; write the items into 8-type memory tagged `source=meeting:{id}`; attach the recap as a structured assistant message. *(medium)*
5. **Tone/sentiment** (new): a small LLM classifier over the transcript (collaborative/tense/productive/…) + per-person tone. No existing capability. *(small)*
6. **Frontend wiring**: replace the static `meeting-capture-page.tsx` content with: start → create session + begin capture; subscribe to the event hub for live transcript + streaming cards; stop → call the recap route and render the recap. *(medium)*

## Phasing
- **Phase A (MVP, ~1 sprint):** session model + reuse recording/STT for audio → live transcript → on stop, recap via the (customized) extraction pipeline → write to memory. Single-speaker, macOS-first.
- **Phase B (~1 sprint):** live action-item/decision streaming, tone analysis, attendee↔contact linking, web (MediaRecorder) capture.
- **Phase C:** multi-speaker diarization, wearable capture (shares the same pipeline — see ROADMAP Phase 5).

## Invariants to respect
- LLM calls via the provider abstraction (not SDKs). Memory writes via the extraction pipeline (provenance/actor gates). Capture is **consent-first** — gated by the Trust console toggles (`cue:trust:*`), off by default. Audio retention honors "auto-delete raw audio after 24h".
