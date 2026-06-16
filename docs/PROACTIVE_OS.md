# Cue Proactive OS — subsystem reference

How the connector data plane, the daily action board, and auto-draft fit
together. This is the "layering" that turns Cue from a chat app into a
personal operating layer. Written for whoever wires the UI and backend next.

---

## 1. Connector data plane (read + write)

All connector access goes through the existing OAuth machinery
(`assistant oauth request --provider <X>` / `resolveOAuthConnection`). In this
fork that resolves **Composio-first** and calls Composio's **request proxy**,
which injects the live (auto-refreshed) provider token.

- File: [`assistant/src/oauth/composio-oauth.ts`](../assistant/src/oauth/composio-oauth.ts)
- Proxy: `POST https://backend.composio.dev/api/v3.1/tools/execute/proxy`
  with `{connected_account_id, endpoint, method, body?, parameters?}`.
- **Encoding contract** (see `buildProxyArgs`, unit-tested):
  - Query goes in the endpoint URL, encoded with `encodeURIComponent`
    (spaces → `%20`). `URLSearchParams` uses `+`, which the proxy turns into a
    literal `%2B` and corrupts e.g. Gmail `q=is:unread in:inbox`.
  - Header/query params use `{name, value, type}` — the field is **`type`**,
    not `in`. Sending `in` 400s any request that carries a header.
  - The `Authorization` header is dropped (Composio injects the real token).
- Verified end-to-end: GET / POST / DELETE on Gmail + Calendar; raw tokens are
  intentionally not exposed (`withToken()` throws — use `request()`).

Provider→toolkit mapping is per-host (`google` → `gmail` vs `googlecalendar`).
Adding a provider that Composio supports is just a `PROVIDER_TOOLKITS` entry.

## 2. Daily action board

The proactive surface: reads connected data, has the model triage it into a
small prioritized set of action cards, writes them to the Home feed.

- File: [`assistant/src/home/action-board.ts`](../assistant/src/home/action-board.ts)
- **Sources today:** Gmail unread (`is:unread in:inbox`, top 15) + today's
  primary Calendar (top 12). Add sources by fetching them and appending to the
  synthesis context.
- **Synthesis:** forced tool call `emit_action_board` on the `actionBoard`
  call site. Must use a **no-thinking profile** (`cost-optimized`) — the
  `balanced`/Sonnet profile emits the tool call as *text* under forced
  `tool_choice` because extended thinking is incompatible with it.
- **Deterministic enrichment:** `detectConflicts()` finds overlapping timed
  meetings (half-open; all-day events excluded by shape) and injects a
  must-surface "Scheduling conflicts" section so overlaps always become a
  high-urgency card.
- **Cards:** one summary header (or a "You're all caught up" header when
  empty) + one card per item. Email items carry the source Gmail id in
  `metadata.sourceMessageId` (and `gmailMessageId`) so the UI can deep-link to
  the thread and drive auto-draft for that exact message. Idempotent per local
  day via deterministic ids (`action-board:<YYYY-MM-DD>:<n>`).
- **Triggers:**
  1. Manual — `POST /v1/home/action-board/build` (op `build_action_board`).
  2. Lazy — built once/day when Home opens (`home-content-refresh.ts` →
     `maybeBuildActionBoardForToday`), success-based guard so a startup-time
     skip doesn't poison the day.
  3. Morning backstop — `action-board-scheduler.ts` ticks after a configured
     hour (`CUE_ACTION_BOARD_HOUR`, default 7) and builds even if the app was
     never opened, with `notify: true`.
- **Morning push:** on the morning tick only, if any item is high/critical, it
  emits a notification (→ macOS/Telegram/Slack adapters) with
  `isAsyncBackground: false` + a sentinel `sourceContextId`, which suppresses
  the duplicate home-feed card. The in-app unread badge already updates via the
  `home_feed_updated` SSE event on every write.

## 3. Auto-draft replies (write side)

Turns "this email needs a reply" into a ready-to-review Gmail **draft**
(threaded, **never sent**).

- File: [`assistant/src/home/auto-draft.ts`](../assistant/src/home/auto-draft.ts)
- Flow: GET message metadata → compose reply (`autoDraft` call site, balanced
  profile, plain text) → `buildReplyMime()` (Re: collapsing, In-Reply-To /
  References threading, RFC-2047 + base64url) → `POST /gmail/.../drafts`.
- The system prompt forbids inventing facts — it leaves bracketed placeholders
  like `[confirm date]` instead.
- Route: `POST /v1/home/draft-reply {messageId}` (op `draft_reply`). Invoked
  explicitly; it **never auto-runs** across the mailbox.
- Verified end-to-end (real message → threaded draft → cleaned up), and via the
  board→draft loop (card `sourceMessageId` → `draft_reply` → draft).

## 4. Wiring the UI (next)

The two presentational pages and the action cards are ready to wire:

- **Action card "Draft reply" button** → call `draft_reply` with the card's
  `metadata.sourceMessageId`, then surface the created draft (link to Gmail or
  show a "Draft ready — review" state). Today the generic feed-action route
  seeds a conversation instead; switching email-reply actions to `draft_reply`
  is the main remaining wire-up.
- **Channels page** (`apps/web/.../channels-page.tsx`) → the
  `channel-verification-*` routes.
- **Agents page** (`apps/web/.../agents-page.tsx`) → the `integrations/a2a`
  routes (enable/disable, invite create/redeem). A2A is fully local — no
  external creds — so it can be wired and tested immediately.

## 5. Call sites & config

- LLM call sites added: `actionBoard` (cost-optimized, no-thinking, forced
  tool), `autoDraft` (balanced, plain text). Defined in
  `config/schemas/llm.ts`, `config/schemas/call-site-catalog.ts`,
  `config/call-site-defaults.ts`.
- Env: `CUE_ACTION_BOARD_HOUR` (0–23, default 7) gates the morning tick.

## 6. Tests

`bun test` over: `composio-oauth.test.ts` (proxy encoding), `auto-draft.test.ts`
(address/base64url/RFC-2047/MIME threading), `action-board.test.ts` (conflict
detection). 21 tests; one caught a real all-day false-conflict bug.

## 7. Ideas not yet built

- Auto-draft **routines** (opt-in: draft replies for a sender/label set on a
  schedule) — writes to the mailbox, so gate behind an explicit setting.
- More board sources (Notion, Slack, Linear) once those connectors are
  connected — generalize the fetch step.
- Meeting prep generation for "Prep" items (gather attendees + related threads).
