# Cue web app — data-path performance audit (2026-07-20)

Scope: per-surface request waterfalls (desktop + mobile viewport), bundle cost, SSE-vs-poll,
perceived speed. Measured live against **prod** (`https://manav.justcue.app/assistant/…` via the
`?cueToken=` trick) — the vite dev proxy on :5200 adds ~100–300 ms per request (identity read:
prod 272–304 ms vs dev-proxy 363–585 ms), so all absolute numbers below are prod.

**Network floor on this connection: ~275 ms RTT to the Fly machine.** `healthz` (zero server
work) takes the same 274 ms as real reads — the daemon answers most reads in near-zero server
time. The UAT's "reads run 0.5–2.5 s" is therefore almost entirely *shape* (serial chains,
request count, chunk→data waterfalls), not server compute. Every eliminated round-trip saves a
flat ~0.3 s; every serialized chain multiplies it.

---

## 1. Per-surface waterfalls (prod, warm asset cache)

### HQ / Today (`/assistant/hq`) — desktop and mobile are identical (32 requests)
| phase | t (ms) | what |
|---|---|---|
| JS boot (parse/eval ~1.9 MB) | 0 → ~700 | DCL 668–693 ms on an M-series Mac |
| API burst (21 requests, parallel) | 706 → ~1,090 | next-move, home/feed (38.8 KB), conversations p0, identity, feature-flags (8.7 KB), config GET (21.4 KB), 4× work-items, missions, projects, schedules, home/state, company-profile, usage/totals, budget, brand-profiles, avatar components (46 KB), pending-interactions |
| avatar re-fetch + walk begins | 1,100 | avatar/character-components **again** (46 KB dup), avatar/state |
| conversations pagination walk (serial) | 1,105 → **3,220** | offsets 50→350, 7 more requests × ~280 ms each, ~150 KB total |

**Modules are interactive ~1.1 s; the Chats rail / anything reading the conversation list waits
~3.2 s.** Parallelism of the first burst is good. The tail is 100% the serial conversations walk.

- Total payload per HQ load: ~330 KB JSON, 32 requests.
- Same 32-request pattern at mobile viewport (375×812) — the mobile Today deck fetches the full
  conversation walk even though no sidebar exists there.

### Chats (`/assistant/conversations`)
**0 requests** on client-side nav — renders fully from the already-mounted list query. Chats is
only slow when it's the *first* surface (cold boot pays the 8-page walk before anything renders,
because the queryFn returns nothing until ALL pages are drained — see Fix #1).

### A conversation (`/assistant/conversations/:id`)
17 requests, **all parallel** at +92 ms, each ~270–300 ms → messages painted ~400 ms, suggestion/
pending-interactions ride a second wave at +440 ms. Good shape. But the burst includes
**home/feed (38.8 KB), config (21.4 KB), healthz, 2× work-items, brand-profiles, identity/intro**
— none needed to show a chat; they refire because their 10–30 s staleTimes have lapsed by the
time you navigate (see Fix #2).

### Projects (`/assistant/projects`)
2 requests (projects 1.1 KB + work-items?running) but they start at **+341 ms** — the route
chunk downloads first, then queries fire. Chunk→data serial chain (see Fix #5). Interactive ~620 ms.

### All work (`/assistant/work`)
2 requests at +307 ms; `work-items` (no status filter) = **56 KB, 547 ms**. Interactive ~850 ms.
Unpaginated full dump of every work item.

### Memory (`/assistant/memory`)
2 requests at **+562 ms** (chunk chain), then `memory-items?limit=200` = **181 KB, 617 ms**.
Interactive ~1.2 s. Biggest routine read payload in the app after marketplace.

### Skills (`/assistant/skills`)
First query at **+856 ms** (heaviest chunk chain measured). `skills?include=catalog` 33 KB /
493 ms, then marketplace `sources` → fan-out of **6 `marketplace/items?source=…` requests**
(414 KB, 316 KB, 172 KB, 63 KB, 32 KB, 16 KB ≈ **1.03 MB JSON**), finishing ~2.0 s. The mobile-v3
skills surface mounts the same all-sources read the desktop Marketplace page uses.

### You (`/assistant/channels`, mobile "You" tab target)
7 requests at +594 ms (chunk chain). `connector-apps` = **69.6 KB / 540 ms**; guardrails 11 KB.
Interactive ~1.15 s.

### Brief (`/assistant/brief`)
1 request at +292 ms, but the endpoint itself takes **1,332 ms** — the only genuinely slow
server read measured. Cause: `assistant/src/runtime/routes/morning-brief-routes.ts:303,368`
awaits `resolveOAuthConnection("google")` + `fetchTodaysEvents(...)` — a **live Google Calendar
call inside the request path**. Meanwhile the page renders **`null`** while loading
(`apps/web/src/mobile-v3/brief/brief-page.tsx:643`) → ~1.6 s of blank screen every morning.

### Focus burst (any surface)
Dispatching window focus/visibility → **11 requests, ~2.2 s, ~230 KB**: feature-flags,
conversations p0, identity, home/feed (38.8 KB), then the serial conversations walk offsets
50→350. This is the previously-seen "11-request focus burst", still live. Driver: global
`focusManager` refetch (`apps/web/src/lib/query-focus-manager.ts:37-50`) × short staleTimes
(10 s default, `apps/web/src/components/providers.tsx:37`) × the full-drain conversations
queryFn. On mobile (Capacitor `appStateChange` → `app.resume`) this fires on **every
foregrounding of the app**.

---

## 2. The conversations full-drain — the single biggest lever

`apps/web/src/utils/conversation-list-fetchers.ts:101-122` — `fetchConversationList` serially
fetches pages of 50 (max 200 pages!) until `hasMore` is false, and only then returns. With ~360
conversations that is 8 sequential round-trips ≈ 2.2–2.3 s, ~150 KB.

Consequences:
- The query is mounted on effectively every surface — `chat-layout.tsx:143`,
  `use-active-conversation.ts:40`, `use-attention-tracking.ts:54`, `home-page-route.tsx:27`,
  `recent-threads-strip.tsx:99`, `command-palette-window-page.tsx:122` — so **every cold boot
  and every focus/foreground pays the walk**, on HQ, chat, everywhere; mobile included.
- Because the queryFn resolves only after the last page, **the list renders nothing until the
  entire drain finishes** — this is the UAT "lists arrive slowly" symptom on first paint.
- The codebase already has the right primitive: `listConversationsFirstPage`
  (`conversation-list-fetchers.ts:274-284`) exists and is used by the `sync_changed` consumer
  (`conversation-cache-mutations.ts:290`) precisely because "the full drain is hundreds of
  sequential GETs". Boot/focus just never got the same treatment.
- SSE already invalidates the list (`conversations:list` tag, `lib/sync/types.ts:9`), so the
  aggressive focus refetch is redundant belt-and-braces.

---

## 3. Bundle

Built dist (`apps/web/dist/assets/`): main `index-*.js` **1,325 KB raw / 382 KB gz**, plus an
always-loaded `src-*.js` (design library) **475 KB / 140 KB gz** and `api-*.js` 96 KB → **~550 KB
gz of boot JS**. Warm-cache parse/eval to DCL: ~670–690 ms on an M-series Mac; on a mid-tier
Android (3–4× slower single-core) expect **~2–2.5 s before the first API request can even fire**.

- `apps/web/vite.config.ts:138-146` — **no `manualChunks`**; the chunk-size warning fires every
  build and is being ignored.
- `apps/web/src/routes.tsx:10-12` — `ChatLayout` + `ChatPage` are **statically imported**, so the
  entire chat domain (transcript, tool-progress cards, web-search carousel, make-rule sheet,
  attachments, OAuth popup plumbing — visible as the hundreds of dev-mode module requests on
  `/assistant/hq`) ships in the main chunk for every surface, including HQ/mobile Today.
- Heavy libs correctly lazy already: tiptap editor (592 KB), pdf (457 KB), xterm (272 KB), shiki
  grammars (761 KB emacs-lisp etc.) are separate chunks.
- Inside the main chunk: sentry (~36 refs), motion/framer, moment (4 refs — dead-weight
  candidate), radix/design-library.

Top split candidates, in order: (1) chat transcript sub-tree (tool cards / web-search / attachments
render paths — keep the composer shell eager), (2) vendor split (`react`, `design-library`,
`motion`, `sentry`) via `manualChunks` so surface chunks stop re-bundling shared code, (3) HQ page
is already lazy but rides the main chunk's weight.

---

## 4. SSE vs polling

The SSE plumbing is good: `sync_changed` tags → TQ invalidation
(`use-assistant-resource-sync.ts`, `use-conversation-sync.ts`), discrete events
(`home_feed_updated`, work-item events via `useActivitySync`), and reconnect-gap invalidation.
Work-items polls are explicitly 60 s *safety nets* on top of SSE (`use-work-items.ts:120-124`) —
acceptable cadence, though 5+ surfaces each holding a 60 s interval (activity-page.tsx:65-88,134,
needs-you-section.tsx:54, recently-done-section.tsx:71, agents-at-work-page.tsx:192,
mobile-chat-view.tsx:434) means a parked tab still issues ~6 req/min. The real problem is the
opposite of missing SSE: **staleTimes are tuned as if SSE didn't exist** (10 s global default),
so focus/navigation refires everything SSE already keeps fresh. Missing tags worth adding while
touching the daemon: `work-items:list`, `projects:list`, `memory-items:list` (SYNC_TAGS,
`lib/sync/types.ts:1-12`) — then the 60 s safety nets can stretch to 5 min.

---

## 5. Perceived speed

- **Brief**: blank screen ~1.6 s (renders `null` while loading — `brief-page.tsx:643`). Worst
  offender; it's the flagship morning surface.
- **Chats cold boot**: nothing until the full drain returns (Fix #1 makes the first 50 rows paint
  at ~0.4 s instead of ~2.5 s).
- HQ modules, Memory (`memories-page.tsx:513`), Activity/Work have skeleton/loading states — OK.
- Surfaces >300 ms without optimistic/skeleton treatment after the fixes land: Skills explore grid
  during the ~1 MB marketplace fan-out (has per-source streaming, but the first paint still waits
  on the chunk chain + catalog).

---

## 6. Ranked fix list

Impact = wall-clock saved on the surfaces users hit most. Effort: S (<½ day), M (1–2 days), L (3+).

| # | Fix | Saving | Effort | Type |
|---|---|---|---|---|
| 1 | **Stop the serial conversations drain on the hot path.** Boot/focus should fetch page 0 only (primitive already exists: `listConversationsFirstPage`, `conversation-list-fetchers.ts:274`), paint immediately, and either lazy-"show more" or background-drain the rest with per-page cache seeding. Also drop `refetchOnWindowFocus` for this query — the `conversations:list` SSE tag already invalidates it. | ~2 s off every cold boot on every surface; kills the 2.2 s / 11-request focus burst; Chats first paint 2.5 s → ~0.4 s | **M** | quick-win |
| 2 | **Re-tune staleTime around SSE.** Global default 10 s (`providers.tsx:37`) + focusManager refetch means every navigation/focus refires home/feed (38.8 KB), config (21.4 KB), feature-flags, identity… Resources covered by sync tags/events should get `staleTime: 5 min` + `refetchOnWindowFocus: false`; keep short staleTime only for non-SSE resources. | Removes ~100–150 KB + 6–10 requests per navigation/focus; conversation-open burst 17 → ~8 requests | **S–M** | quick-win |
| 3 | **Brief: take Google Calendar out of the request path** (serve cached/last-known events + refresh async, or split `/brief/morning` into instant core + streamed calendar section) and **add a skeleton** instead of `null` (`brief-page.tsx:643`). | 1.3 s server + 1.6 s blank → ~0.4 s perceived | **S (skeleton) + M (server)** | quick-win + structural |
| 4 | **Kill the chunk→data serial chain on lazy routes.** Queries start only after the route chunk arrives (+341 ms projects, +562 ms memory, +594 ms channels, +856 ms skills). Options: React Router `loader`s that `queryClient.prefetchQuery` in parallel with the lazy `Component` import (router resolves both together), or `<link rel="modulepreload">` / hover-intent chunk preload. | 300–850 ms on first visit to every lazy surface | **M** | structural |
| 5 | **Slim the fat reads.** (a) `memory-items?limit=200` → 181 KB: paginate (50) + trim fields; (b) `work-items` unfiltered → 56 KB: paginate or summary DTO; (c) `connector-apps` → 70 KB: list DTO without embedded metadata/icons; (d) marketplace `items?source=…` → up to 414 KB each, ~1 MB total on Skills/Marketplace: server-side list DTO (name/desc/icon/installs) + fetch per-source on demand instead of all sources eagerly (`use-marketplace.ts:63-84`, mounted by mobile skills `you/skills-page.tsx:619`). | 0.3–1.5 s + ~1.3 MB on the affected surfaces; big mobile-data win | **M** (daemon DTOs) | structural |
| 6 | **Split the main bundle.** Add `manualChunks` (vendor/react, design-library, motion, sentry) and make `ChatLayout`/`ChatPage` transcript internals lazy (`routes.tsx:10-12`); drop moment if truly vestigial. Target: main chunk 382 KB gz → ~200 KB gz. | ~1 s+ first-load parse on mid mobile devices; faster time-to-first-fetch everywhere | **M–L** | structural |
| 7 | **Dedupe boot requests.** `avatar/character-components` fetched twice (46 KB × 2 — the second fires when the `supportsManifest` key segment flips, `use-assistant-avatar.ts:93`); `pending-interactions` twice; `config` GET (21 KB) + a `PATCH /config` write on every boot. Share queryOptions/keys; gate the PATCH behind an actual change. | ~70 KB + 3–4 requests per boot | **S** | quick-win |
| 8 | **HQ aggregate boot endpoint (`/home/boot`).** HQ needs 21 endpoints; even fully parallel that's 21× gateway/auth overhead and one straggler gates the deck. A single daemon aggregate for the HQ modules (next-move, home/state+feed summary, work-item counts, missions, projects, schedules, budget) would cut HQ to ~4 requests. Do after #1/#2 — they may make this unnecessary. | ~0.3–0.5 s HQ + resilience on high-RTT mobile networks | **L** | structural |
| 9 | **Add daemon sync tags for work-items/projects/memory-items**, then stretch the five 60 s safety-net polls to 5 min (`use-work-items.ts:122`, `activity-page.tsx:65-88`, `needs-you-section.tsx:54`, `recently-done-section.tsx:71`, `agents-at-work-page.tsx:192`, `mobile-chat-view.tsx:434`). | ~6 req/min per parked tab → battery/server load, not latency | **M** | structural |

### Order of operations
Week 1 (quick wins, no daemon changes except #3 skeleton): **#1, #2, #7, #3-skeleton** — this
alone turns the UAT symptoms around: lists paint in one RTT, the focus storm dies, boot drops
~10 requests. Then **#4 + #3-server** (perceived-speed pass), then the payload/bundle structural
work **#5, #6**, and **#8/#9** opportunistically with other daemon work.

### Measurement notes / caveats
- Browser-pane CDP CPU throttling wasn't available; mid-device parse costs are scaled estimates
  (3–4× M-series single-core).
- This connection's ~275 ms RTT to the Fly machine is itself high (region distance); alpha users
  closer to the region will see proportionally smaller absolute wins from round-trip elimination,
  but the serial-chain multipliers (8× walk, chunk→data) hurt everyone equally.
- Dev-server (:5200) numbers are not representative: vite proxy adds 100–300 ms/request and dev
  serves ~800 unbundled modules.
