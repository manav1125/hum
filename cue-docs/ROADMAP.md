# Product Roadmap — Personal AI Assistant (forked from `vellum-assistant`)

_Owner: Manav · Drafted 2026-06-13 · Living document_

## 1. What we're building

An always-on personal AI assistant that knows you inside out, runs across all your
devices, and acts on your behalf across email, calendar, tasks, calls, and payments.
Business & productivity first, expanding to all of life. The long-term differentiator
is an **ambient capture layer** — starting with the phone mic in meetings, eventually a
wearable pin — that feeds everything you see, say, and agree to into a persistent memory
the assistant organizes and acts on, so nothing is ever missed or dropped.

## 2. What we forked — and why it's a strong base

The fork is `vellum-ai/vellum-assistant`, a mature TypeScript/Swift monorepo. The
expensive, hard-to-build foundations already exist. We are **rebranding and building on
top**, not starting over.

| Asset (already built) | What it gives us | Leverage |
| --- | --- | --- |
| **8-type memory engine** (episodic, semantic, procedural, emotional, prospective, behavioral, narrative, shared) | Local embeddings, dedup, source attribution, staleness windows | This IS the "knows you inside out" + the destination for wearable capture. Highest-value inheritance. |
| **Multi-channel runtime** (macOS, iOS, Web, Voice, Email, Telegram, Slack, Twilio → one memory) | Start a thought on one surface, continue on another | "Always-on, every channel" is done at the plumbing level. |
| **Capacitor mobile shell** (`apps/web` → `apps/ios`) | Web app compiles into native iOS shell | "Build a mobile app" = rebrand + redesign + extend, not greenfield. |
| **Voice + call primitives** (`live-voice/`, `calls/`, `twilio-client`, ElevenLabs/Fish skills) | Real-time voice in and out | Meeting capture & voice assistant build on these now — no hardware required. |
| **Skills system** (Gmail, Google Calendar, Notion, Linear, inbox-management, + a catalog) | Pluggable SKILL.md + TOOLS.json tools | Our "connect all your tools" story; we add/curate business skills. |
| **Credential Execution Service (CES)** | Hard process-isolation for secrets; sandbox-by-default | Enterprise-grade security story for B2B, already architected. |
| **Design library** (`packages/design-library`, `tokens.css`) | Single source of truth for color/type tokens; theming via `data-theme` | Rebrand is centralized — change tokens once, propagate everywhere. |
| **Proactivity loop** | Hourly re-read of notes, surfaces what's due/unfinished | Core of "nothing is ever missed." |

**Gaps we own:** branding/identity, differentiated UX/UI, the meeting-capture →
action-items → memory product flow as a first-class feature, our own skill curation for
business/productivity, and (future) the wearable hardware + its ingestion pipeline.

## 3. Phased plan

### Phase 0 — Foundations (current)
- [x] Read & map the repo; identify leverage and gaps
- [ ] Lock brand (name + identity) — _decision in progress_
- [ ] Get the fork running locally on macOS (working base before deep changes)

### Phase 1 — Rebrand + core UX redesign (macOS desktop first) ← **building now**
- Centralized rebrand: `design-library/tokens.css` (color/type), `electron-builder.config.cjs` (productName, appId, schemes, copyright), package metadata, app icons & assets, in-app strings (~600 "Vellum" refs).
- New visual identity applied to the macOS app: palette, typography, logo/wordmark, icon, menu-bar glyph, about screen, onboarding.
- Redesign the core assistant surface (conversation, memory view, now/focus, proactive notifications) to our UX.
- Deliverable: a branded, redesigned macOS build that is unmistakably _ours_.

### Phase 2 — Mobile app (iOS)
- Apply identity + redesigned UX to the Capacitor/iOS shell.
- Voice-or-text-or-touch entry. "Take it into a meeting" recording entry point.

### Phase 3 — Flagship feature: Meeting Capture → Action Items → Memory
- Record via mic → transcribe → extract action items, decisions, people, tone/context →
  write structured items into the 8-type memory → assistant surfaces & acts (drafts
  follow-ups, creates tasks, schedules).
- Built on `live-voice` + memory extraction; works on phone today, wearable later.

### Phase 4 — Business/productivity skill curation
- Curate and harden the connectors people actually re-wire constantly (email, calendar,
  CRM, task tools, docs). Streamlined connect-once experience.

### Phase 5 — Wearable hardware + always-on ingestion
- Pin device (see/listen) → continuous capture → same meeting-capture pipeline, always-on.
- Persistent, ambient context feeding memory 24/7. Privacy/consent model is a first-class design problem here.

## 4. Immediate next steps
1. Pick the brand direction (Hum / Cue / Vera, or a custom name).
2. I apply it centrally and redesign the macOS core UX (Phase 1 slice).
3. Stand the app up locally so each slice is verifiable on a running build.

## 5. Open decisions to revisit
- ~~Hosting: self-host on our own cloud (DECIDED 2026-06-13).~~ CI/CD targets our own cloud, not the managed platform.
- Managed (cloud) vs. local-first as the default posture for our users.
- iOS-native (Swift) vs. Capacitor-web for the long-term mobile investment.
- Privacy/consent framework for always-on capture (legal + UX), needed before Phase 5.
- Voice persona & TTS provider for the assistant's spoken identity.
