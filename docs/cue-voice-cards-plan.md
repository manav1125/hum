# Inline Visual Result Cards for Cue Live Voice — Implementation Plan

**Status:** Design / architecture. No product code in this doc — this is the map + the build spec.
**Goal:** Bring the "GPT Live" pattern to Cue's real-time voice mode: during a live spoken
conversation, visual cards (lists, results, tables, images) appear inline **above the voice orb**
in real time, so voice becomes a simultaneous audio+visual conversation instead of a microphone
that narrates and punts everything to the Review lane.

**Author's one-line summary of the seam:**
> The daemon already produces structured `ui_surface_show` events during a voice turn (the model
> can call `ui_show`), and the web already renders them via `SurfaceRouter`. The **only** missing
> wire is between those two: the live-voice WebSocket session forwards `assistant_text_delta` and
> `message_complete` but drops every surface event. Add one server→client frame (`card`), forward
> `ui_surface_show`/`_update`/`_dismiss` through it at the `voice-session-bridge` `onEvent` seam,
> render it with the existing `SurfaceRouter` on the voice page, and change the voice prompt to
> present results inline instead of "sending them to your Review lane."

---

## 1. Current architecture — the live-voice wire, end to end

### 1.1 Two engines behind one socket

`/v1/live-voice` (a Bun WebSocket) is served by `RuntimeHttpServer`. A single
`LiveVoiceSessionManager` owns at most one active session and routes by the `start` frame's
`engine` field:

- **`cascade`** (default, and what the user is describing) — STT → **full agent loop** → streaming
  TTS. Built in `assistant/src/live-voice/live-voice-session.ts`.
  Factory: `createLiveVoiceSession` (`http-server.ts:171-179`).
- **`gemini-live`** — speech-native Gemini realtime engine (`assistant/src/gemini-live/`). Opt-in.

Routing: `assistant/src/runtime/http-server.ts:171-179`.

This plan targets the **cascade** engine first (it runs Claude + tools + memory and is what the
user is using). §7 covers the Gemini-Live parity follow-up.

### 1.2 Server frame types (the wire vocabulary today)

Canonical source: `assistant/src/live-voice/protocol.ts:11-23`. Web port (kept byte-identical):
`apps/web/src/domains/chat/voice/live-voice/protocol.ts:96-108`.

```
ready | busy | stt_partial | stt_final | thinking | assistant_text_delta |
tts_audio | tts_done | metrics | archived | error
```

Every server frame carries a monotonic `seq` (added by `LiveVoiceServerFrameSequencer`,
`protocol.ts:226-247`). Client control frames (`start`/`ptt_release`/`interrupt`/`end`) are JSON
text; mic audio is raw **binary** PCM frames. **There is no frame that carries structured visual
content.** That is the gap.

### 1.3 How frames are produced (server)

Inside a session, all outbound frames flow through
`LiveVoiceSession.sendFrame(payload)` (`live-voice-session.ts:1193-1208`) →
`context.sendFrame(payload)` → `LiveVoiceSessionManager` sequencer adds `seq`
(`live-voice-session-manager.ts:126-134`) → `sink.sendFrame` →
`RuntimeHttpServer.sendLiveVoiceFrame(ws, frame)` (`http-server.ts:971-972, 1027`). So **any new
frame type is emitted simply by calling `this.sendFrame({ type: "card", … })`** from the session,
once the type is added to the `LiveVoiceServerFramePayload` union.

### 1.4 How the assistant response is produced

`startAssistantTurnIfReady()` (`live-voice-session.ts:599-754`) calls `startVoiceTurn(...)`
(`assistant/src/calls/voice-session-bridge.ts:286`) with a set of **callbacks**. Only two response
callbacks are wired:

- `assistant_text_delta` → emits `assistant_text_delta` frame + buffers text for TTS
  (`live-voice-session.ts:667-675`).
- `message_complete` → finalizes the turn (`live-voice-session.ts:676-696`).

`startVoiceTurn` runs the **real agent loop** (`conversation.runAgentLoop`,
`voice-session-bridge.ts:595-624`). Its `onEvent(msg: ServerMessage)` handler sees the **entire**
event stream — `assistant_text_delta`, `message_complete`, `tool_use_start`, `tool_result`, and
crucially **`ui_surface_show` / `ui_surface_update` / `ui_surface_dismiss`** — and
`broadcastMessage(msg)`s every one of them to SSE clients. But it only forwards
`assistant_text_delta` / `message_complete` / errors / `tool_use_start` into the voice
`eventSink` (`voice-session-bridge.ts:596-622`). **Surface events are broadcast to SSE and dropped
on the voice path.** This is the exact seam to extend.

### 1.5 Client parse + render (web)

- Transport client: `apps/web/src/domains/chat/voice/live-voice/live-voice-client.ts`. Parses each
  frame (`handleMessage`, `:289-336`) and re-emits as a typed event
  (`LiveVoiceClientEventMap`, `:60-74`).
- Session controller hook: `apps/web/src/domains/chat/voice/live-voice/use-live-voice.ts`.
  Subscribes to client events (`:466-556`) and writes observable state into the store.
- Store: `apps/web/src/domains/chat/voice/live-voice/live-voice-store.ts` (Zustand; per-field
  selectors). Holds `state`, `partialTranscript`, `finalTranscript`, `assistantTranscript`,
  `inputAmplitude`, `error`. **No card state yet.**
- The page: `apps/web/src/domains/chat/voice/voice-mode-surface.tsx` — the ink-panel orb UI
  (`VoiceOrb`, "● listening"/"thinking…"/"speaking" eyebrow, live transcript). Reused by both the
  standalone `/voice` route and the in-chat overlay. The transcript block (`:465-541`) sits
  directly above the orb button (`:546-625`) — **that is where the card stack goes.**

### 1.6 macOS + mobile inheritance — confirmed

Both are the **same web SPA**, so a change to the voice page reaches all three:

- **macOS** (`apps/macos`, Electron): the main `BrowserWindow` loads the web SPA at the connected
  instance origin `/assistant` (`apps/macos/src/main/app-config.ts:100-140`, `getRendererBaseProd`
  → `…/assistant`). No native voice-card work needed.
- **Mobile** (Capacitor WebView): `apps/web/capacitor.config.ts` — the mobile app wraps the same
  `apps/web` build. No native work needed.

The one place a native shell *could* matter is the native `LiveVoiceChannelManager.swift` on macOS
(`clients/macos/`), which is a **separate** Swift client. The current shipping macOS app is the
Electron/web SPA, so the web voice page is the single surface to build against. (Note the Swift
manager for future parity, but it is out of scope.)

---

## 2. Why it says "I'm sending them to your Review lane"

There is **no** prompt that says "you can't show things in voice." The punt comes from two places,
both a consequence of voice having historically been *audio-only*:

1. **Cascade — the tasks skill routes background work to the Review lane.** The live-voice turn
   preactivates the `tasks` skill (`live-voice-session.ts:41-47`,
   `LIVE_VOICE_PREACTIVATED_SKILLS`). When the model treats a request as "real work," it enqueues a
   work item, and the skill/enqueue copy explicitly tells it to say the result lands in the Review
   lane:
   - `assistant/src/tools/tasks/work-item-enqueue.ts:72`:
     > "…the result will land in the **Review lane** — do NOT say it is queued or waiting for approval."
   - `assistant/src/config/bundled-skills/tasks/SKILL.md:27,33` — "the result lands in the Review lane."

2. **Gemini-Live — the `run_deep_task` handoff tool is Review-lane by construction.**
   `assistant/src/gemini-live/gemini-live-tools.ts:46`:
   > "Hand a substantive request to Cue's full assistant… The user will get the result in their **Review lane**."
   and its canned reply, `:155`: "…it'll be in the Review lane."

3. **The cascade voice prompt biases toward *speaking only*.** `LIVE_VOICE_CONTROL_PROMPT`
   (`live-voice-session.ts:20-33`) says: "Speak naturally and briefly… one or two sentences" and
   "write plain conversational text ONLY. No markdown, … bullet points…". It never tells the model
   it *can* render a visual card. Combined with "brief," the model's best move for a 6-item list is
   to summarize aloud and offload the detail — i.e. punt.

**Key fact that makes the fix cheap:** the `ui_show` surface tool is *already available* on a voice
turn. Surface tools are gated on `channelCapabilities.supportsDynamicUi`
(`conversation-tool-setup.ts:617-624`), and the voice turn resolves channel `vellum` + interface
`macos` → `supportsDynamicUi: true` (`conversation-runtime-assembly.ts` `vellum` case:
`supportsDynamicUi = supportsDesktopUi || iface === "web"`). So the model *can* call `ui_show`
today; the surface event just never reaches the voice page and the prompt never invites it.

---

## 3. How rich cards are ALREADY rendered elsewhere (the reuse target)

Cue has a complete, shipped **surface system** for rich in-chat content. We reuse it wholesale —
no new card components.

- **Wire event:** `ui_surface_show` (`assistant/src/api/events/ui-surface-show.ts:53-67`):
  `{ type, conversationId, surfaceId, surfaceType, title?, data, actions?, display?, messageId?,
  persistent?, toolCallId? }`. Plus `ui_surface_update`, `ui_surface_dismiss`, `ui_surface_complete`.
- **Renderer:** `apps/web/src/domains/chat/components/surfaces/surface-router.tsx` —
  `<SurfaceRouter surface={...} onAction={...} />` dispatches on `surface.surfaceType` to concrete
  components:
  - `list` → `ListSurface` (`list-surface.tsx`; `data: { items: {id,title,subtitle?,icon?}[],
    selectionMode }`) ← **the minimum first slice**
  - `table` → `TableSurface`
  - `card` → `CardSurface`
  - `work_result` → `WorkResultSurface` (this is the Review-lane result card)
  - `call_summary` → `CallSummarySurface`, `weather` display, `document_preview`, `dynamic_page`, …
- **Surface type:** `apps/web/src/domains/chat/types/types.ts:143` (`Surface extends
  ConversationMessageSurface` = `{ surfaceId, surfaceType, data, actions?, completed?,
  completionSummary?, toolCallId? }`). Display-only types (`list`, `table`, `card`, `work_result`)
  are explicitly **non-interactive** and never block input
  (`isSurfaceInteractive`, `types.ts:180-190`).

Because the wire `ui_surface_show` event and the `Surface` client type line up field-for-field, we
can carry the surface payload across the voice socket verbatim and hand it straight to
`SurfaceRouter`.

---

## 4. Design — the `card` voice frame + the seam

### 4.1 New server→client frame: `card`

Add `card` to both protocol modules (server canonical + web port). Shape mirrors the existing
`ui_surface_*` lifecycle so the client can reuse the surface reducer semantics (show → update →
dismiss). Carrying the surface fields verbatim keeps the daemon a pass-through and lets the client
build a `Surface` with zero translation.

```ts
// assistant/src/live-voice/protocol.ts  (add to _LIVE_VOICE_SERVER_FRAME_TYPES + union)
// apps/web/.../protocol.ts               (mirror exactly)

export interface LiveVoiceCardServerFrame extends LiveVoiceServerFrameBase {
  readonly type: "card";
  /** Lifecycle op — mirrors ui_surface_{show,update,dismiss}. */
  readonly op: "show" | "update" | "dismiss";
  /** Stable correlation key across op=show/update/dismiss (the surfaceId). */
  readonly surfaceId: string;
  /** Present for op=show|update. Absent for op=dismiss. */
  readonly surfaceType?: string;      // "list" | "table" | "card" | "work_result" | …
  readonly title?: string;
  readonly data?: Record<string, unknown>;
  readonly actions?: ReadonlyArray<{
    id: string; label: string;
    style?: "primary" | "secondary" | "destructive";
    data?: Record<string, unknown>;
  }>;
  /** The turn this card belongs to (so the client can clear stale cards on a new turn). */
  readonly turnId?: string;
}
```

Notes:
- **`op` collapses three source events into one frame type** — simpler client switch than three
  frame types, and matches how surfaces already model their lifecycle.
- `data` is opaque on the wire (same contract as `ui_surface_show`, whose schema treats `data` as
  `z.record`). No per-surface schema duplication.
- Reuse the existing `seq` ordering; cards interleave with `assistant_text_delta`/`tts_audio`
  naturally.

### 4.2 Server emit path — exact code seams

**Seam A — forward surface events out of the agent loop** (`voice-session-bridge.ts`):

1. Extend `VoiceTurnCallbacks` (`:93-105`) with:
   ```ts
   ui_surface_show?: (msg: Extract<ServerMessage, { type: "ui_surface_show" }>) => void;
   ui_surface_update?: (msg: Extract<ServerMessage, { type: "ui_surface_update" }>) => void;
   ui_surface_dismiss?: (msg: Extract<ServerMessage, { type: "ui_surface_dismiss" }>) => void;
   ```
2. In the agent-loop `onEvent` (`:596-622`), after the existing `broadcastMessage(msg)`, add:
   ```ts
   else if (msg.type === "ui_surface_show")    opts.callbacks?.ui_surface_show?.(msg);
   else if (msg.type === "ui_surface_update")  opts.callbacks?.ui_surface_update?.(msg);
   else if (msg.type === "ui_surface_dismiss") opts.callbacks?.ui_surface_dismiss?.(msg);
   ```
   (Keep the SSE broadcast — a chat window open on the same conversation still renders it there.
   This only *adds* the voice path.)

**Seam B — emit `card` frames from the session** (`live-voice-session.ts`, inside the
`startVoiceTurn({... callbacks: {...} })` block, `:666-708`):

```ts
ui_surface_show: (msg) => {
  if (!this.isForwardingAssistantText(token)) return;      // same gate as text deltas
  void this.sendFrame({
    type: "card", op: "show",
    surfaceId: msg.surfaceId, surfaceType: msg.surfaceType,
    title: msg.title, data: msg.data, actions: msg.actions, turnId,
  });
},
ui_surface_update: (msg) => { /* op:"update" … */ },
ui_surface_dismiss: (msg) => { /* op:"dismiss", surfaceId only … */ },
```

Add `"card"` to `_LIVE_VOICE_SERVER_FRAME_TYPES` and the `LiveVoiceServerFramePayload` union so
`sendFrame`'s type accepts it. Nothing else in the session changes — sequencing, ordering, and
teardown all already flow through `sendFrame`.

**Honesty guarantee (built-in):** cards are emitted *only* from real `ui_surface_show` events the
agent loop produced during this turn from real tool output. There is no synthesis of card content
in the transport layer. The card shows exactly the data the turn produced — same source of truth as
the chat surface.

### 4.3 Prompt change — stop punting, present inline

Edit `LIVE_VOICE_CONTROL_PROMPT` (`live-voice-session.ts:20-33`). Add a rule (and soften the
"plain text only / never bullet points" bias so it applies to *spoken* text, not the visual card):

> "You are on a screen the user can see. When you produce results the user would want to look at —
> a list of options, search results, a comparison, a table, an image — **show them as a visual card
> using the `ui_show` tool** (surfaceType `list`, `table`, or `card`), then say a short one- or
> two-sentence spoken summary. The card is seen, not spoken, so your **spoken** reply must never
> read the list item-by-item — summarize it ('Here are five late-night spots in Berawa — the top
> one's Luigi's Hot Pizza') and let the card carry the detail. Do **not** offload viewable results
> to the Review lane just because this is voice; the Review lane is for background work you'll
> finish later, not for results you have right now."

Also: add `ui_show`'s owning skill to `LIVE_VOICE_PREACTIVATED_SKILLS` **only if** `ui_show` isn't
already exposed as a core tool on the voice turn. It is gated purely on `supportsDynamicUi`
(`conversation-tool-setup.ts:617-624`), which is already `true` for the voice channel context — so
no skill change is required; the prompt invitation is the whole behavioral fix. Verify in a live
turn that `ui_show` appears in the tool set (it should).

For the **Gemini-Live** engine, the analogous change is to give it a `show_card` tool (or reuse the
surface pipeline) instead of only `run_deep_task` → Review lane (`gemini-live-tools.ts`). Deferred to
§7.

### 4.4 Client — parse, store, render

**Parse** (`live-voice-client.ts`): add `card: LiveVoiceCardServerFrame` to
`LiveVoiceClientEventMap` (`:60-74`), a `case "card": this.emit("card", frame);` in `handleMessage`
(`:296-335`), and the listener set entry.

**Store** (`live-voice-store.ts`): add card state + actions:
```ts
cards: LiveVoiceCard[];                      // ordered, current-turn surfaces
showCard(frame): void;                       // upsert by surfaceId
updateCard(frame): void;                     // merge data by surfaceId
dismissCard(surfaceId): void;
clearCards(): void;                          // called on "thinking" (new turn) + reset()
```
Where `LiveVoiceCard` is `{ surfaceId, surfaceType, title?, data, actions?, turnId }` — the exact
fields `SurfaceRouter` needs.

**Controller** (`use-live-voice.ts`): in the `client.on(...)` block (`:466-556`) add
`client.on("card", frame => { switch(frame.op){ show→showCard; update→updateCard; dismiss→
dismissCard } })`. Clear cards when a new turn starts — the existing `client.on("thinking", …)`
handler (`:490-498`) already resets per-response state; add `s.clearCards()` there so the previous
turn's cards don't pile up. (Design choice: **cards are per-turn and replace**, matching the "one
live conversation" feel; a running history lives in the persisted chat thread.)

**Render** (`voice-mode-surface.tsx`): add a **card stack directly above the orb**, between the
transcript block (`:465-541`) and the orb button (`:546`). Read `useLiveVoiceStore.use.cards()` and
map each through the existing router:

```tsx
{cards.length > 0 && (
  <div className="cue-voice-cards" style={{ width:"100%", maxWidth:560, display:"flex",
       flexDirection:"column", gap:10, /* scrollable if tall */ overflowY:"auto",
       maxHeight:"38vh" }}>
    {cards.map(card => (
      <SurfaceRouter key={card.surfaceId}
        surface={toSurface(card)}                 // {surfaceId, surfaceType, data, actions}
        onAction={handleCardAction} />            // see §4.5
    ))}
  </div>
)}
```

The ink-panel voice surface is dark-only; `SurfaceRouter`'s children use design tokens
(`var(--surface-base)` etc.), so wrap the stack in the design-library dark theme context (or a
`data-theme="dark"` scope) so token colors resolve to the dark palette against the ink gradient.
Confirm during build.

**Reduced motion:** cards must appear without motion under `prefers-reduced-motion`. The page
already scopes its ring/bar keyframes behind `@media (prefers-reduced-motion: reduce)`
(`voice-mode-surface.tsx:83-85`). Add the card entrance as a short fade/scale in a
`.cue-voice-card-enter` class disabled by the same media query (default = instant appearance). No
layout-shifting spring.

### 4.5 Card actions (phase 2)

Display-only cards (`list`, `table`, `card`, `work_result`) are non-interactive
(`isSurfaceInteractive`), so **phase 1 needs no action round-trip** — `onAction` can be a no-op /
"open in chat." When we later want tappable cards, wire `onAction(surfaceId, actionId, data)` to the
existing `POST /v1/…` surface-action route the chat composer already uses (the same path
`ui_request`/`handleSurfaceAction` resolves), keyed by the voice turn's `conversationId`. Out of
scope for the first slice.

---

## 5. Minimum first slice vs. full

**Slice 1 (ship this first) — one card type, list, cascade only, display-only:**
1. `card` frame added to both protocol modules (`op: show|update|dismiss`).
2. `voice-session-bridge.ts`: forward `ui_surface_show` through a new callback (Seam A).
3. `live-voice-session.ts`: emit `card`/`op:show` from that callback (Seam B).
4. Prompt: add the "show viewable results as a `ui_show` list, summarize aloud, don't punt to
   Review lane" rule.
5. Client: parse `card` → store `cards[]` → render a stack of `ListSurface` (via `SurfaceRouter`)
   above the orb, cleared on each new `thinking`.
6. Reduced-motion-safe entrance; dark-token scoping.

This alone delivers the "late-night options in Berawa" scenario: the model calls `ui_show` with a
`list` of the 5 spots, the list card pops above the orb, and Cue says a one-line summary.

**Slice 2 — breadth:** `table` + `card` + `work_result` + image surfaces (all already in
`SurfaceRouter`); `op:update` for streaming/refining a card mid-turn; per-turn multi-card stacking
polish.

**Slice 3 — interactivity:** tappable card actions wired to the surface-action route (§4.5);
optional persistence of the card into the live-voice chat thread recap so it's there on reopen
(`live-voice-thread.ts`).

**Slice 4 — Gemini-Live parity:** give the realtime engine a card-emitting tool and route it
through the same `card` frame (§7).

---

## 6. Files touched (build checklist)

Server (daemon):
- `assistant/src/live-voice/protocol.ts` — add `card` to frame-type list + `LiveVoiceCardServerFrame`
  + union.
- `assistant/src/calls/voice-session-bridge.ts` — extend `VoiceTurnCallbacks`; forward
  `ui_surface_show|update|dismiss` in `onEvent` (`:596-622`).
- `assistant/src/live-voice/live-voice-session.ts` — add `ui_surface_*` callbacks that emit `card`
  frames (`:666-708`); edit `LIVE_VOICE_CONTROL_PROMPT` (`:20-33`).
- (No change needed to `live-voice-session-manager.ts` / `http-server.ts` — `sendFrame` is generic.)

Client (web, inherited by macOS + mobile):
- `apps/web/src/domains/chat/voice/live-voice/protocol.ts` — mirror the `card` frame + parse.
- `apps/web/src/domains/chat/voice/live-voice/live-voice-client.ts` — event map + `handleMessage`
  case + listener set.
- `apps/web/src/domains/chat/voice/live-voice/live-voice-store.ts` — `cards[]` + show/update/dismiss/
  clear actions.
- `apps/web/src/domains/chat/voice/live-voice/use-live-voice.ts` — `client.on("card", …)`;
  `clearCards()` on `thinking`.
- `apps/web/src/domains/chat/voice/voice-mode-surface.tsx` — render the card stack above the orb via
  `SurfaceRouter` (reused, not rebuilt); dark-token scope; reduced-motion entrance.

Tests to extend (existing suites): `protocol.test.ts` (both), `live-voice-client.test.ts`,
`use-live-voice.test.ts`, and a session test asserting a `ui_surface_show` in the loop produces a
`card` frame.

---

## 7. Gemini-Live parity (follow-up, not first slice)

`assistant/src/gemini-live/gemini-live-session.ts` + `gemini-live-tools.ts` currently only expose
`run_deep_task` (Review-lane handoff) and simple task capture. To match: add a `show_card` function
tool whose handler emits the same `card` frame through the Gemini-Live session's frame sink (the
manager/frame plumbing is shared via `LiveVoiceSessionFactoryContext.sendFrame`), and update its
tool copy so viewable results are shown inline rather than always handed to the Review lane. Because
the client `card` frame is engine-agnostic, **no client change** is needed for this — only the
Gemini server path.

---

## 8. Design references (GPT-Live pattern)

The target interaction is OpenAI's "Live"/Advanced-Voice visual pattern: during a spoken call, the
assistant surfaces compact visual cards (a list of places, a map, an image, a table) *above* the
voice input while continuing to talk — the screen and the voice are one conversation, not two
modes. Cue's version keeps the ink-panel orb identity and simply stacks real `Surface` cards in the
space above the orb, driven by the same tool output that would render in chat. The honesty rule
(cards = real turn output, never fabricated) and reduced-motion support are first-class, not
retrofits.
