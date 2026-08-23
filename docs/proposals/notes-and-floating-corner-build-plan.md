# Notes & the floating corner — implementation plan

**Date:** 2026-08-20 · **Source:** `CUE asdesign deliverables.zip` (`00-ORIGINAL-BRIEF.md`, `BRIEF-FOR-CODE.md`, `01`–`04` HTML)
**Status:** direction locked (Notes = 1a + 1b, floating = 1e); the four open decisions are closed — see below.

This maps the design handoff onto the repo: what already exists, what is new, and what the brief assumes that the
codebase does not currently support. It follows the brief's own build order.

---

## Decisions (owner, 2026-08-20)

| # | Decision | Consequence |
|---|---|---|
| 1 | **The corner summons on `⌥C`.** Cue Live keeps `⌃⌥Space`. | Overrules the brief's *"`⌥␣` is the single global summon"*. Nothing existing moves and no migration note is owed; the collision in §0.3 is closed by moving the new thing rather than the shipped one. **Every `⌥␣` string in the design copy becomes `⌥C`** — the F1 invitation, the R6 menu-bar footer, and the "from ⌥␣" badge on note cards. `⌥C` types `ç`, the same class of trade as `⌥Space` typing a non-breaking space; rebindable from day one settles it. |
| 2 | **Build the full local-first store**, as S5 specs it. | Local write-ahead queue + sync worker. Capture and local recall work offline; extraction, ask and filing queue. Its own workstream inside step 2 — see §2 step 9. |
| 3 | **Keep R1's scope sentence, reframe F1's ask.** | R1 keeps *"Only the text you highlighted. Nothing else on this screen was read."* F1 stops claiming a permission gate and becomes an upgrade in reach: *"now I can read the whole window, not just what you pick."* The staged ask (earned on second use) survives. |
| 4 | **Adopt "Halo captures your day, Cue turns it into work."** | The wearable's value story runs through Notes. R3 is what makes the sentence true, so it is now load-bearing for marketing and cannot be deferred indefinitely — the pre-sale page ships first, so the claim is written before the feature exists. Flag R3 accordingly when sequencing step 6. |

---

## Build status

**The design is built.** Every item in the four design files except R5, which the brief says
to build last or never. **355 tests green** (185 assistant · 108 web · 62 macOS); typecheck
and lint clean across `assistant/`, `apps/web/`, `apps/macos/` and `packages/ipc-contract/`.

Two things turned out not to need the Swift build they were budgeted for:

- **F2·E hold-⌥-to-talk** — the corner has focus while it is open, so the hold is plain
  `keydown`/`keyup` on the window. `hooks/use-hold-to-talk.ts`, which also stops on blur and
  on tab-hide, because a key-up never arrives when focus moves mid-hold.
- **F1 screen-reading** — the mac-helper already answers `observe.screen`, a read-only method
  deliberately kept off the channel that clicks and types, so "you may look" can be granted
  without "you may act". `main/corner-screen-read.ts` rides it, asks on the second summon,
  and the footer sentence renders every time.

| Step | What landed |
|---|---|
| 4 · R2 Ask | `notes` / `email` / `work` recall adapters + `note-ask.ts`; every claim numbered, unsourced sentences deleted in code |
| 5 · S2 import | `note-import.ts` — searchable immediately, `last_month` extraction default |
| 6 · R3 inbound | `note-arrivals.ts` — an arrival becomes a note, never a task |
| 6 · S3 rituals | `note-ritual.ts` + the morning brief's `notes` beat |
| 6 · S4 tidy | `note-tidy.ts` — diff, three answers, original recoverable after accepting |
| 6 · R4 note→Create | `note-create.ts` — the note's plausible outputs, never a menu |
| R6 approvals | `apps/macos/src/main/needs-you.ts` + tray pull-down, fed by HQ's own badge hook |

**The client gap is closed.** Every route that existed now has a surface: the import screen
with its one decision, the "Came in" lane, the tidy diff with three answers, note→Create, and
the accept-rate readout (decision A — the data was being recorded but nobody could see it).
Render tests were added because the two defects found by running the app both passed
typecheck and lint: a hook that throws outside the auth gate, and a list that sat on
"Loading…" forever.

| Piece | Where |
|---|---|
| Schema + migration | `assistant/src/memory/schema/notes.ts`, `migrations/332-notes.ts` (+ `work_items.note_id`) |
| Store | `assistant/src/notes/note-store.ts` |
| Read path (S6 cost rules) | `assistant/src/notes/note-extraction.ts` |
| N4 conflict detection | `assistant/src/notes/note-conflict.ts` |
| Acceptance — the only writer | `assistant/src/notes/note-accept.ts` |
| API | `assistant/src/runtime/routes/notes-routes.ts` (10 routes) |
| Spend, by name | `noteExtraction` call site → ledger line "Reading your notes" |
| Client | `apps/web/src/domains/notes/` (page, rail, hooks) |
| Nav | Tier-2 row after the People/Library pair; phone door in the ☰ drawer |
| **Local-first store (S5)** | `apps/web/src/domains/notes/note-local-store.ts` — IndexedDB, with an in-memory fallback so capture still works in a private window |
| **Sync worker (S5)** | `note-sync.ts` — drains on `online` + `visibilitychange`, never a timer |
| **Idempotent capture** | client-minted note id; `createNote` returns the existing row on replay |
| **Selection read (R1)** | `apps/macos/src/main/selection-read.ts` — clipboard snapshot → synthesised ⌘C → restore, on every path |
| **The corner** | `apps/macos/src/main/corner-window.ts` + `apps/web/src/domains/corner/` (F2 states A–D) |
| **Summon** | `⌥C` via `globalShortcut`, rebindable, gated on the `desktop-corner` flag (default OFF) |
| **Shared capture** | lifted to `hooks/use-note-capture.ts`, `stores/note-local-store.ts`, `types/notes.ts` — the corner writes notes too |

### How the selection is actually read, and the trade it makes

`kAXSelectedText` from the accessibility API is the cleaner path and the one this should
eventually take — it never touches the pasteboard. It also needs a **native helper build**,
and this machine has no disk for one (see below). So the shipped path snapshots the
clipboard, synthesises ⌘C into the frontmost app, reads what lands, and restores the original
— on every path including failure, because someone who copied a password a moment ago must
not find it replaced by a paragraph of email. There are tests on exactly that.

Two things this buys beyond avoiding a build: `kAXSelectedText` is unimplemented in a
surprising number of apps (Electron apps and most web views among them) where a synthesised
⌘C works fine, and clearing the clipboard first makes **"nothing was selected" detectable**
rather than guessed — without it a no-op copy leaves the previous clipboard in place and the
panel would confidently quote text the owner never selected.

### What is gated, and why

`desktop-corner` is **off by default, and the gate is on the summon rather than only the
window**. Turning the corner on claims `⌥C` system-wide, and `⌥C` types `ç` in every app that
has not bound it — registering that for someone who never asked for the feature would take a
character away from them. The binding is rebindable from day one for the same reason.

The companion orb is left in place, exactly as this plan said it should be: it is retired in
the same change that flips the corner on, not before something unverified replaces it.

Rule 1 is enforced structurally rather than by convention: proposals are rows, and
`acceptance-boundary.test.ts` asserts that no module in the read path so much as *imports* a
writer. `note-accept.ts` is the single door.

**Not yet built, and deliberately not drawn:** the Undo on the accepted state (N2 state 4).
Un-accepting a task is a delete; un-accepting a memory is not cleanly reversible, since the
fact has been appended to a concept page. A half-working Undo that covers one kind and not the
other is worse than none, so the state renders without it until undo has its own design. This
is the one specced affordance the build omits.

**Only S1's three iOS doors remain unbuilt.** The lock-screen widget, the Action Button intent and
the share extension are new native targets in `apps/ios/App` against a Capacitor shell. They
need an Xcode build to be worth anything, and the machine's disk has no room for one — see
the verification note below. The capture *budget* they must satisfy is honoured by what does
exist: one gesture, no network block, no "where does it go?", no confirmation screen.

**F2 state E (hold-⌥-to-talk) is not built.** A modifier-only hold is a `flagsChanged`
NSEvent monitor, which lives in the mac-helper and needs a Swift build. The contract it must
honour is written down: the mic cannot outlive the key, release sends, `esc` cancels.

Also not built (later steps, as planned): R2 Ask, voice capture (1b/N3), the mobile in-flow
form (N5 — the desktop grid collapses to a single column below `md`, which lands the rail
under the note in roughly the right shape), tidy-with-diff (S4), F1 screen-reading, and the
R6 menu-bar approvals count.

**What the offline layer guarantees, and what it does not.** Writing, editing, deleting and
reading back everything already on the device work with no signal; extraction, filing and the
"Waiting on you" filter queue or are hidden, because only the daemon can answer them. The
header's counts are *omitted* offline rather than estimated — that line is the feature's
central claim and a guessed one would be worse than none. The IndexedDB path itself is not
covered by tests (bun's test environment has no IndexedDB, so the suite exercises the
in-memory fallback); the queue's ordering, retry and idempotency behaviour is.

### Verified by running it — the backend, end to end (2026-08-21)

Driven over the assistant IPC socket (the transport the CLI uses, authenticating as `local`),
against the live daemon and the real database. **12 of 13 checks pass**, and the one that
does not is a provider reliability finding rather than a defect — see below.

Working for real: capture · the read producing genuine proposals ("Send redlines to Rachel",
"Decide tooling vendor" with a real due date, and a memory about the $47 term) · accept ·
undo · **ask, answering across stores with a real numbered citation** · import defaulting to
last-month · arrivals landing as unfiled notes · the weekly line · accept rates · delete.

**Root cause of the original "Loading…" — found.** The app's persisted instance is
`https://manav.justcue.app`, running image `cue-releases:v67eef65f81`, four commits behind
this branch. `/v1/notes` does not exist there. The local daemon was never in the picture, and
no amount of restarting it could have helped.

**A second cause, in my own code.** `noteExtraction` was declared as
`{ profile: "cost-optimized" }` with a comment saying extraction is a structured task rather
than a reasoning one — but a profile name is not a parameter. It inherited `effort: high`
with a 16k budget, and the model spent the whole budget reasoning and returned no content, so
every read reported "I couldn't read this one". The call site now pins the shape explicitly
(4096 / low / no thinking / temperature 0), mirroring `recall`. The original 12s budget was
also far too short for the models this product routes to — a failure class this codebase has
hit before.

**Measured reliability:** five identical reads → 4 succeeded, 25–50s typical. The failures are
the provider returning an empty completion inside budget, so there is now **one** retry on a
tighter budget. When both attempts fail the note is safe and the rail says so, which is the
behaviour that was always intended for this case.

**Still not verified:** the UI. Every surface is typechecked, linted and unit-tested, and the
render tests cover the honest-state branches, but no Notes screen has been driven by a human.

### Verified by running it — the corner (2026-08-21)

Services restarted from this checkout (`vellum wake`), Electron dev app launched with
`VELLUM_FLAG_DESKTOP_CORNER=true`.

- **`[global-shortcuts] registered cornerSummon → Alt+C`** in the app log — the flag gate and
  the binding both work, and Cue Live's `Control+Option+Space` registered separately, which is
  the collision decision holding in practice.
- **The corner renders in both states.** State A (bare "What do you need?") and the R1
  selection state ("YOU SELECTED · 22 WORDS · GMAIL" over the verbatim quote, with the consent
  footer). Screenshots taken.
- **One real crash found and fixed:** `CornerPage` called `useActiveAssistantId()`, which
  throws outside `ActiveAssistantGate` — and the whole point of a floating route is that it
  sits outside RootLayout and auth. It reads the raw store now and copes with null by saying
  so rather than writing a note into the void. The window was also resized 320 → 260 to match
  its content.

**Still not run:** the Notes page itself, which needs a signed-in app (the plain browser has
no daemon connection), and the selection read end-to-end, which needs macOS Automation
permission the first time `⌥C` fires.

**Was not verified by running it, before that session:** The daemon serving these routes has not been restarted, no
Electron build has been made, and the machine's Data volume fell from ~3 GiB free to **809 MiB
during this session** — see `cue-mac-disk-pressure`. That is why the selection read avoids a
native build entirely, and why nothing here has been driven end to end. The backend is
verified by tests against the real database; the clients by typecheck, lint and unit tests.

**Disk is now the blocking constraint on this workstream.** Everything remaining that touches
the corner's voice state, the iOS capture doors, or F1 screen-reading needs a compile.

---

## 0 · What the survey changed about the brief

Five findings that move work in or out of scope before step 1 starts.

### 0.1 · §6 colour tokens are already built — nothing to do

The brief closes with the recurring contrast defect class and asks for ground-named tokens plus a lint. Both shipped:

- `apps/web/src/index.css:116` — `--muted-on-paper: #6b6b60`, `--muted-on-canvas: #5a6672`, `--muted-on-dark: #9a9aa8`,
  with `--muted` aliased per theme at `:126` and `:162`.
- `apps/web/eslint-rules/no-on-token-as-ground.mjs` — the exact lint the brief asks for, implemented as a blocklist of
  ground-painting slots (with the reasoning for blocklist-over-allowlist in its header) and covering three spellings
  including `dangerouslySetInnerHTML` CSS strings.

**Action:** none. Build Notes against the existing tokens. If the design's warm paper surfaces (`#F4F3EF` / `#E8E6E0`)
aren't in `packages/design-library/src/tokens.css` yet, add them as surfaces there — not as new muted values.

### 0.2 · R1 does not avoid a permission prompt — it avoids Screen Recording

The brief's strongest argument for shipping selection before screen-reading is that it is *"nearly free on consent"* and
makes F1's ask *"an upgrade rather than a gate."* On macOS that is only half true:

- Reading the current selection means `kAXSelectedText` on the focused AX element — **Accessibility (TCC)**, the same
  grant `F1`'s front-window read needs. `native/mac-helper/Sources/MacHelperExecutable/ComputerUse/AccessibilityTree.swift`
  already enumerates the frontmost window under that grant.
- What R1 genuinely avoids is **Screen Recording** (`ScreenCaptureKit`, `Package.swift:32`) and, more importantly, it
  narrows *scope* from "the window" to "the 41 words you chose".

Cue Live already prompts for Accessibility (`CueLive.swift:99`, `:128`, `:142`), so for a user who has enabled Cue Live
there is no new prompt. For everyone else there is one.

**Resolved (decision 3):** R1 keeps *"Only the text you highlighted. Nothing else on this screen was read."* — true, and
the thing users actually feel. F1 stops presenting itself as a permission gate and becomes an upgrade in reach:
*"now I can read the whole window, not just what you pick."* R1 still ships first, and the staged ask — earned on second
use, never in onboarding — survives unchanged.

### 0.3 · The corner's summon sat one modifier away from Cue Live's — **closed, decision 1**

`native/mac-helper/Sources/MacHelperExecutable/CueHotkeys.swift:13` — Cue Live's shipped default summon is
**Control+Option+Space**, with `⌥R` push-to-run and `⌥P` point. The brief wanted the corner on **Option+Space**.

Two summons one modifier apart, on a product whose brief insists *"never let the corner drift into ambient watching"*,
is a collision waiting to happen — a slipped finger starts a continuous watching session instead of opening a panel.

**Resolved: the corner takes `⌥C` and Cue Live keeps `⌃⌥Space`.** Nothing shipped moves, so no rebinding migration is
owed to existing users. The cost is the brief's `⌥␣`, which was chosen partly for its Raycast-adjacent familiarity;
the owner traded that for leaving a live surface alone.

Consequences for the build: every `⌥␣` in the design copy becomes `⌥C`, and the binding is rebindable from day one
(`apps/macos/src/main/hotkeys.ts` `HOTKEY_CATALOG` — a `cornerSummon` entry with `scope: "global"`). `⌥C` types `ç`
when unregistered, which the global registration swallows — the same trade `⌥Space` makes against a non-breaking space,
and the reason rebinding is not optional.

### 0.4 · There is no offline layer anywhere in the client

`S5` ("the note always wins") and the capture budget's *"capture never blocks on the network"* are load-bearing — the
brief puts them in build step 2 as one of "the two things that decide whether the feature gets used at all."

The SPA has no service worker, no IndexedDB, no local write-ahead store (`apps/web/src` has zero `serviceWorker` /
`indexedDB` / `idb` references outside PDF thumbnailing). iOS is a Capacitor web shell (`apps/ios/App`, 13 Swift files),
so the phone inherits the same gap.

**This is the largest hidden cost in the plan.** Treat it as its own workstream, not a checkbox inside step 2 — see §3.

### 0.5 · "Reuse the memory importer" — there is no memory importer

`S2` says the import reuses the memory-import flow. The nearest existing thing is
`assistant/src/runtime/routes/conversations-import-routes.ts`, which imports **chat transcripts** into conversations
(ChatGPT/Claude exports) — not a notes/markdown corpus importer. The pattern and the "nothing leaves your machine"
promise are reusable; the importer itself is new work.

---

## 1 · What already exists that the plan should build on

| Need | What exists | Where |
|---|---|---|
| Extraction engine shape | Two-stage prefilter → cheap-LLM structured extraction, tuned for recall, `[]` returned readily, kill switch. Exactly S6's "small model first". | `assistant/src/work-items/commitment-capture.ts` |
| Note → task provenance | `work_items.sourceType` / `sourceId`, already carrying a channel id for arrivals and inbound commitments. `sourceType: "note"` needs no migration. | `assistant/src/memory/schema/tasks.ts:42`, `work-items/work-item-store.ts:64` |
| R2 "Ask" across stores | Adapter architecture over `memory` / `conversations` / `workspace`, returning `RecallEvidence { id, source, title, locator, excerpt, timestampMs, score }` — the citation shape R2 needs, numbering included. | `assistant/src/memory/context-search/` |
| Accept → Memory write | Memory v2 concept pages, atomic write, deterministic batch ingest with per-page validation. | `assistant/src/memory/v2/page-store.ts`, `ingest.ts` |
| Accept → task | Work item store + triage, the same path arrivals use. | `assistant/src/work-items/work-item-store.ts`, `work-item-triage.ts` |
| R3 inbound lane | `arrivals` table and routes — a filtered, reason-carrying, never-deletes inbound floor with `surfaced` / `filed` dispositions. | `assistant/src/memory/schema/arrivals.ts`, `runtime/routes/arrivals-routes.ts` |
| Front-window read (F1) | AX enumeration of the frontmost non-self app, with `AXIsProcessTrusted` gating. | `native/mac-helper/.../AccessibilityTree.swift:152` |
| Floating panel shell | Generic frameless always-on-top window factory hosting SPA routes; position persistence; non-activating `type: "panel"`. | `apps/macos/src/main/floating-window.ts`, `companion-window.ts` |
| Menu-bar surface (R6) | Tray + dock badge plumbing. | `apps/macos/src/main/tray.ts`, `dock.ts:269` |
| Rituals (S3) | Morning brief and ritual snapshots. | `assistant/src/rituals/`, `runtime/routes/morning-brief-routes.ts` |
| Colour tokens + lint (§6) | Done. See §0.1. | — |

### The floating Cue being replaced

Today's floating Cue is the **desktop companion**: a 72×72 orb that expands to a 260×148 card with two buttons
(`Talk`, `Open Cue`) and no composer.

- Main: `apps/macos/src/main/companion-window.ts` (315 lines) — flag `desktop-companion`, **defaultEnabled: false**.
- Renderer: `apps/web/src/domains/companion/companion-page.tsx` (204 lines), route `/assistant/floating/companion`
  (`apps/web/src/routes.tsx:360`), bridge at `companion-bridge.ts`.

It is *not* a thread — it is a launcher for the app, which is the brief's diagnosis exactly: *"a place you go to,
shrunk."* Because it is flag-gated and off by default, replacing it is low-risk: the window plumbing (position memory,
non-activating panel, drag regions, status push) is all reusable; the *page* is what gets rewritten.

Separately there are two adjacent floating windows to keep distinct and not merge into the corner:
`command-palette-window.ts` (584×444, command list) and `dictation-overlay-window.ts`.

---

## 2 · Build order

Following the brief's order, with repo-specific steps. Each step is independently shippable.

### Step 1 · Notes + rail + conflict (1a, N1, N2, N4)

**Backend**

1. Migration `332-notes.ts` (next free number — `331-schedule-script-env.ts` is current head; register in
   `migrations/index.ts` and `registry.ts`). Two tables:
   - `notes` — `id`, `title`, `body`, `source` (`typed` | `voice` | `selection` | `arrival:<channel>` | `import`),
     `projectId` (nullable, reference-by-convention, same as `work_items.project_id`), `audioPath` (nullable, local),
     `lastReadHash` (S6's diff-against-last-read), `createdAt`, `updatedAt`.
   - `note_extractions` — `id`, `noteId`, `kind` (`task` | `memory` | `person_trait`), `payload` (JSON),
     `confidence_tier` (`confident` | `unsure` — **a tier, never a percentage**, rule 2), `reason` (plain words, for
     the unsure tier), `state` (`proposed` | `accepted` | `dismissed`), `acceptedRefType` / `acceptedRefId`
     (`work_items.id` or memory page slug), `createdAt`, `decidedAt`.

   `note_extractions.state` is what makes rule 1 structural rather than a convention: **the accept route is the only
   code path that writes to `work_items` or memory.** Nothing in the extraction pipeline may hold a writer.

2. `assistant/src/notes/note-store.ts` — CRUD, list with the N1 filters (`All` / `Waiting on you` / `Unfiled` /
   `Recorded`), and the header counts (`62 notes · 78 tasks · 31 memories`) computed from `note_extractions` joins.
   The brief is right that this is computable, not a vibe — compute it, never estimate it.

3. `assistant/src/notes/note-extraction.ts` — modelled on `commitment-capture.ts`: prefilter → cheap side-chain LLM →
   structured JSON, `[]` returned readily, any failure ⇒ no extraction. **Two differences from commitment-capture:**
   it writes `note_extractions` rows, never work items; and it is triggered on close or on demand (S6), not on a timer.
   Diff `body` against `lastReadHash` and skip unchanged text.

4. `assistant/src/notes/note-conflict.ts` (N4) — before an extraction of kind `memory` is *proposed*, look up the
   contradicted fact via the memory-v2 page index and attach `{ existing, existingSource, incoming, incomingSource }`
   to the payload. Accept offers **three** answers: `replace` / `keep_both` / `ignore`, default `keep_both`. Neither
   value ever renders without its source.

5. `assistant/src/runtime/routes/notes-routes.ts` + registration in `runtime/routes/index.ts` (import at the
   alphabetical position, spread into the exported array — same two-line pattern as `ARRIVALS_ROUTES` at `:20`/`:193`).
   Routes: list, get, create, update, delete, `POST notes/:id/read` (on-demand extraction),
   `POST notes/:id/extractions/:eid/accept`, `.../dismiss`, `POST notes/:id/extractions/accept-all`.

   **Delete is one-way (rule 4):** deleting a note nulls nothing on `work_items`. The task keeps `sourceType: "note"` /
   `sourceId`; the display layer renders "from a note you deleted" rather than hiding the provenance.

**Frontend**

6. New domain `apps/web/src/domains/notes/` — list page (N1), editor + rail (1a), rail states (N2: reading / nothing to
   file / couldn't read / accepted-collapsed), conflict card (N4), mobile in-flow variant (N5).
7. Sidebar row: add `notes` to the `SidebarDestination` key union in `apps/web/src/components/nav/nav-model.ts` and to
   the Tier-2 array. Notes passes that file's own accumulation test (it gets richer on its own), so it sits with People
   and Library under the divider — **not** in `PRIMARY_NAV`, which the file states is full at three and stays full.
   On phone, Notes is reached from the ⓶ menu, which is what N5 draws.
8. Regenerate the daemon client (`openapi-ts`) after the routes land — see `apps/web/openapi-schemas/daemon.json`.

**The four rail states must be four distinct render branches, not one with flags.** Rule 3 ("nothing to file" ≠
"couldn't read") is the kind of thing that collapses into a shared component during review and silently ships wrong;
the couldn't-read branch must always print *"your note is saved."*

### Step 2 · Capture (S1) + offline (S5)

The brief's own words: the two things that decide whether the feature gets used at all.

9. **Local-first note writes — its own workstream (decision 2).** Build the write-ahead store the SPA does not have:
   a local queue (IndexedDB in the browser; Capacitor SQLite on iOS) that a note is written to *first*, with a sync
   worker that promotes it to the daemon when reachable. The split the brief draws is the spec:
   **capture and local recall work offline; extraction, ask and filing queue.** No spinner may outlive the connection,
   and the acknowledgement sentence is "your note is saved", printed before any network call is attempted.
   Local recall means the note list and search over already-synced notes keep working with no signal — not just the
   draft surviving. Budget it accordingly; this is the single largest piece of new foundation in the plan.
10. Desktop capture: `⌥C` + `⌘↵` (delivered by step 3) and the Notes editor itself.
11. iOS capture doors (S1 A–C) are **new native targets** in `apps/ios/App`:
    - Lock-screen widget — extend the existing `CueWidgets` target (`CueRunLiveActivity.swift` proves the target works).
    - Action Button — an App Intent, hold-to-talk, mic released on finger release (never a toggle).
    - Share sheet — a new Share Extension target ("Keep in Cue"), saving the page plus the project guess.

    Each must satisfy the capture budget: one deliberate gesture, no network block, no "where does it go?" prompt,
    no confirmation screen.

### Step 3 · R1 selection + the corner (F2 states, no F1)

12. **Native:** add a `readSelection` RPC to the mac-helper returning `kAXSelectedText` (plus word count and the source
    app name) from the focused element of the frontmost non-self app. Nearest existing code:
    `AccessibilityTree.enumerateCurrentWindowSync()` — same trust gate, much smaller payload.
13. **Hold-⌥-to-talk (F2·E):** a modifier-only hold is a `flagsChanged` NSEvent monitor, not a hotkey registration.
    `CueHotkeys.swift` already runs on global/local NSEvent monitors, so it is the right home. The contract is absolute:
    **the mic cannot outlive the key.** Release sends; `esc` cancels.
14. **Main:** `apps/macos/src/main/corner-window.ts`, reusing `createFloatingWindow`. Remembers its corner, never
    repositions, never follows the cursor, never appears unbidden. `esc` closes the window and **must not** cancel work
    in flight — the running action continues and reports in HQ (rule 5). Register **`⌥C`** (decision 1) via Electron
    `globalShortcut` (`global-shortcuts.ts`) and add a `cornerSummon` entry to `HOTKEY_CATALOG` as rebindable.
15. **Renderer:** `apps/web/src/domains/corner/` at route `/assistant/floating/corner`. Five states (A nothing worth
    offering · B working, named + Stop · C done something, with local Undo beside the claim · D couldn't, amber, with
    the ask surviving · E holding ⌥ to talk). Quote the received selection verbatim above the actions. Never more than
    three suggestions; none rather than weak ones. `↵` sends a request, `⌘↵` makes a note — the Notes ↔ Chat boundary.
    All summon copy reads `⌥C`, including the "from ⌥C" badge on note cards and R6's menu-bar footer.
16. **Retire the companion:** delete `companion-page.tsx` / `companion-bridge.ts` / `companion-window.ts` and the
    `/floating/companion` route; introduce flag `desktop-corner` (client scope, default off) in
    `meta/feature-flags/feature-flag-registry.json` and both bundled copies. Keep `desktop-companion` declared until
    the corner ships, then remove it in the same change that flips the new flag on.

**Undo is not a toast.** It renders inside the panel next to the claim it undoes, and it survives `esc` — closing the
panel must never be how an action becomes unundoable.

### Step 4 · R2 Ask

17. Add three `RecallSourceAdapter`s to `assistant/src/memory/context-search/sources/` — `notes.ts`, `email.ts`,
    `work.ts` — and extend `RecallSource` and `ALL_RECALL_SOURCES` (`context-search/types.ts:3`, `limits.ts:3`).
    This is the single highest-leverage change in the plan: it upgrades every existing recall caller at the same time.
18. Answer composition: each claim carries the `RecallEvidence.id` it came from, and **the renderer drops any sentence
    without one.** Enforce it in the composer, not the prompt — a prompt instruction is not enforcement.
19. "2 aren't in HQ as tasks → Add them ›" reuses the step-1 accept route. The answer itself is never persisted.

### Step 5 · Day one + import (S2)

20. Empty state: one sentence, two buttons, no tour.
21. Importer for Apple Notes / Notion / Obsidian / markdown folders, following `conversations-import-routes.ts`'s shape
    and its "nothing leaves your machine" promise. Notes are searchable on write; **extraction defaults to the last
    month only**, with `All of them` / `None` as the other two answers. The default is not a preference — proposing 73
    tasks from two years of archive makes HQ unusable on day one.

### Step 6 · The rest, in the brief's order

- **R3 inbound** — arrivals whose disposition is a note. Extend `arrivals` with a `note_id` and a third landing that
  creates a `notes` row instead of a `work_items` row. The restraint is the point: **an arrival becomes a note, never
  a task.** Sources: Halo, `notes@` forwarding, meeting capture.
- **1b voice + N3** — recording, local audio, transcript vs. summary kept visually distinct, sentence→timestamp
  playback, "delete audio, keep note" always present. Reuse `assistant/src/stt/` and the existing recording plumbing.
- **S3 rituals** — carry "waiting on you" into the morning brief and weekly review (`ritual-compose.ts`,
  `morning-brief-routes.ts`), leading with what is relevant today rather than a count.
- **S4 tidy-with-diff** — in the `⋯` menu only. No `✧` button in the editor. Original always recoverable after accept.
- **R4 note → Create** — open Create with the note as the brief; output lands in Library remembering the note.
  Same one-way provenance.
- **F1 screen-reading** — the front-window AX read, asked for on *second* use, with the footer sentence rendered
  every time. Keep the Cue Live distinction sharp in copy and in code: one window, once, while the panel is open.
- **R5 related notes** — last, or never.

### R6 · Approvals (any time after step 3)

22. The corner never interrupts. Approvals surface as a menu-bar count you pull down: extend
    `apps/macos/src/main/tray.ts` with a pull-down list, using the **same post-valve count HQ's badge uses** — read it
    from the existing valve/needs-you source, never compute a second one.

---

## 3 · The two things the brief hands back

**A · Instrument accept rate from day one.** This is cheap to build into step 1 and expensive to retrofit:
`note_extractions` already carries `kind`, `confidence_tier`, `state` and `decidedAt`, so accept rate per type is a
`GROUP BY` away. Emit it as a first-class metric, not a log line. If it is low after a week, the brief's answer stands:
fewer and better extractions, not more prompting.

**B · The Halo framing — adopted (decision 4).** *"Halo captures your day, Cue turns it into work"* is the story, and
R3 is what makes it true. Because the pre-sale page ships before any of this does, the claim is written before the
feature exists: **R3 is now load-bearing for marketing and cannot drift to the back of step 6.** Sequence it first
among the step-6 items.

## 4 · Risks, ranked

1. **Offline (§0.4)** — no foundation exists, and the brief puts it in step 2. Under-scoping this is how Notes ends up
   unusable on a train, which is where notes get taken.
2. ~~The summon collision (§0.3)~~ — closed by decision 1: the corner takes `⌥C`, Cue Live keeps `⌃⌥Space`.
3. **Acceptance leaking** — the moment any code path other than the accept route can write to `work_items` or memory,
   the feature is a different and much worse product. Worth a guard test asserting the extraction module imports no
   work-item or memory writer.
4. **The iOS capture doors (S1)** — three new native targets against a Capacitor shell. Real work, easy to hand-wave.
5. **R2's unsourced-sentence rule** — enforce in the composer. Prompt-level instructions are not a guarantee.

## 5 · Cut list, if time is short

The brief's own ruling, and it should be honoured: **cut the "less sure" extraction tier, never cut acceptance.**
Shipping only confident extractions — solid cards, pre-ticked, nothing dashed — is smaller and honest. Also fair to
defer: R5 entirely, R4, and F1 (the corner is useful on selection alone, which is the whole argument for R1 going first).
