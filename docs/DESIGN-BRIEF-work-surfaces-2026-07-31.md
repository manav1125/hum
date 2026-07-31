# Design brief — Cue's work surfaces

**Date:** 2026-07-31 · **Author:** engineering (findings verified against production `cue-manav-prod`)
**For:** design rework of HQ, All Work, People, and the surfaces that show what Cue is doing
**Status:** problem definition. No solution is prescribed — the engineering constraints are stated so design can push against real walls rather than imagined ones.

---

## 0. Read this first — the one-sentence version

Cue's product promise is *"an AI that watches your work and brings you what matters."* Today it is **an AI that answers when asked.** Nothing arrives on its own, because nothing is watching. Every UI problem below is downstream of that, and the UI currently hides it rather than showing it.

---

## 1. What is actually true in production today

Every number here is from the live instance, not an estimate.

| Thing | Reality |
|---|---|
| Inbound channel events, all time | **1** (one Slack message, 2026-06-20) |
| Work items created by the inbound-capture path | **0** |
| Watchers configured | **0** |
| Messages in non-`vellum` conversations | **8**, out of 18,144 |
| Contacts | **2** — both are the owner |
| Contact memories | **0**, from 718 extraction jobs that all "succeeded" |
| Missions | **1**, status `abandoned` since 2026-07-16 |
| Heartbeat runs | **1,851** (every 30 min, invisible unless you dig into Settings) |
| Assistant turns saying "I don't have access to your emails" | **77** of 8,887 |

**Gmail is not connected to Cue as a channel.** It is a pull-only tool the agent calls mid-conversation. There is no webhook, no inbound route, no observer. The same is effectively true of Slack — its events subscription delivered one message in June and nothing since.

So when the user says *"none of the conversations from Gmail or Slack show up in HQ until I ask"* — that is not a bug. **That is the system working as built.**

---

## 2. The core structural problem

### HQ is a database view, not a workspace

HQ renders exactly one thing: `work_items`, grouped by status into four lanes. It has **no representation for a conversation, a thread, or a person.** An email thread cannot appear in HQ. A Slack conversation cannot appear in HQ. They have nowhere to go.

The mental model the UI implies — *"HQ is where everything Cue is tracking lives"* — is not the model underneath. The model underneath is *"HQ is a task queue, and tasks are created almost exclusively by the agent during a chat turn."* 78 of 93 work items were created that way.

### Nothing turns a connection into an observation

The machinery to watch a channel **exists and runs**: a watcher engine polls on every scheduler tick, and a Gmail watcher provider is implemented and wired to create work items. It has never had a single watcher to run, because **connecting a connector does not create one.** Connecting Gmail today grants the agent the ability to *look* when asked. It does not cause Cue to *watch*.

This one gap produces at least three of the user-visible symptoms:
- HQ is empty of anything that arrived on its own
- People is empty (no channel bindings ⇒ no contacts ⇒ no relationship memory)
- The assistant genuinely has nothing to proactively surface

---

## 3. The four surfaces, and what's wrong with each

### 3.1 HQ — three numbers for one idea

The same concept is counted three different ways on screen simultaneously: sidebar badge **5**, headline **"6 things I'd glance at"**, All Work **24**. Two were defensible (different questions), one was an off-by-one, now fixed.

The deeper issue is not the arithmetic. It is that **"how much needs me?" has no single canonical answer in the product**, so each surface invented its own. Design needs to decide what the number *means* before engineering can make it agree.

### 3.2 All Work vs HQ — two answers to the same question

The user's words: *"the tasks Cue page is different from a usability perspective than HQ… it's just not intuitive and this is a core moat."*

They are two different renderings of overlapping data with different grouping, different vocabulary, and no stated relationship:

- **HQ** — editorial. "Good morning. A calm one — 6 things I'd glance at." Curated, opinionated, hides most of the list.
- **All Work** — a ledger. "Everything, one list." Exhaustive, status-grouped, hides nothing.

Neither is wrong. But a user cannot tell **when to use which**, and the same item appears in both with different affordances. The status vocabulary also splits: HQ says *needs you / came in / running / done*; All Work says *review / in motion / queued*. `AWAITING REVIEW`, `QUEUED`, `RUNNING` are raw enum values shown to users.

**This is the piece the user is calling a moat, and it is the piece with the least design coherence.**

### 3.3 People — empty, and structurally so

"The people Cue knows" shows *No people yet* after 30+ days. Two independent causes:

1. **Nothing observes people.** Email senders, calendar attendees and thread participants are never recorded. Only explicit invite flows create contacts.
2. **A filter bug hides the rest.** The two existing rows merge into one, get promoted to `guardian`, and the page filters guardians out. Generalised: *any real contact who shares a normalised name with the owner is permanently invisible.* (One-line fix, but it only ever reveals the owner until cause 1 is solved.)

The 718 "completed" extraction jobs are all no-ops. **A no-op and a success are recorded identically**, which is why this was invisible for a month. That is a design problem as much as an engineering one: *the system had no way to tell anyone it was doing nothing.*

### 3.4 The invisible machine

Cue runs roughly **40 recurring timers** — a 30-minute heartbeat (1,851 runs), a 15-minute mission sweep, memory consolidation, decay, filing, queue drainers. The user asks, reasonably: *"shouldn't these be showcased somewhere?"*

Partly they are: **Settings → Schedules** already shows heartbeat, consolidation and retrospective with run history and a "run now" control, wired to real endpoints. It is buried two levels deep in Settings, framed as configuration rather than as activity.

Meanwhile **Automations, Explore and Guardrails are orphan routes on desktop** — they exist, they're in mobile navigation, and they are absent from the desktop sidebar. Automations would currently show an empty board.

**The gap is framing, not capability.** Cue does a great deal on the user's behalf and tells them almost none of it. The one place it does is filed under Settings.

---

## 4. What design needs to decide

These are genuinely open, and engineering should not decide them by default.

1. **What is HQ?** A triage inbox (everything arrives, you clear it), a briefing (an editor picks the few things worth your attention), or a control room (live state of an autonomous system)? It is currently written like a briefing, structured like a task queue, and populated like a chat log.

2. **What is the relationship between HQ and All Work?** Same data, two lenses? Or two genuinely different jobs? If the former, they need one vocabulary and an obvious switch. If the latter, they need names that make the difference self-evident.

3. **How does an item *arrive*?** Once watchers exist, HQ will receive things the user never asked for. What does an unreviewed arrival look like? How does it differ from work Cue chose to do? What is the density budget when 40 things arrive on a Monday?

4. **What is the single "needs you" number?** One definition, used everywhere.

5. **How does Cue show its own activity?** There is a real trust asset here — 1,851 heartbeats is evidence of an assistant genuinely working. Right now it reads as nothing at all.

6. **What does an empty state promise?** "As Cue meets people across your channels, they'll show up here" is currently a promise the system cannot keep. Empty states should distinguish *"nothing yet"* from *"not set up"* from *"something is broken."*

---

## 5. Engineering constraints design should know

- **Work items have a fixed status vocabulary** (`awaiting_review`, `running`, `queued`, `done`) plus `source_type` and an assignee. Any new grouping must map onto these or the schema changes.
- **The watcher engine already exists** and creates work items with a `came_in` lane. Auto-provisioning on connector-connect is a small change; the design question of what arrives and how it's presented is the large one.
- **Composio provides logos for ~500 connectors** at a stable URL — connector-dense UI is cheap.
- **Surfaces are model-driven.** The assistant renders cards (`oauth_connect`, `connector_recommend`, `table`, `choice`, `work_result`) by calling a tool. New card types are additive and cheap; the constraint is that the *model* must choose to use them, which is a prompt-reliability problem, not a UI one.
- **Live updates run over SSE with a 60-second REST fallback.** Designs may assume near-real-time, but must degrade legibly.
- **Mobile follows a separate v3 native spec** and is not a responsive fold of desktop. Both need answering.

---

## 6. What is already fixed (don't design around these)

- Connector cards show real logos rather than coloured initials
- Desktop OAuth "Popup blocked" dead-end
- The assistant no longer claims it lacks email access without looking, and presents connections as cards rather than pasted links
- HQ headline count off-by-one
- The live indicator no longer says "reconnecting…" when nothing is retrying
- Mobile Today's primary CTA, which navigated in a circle
- The one fabricated number in the app ("1 OPEN ROLE") and a button that did nothing ("Undo all")

---

## 7. Suggested sequencing

**Nothing here is worth designing beautifully until things actually arrive.** The recommended order:

1. **Auto-provision watchers on connector connect.** Small engineering change. Turns HQ from a task queue into a live feed and gives People its channel bindings for free. *Everything below depends on this.*
2. **Design the arrival.** What an unrequested item looks like; how it's triaged; what the density budget is.
3. **Resolve HQ vs All Work** into one coherent model with one vocabulary.
4. **Give the running machine a face** — promote the existing Schedules data out of Settings.
5. **People**, once observation feeds it.

---

## Appendix — where to look

| Concern | Location |
|---|---|
| HQ surface | `apps/web/src/pages/hq/hq-page.tsx`, `hq-board.tsx`, `hq-kit.tsx` (`RingsHero`) |
| All Work | `apps/web/src/pages/projects/all-work-page.tsx` |
| People | `apps/web/src/domains/people/people-page.tsx` |
| Work item model | `assistant/src/work-items/` |
| Inbound capture (never fires) | `assistant/src/work-items/commitment-capture.ts` |
| Watcher engine + Gmail provider | `assistant/src/watcher/` |
| Contacts | `assistant/src/contacts/`, `contact-presentation.ts` |
| Recurring jobs | `assistant/src/heartbeat/`, `assistant/src/missions/mission-orchestrator.ts` |
| Existing schedules UI | `apps/web/src/domains/settings/pages/schedules-page.tsx` |
| Surface catalogue | `assistant/src/tools/ui-surface/definitions.ts` |
