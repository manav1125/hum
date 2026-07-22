# Cue — Mobile (v3) Capability-Parity Audit

**Scope:** what the desktop / macOS web surfaces expose that the new mobile **v3** surfaces omit.
**Method:** desktop component tree (actions/controls/options rendered) vs the mobile v3 branch, per surface.
**Read-only audit.** Classes: **A** = restore now with existing v3 patterns · **B** = needs design (new screen/pattern) · **C** = keep desktop-only (with an honest pointer). Priorities inside A: **P0** core daily-use · **P1** important · **P2** long tail.

> Key architecture facts established while auditing:
> - Mobile v3 tab bar = `Today · Projects · + · Voice · You` (`mobile-v3/tab-bar-v3.tsx`). The `+` lifts `create-sheet.tsx` over the current screen.
> - Extra reach is only via the `⋯` overflow (`mobile-v3/overflow-menu.tsx`): **Chats · Search (⌘K) · Settings · Logs**. Plus the You screen's rows + two quiet footer lines.
> - Many domain pages branch on `useIsMobile()` and render a `Mv3*` variant (projects, project-detail, memory, connections, skills, rules, ledger, agents, chat, meeting, library). Desktop trees are left byte-identical.
> - Several settings pages are **reachable** on mobile (they render) but are **not** v3/touch-adapted (only `notifications-page.tsx` has an `isMobile` branch; `settings-layout.tsx` does not).

---

## 1. Create — the owner's named example

Desktop `domains/create/create-view.tsx` renders **11 modes** (`create-templates.ts` `CREATE_MODES`), each with a **quick-start** row *and* a **structured template form** row, plus a **StudioComposer** (typed prompt + reference-drop + brand toggle) and a per-mode **gallery overlay** (`create-gallery-overlay.tsx`) backed by `studio-specs.ts`.

Mobile `domains/create/create-sheet.tsx` renders **4 modes** (`slides · docs · images · data`), a single-line prompt, a **thumbnail strip** (reusing the spec catalogs as pictures only), an auto brand-match (slides only), and `Create it →`.

| Capability | Desktop source | Mobile status | Class | Where on mobile | Priority |
|---|---|---|---|---|---|
| **Research mode** (web + browser research) | `create-templates.ts` mode `research` (4 quick-starts) | Absent | **A** | 5th mode chip in `create-sheet` → seeds `research` skill | **P0** |
| **Video mode** (generate clips / animate / analyze footage) | mode `video` (9 templates); `VIDEO_STYLE_SPECS` (6 styles, live/animated) | Absent | **A** (chip + strip reusing `VIDEO_STYLE_SPECS`); live/animated sub-tabs = B | mode chip + style strip | **P1** |
| **Canvas** image-edit actions (Create new · Edit · Upscale · Remove bg) | `CANVAS_ACTION_SPECS` (studio-specs); `create-templates` mode `canvas` | Absent | **B** (needs image-attach + action flow) | new edit sheet off `+` | **P1** |
| **Sheets mode** (real .xlsx models) | mode `sheets` → `spreadsheet-studio` | Absent (folded into "Data" strip label only) | **A** | mode chip / Data format `sheet` | **P2** |
| **Audio mode** (music / voiceover / SFX) | mode `audio` (4 templates) | Absent | **A** | mode chip | **P2** |
| **Leads mode** (Apify scraping) | mode `leads` (3 templates) | Absent | **A** | mode chip | **P2** |
| **Structured "Fill & build" template forms** (typed fields → composed prompt) | `create-form-templates.ts` (**18 forms**: 3 slides, 3 data, 3 docs, 3 images, 3 research, 1 video, 1 leads); `create-template-form.tsx` | Absent (strip is picture-only) | **B** (a fielded form sheet: text/textarea/select/number/url/tags) | tap a strip pick → form sheet | **P1** |
| **Quick-start prompt cards** (one-tap prefilled prompts) | `CREATE_MODES[].templates` (3–4 per mode) rendered as `QuickTemplateCard` | Absent | **A** (a second strip of prompt chips per mode) | under the template strip | **P1** |
| **Gallery overlay — deck template breadth** (18 `TEMPLATE_SPECS`, category tabs + search + fidelity badge) | `create-gallery-overlay.tsx` `SlidesGrid` | Only a flat scroll of thumbnails, no tabs/search | **A** (category chip rail + search, per the spec's "longer lists" grant) | inside slides strip | **P2** |
| **Image style breadth** (15 `IMAGE_STYLE_SPECS`) | gallery `StyleGrid` | Present as strip (parity of data) | — | — | — |
| **Data: chart-type multi-select** (6 `CHART_TYPE_SPECS`) | gallery `DataPicker` (format + multi charts) | Absent (only the 4 format picks) | **A** (chip multi-select row) | under Data strip | **P2** |
| **Reference drop — "make it look like this"** (drag image / paste URL → per-generation style; `CreateReference`) | `create-view.tsx` `ReferenceDrop` / `ReferenceChip` | Absent | **B** (mobile attach-image / paste-URL affordance + extract beat) | composer of `create-sheet` | **P2** |
| **Brand toggle for non-slides modes** (`In your brand ✓` on docs/images/data) | `StudioComposer` brand toggle applies to all gallery modes | Only auto-applied to slides | **A** | brand chip in sheet | **P2** |
| **Multi-line prompt** (Shift-Enter, textarea) | `create-view` textarea | Single-line `<input>` | **A** (swap to textarea) | sheet prompt | **P2** |

---

## 2. Chat

Desktop composer (`chat-composer/chat-composer.tsx`) + `chat-layout.tsx` chrome expose a rich control surface. Mobile v3 chat (`domains/chat/components/mobile-chat-view.tsx`) **reuses the live `Transcript`** (so tool chips, subagent cards, surfaces, confirmations all work) but ships its **own minimal composer**: a plain `<textarea>` + `+` (attach) + mic. Everything else is dropped.

| Capability | Desktop source | Mobile status | Class | Where on mobile | Priority |
|---|---|---|---|---|---|
| **Model profile picker** (per-conversation + global) | `composer-settings-menu.tsx` (has a `BottomSheet` mobile variant already!) | Not mounted in `mobile-chat-view` | **A** | a `⋯`/sliders button in the mchat header → the existing `BottomSheet` | **P0** |
| **Assistant Access / autonomy threshold override** (per-conversation) | `composer-settings-menu.tsx` `THRESHOLD_PRESETS` | Not mounted | **A** | same bottom sheet | **P0** |
| **Conversation actions menu** (Pin · Rename · Archive · Mark read/unread · Analyze · Open in new window · Inspect context · Copy full conversation · Fork · Refresh · Share feedback) | `conversation-actions-menu.tsx` (already exposes a mobile primitive set) | Absent (no menu in mchat header) | **A** (Pin/Rename/Archive/Copy/Feedback); Inspect+Open-new-window = C | header `⋯` menu | **P1** |
| **Slash commands** (`/` command palette in composer) | `chat-composer` `SlashCommandPopup` | Absent (mchat textarea has none) | **A** | mchat composer | **P1** |
| **Context-window indicator** | `context-window-indicator.tsx` (slot) | Absent | **A** | mchat composer chrome | **P2** |
| **Live full-duplex voice mode** (in-chat orb) | `EnterVoiceModeButton` in composer (gated `voice-mode` flag) | Absent from mchat (there is a separate Voice *tab*) | **B** (decide: in-thread orb vs Voice tab only) | mchat mic long-press or Voice tab | **P1** |
| **Emoji picker / markdown-format shortcuts / ghost autocomplete / recall-last-message** | `chat-composer` (emoji, `matchFormattingShortcut`, `computeGhostSuffix`, `onRecallLastMessage`) | Absent | **C** (desktop-keyboard ergonomics) | — | — |
| **App / Canvas editing split** (open an app from chat into the editor) | `chat-layout.tsx` `useOpenAppFromChat` / `enterAppEditing` | Absent | **B** (mobile app-edit is a real new pattern) | — | **P2** |
| **LLM Inspector** (per-conversation context inspector) | `chat/inspector/*`, `chooseSidebar…`, `useCanUseLlmInspector` | Absent | **C** (power-debug) | pointer in settings/logs | — |
| **Attachments · dictation mic** | composer | **Present** (shared `useComposerStore`, `VoiceInputButton`) | — | — | — |

---

## 3. Projects / work

Desktop: `pages/projects/projects-page.tsx` (already a shared restyle) → `project-detail-page.tsx` (kanban lanes, quick-add, `TaskDrawer`, `ProjectBrief`, `ProjectKnowledge`, `AddExistingPanel`) and **All Work** `all-work-page.tsx` (group-by status/project/due). Mobile: `mv3-projects.tsx`, `mv3-project-detail.tsx`, `mobile-v3/triage/came-in-page.tsx`, `review/review-queue-page.tsx`, `watch/watch-live-page.tsx`.

| Capability | Desktop source | Mobile status | Class | Where on mobile | Priority |
|---|---|---|---|---|---|
| **All-Work list with group-by (status / project / due)** | `all-work-page.tsx` (`/work`) | Not reachable (tab `to` = `/projects`; Mv3Projects has no `/work` link) | **A** | a "All work" entry on Mv3Projects + segment chips (status/project/due) reusing existing grouping | **P0** |
| **Task drawer — edit due date** | `task-drawer.tsx` `dueAt`/`DueChip` | Absent (mv3 detail rows are read + approve/step-in only) | **A** (due-date leaf in a task sheet) | tap a work row → task sheet | **P1** |
| **Task drawer — labels** | `task-drawer.tsx` `labels[]` (parsed JSON) | Absent | **A** (chips in task sheet) | task sheet | **P2** |
| **Task drawer — reassign / "Filed to" (ReassignMenu)** | `task-drawer.tsx` `ReassignMenu` + teach toast | Absent | **A** (reassign row) | task sheet | **P1** |
| **Task actions: Run now · Redo · Run again · Open thread** | `task-drawer.tsx` action row | Partial (mv3 has Approve & finish, Step in, Watch live) — **Run now / Redo / Run again** missing | **A** | task sheet buttons | **P1** |
| **Kanban board lanes** (per-status columns) | `project-detail-page.tsx` `BOARD_LANES` / `laneForStatus` | Absent (mv3 detail is a linear stack) | **C** (columns don't fit phone; the stack is the mobile form) | — | — |
| **Quick-add task** (type a task into a project) | `project-detail-page.tsx` `useQuickAddTask` | Absent | **A** (an inline "+ add task" row) | mv3 project detail | **P1** |
| **Project brief (editable)** | `project-brief.tsx` | Absent | **B** (mobile brief editor) | project detail | **P2** |
| **Project knowledge / files** | `project-knowledge.tsx` (`use-project-knowledge`) | Absent | **B** | project detail | **P2** |
| **Add existing work to a project** | `add-existing-panel.tsx` | Absent | **A** (picker sheet) | project detail | **P2** |
| **New project (full modal: emoji, color, category, mission link)** | `new-project-modal.tsx` | Mv3Projects routes "+ Tell Cue…" to Create (conversational), no structured create | **A** (a small new-project sheet) or keep conversational | Mv3Projects header | **P2** |
| **Pin / unpin project** | `projects-page.tsx` `togglePin` | Absent on Mv3Projects cards | **A** | card long-press / row action | **P2** |
| Triage swipes / Review pager / Watch-live | — | **Present** (`came-in`, `review-queue`, `watch-live`) | — | — | — |

---

## 4. Memory / Contacts / People

Desktop `intelligence/memories-page.tsx` (kind chips over `MEMORY_TYPES`, per-kind counts, search, edit/forget) and `people/people-page.tsx` (full relationship **dossier**: score/tier badge, reachability channels, interactions timeline, memory). Mobile `mobile-v3/you/memory-page.tsx` (People/Preferences/Work/Life segments, search, edit/forget — same mutations).

| Capability | Desktop source | Mobile status | Class | Where on mobile | Priority |
|---|---|---|---|---|---|
| **Full 8-kind filtering with per-kind counts** | `memories-page.tsx` `KindFilter` + `kindCounts` | Collapsed to 4 coarse segments | **A** (add kind sub-chips) | memory-page segment rail | **P2** |
| **Add a memory manually** | memories mutations (`memoryitemsPost`) | Only edit/forget existing | **A** (an "+ add" row) | memory-page | **P2** |
| **Memory constellation / graph view** | `intelligence/components/constellation-view/*`, `memory-v2/*` | Absent | **C** (large-canvas visualization) | pointer only | — |
| **People dossier (score, reachability, timeline)** | `people-page.tsx` `DossierPane` | Reachable via People segment → dossier route (people-page has mobile branch) | verify — likely **present**; if list-only on mobile, promote to **A** | People segment | **P1** |
| **Edit/forget memory** | mutations | **Present** | — | — | — |

---

## 5. Connectors / Channels

Desktop `intelligence/connectors-page.tsx` (catalog, category filter, connect/reconnect, **per-tool Manage** — Electron-gated), `connector-detail-page.tsx`, `channels-agents-page.tsx` (channel reach + **A2A agent pairing**: enable toggle, paired grid, invite dialog). Mobile `mobile-v3/you/connections-page.tsx` (2-col tiles, add-a-connection sheet, connector detail sheet, quiet Channels footer link).

| Capability | Desktop source | Mobile status | Class | Where on mobile | Priority |
|---|---|---|---|---|---|
| **Connect / reconnect app (OAuth)** | `connectors-page.tsx` | **Present** (real OAuth + poll) | — | — | — |
| **Per-tool scopes / Manage** (which tools in a connector are enabled) | `connectors-page.tsx` (Electron desktop surface) | Absent (sheet says so) | **C** (with honest pointer, already present) | detail sheet note | — |
| **Channel setup** (Telegram / WhatsApp / email verify, token entry) | `channels-page.tsx` per-channel setup | Deep-links desktop workbench via footer "Channels" | **B** (native channel-verify flow) or keep C-with-pointer | You footer → Channels | **P1** |
| **A2A agent pairing** (enable, paired-agents grid, invite dialog) | `channels-agents-page.tsx` Agents section | Absent on mobile "You" tab | **C** (with pointer) or **B** | — | **P2** |
| **Disconnect a connector** | connectors-page | Verify in detail sheet; if absent → **A** | detail sheet | **P2** |

---

## 6. Skills / marketplace

Desktop `intelligence/components/skills/skills-tab.tsx` + skill detail. Mobile `mobile-v3/you/skills-page.tsx` (Explore/Installed/Sources; real two-phase install + consent sheet; skill file content; manage screen).

| Capability | Desktop source | Mobile status | Class | Where on mobile | Priority |
|---|---|---|---|---|---|
| **Explore marketplace + install (plan → consent → confirm)** | `skills/install.ts`, `use-source-items` | **Present** | — | — | — |
| **Installed manage / remove** | `skillsGet`, delete mutation | **Present** | — | — | — |
| **Marketplace sources (add/remove/toggle)** | source registry | **Present** | — | — | — |
| **Per-skill run history / runs·reversed / spend** | (desktop manage detail) | Omitted (no per-skill data source yet — honest) | **C** (until data exists) | — | — |
| **Skill file browser depth** | `skill-file-content.tsx` | **Present** (reused) | — | — | — |

*Skills is at near-parity — a rare bright spot.*

---

## 7. Settings

Desktop tree (`routes.tsx`, `settings/pages/*`, `settings/ai/*`): **general, ai, integrations, brand, schedules(+editor), notifications, keyboard-shortcuts, sounds, voice, devices, privacy, budget, archive, billing, debug, developer, advanced, danger-zone, system-events**. Mobile reaches: You footer → **general(appearance)**, **notifications** (only notifications is touch-adapted), **brand kit**; and `⋯ → Settings` opens `settings.root` — which renders the **desktop** `settings-layout.tsx` (sidebar, not touch-adapted).

| Settings leaf | Desktop source | Mobile status | Class | Where on mobile | Priority |
|---|---|---|---|---|---|
| **Settings index is desktop-chrome** | `settings/settings-layout.tsx` (no `isMobile`) | Renders desktop sidebar on phone | **A** (a v3 settings list screen — the "settings leaf rows" grant) | new "Settings" You screen | **P0** |
| **AI / model config** (`LanguageModelCard`, providers, image-gen, STT/TTS, web-search, profiles, call-site overrides) | `settings/ai/*` | Unreachable in usable form | model-switch = **A** (already a bottom sheet, see §2); full config = **C** (pointer) | chat sheet + pointer | **P1** |
| **Privacy / data retention / autonomy** | `settings/pages/privacy-page.tsx` | Autonomy surfaced via You dial + Rules; retention toggles unreachable | **A** (privacy leaf rows) | You settings screen | **P1** |
| **Schedules** (list + `:scheduleId` editor) | `settings/pages/schedules-page.tsx` | Unreachable | **A** (list) + **B** (editor) | You settings → Schedules | **P1** |
| **Billing / budget / usage** | `settings/billing/*`, `budget-page.tsx`, billing-usage charts | Unreachable in v3 form | **A** (billing/usage rows) | You settings | **P1** |
| **Voice settings** | `voice-page.tsx` | Unreachable | **A** leaf | You settings | **P2** |
| **Sounds** | `sounds-page.tsx` | Unreachable | **A** leaf | You settings | **P2** |
| **Archive** | `archive-page.tsx` | Unreachable | **A** leaf | You settings | **P2** |
| **Integrations** | `integrations-page.tsx` | Overlaps Connections | **A** (or fold into Connections) | Connections | **P2** |
| **General/appearance** (theme, timezone, language, delete account) | `general-page.tsx` | Reachable, not v3-adapted | **A** (re-tone) | You → Appearance | **P2** |
| **Devices** | `devices-page.tsx` | Unreachable | **C** (desktop/pairing) | pointer | — |
| **Keyboard shortcuts** | `keyboard-shortcuts/*` | Unreachable | **C** (desktop concept) | — | — |
| **Developer / debug / advanced / danger-zone / system-events** | respective pages | Unreachable | **C** (power/dev) | pointer | — |

---

## 8. Agents / Guardrails

Desktop `guardrails/guardrails-page.tsx` = 3 bands: **Checkpoints** (toggles, scope chips, DEFAULT badges, **+ Add-a-checkpoint composer** template→scope→name), **Agent scopes** (per-agent editable `toolScopes`), **Act ledger**. Desktop agents org = `pages/hq-agents/*` (charter/hire/pause/retire). Mobile: `mobile-v3/you/rules-page.tsx` (autonomy policies + standing rules + checkpoint toggles + make-a-rule sheet), `agents-page.tsx` (roster, pause/resume/retire, re-charter, adjust-scope deep-link), `ledger-page.tsx`.

| Capability | Desktop source | Mobile status | Class | Where on mobile | Priority |
|---|---|---|---|---|---|
| **Autonomy policies (per-category auto/ask/never)** | gateway policies | **Present** (Rules) | — | — | — |
| **Standing rules toggle + make-a-rule** | trust/rules | **Present** | — | — | — |
| **Checkpoints on/off** | guardrails checkpoints | **Present** (toggle) | — | — | — |
| **+ Add-a-checkpoint composer** (template → scope → name) | `guardrails-page.tsx` band 1 | Absent (mobile only makes trust rules) | **A** (3-step sheet, reuse `CheckpointTemplate`) | Rules header "+ Checkpoint" | **P1** |
| **Agent scopes editing** (toggle `toolScopes` per agent) | `guardrails-page.tsx` band 2 | Absent (mobile guardrails = Rules + Ledger only; agents-page "Adjust scope" deep-links a band that doesn't render on mobile) | **A** (scope-chip toggle sheet — the deep-link target is broken on mobile today) | Agents → Adjust scope | **P1** |
| **Charter / pause / retire / re-charter / hire** | `hq-agents/*` | **Present** (agents-page) | — | — | — |
| **Act ledger + reverse** | acts store | **Present** (ledger-page) | — | — | — |

> **Bug flag:** on mobile, Agents → "Adjust scope" deep-links the Guardrails *agent-scopes band*, but mobile `GuardrailsPage` renders only `Mv3RulesPage`/`Mv3LedgerPage` — so the scope editor is unreachable. Restoring **Agent scopes editing** (above) also fixes this dangling link.

---

## 9. Inherently desktop, or needs a mobile decision

| Surface | Desktop source | Recommendation |
|---|---|---|
| **Cue Live** (screen capture / share) | `intelligence/cue-live-page.tsx` (`/cue-live`) | **C** — screen capture is a desktop capability. Add a "Cue Live is on your Mac" pointer if a mobile user looks. |
| **Terminal** | `domains/terminal/*` (`/... /terminal`? — desktop) | **C** — desktop/dev only. |
| **Logs / doctor** | `domains/logs/*` (reachable via `⋯ → Logs`) | **C**, but reachable; leave as-is. |
| **Workspace / file browser** | `domains/workspace/workspace-tree.tsx` (has `isMobile` branch; You footer "Workspace") | Reachable; **A** to polish the mobile tree if it's a daily need, else C. |
| **App-canvas / documents / app editing** | `chat/components/surfaces/*` (render inline in Transcript — reused on mobile) + `chat-layout` app-editing split | Inline surfaces **present**; the *editing split* is **B** (real new mobile pattern). |
| **Library (apps & documents gallery)** | `library/library-view.tsx` (has mobile branch) | **Present** on mobile; verify reachability (only via chat/home deep-links — consider a You row). |
| **Meeting capture** | `meeting/meeting-capture-page.tsx` (mv3 frame 25 present) | **Present** on mobile. |
| **Impact page** | `intelligence/impact-page.tsx` | **C**/pointer — folds into Today/Track-record tiles. |

---

## 10. Cross-cutting

| Capability | Desktop source | Mobile status | Class | Where | Priority |
|---|---|---|---|---|---|
| **Global search / ⌘K command palette** | `components/command-palette/*` | Reachable via `⋯ → Search` (opens same palette) | verify palette is touch-usable; if desktop-only widths → **A** re-tone | `⋯` menu | **P1** |
| **Model / effort (threshold) pickers** | `composer-settings-menu.tsx` | Absent from v3 chat (bottom-sheet exists but unmounted) | **A** | chat header sheet (§2) | **P0** |
| **Notifications center** | `settings/pages/notifications-page.tsx` (mobile-adapted) | Reachable (You footer) | — (present) | — | — |
| **Approvals beyond v3 cards** | `surfaces/confirmation-surface.tsx`, HQ needs-you deck | Inline confirmations render in Transcript; Today deck present | — (present) | — | — |
| **Open-in-new-window / multi-window** | chat/home | Absent | **C** | — | — |

---

## Top 10 P0 restorations (do these first)

1. **Model profile picker in mobile chat** — mount the existing `composer-settings-menu.tsx` **BottomSheet** (it already has a mobile branch) behind a header control in `mobile-chat-view.tsx`. Data/endpoint already wired (`configPatch`, `conversationsByIdInferenceprofilePut`).
2. **Per-conversation Assistant-Access / autonomy threshold** — same bottom sheet, `THRESHOLD_PRESETS` + `setConversationOverride`. (P0 for trust/autonomy control on the go.)
3. **Create → Research mode** — add the 5th mode chip to `create-sheet.tsx`; seeds the `research` skill. Pure extrapolation of the existing chip pattern.
4. **All-Work list + group-by (status/project/due)** — add an entry from `Mv3Projects` to `/work` (or a native list) using the existing `all-work-page` grouping logic and `useWorkItems`.
5. **v3 Settings screen** — replace the desktop `settings-layout` on phone with a native grouped "Settings" list under You (settings-leaf-rows grant); rows deep-link the existing pages.
6. **Create → Quick-start prompt cards** — surface the 3–4 prefilled prompts per mode (`CREATE_MODES[].templates`) as a chip strip beneath the template strip.
7. **Conversation actions on mobile chat** — Pin · Rename · Archive · Copy · Share Feedback via a header `⋯` (reuse `renderConversationMenuItems` mobile primitives).
8. **Task sheet: edit due date + reassign** — tap a work row in `mv3-project-detail` → a sheet exposing `DueChip` edit + `ReassignMenu` (existing mutations).
9. **Agent scopes editing on mobile** — restore the Guardrails "agent scopes" toggle sheet so Agents → "Adjust scope" resolves (currently a dead deep-link) — toggles `toolScopes`.
10. **Slash commands in mobile composer** — wire `SlashCommandPopup`/`filteredCommands` into the mchat textarea (or adopt the shared `ChatComposer`).

---

## B-list — copy-pasteable brief for Claude Design

These need a **new screen or interaction pattern** (not just an extrapolated row/chip). Each is one line: what + why + where.

- **Create → structured "Fill & build" form sheet.** A fielded template form (field types: text, textarea, select, number, url, tags) that composes into a prompt — desktop has 18 of these (`create-form-templates.ts`) and mobile only shows the templates as pictures. Lives as a sheet pushed from a tapped template pick in the `+` Create sheet.
- **Create → Canvas image-edit flow.** Attach/point at an image, then Create-new · Edit (inpaint/outpaint/restyle) · Upscale · Remove-background (`CANVAS_ACTION_SPECS`). Needs a mobile image-source + action-tile pattern. Off the `+` Create sheet.
- **Create → Video mode with live-action/animated style tabs.** Mode chip is easy; the sub-tab grouping (`VideoStyleKind` live/animated) over the 6 video styles needs a tab pattern in the strip.
- **Create → Reference "make it look like this".** Drag-image / paste-URL → brief "extracting the look…" → a reference chip that rides one generation (`CreateReference`). Needs a mobile drop/paste affordance in the Create composer.
- **In-thread live voice mode (orb).** Decide: is full-duplex voice the standalone Voice tab only, or also an in-thread orb (desktop's `EnterVoiceModeButton`)? If in-thread, needs the orb overlay bound to the current conversation.
- **Mobile app-editing / canvas split.** Opening a generated app/doc into an editor from chat (desktop `enterAppEditing`). A genuinely new mobile editing surface — or an explicit "edit on desktop" handoff.
- **Native channel setup / verification.** Telegram/WhatsApp/email token entry + verification on-device (today it deep-links the desktop workbench). Needs a mobile verify flow or a deliberate C-with-pointer decision.
- **Schedule editor (mobile).** The `:scheduleId` schedule editor (cron/agent/action) — the list is an A row, but the editor is a new mobile form.
- **Project brief + project knowledge (mobile).** Editable brief and a knowledge/files pane on the mobile project-detail screen.
- **New-project structured create (optional).** If "+ Tell Cue…" conversational create isn't enough, a small emoji/color/category/mission-link sheet (desktop `new-project-modal`).

---

### Honest bright spots (near-parity — do not touch)
Skills/marketplace, Agents (charter/pause/retire/re-charter), Act ledger, Rules (autonomy + standing rules + checkpoint toggles), Memory edit/forget, Connector OAuth connect, Meeting capture, inline chat surfaces/confirmations, Triage/Review/Watch-live. These already reuse the real desktop data + mutations.
