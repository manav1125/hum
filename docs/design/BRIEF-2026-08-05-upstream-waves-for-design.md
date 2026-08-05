# Request to design — 2026-08-05, from code (upstream waves)

Context: we are absorbing the best of upstream (vellum-assistant) in waves. Waves A+B are
merged; Wave C (advisor context, plugin platform, memory import, voice periphery, memory-DB
split) is landing now. Everything so far was built on existing Cue primitives so nothing is
blocked on design — but several pieces shipped functional-without-spec, and the two biggest
FUTURE ports are gated on design decisions that can be made entirely in advance. Ranked by
leverage; items 1–2 gate future engineering, items 3–6 are polish on shipped features.

---

## 1 · Cue's live-voice surface system (gates the voice re-platform — highest leverage)

We have deferred upstream's full voice re-platform (server-side endpointing, speculative
answers). When we do it, it comes with a complete voice UX system that we should NOT copy —
we should have Cue's own answer designed before the port starts. What needs designing:

- **The voice room.** Upstream: a full-screen surface with animated "eyes", a listening
  indicator, session controls (mute assistant, end), inset into the content area. Question
  for design: what is Cue *visually* when you talk to it? (Our avatar language, not theirs.)
- **The minimized state ladder.** Upstream has three exclusive states: room → minimized bar
  (sits above a usable chat input, animated by real audio levels) → title-bar pill (when you
  navigate away). One surface visible at a time. We need Cue's version of all three and the
  transitions between them.
- **Mid-call surface reveal.** During a call the assistant can open a UI surface (a chart, a
  doc); the room minimizes to reveal it — deterministically, only after the assistant
  finishes speaking, never mid-sentence. Design the reveal moment and how the user gets back
  to the room.
- **Mid-call approvals.** When a sensitive action needs a yes, the room minimizes
  immediately and the assistant says one fixed phrase ("I need your okay for that one. Take
  a look."). Design the approval card treatment in this context + the fixed phrase in Cue's
  voice.
- **Mobile:** voice room as a bottom sheet under the header; session state in the platform
  surfaces (iOS Live Activity / Dynamic Island layouts, Android notification) — content:
  phase (listening/thinking/speaking), a one-line activity label ("reading your calendar"),
  session timer, avatar. Lock-screen privacy rule: present-participle labels, no tool names,
  no arguments.
- **Spoken-voice copy (needed NOW for Wave C-4):** the assistant speaks fillers during work —
  ack phrases when it starts something slow, progress narrations ("Searched the web, reading
  through it now"), and static fallbacks when generation fails. The fallback lists live in
  `assistant/src/live-voice/ack-phrases.ts` and (new) `progress-phrases.ts`; the generated
  phrasing tone is steered by a prompt in `front-decision.ts`. These are Cue's persona out
  loud. A voice-and-tone pass (phrase lists + tone guidance we can paste into the prompt)
  can be done today; the feature ships flag-off until QA either way.

Deliverable: a voice-surface spec (frames or written system) + the copy pass. Everything
here can be completed before a single line of the re-platform is written.

## 2 · Memory import as an onboarding moment (Wave C-3 ships the plumbing)

Wave C lands importers for ChatGPT exports and other assistants' memory files — today they
are CLI/skill-driven. If "bring your history to Cue" is an onboarding hook (we think it is —
it's a switching-cost eraser), it needs a surface: where a new user drops the export file,
what progress/ingest feedback looks like, what "Cue now knows you" shows at the end (tie-in
to the memory constellation?), and how we frame provenance ("imported from ChatGPT" badges
on memories — do we show them?). Design can spec this flow now; engineering is a thin layer
over the already-landing importers.

## 3 · Bookmarks: a real home (shipped functional in Wave B)

Bookmarks shipped as a Settings leaf (parity with the macOS tab): rows of
snippet + conversation link + remove, plus a hover toggle on messages. Decisions owed:
is Settings the right home or does it belong nearer the sidebar/library? Row treatment,
empty state, and whether bookmarking gets any affordance on mobile v3. Current code:
`apps/web/src/domains/settings/pages/bookmarks-page.tsx`,
`.../message-hover-actions/bookmark-toggle.tsx`.

## 4 · System cards: one voice for daemon-authored messages (Wave B-7 exposed this)

"Summarize up to here", `/compact`, and `/clean` all end with a card the *system* (not the
model) writes into the chat. Today these reuse the plain canned-message pattern.
Upstream later gave these a distinct `system_card` treatment. Decision + spec owed: how do
daemon-voice messages look in Cue chat — distinct from assistant messages, quiet, and
consistent? One spec covers summarize results, compaction results, error/skipped notices.

## 5 · Decided-approval-card states (Wave B-3 made decisions persist)

Approval cards now rehydrate as *decided* instead of re-showing live buttons, and Telegram
cards get their buttons removed in place with a quoted status line. In-app, the decided
state currently reuses the generic completed-surface rendering. Worth a small spec: how a
decided card reads at a glance (approved vs denied vs expired), consistent across in-app,
Slack, and Telegram — glyphs are per-surface, wording is shared (one status-word source in
code already).

## 6 · Skills copy branding sweep (decision, then trivial)

All skill `compatibility` strings and some user-facing skill copy still say "Vellum" — a
pre-existing convention, inherited by new skills. Protocol ids (`metadata.vellum`, config
keys) must stay `vellum` and are not in question. The decision owed: rebrand
*display-facing* skill copy to Cue for alpha, or leave as-is? If yes, we run one sweep with
the protocol boundary enforced; design/brand just needs to say the word and give the
preferred phrasing ("Cue desktop app" etc.).

---

Not requested (deliberately): request-diagnostics UI (developer-facing, logs are enough for
now), memory-graph visual overhaul (our constellation view is fine; revisit post-alpha),
"My Superpowers"-style unified skills+plugins page (nav decision for a later wave — if the
skills/plugins split ever bothers users, we'll bring it back with data).
