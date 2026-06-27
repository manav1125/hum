# Cue Mission Control — activity OS audit + design

A personal/company operating system needs one coherent command center where
activities come **in** (MCP/channels), are **displayed + controlled**, **handed
off** to the AI, and the **results** come back — all in real time. This doc
audits Cue's current end-to-end lifecycle, names the gaps, and proposes a
concrete, buildable design that *evolves* the existing surfaces (Activity / Home
/ Agents) into one "Mission Control" rather than a rewrite.

Sibling reference: `docs/PROACTIVE_OS.md` (on the `cue/handoff-bundle` branch)
covers the connector data plane + action board + auto-draft. This doc is the
lifecycle + UI layer above it.

---

## PART 1 — AUDIT: the current lifecycle

### 1.1 The four stages, mapped

```
INBOUND                CONTROL                HANDOFF               RESULTS
─────────              ─────────              ─────────             ─────────
channel webhook        Home feed (cards)      runWorkItemIn-        getWorkItemOutput()
  → gateway            Activity (7 sections)    Background()          (polled)
  → /v1/channels/        Next-moves           runTask() →           home feed item
    inbound            Agents-at-work          headless conv        impact store
  → conversation                              subagent.spawn()      conversation msgs
work-item / feed       controls: Run/Approve  autonomy policy       SSE agent events
watcher poll           /Decline/Cancel/Pause  + approvals           surface_action_completed
heartbeat              /Run-now/Digest
action-board (LLM)
```

### 1.2 Inbound — how activities enter

**Channel webhooks** (Slack/Telegram/email/WhatsApp/phone/a2a) all funnel
through the **gateway**, never directly into the daemon:

- Channel + interface taxonomy: `assistant/src/channels/types.ts` —
  `CHANNEL_IDS` (telegram, phone, vellum, whatsapp, slack, email, platform,
  a2a). Per-channel delivery + conversation strategy in
  `assistant/src/channels/config.ts`. Per-channel tool gating in
  `assistant/src/channels/permission-profiles.ts`
  (`isToolAllowedInChannel`).
- Gateway pipeline (dedup / circuit-breaker / forward):
  `gateway/src/webhook-pipeline.ts` → `POST /v1/channels/inbound`.
- Inbound handler + intercept stages (ACL, guardian verify/reply, bootstrap,
  edit, escalation, secret, transcription, background dispatch):
  `assistant/src/runtime/routes/inbound-message-handler.ts` and
  `assistant/src/runtime/routes/inbound-stages/*`.
- Messages land in `conversations` / `messages` with `originChannel` /
  `originInterface` / provider `metadata` (Slack `thread_ts`):
  `assistant/src/memory/schema/conversations.ts`. Inbound dedup tracked
  separately in `assistant/src/memory/delivery-crud.ts`.

**Becoming work:** inbound events become one of three loosely-coupled things:

1. **WorkItem** (`assistant/src/work-items/work-item-store.ts`) — the durable
   queue row. Model:
   `{ id, taskId, title, notes, status, priorityTier, sortIndex, lastRunId,
   lastRunConversationId, lastRunStatus, sourceType, sourceId, requiredTools,
   approvedTools, approvalStatus, createdAt, updatedAt }`. Status enum:
   `queued | running | awaiting_review | failed | cancelled | done | archived`.
   Every WorkItem references a **Task** (`assistant/src/tasks/task-store.ts`) —
   a reusable *template*; the WorkItem is an *instance/run*. Dedup by
   `(sourceType, sourceId, normalizedTitle)` via `findActiveWorkItemBySource`.
2. **FeedItem** (`assistant/src/home/feed-types.ts`, written by
   `assistant/src/home/feed-writer.ts` to `data/home-feed.json`). The
   proactive **action board** (`assistant/src/home/action-board.ts`) is the
   main producer — it pulls Gmail unread + Calendar + recent channel messages,
   LLM-triages into ≤8 cards. WorkItems are folded in at read time via
   `assistant/src/home/work-item-feed.ts` (`mergeWorkItemsIntoFeed`).
3. **Background jobs** from polling: **watchers**
   (`assistant/src/watcher/engine.ts` — `runWatchersOnce`, watermark + per-event
   dedup → background job per tick) and **heartbeat**
   (`assistant/src/heartbeat/heartbeat-service.ts` — proactive check-ins,
   conversational, *no* structured work-item).

### 1.3 Display + control — where the user sees & steers

Four **separate** surfaces, three of them in top-level nav
(`apps/web/src/domains/chat/components/assistant-side-menu.tsx:493-517` — Home,
Activity, Agents are sibling nav items):

| Surface | File | Shows | Real-time |
| --- | --- | --- | --- |
| **Home** | `apps/web/src/domains/home/home-page.tsx` (+ `home-feed-list`, `home-recap-row`, `detail-panel/home-detail-panel`) | Feed cards (category icon, urgency, title); controls hidden in hover/detail panel: Mark read, Go to thread, Dismiss, action trigger | **Poll** (30 s stale, refetch on `app.resume`). No SSE. |
| **Activity** | `apps/web/src/domains/activity/activity-page.tsx` + `sections/*` | 7 sections — Needs you / Running / Queued / Scheduled / Watching / Sequences / Recently done — with **provenance chips** + inline controls | **Poll** per section (15–30 s). No SSE. |
| **Next-moves** | `apps/web/src/domains/next-moves/next-moves-page.tsx` | Same `useHomeFeedQuery` feed, re-rendered in a different (v0.3) layout | **Poll** (same as Home). |
| **Agents at Work** | `apps/web/src/domains/agents-at-work/agents-at-work-page.tsx` | In-chat subagents only; **read-only**, no controls | **Poll** 3 s (most aggressive in the app). |

**Controls inventory (all wired to real endpoints):**

- Needs you → `confirmPost({decision:"allow"|"deny"})`
  (`sections/needs-you-section.tsx`).
- Running → Output (`workitemsByIdOutputGet`), Cancel
  (`workitemsByIdCancelPost`) (`sections/running-section.tsx`). Subagent rows'
  reconcile query is **disabled** (~line 44-53).
- Queued → Run now (`workitemsByIdRunPost`), Cancel
  (`sections/queued-section.tsx`).
- Scheduled → Run / Pause-Resume (`schedulesByIdTogglePost`) / Cancel.
- Watching → Digest only (read-mostly).
- Sequences → Pause / Resume (hidden if none).
- Home/Next-moves → Mark read, Dismiss, Go to thread, action trigger
  (`homeFeedByIdActionsByActionIdPost` with `mode: smart|background|thread`).

### 1.4 Handoff — controlled item → AI

- "Run it" → `runWorkItemInBackground(workItemId)`
  (`assistant/src/work-items/work-item-runner.ts:61`): **auto-approves the
  item's required tools** (~line 109 — explicit user request bypasses approval),
  sets `running`, spawns an async **headless conversation** via `runTask()`
  (`assistant/src/tasks/task-runner.ts`), runs the **main agent loop**
  (`assistant/src/daemon/conversation-agent-loop.ts` →
  `assistant/src/agent/loop.ts`) — *not* a separate subagent. Terminal status →
  `awaiting_review` / `failed`, broadcasts `work_item_status_changed`.
- **Subagents** (`assistant/src/subagent/manager.ts`) are a *different* path —
  spawned by the parent LLM via `skill_execute`, child conversations, depth-1,
  role-scoped tools, events wrapped in `subagent_event` envelopes, terminal
  retention 30 min. This is what Agents-at-work shows.
- **Autonomy policy** (`assistant/src/permissions/autonomy-policy-reader.ts`):
  classes `research | draft | send | money | delete | other`, modes
  `auto | ask | never`; safe defaults auto-allow research/draft, ask for the
  rest; 5 s cache; **fails closed**. Approvals minted as scoped grants
  (`assistant/src/approvals/approval-primitive.ts`).

### 1.5 Results — how they come back

- WorkItem output is **derived + polled**:
  `assistant/src/runtime/routes/work-items-routes.ts:getWorkItemOutput()`
  re-reads the run's conversation, extracts latest assistant text + bullet
  highlights + tool outcomes. There is **no** `work_item_completed` event
  carrying the summary inline — UI sees a status change, then must fetch.
- Conversation messages are durable (`messages` table); agent events stream
  live; action surfaces emit `surface_action_completed`
  (`assistant/src/daemon/conversation-surfaces.ts`).
- "Hours saved" recap: append-only `assistant/src/home/impact-store.ts`
  (`recordImpact` / `getImpactSummary`), served at `/v1/identity/impact`.
  Only **interactive** actions record impact — background task results don't.

### 1.6 Real-time wiring — live vs poll

- **Bus + hub:** `assistant/src/events/bus.ts` (in-process) +
  `assistant/src/runtime/assistant-event-hub.ts` (SSE fan-out, capability
  targeting, slow-subscriber shedding). SSE endpoint: `GET /v1/events`
  (`assistant/src/runtime/routes/events-routes.ts`, 7 s heartbeat). CLI gets a
  file-based mirror (`assistant/src/signals/event-stream.ts`).
- **LIVE (pushed):** agent-loop deltas (`text_delta`, `tool_use`,
  `tool_result`, `message_complete`, `usage`, `error`), `confirmation_request` /
  `secret_request`, subagent events, `work_item_status_changed`,
  `task_run_conversation_created`, `tasks_changed`, `home_feed_updated`,
  `surface_action_completed`, `contact_change`, resource sync.
- **POLLED:** conversation history, **work-item output**, **home feed**, impact,
  task list, work-item list, schedules, pending interactions, watchers,
  sequences, subagents — i.e. **every aggregate the command-center surfaces
  read.**
- **Frontend SSE plumbing exists** (`apps/web/src/assistant/sse-service.ts` with
  reconnect/bounce policy) and is consumed by conversation/resource/flag/
  notification/document sync hooks — but **not** by Home or Activity. The pipe
  is laid; the command center just isn't plugged into it.

### 1.7 Gaps + usability problems (the core complaint)

1. **Fragmentation — the same activity lives in 3-4 places, shaped
   differently.** A running background work-item appears as a Home feed card, an
   Activity → Running row, and a Next-moves row — different title treatment,
   different controls, different status vocabulary ("snooze" in Home vs "cancel"
   in Activity), independent state. There is **no single OS view**. Nav itself
   advertises the split (Home / Activity / Agents as three destinations).
2. **No real-time in the command center.** Every governing surface polls
   (15-50 s). You cancel a run and it lingers up to 20 s; an approval can sit
   30 s before you see it; "work just started" never lands as a live cue. The
   SSE bus already broadcasts the exact events (`work_item_status_changed`,
   `home_feed_updated`, `confirmation_request`) — they're just not wired to
   invalidate these queries.
3. **Results dead-end.** Background results accumulate in a headless
   conversation. There's no `work_item_completed` event with an inline summary,
   and no injection of "Cue finished X" back into the conversation where you
   asked. You only learn the outcome by navigating to Activity and clicking
   *Output* (an extra fetch). Background actions don't even count toward impact.
4. **Inbound → control gaps.** Heartbeat ideas never become structured items;
   watcher events route to background jobs with weak surfacing; FeedItem ↔
   WorkItem lifecycles are decoupled (delete a work-item and its feed card
   persists on disk; expire a feed item and the work-item stays queued —
   `mergeWorkItemsIntoFeed` only joins at read time).
5. **Agents-at-work is an island.** Subagents are real in-flight work but
   read-only, can't be aborted there, separate from Activity's Running section,
   and poll at 3 s. Two "what's running" mental models.
6. **Control affordances are inconsistent + hidden.** Home buries Approve/Run in
   a detail panel; Activity shows them inline; Agents shows none. Users don't
   know where to act.
7. **Opaque payloads.** Watching + Sequences sections defensively narrow
   `unknown` payloads — a sign the contracts aren't first-class.

---

## PART 2 — DESIGN: "Mission Control"

### 2.1 Principle

One surface that shows the **whole lifecycle as columns of the same object**,
updated live. Don't invent a new data model — **promote a unified read model**
over the existing stores and **plug the existing SSE bus into it**. Activity
already self-describes as "the command center" and has the richest data + real
controls; make it the spine and fold Home's triage and Agents' fleet into it.

### 2.2 The unified object: `ActivityItem`

A read-model projection (not a new table) that normalizes WorkItem, FeedItem,
pending interaction, schedule, watcher, sequence, and subagent into one shape:

```ts
type ActivityLane =
  | "inbound"      // triage: feed cards / unrouted channel events (FeedItem, action-board)
  | "awaiting_you" // pending interactions + approvals
  | "in_progress"  // running work-items + live subagents
  | "scheduled"    // schedules + watchers + sequences (the "standing orders")
  | "done";        // recently completed (with results inline)

interface ActivityItem {
  id: string;              // stable, prefixed by kind: "wi:", "feed:", "sub:", "sched:"...
  kind: "work_item" | "feed" | "interaction" | "schedule" | "watcher"
      | "sequence" | "subagent" | "heartbeat";
  lane: ActivityLane;
  title: string;
  summary?: string;
  source: { channel?: ChannelId; provenance: string; conversationId?: string };
  status: string;          // normalized per-lane vocabulary
  urgency: "critical" | "high" | "medium" | "low";
  controls: ActivityControl[];   // [{ id:"run", label:"Run now", endpoint, method }]
  result?: { summary: string; highlights: string[]; conversationId?: string };
  createdAt: string; updatedAt: string;
}
```

The projection lives **server-side** in a new
`assistant/src/runtime/routes/activity-routes.ts` (op `activity_list`) that
unions the existing stores once, so the client makes **one** call instead of
seven. Each store already exposes its rows; this just maps them into lanes +
attaches the canonical control set (eliminating the per-section "what buttons go
here" divergence and the opaque-payload narrowing).

### 2.3 Layout — Mission Control

A single `/assistant/mission-control` route, **five-lane** board (vertical
columns on desktop, swipeable lane tabs on mobile), left-to-right mirroring the
lifecycle:

```
┌── INBOUND ──┬── AWAITING YOU ─┬── IN PROGRESS ──┬── SCHEDULED ──┬── DONE ──┐
│ feed/triage │ approvals       │ running + live  │ schedules     │ results  │
│ cards       │ (Approve/Decline│  agents (live    │ watchers      │ w/ inline│
│ Run · Snooze│  inline)        │  token/tool feed)│ sequences     │ summary  │
│ Dismiss     │                 │ Cancel · Output  │ Run·Pause     │ Reuse    │
│             │                 │ Abort            │ ·Digest       │ Re-run   │
└─────────────┴─────────────────┴──────────────────┴───────────────┴──────────┘
 header: "3 awaiting · 2 running · 5 standing · 12 done today"  [● live]
```

- **Inbound** = today's action-board cards + any channel event not yet routed
  to a work-item. Primary action **Run** (creates+runs a work-item), secondary
  **Snooze/Dismiss**. This *is* Home's feed, re-housed as the triage lane.
- **Awaiting you** = pending interactions + approvals, Approve/Decline inline
  (the highest-priority lane; badge it).
- **In progress** = running work-items **and** live subagents in one lane. Each
  row can expand to a **live mini-transcript** (subscribe to that
  conversation's SSE: `tool_use` / `tool_result` / `text_delta`) so "what Cue is
  doing right now" is visible without leaving the board. Cancel / Abort /
  Output inline.
- **Scheduled** = the "standing orders" (schedules + watchers + sequences) —
  Run-now / Pause / Digest.
- **Done** = recently completed **with the result summary inline** (no extra
  click), plus **Re-run** and **Open thread**.

Home keeps its greeting/recap identity but its feed list becomes a *view of the
Inbound lane*. Agents-at-work's content becomes the live-agents portion of the
In-progress lane. Next-moves is **retired/redirected** (it's a duplicate render
of the feed).

### 2.4 Real-time wiring (the highest-leverage change)

Add **one** SSE-driven sync hook, `use-mission-control-sync.ts`, modeled on the
existing `use-conversation-sync.ts` / `use-assistant-resource-sync.ts`. It
subscribes to the existing `sse-service` stream and, on each relevant event,
invalidates exactly the affected query (or patches the cache):

| SSE event (already broadcast) | Cache effect |
| --- | --- |
| `work_item_status_changed` | move item between In-progress/Awaiting/Done lanes |
| `home_feed_updated` | refresh Inbound lane |
| `confirmation_request` / consumed | add/remove from Awaiting you |
| `subagent_status_changed` / `subagent_event` | update live-agents rows |
| `tasks_changed` / `task_run_conversation_created` | refresh in-progress |
| `surface_action_completed` | attach result to the Done row |

Polling drops to a slow safety-net (e.g. 60 s) instead of the driver. This alone
fixes gap #2 across all surfaces and lets the header carry a real **● live**
indicator.

**Backend addition for results (gap #3):** emit a `work_item_completed` event
carrying `{ id, status, result: { summary, highlights, conversationId } }` from
`work-item-runner.ts` at the terminal transition (the extraction logic already
exists in `getWorkItemOutput`). The Done lane then renders results with **zero**
extra fetches, and the same payload can be injected as a context note back into
the originating conversation ("Cue finished: …").

### 2.5 Key interactions

- **Triage → run:** Inbound card → **Run** → optimistic move to In-progress →
  live transcript expands → on `work_item_completed`, animates to Done with
  summary. End-to-end visible in one screen.
- **Approve in place:** Awaiting-you badge pulses on `confirmation_request`;
  Approve/Decline inline; row clears on consume. No 30 s lag.
- **Steer running work:** expand a Running row for the live tool feed; Cancel /
  Abort without navigating to chat.
- **Standing orders:** Scheduled lane is the "set it and forget it" register;
  Run-now / Pause are the OS-level controls over recurring automation.

### 2.6 What to merge / restructure

- **Promote** Activity → Mission Control (rename + relane its 7 sections into 5
  lanes); keep its endpoints + controls (they're correct).
- **Fold** Home's feed into the Inbound lane (reuse `useHomeFeedQuery` data;
  share the card component). Home page keeps greeting + impact recap.
- **Fold** Agents-at-work into In-progress (live agents sub-list); keep a deep
  filter `?lane=in_progress&kind=subagent` for the fleet view.
- **Retire** Next-moves (redirect to Mission Control, like `/dashboard` already
  redirects to Home — `routes.tsx:310`).
- **Collapse** three nav items (Home/Activity/Agents) → two (Home,
  Mission Control), removing the fragmentation at the nav level.

---

## PART 3 — PRIORITIZED BUILD PLAN

Ordered by leverage. Each is independently shippable.

### P1 — Wire SSE into the command center (biggest win, lowest risk)
Make Activity (and Home feed) update live off events the daemon **already**
broadcasts. No backend change.
- **New:** `apps/web/src/domains/activity/use-activity-sync.ts` — subscribe via
  `apps/web/src/assistant/sse-service.ts`; on `work_item_status_changed`,
  `home_feed_updated`, `confirmation_request`, `tasks_changed`,
  `subagent_status_changed`, invalidate the matching react-query keys used in
  `activity-page.tsx` + `use-home-feed-query.ts`.
- **Edit:** `activity-page.tsx` (mount the hook; drop polling to 60 s safety
  net), `home/hooks/use-home-feed-query.ts` (invalidate on `home_feed_updated`).
- **Effort:** ~0.5–1 day. **Risk:** low (mirrors existing sync hooks).

### P2 — Emit `work_item_completed` with inline results (kills the results dead-end)
- **Edit:** `assistant/src/work-items/work-item-runner.ts` — at terminal
  transition, build the summary via the existing extractor and broadcast
  `work_item_completed { id, status, result }`. Register the event type in the
  hub/types.
- **Edit (frontend):** Done lane / `recently-done-section.tsx` renders
  `result.summary` + highlights inline; Mission Control sync attaches it without
  re-fetch.
- **Optional:** inject a context note into the originating conversation +
  `recordImpact()` for background completions.
- **Effort:** ~1 day. **Risk:** low–medium (one new event type).

### P3 — Server-side unified `activity_list` read model (one call, five lanes)
- **New:** `assistant/src/runtime/routes/activity-routes.ts` (op
  `activity_list`) unioning work-items / feed / interactions / schedules /
  watchers / sequences / subagents into `ActivityItem[]` with `lane`, normalized
  `status`, and a canonical `controls[]`. Replaces seven client calls + the
  opaque-payload narrowing.
- **Effort:** ~2–3 days. **Risk:** medium (touches several stores read-only).

### P4 — Mission Control surface (the unified UI)
- **New:** `apps/web/src/domains/mission-control/mission-control-page.tsx` +
  five lane components + a shared `ActivityCard` (with expandable live
  transcript that subscribes to the row's conversation SSE).
- **Edit:** `routes.tsx` (add `/assistant/mission-control`, redirect
  `/next-moves` → it), `assistant-side-menu.tsx` +
  `cue-mobile-tab-bar.tsx` (collapse Home/Activity/Agents nav → Home +
  Mission Control). Reuse Activity's section components as lane bodies; reuse
  Home's feed card for Inbound.
- **Effort:** ~3–5 days. **Risk:** medium (UI surface area; reuses existing
  pieces).

### P5 — Close inbound → control lifecycle gaps
- **Edit:** `assistant/src/home/feed-writer.ts` + `work-item-store.ts` — when a
  work-item is archived/cancelled, strip its feed card; when a feed item
  expires, optionally archive the work-item (fix the read-time-only join).
- **Edit:** `assistant/src/heartbeat/heartbeat-service.ts` /
  `assistant/src/watcher/engine.ts` — let high-signal proactive ideas surface as
  Inbound `ActivityItem`s instead of dead-ending in a background conversation.
- **Effort:** ~2 days. **Risk:** low–medium.

**Recommended cut line for a genuinely usable OS feel:** **P1 + P2** deliver the
"real-time command center" perception almost immediately on the *existing*
Activity page; **P4** delivers the single coherent "mission control" view.
P3/P5 are the durability + cleanliness follow-through.
