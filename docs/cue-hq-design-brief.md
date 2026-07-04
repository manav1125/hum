# Cue HQ — Design Brief

*For Claude design. Deliverable: visual/UX options for the surfaces below, desktop + mobile (390px), light + dark.*

## Product context (read first)

Cue is an AI chief-of-staff for busy founders and small founding teams. Everything flows in (chat, voice, screen via Cue Live, connected systems via MCP/Slack/Gmail), Cue triages it, hands work to agents that actually execute (research, documents, decks, spreadsheets, code, images, video), and brings results back for review. That loop is live today.

**HQ is the new top layer: the user declares Missions (goals with outcomes), and a fleet of chartered agents continuously sprints toward them — planning, executing, and reporting — with the human approving anything that publishes, sends, or spends.** The emotional promise: *you see your company moving toward a destination*, not a chat log. This becomes the product's centerpiece and the evolution of the Home screen (integrated — not a separate app).

## Object model the UI must express

- **Company** — who we are: identity, direction docs, never-lines (hard boundaries the AI may never cross), org knowledge (files/links).
- **Missions** — outcome-oriented goals: a measurable outcome, a horizon (date/quarter), status/progress, linked initiatives. *Everything in HQ is framed against mission outcomes — "work results," not activity.*
- **Initiatives = Projects** (already built: emoji, category, context brief, knowledge files, task board) — missions decompose into these.
- **Agents** — a flexible org: 3 default charters (**Ops, Builder, Growth**) the user can rename, re-charter, add to. Each has a domain charter, an autonomy tier (progressive trust), a budget, live current work, and a track record.
- **Work items** — tasks with status (queued → running → review → done), live progress notes, outputs/artifacts.
- **Review queue** — the one human checkpoint: drafts/results awaiting approve/redo, grouped by mission.

## Surfaces to design (priority order)

### 1. HQ (the new Home)
The company map in motion. Must answer in one glance: *are we moving, what moved today, what needs me?*
- Missions as **living cards**: outcome, progress toward it, horizon, active agents (avatars in motion), latest result, next checkpoint.
- **Daily brief** module: what happened, what shipped, what needs you (approve/steer), one-line per item with drill-in.
- "Needs you" queue (approvals) always visible but never nagging.
- Ambient signals: agent activity ticker, spend vs budget, hours saved.
- Must scale from 1 mission (solo founder) to ~6 (small team) gracefully; strong first-run empty state that sells the promise.

### 2. Mission detail
- Hero: the outcome + progress + horizon + "why" (the mission brief).
- Sprint timeline: what the orchestrator planned/did each cycle, outputs as artifact cards (docs, decks, sheets — previewable).
- The initiative projects beneath (existing project cards), agents assigned, budget/spend for this mission, cadence control (default with adjust).
- **Step-in affordance**: at any level the user can open the weeds (a run's live stream, a task's thread) and redirect — "get into the weeds and step in" is a first-class verb, not a debug view.

### 3. Agents (org chart)
- The company org: charter cards (name, avatar, domain, autonomy tier, current work, spend, results shipped). Rename/re-charter/add.
- Progressive trust made visible: what this agent may do alone vs. what waits for approval; a track record that justifies granting more.

### 4. Onboarding (VenturOS-style, but clean & sexy — and skippable)
- A short guided sequence: quick interview (who are you / what's the company / direction) → connect sources (GitHub/Slack/Gmail/MCP, each optional) → drop direction docs → define the first Mission → meet your three agents.
- Every step skippable with graceful "come back later" re-entry from HQ (persistent, non-shaming setup meter).
- The moment of magic to design for: within minutes, the HQ map is alive with the user's own context.

### 5. Daily brief (also as push/email skin)
One screen/card: results shipped (artifact thumbnails), decisions waiting, progress deltas per mission, spend. Tappable into everything.

## Design language & constraints

- Existing system: serif display headings (editorial, confident), mono microlabels (COMMAND, NEEDS YOU), clean cards, restrained color; light + dark themes via tokens; the Cue "C" aperture mark. Keep this DNA — HQ should feel like the same product graduating, not a new skin.
- Mobile: 390px first-class (bottom tabs: Today/Projects/Create/Voice/You); HQ replaces/augments Today.
- Tone: calm operator, not dashboard clutter. Progress-toward-destination over activity noise. Numbers only where they carry meaning (outcome %, spend, hours saved).
- States to cover: empty (no missions), first mission mid-onboarding, healthy motion, mission blocked/needs decision, budget warning/paused, agent awaiting trust grant.

## Reference points
- VenturOS (ventur-os.com): the map-in-motion hero, named-exec ownership, "drafting is autonomous; publishing waits for your yes" framing — steal the feeling, exceed the craft.
- Claude Projects: knowledge/files-per-project mental model (already built in Cue).
- What neither has (Cue's wedge, make it visible): ALL inbound flowing in automatically and becoming mission work — show captured items auto-filing onto the map.
