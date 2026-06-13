# Cue — Functionality Map (grounded in the forked codebase)

Honest status: earlier I had mapped the **architecture** (systems + data model). This is the
**feature-level** map, read from the actual code (`assistant/src/*` runtime domains and
`apps/web/src/domains/*` UI). Design must follow this. It also exposes what my first mockup
(`design/cue-design-system.html`) missed, and where the real gaps are for a world-class product.

## A. Runtime capabilities (what the assistant can actually do)
From `assistant/src/` — 60+ domains. The product-relevant ones:

- **Memory** (`memory/`) — 8 memory types, extraction, dedup, recall, staleness. The core.
- **Identity** (`agent/`, `prompts/`, SOUL.md) — personality the assistant writes about itself.
- **Conversations / Chat** (`conversations/`, `context/`) — threads, compaction, overflow recovery.
- **Proactivity** (`heartbeat/`, `background-wake/`, `followups/`, `signals/`, `work-items/`,
  `tasks/`, `schedule/`, `playbooks/`, `sequence/`) — the "nothing dropped" engine: re-reads
  notes, surfaces due/unfinished, runs scheduled + multi-step playbooks.
- **Voice** (`live-voice/`, `stt/`, `tts/`, `calls/`) — real-time talk, dictation, and **phone
  calls** (place/receive via Twilio). Voice is first-class, not a bolt-on.
- **Channels** (`channels/`, `telegram/`, `email/`, `messaging/`, `inbound/`, `outbound-proxy/`)
  — one assistant reachable from macOS, web, iOS, voice, email, Telegram, Slack.
- **Tools / computer use** (`tools/`, `browser/`, `browser-session/`, `terminal` via web,
  `media/`, `documents/`, `filing/`, `workspace/`) — browse the web, run a terminal, read/write
  files, handle documents and media.
- **Skills & plugins** (`skills/`, `plugins/`, `plugin-api/`, `bundler/`, `mcp/`) — 67-entry
  skill catalog (Gmail, Calendar, Notion, Linear, inbox-management, doordash, amazon, meet-join,
  restaurant-reservation, voice providers…) + MCP connectors. Installable, sandboxed.
- **Security & trust** (`security/`, `permissions/`, `approvals/`, `credential-execution/`,
  `credential-health/`, `oauth/`) — actor roles (guardian/trusted/unknown), permission/approval
  cards, CES credential isolation, OAuth.
- **Contacts & A2A** (`contacts/`, `a2a/`, `acp/`) — trusted contacts can reach your assistant;
  **agent-to-agent** interaction between assistants.
- **Subagents** (`subagent/`) — spawns child agents for parallel work (shown as avatar chips).
- **Avatar** (`avatar/`) — an **animated, customizable character** with SVG/PNG/ASCII renderers.
- **Lifecycle / infra** (`daemon/`, `runtime/`, `backup/`, `export/`, `usage/`, `telemetry/`,
  `embedded/`, `home/`, `watcher/`, `providers/`) — multi-provider LLM, backup/export, usage.

## B. Real UI surfaces (what screens exist today)
From `apps/web/src/domains/*` — the one React app rendered on web, macOS (Electron), iOS (Capacitor):

| Surface | What it is | My v0.1 mockup? |
| --- | --- | --- |
| **Home** (`home/`) | An activity **feed**: greeting header, recap row, suggestion pills, filterable feed, detail panel | Partial — I showed a "Now rail," not the feed |
| **Chat** (`chat/`) | Conversation: composer, inspector, subagent detail, document viewer, confirmation/approval + contact actions | Yes (basic) |
| **Intelligence** (`intelligence/`) | The "knows you" hub: **identity/SOUL**, **memories** (+ memory-v2), **skills**, **plugins** | Missed — I showed only a flat memory list |
| **Library** (`library/`) | Catalog to discover/install apps & skills | **Missed entirely** |
| **Workspace** (`workspace/`) | Files the assistant reads/writes | **Missed** |
| **Contacts** (`contacts/`) | Contacts, connect/invite, **A2A invites**, trusted-contact access | **Missed** |
| **Terminal** (`terminal/`) | Live computer-use terminal session/stream | **Missed** |
| **Logs** (`logs/`) | Emails, system events, trace, usage/billing | **Missed** |
| **Settings** (`settings/`) | general, **voice**, **devices**, integrations, notifications, **schedules**, privacy, sounds, developer, advanced | **Missed** |
| **Onboarding** (`onboarding/`) | welcome → select assistant → **hatching** (personality) → api-key → hosting → privacy → terms | **Missed** |
| **Avatar** (`components/avatar/`) | Animated assistant face + customization/management modal | **Missed — and it's central to brand** |
| **Command palette** (`components/command-palette/`) | Quick actions / quick input | **Missed** |
| **Credits/usage** (`add-credits`, `earn-credits`, `usage`) | Billing & credits | **Missed** |
| **Embedded apps** (`app-viewer-container`, `app-card`) | Skills render rich in-app UIs | **Missed** |

## C. What this means for the design
My `cue-design-system.html` is a good **brand + core-conversation** direction, but as a product
surface map it is **v0.1 and incomplete**. A world-class redesign (v0.2) must cover:

1. **The assistant avatar** — Cue needs a designed character/identity, animated states (idle /
   listening / thinking / speaking / acting), and the customization panel. This is the emotional
   core and a brand differentiator; right now it's a generic Vellum avatar.
2. **Feed-style Home** — greeting + recaps + suggestion pills + filterable feed, not just a rail.
3. **Intelligence hub** — identity (SOUL), the 8 memory types as a navigable view, skills, plugins.
4. **Library / install flow**, **Workspace/files**, **Contacts + A2A**, **Terminal**, **Logs/usage**.
5. **Approvals/permission** UX (guardian decisions) — trust is a headline feature; design it well.
6. **Calls** UI (active call, transcript), and the **voice settings** (persona/TTS) screen.
7. **Onboarding/“hatching”** — first-run that observes your style and builds the assistant. The
   single most important first impression for a world-class product.
8. **Command palette** as the power-user spine across surfaces.

## D. Gaps to push toward world-class (beyond parity)
Real opportunities the current code does *not* fully deliver, aligned to our differentiators:

- **Meeting capture as a first-class surface** (Phase 3) — live transcribe → action items /
  decisions / people / tone → memory → act. Primitives exist (`live-voice`, memory) but no
  dedicated product flow.
- **Unified "Inbox / next moves"** — one prioritized queue across email, chat, tasks, followups,
  approvals (today these live in separate domains).
- **Trust & privacy console** — make the guardian/trusted/unknown model + always-on capture
  consent legible and controllable (prerequisite for the wearable).
- **Cross-device handoff made visible** — presence + "continue here" is implied by one memory but
  not surfaced as UX.
- **Wearable ingestion** (Phase 5) — net-new pipeline + consent model.

## E. Recommended next step
Produce **design v0.2** as a true surface inventory: one screen per real domain above, in the Cue
identity, *then* layer the new/world-class features. That keeps design following functionality,
which is exactly right. See `design/DESIGN-SPEC.md` (to be expanded to match this map).
