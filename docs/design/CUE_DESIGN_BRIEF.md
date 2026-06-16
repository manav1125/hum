# Cue — Design Brief (WS5 Design Uplift)

> Hand-off document for the design effort. Covers the product, the full feature/functionality map, design principles, the existing visual system to evolve, and per-surface UX guidance. **Specific screen-level design decisions will be guided by the product owner** — this brief defines the frame, the constraints, and the intent, not the final pixels.

---

## 1. What Cue is

Cue is a **local-first personal AI assistant** for macOS (Electron desktop app + web renderer + a local daemon that runs on the user's machine). It is not a chatbot — it is a **personal operating layer**: it reads and writes the user's real tools (email, calendar, docs, CRM, messaging), proactively surfaces what needs attention, and can act on the user's behalf — including taking direct control of the screen.

The product has three layers that the design must make legible:

1. **Data layer (Connectors / MCP)** — the assistant connects to the user's real accounts (Gmail, Calendar, Notion, Slack, …) and can read *and write* through them, per-tool, per-user.
2. **Workflow layer (Skills)** — reusable, honed procedures that shape *how* the assistant does things (inbox triage, meeting prep, reservation booking, …).
3. **Proactive OS layer (Home / Action Board / Automations)** — the assistant works ahead of the user: a daily action board of to-dos drawn from connected data, one-click and automatic routines (e.g. auto-draft replies), scheduled agents.

Plus a signature capability: **Cue Live** — hold-to-talk voice + screen vision where the cursor physically flies to point at things on screen, speaks answers aloud, and can take control to click and type to complete a task.

**Positioning the design must convey:** calm, trustworthy, *in control*, ahead-of-you. Not a flashy AI toy — a competent operator that lives on your desktop. Closer to a premium native macOS productivity tool than a web SaaS dashboard.

---

## 2. Brand & naming

- **Product name:** **Cue** (user-facing everywhere). Legacy "Vellum" strings remain in package names and the browser `<title>` — design should treat **Cue** as the canonical brand; flag any user-visible "Vellum" string as a bug to fix.
- **App icon (existing):** navy rounded-square (`#1A2230`) with a white circle and a Cue-blue (`#3D6EE8`) dot accent (`assets/cue/icon.svg`). The "dot/cue point" motif (a precise point of focus) is a strong brand seed — the cursor-fly target, the "cue" to act. Consider extending it into a coherent mark + motion signature.
- **Tone of voice:** concise, confident, second-person, low-ceremony. "3 emails need a reply." not "I found some emails that may require your attention!" Never chirpy. Never alarmist (it surfaces a banking alert without shouting).

---

## 3. Existing visual system (evolve, don't discard)

The app already has a real, coherent token system in `packages/design-library/src/tokens.css`, mirrored to the Swift macOS client. **Treat this as the baseline to refine and systematize — not a blank slate.** Consistency with macOS-native feel is a deliberate, load-bearing choice.

**Themes:** three modes via `data-theme` — `light` (default), `dark`, `velvet` (dark + red/pink accent). All three must remain first-class.

**Color**
- Neutrals: **Moss/Stone** cool-warm neutral ramp (`#F6F5F4` → `#17191C`).
- Accent (Cue): **`#3D6EE8`** blue (interactive/focus), secondary violet `#7F77DD`.
- Semantic: Forest/Emerald green (positive), Danger orange-red (`#DA491A`), Amber (warning).
- **Ink Hero** surfaces (`#1A2230` base, theme-independent) for focus moments — voice mode, focus cards, the "act now" surfaces. This is the premium, attention-commanding surface.
- Memory system has an 8-type color taxonomy (semantic/episodic/procedural/…) — keep it but audit for accessibility.

**Type**
- **DM Sans** (variable 100–1000) primary; **DM Mono** for code/IDs; **Instrument Serif** for display moments. Type tokens already exist (`--text-title-large`, `--text-body-medium`, `--text-label-*`).

**Spacing** `2 / 4 / 8 / 12 / 16 / 24 / 32 / 48`. **Radii** `2 / 4 / 8 / 12 / 16 / 20 / 999(pill)`. **Shadows** sm/md/lg + accent-glow + warning-glow.

**Motion** (mirrors Swift): snappy 120ms, fast 150ms, standard 250ms, slow 400ms; spring `cubic-bezier(0.16,1,0.3,1)`. Motion is part of the brand — the cursor fly, avatar morph/breathe, voice orb. Keep motion purposeful and physical, never decorative jank.

**Components:** ~70 custom Radix-based primitives in `@vellumai/design-library` (Card, SideMenu, Button, Chip, Toast, Modal, Tabs, ApertureAvatar, VoiceOrb, FocusCard, SourceTag, …). **Design should work within/extend this library**, not introduce a parallel kit. Deliverables that change primitives must update the library so all surfaces inherit.

**Layout:** centered chat column (`--chat-max-width: 800px`); collapsible left sidebar (240–400px) persistent across the app; settings/logs as full-screen overlays.

---

## 4. Full surface & feature map (what exists, what each needs)

The app shell = persistent **left sidebar** (conversations + nav) + main content. Settings/logs/onboarding are overlays/flows. Design priority tiers noted as **[P1/P2/P3]**.

### Core daily surfaces
- **Home / Action Board** `[P1]` — `domains/home/home-page.tsx`. The proactive heart. Greeting header, the **daily action board** (prioritized cards from connected data: emails needing replies, banking/security alerts, meeting prep), one-click actions ("Draft reply"), suggested prompts, a "next move" focus card, unread badge. *This is the screen that proves Cue is ahead of you — it deserves the most design love.* Needs: a clear card hierarchy (urgency, category), scannable triage, satisfying one-click action affordances, empty/clear state ("you're all caught up"), and a sense of "freshly assembled this morning."
- **Chat / Conversation** `[P1]` — `domains/chat/chat-page.tsx`. Thread transcript + composer + streaming. The agent's tool calls, approvals, and actions surface here. Needs: legible distinction between the assistant *talking* vs *acting* (tool use, file/email writes, approvals), streaming feel, attachments, and a calm, focused reading column.
- **Sidebar / conversation list** `[P1]` — search, threads, new-conversation, assistant selector, account menu. Needs: fast scanning, clear active state, graceful collapse, mobile drawer.

### Intelligence hub (tabbed: "About your assistant")
- **Identity** `[P2]` — name, avatar (ApertureAvatar), personality, system prompt. The "who is my assistant" surface.
- **Cue Live** `[P1, signature]` — `cue-live-page.tsx`. Hotkey config, voice keys (AssemblyAI/ElevenLabs), auto-run goals, take-control toggle, a visual explainer of *how it works* (hold-to-talk → see → point → speak → act). Needs: a confident, almost cinematic explainer; clear permission/status states (Accessibility, Screen Recording, Mic); a safe, legible "take control" affordance (this is high-trust — the design must make it feel deliberate and reversible).
- **Connectors** `[P1]` — `connectors-page.tsx`. Category-grouped apps (email, calendar, files, CRM, messaging, dev), Connect/Disconnect, **per-tool enable/disable toggles** per connection. Needs: connection status clarity, per-user/per-account framing ("your accounts, isolated"), trust around read/write scope, search across many apps (this scales to dozens/hundreds of connectors).
- **Skills** `[P2]` — bundled + uploaded skills as a card grid. Needs: discoverability, "what does this do," install/enable states.
- **Memory** `[P2]` — 8-type memory browser, filterable. Needs: make the memory taxonomy legible without overwhelming; trust/transparency ("here's what I remember about you," with edit/delete).
- **Workspace** `[P3]`, **Contacts** `[P3]` — team/shared context; contact directory for personalization.

### Extensibility & content
- **Plugins** `[P3]` — browse/configure plugins + detail pages.
- **Library** `[P2]` — browse/launch published apps (personal + platform catalog) + detail pages.
- **Documents** `[P2]` — document viewer surface, separate from chat.
- **Inspector** `[P3]` — dev/debug trace of conversation state, LLM calls, memory routing (feature-flagged).

### System
- **Settings** `[P2]` — full-screen overlay, ~16 sub-pages: General, AI, Integrations, Schedules, Notifications, Shortcuts, Sounds, Voice, Devices, Privacy, Archive, **Billing**, Community, Debug, Developer, Advanced, Danger Zone, System Events. Needs: a coherent settings IA (this many pages needs grouping + search), consistent form patterns.
- **Logs / Analytics** `[P3]` — usage, trace, system events, email logs.
- **Notifications** `[P2]` — multi-channel (in-app, and routed to Telegram/Slack/push); the action board and scheduled agents emit here.

### Flows
- **Onboarding** `[P1]` — `welcome → select-assistant → review-terms → onboarding/* (hosting/API key, privacy, customization, "hatching" animation, activation)`. First impression. Needs: make local-first + privacy a *selling point*, set up at least one connector during onboarding (so Home isn't empty), and the "hatching" moment should feel special (the assistant coming alive). Compact window sizing (~440×630) is an established constraint for these.
- **Account / Auth** `[P2]` — login/signup/oauth/callback/password reset; compact 440×630. (Tied to WS4 platform.)
- **Managed / Platform assistants** `[P2]` — cloud-hosted assistants, device management, billing — emerging in WS4; design should anticipate a "local vs managed" distinction in the assistant selector and settings.

### Desktop-only floating panels `[P2]`
- **Quick input**, **floating command palette**, **dictation overlay**, **about**, **bundle confirm** — frameless, on-top, fast-summon. These are signature desktop moments; they should feel instant, weightless, and native (think Spotlight/Raycast quality).

---

## 5. Design principles

1. **Calm authority.** The assistant is competent and ahead of you. Restrained color, generous space, clear hierarchy. Reserve the Ink Hero surface and accent-glow for genuine focus/act moments so they retain power.
2. **Native, not webby.** Match macOS feel — the motion, the spacing, the materials. This is a desktop tool the user keeps open all day; it should feel like part of the OS, not a browser tab.
3. **Action is the unit.** Cue's value is *doing*, not *chatting*. Every surface should make "what can I act on / hand off?" obvious. One-click and one-glance.
4. **Trust is the product.** It reads your email and can control your screen. Design must always answer: *what is it about to do, on whose behalf, and can I stop it?* Make scope, permissions, and reversibility visible — especially Connectors (read/write) and Cue Live (take-control).
5. **Proactive, not noisy.** Surface what matters, when it matters; never cry wolf. The action board and notifications must respect attention (urgency tiers, dedupe, "you're caught up" states).
6. **Legible intelligence.** Memory, tool calls, and automations should be transparent and editable, not magic black boxes.
7. **One system.** Everything flows from the token set and the design-library primitives across light/dark/velvet. No one-off styling.

---

## 6. UX patterns to define/standardize (good targets for the design effort)

- **Action card** (Home) — urgency, category, title, summary, primary/secondary actions, source attribution, dismiss/snooze. The hardest-working component.
- **Agent action / tool-use rendering** (Chat) — "Cue is drafting…", "Cue created a draft in Gmail", approvals, write confirmations. Distinct from prose.
- **Permission & take-control states** (Cue Live, Connectors) — granting, granted, blocked, "acting now / stop."
- **Connection card + per-tool toggles** (Connectors) — scalable to many apps, status, account identity.
- **Empty / caught-up / not-connected states** everywhere — these are first impressions and must be designed, not afterthoughts (esp. Home before connectors exist).
- **Notification → home-feed → conversation** continuity — one coherent thread from "we noticed X" to "here's the draft."
- **Settings IA** — group + search ~16 pages coherently.
- **Onboarding-to-first-value** — get one connector connected and one action-board item visible before the user lands on Home.

---

## 7. Deliverables requested from design

1. **Foundations pass:** audit + refine the token system (color contrast/AA, type scale, elevation, motion) and document it as the single source of truth. Confirm/extend the Cue brand mark and the "cue point" motif.
2. **Core flows, high-fidelity:** Onboarding → Home/Action Board → Chat (with agent-action rendering) → Connectors → Cue Live. These five are the product story.
3. **Component specs** that update `@vellumai/design-library` (so engineering inherits, not reskins): Action card, agent-action message, connection card, permission/take-control states, empty states.
4. **Light/dark/velvet** for every delivered surface.
5. **Motion spec** for the signatures: cursor-fly, voice orb, avatar, action-board assembly, floating-panel summon.

**Out of scope / owner-guided:** exact IA choices, copy, specific layouts per screen, and prioritization beyond the P-tiers above — the product owner will steer these interactively.

---

## 8. Constraints & gotchas for design

- **Three themes are mandatory** (light/dark/velvet) — design every surface for all three.
- **Tokens-first:** changes must land as tokens/primitives in `packages/design-library`, consumed by `apps/web` (and mirrored conceptually to the Swift client — keep parity in mind).
- **Desktop-first** (Electron/macOS) but the renderer also runs responsive/mobile (drawer sidebar) — don't break the narrow layout.
- **Frameless floating windows** have fixed compact sizes; design within them.
- **Accessibility:** keyboard-focus variant exists (`data-modality`); maintain visible focus, AA contrast, and reduced-motion fallbacks for the heavy motion surfaces.
- **Local-first privacy** is a brand value — surface it, don't hide it.
