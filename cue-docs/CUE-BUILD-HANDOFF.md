# Cue — Master Build Handoff (for Claude Code)

**Read this first.** This is the single entry point for building Cue on the forked codebase.
It indexes every other doc, enumerates **all functions/features** (existing → keep/redesign, plus
net-new to build), the tech specs, the invariants you must not break, the external repos to
borrow from, the build sequence, and setup/deploy. Run Claude Code on **Claude Fable 5 (`claude-fable-5`)
only** — Anthropic's most capable widely-released model (1M context) — for this large TS+Swift
monorepo. (If the picker shows Fable unavailable, update Claude Code Desktop to the latest version
and reselect it; don't fall back to another model for this build.)

> Design ownership: the **design system + brand + hero mocks are owned upstream** (in this repo's
> `design/` + `BRAND.md` + `tokens.css`). Claude Code **implements to those specs** and, for
> secondary/long-tail screens, **follows the established `design-library` components and patterns**
> rather than inventing new visual language. Do not redesign tokens or invent layouts; match the mocks.

## 0. Document map (all in this repo / Hum folder)
| Doc | What it gives you |
| --- | --- |
| `ROADMAP.md` | Phases, what we forked, decisions (self-host, etc.) |
| `BRAND.md` | Cue identity: palette, type, logo, **deferred deep-rename list** |
| `FUNCTIONALITY-MAP.md` | Code-level feature inventory (runtime domains + web surfaces) |
| `design/cue-design-system.html` (v0.1) | Brand + core conversation direction |
| `design/cue-design-system-v2.html` (v0.2) | **Full surface inventory** — one screen per real domain |
| `design/cue-design-v3-worldclass.html` (v0.3) | Net-new flagships (meeting capture, next-moves, trust, people) |
| `design/cue-live-v0.4.html` | **Cue Live** desktop-presence mock |
| `DESIGN-SPEC.md` | v0.2 surface→repo build spec |
| `CUE-LIVE-RESEARCH.md` | Desktop-presence landscape + fork candidates |
| `CUE-LIVE-SPEC.md` | Cue Live technical + UX spec |
| `CUE-INFRA-SPEC.md` | Self-host infra + CI/CD spec (deploy) |
| `assets/cue/` | Logos: `wordmark.svg`, `icon.svg` |
| `cue-rebrand.patch` | Phase-1 cosmetic rebrand, ready to `git apply` |

> **Packaging:** all of the above ship together in `cue-handoff.zip`. Commit the bundle's contents
> into the repo as a top-level `cue-docs/` folder (and `assets/cue/` for logos, `cue-rebrand.patch`
> at root) so everything is co-located and version-controlled. The `.md` alone is just an index —
> it needs these files beside it.

## 1. Repos & licenses
**Base (build here):** `vellum-ai/vellum-assistant` → fork `github.com/manav1125/hum` (MIT). TS 80% / Swift 18%.
**Borrow (all MIT, compatible):**
- `farzaa/clicky` — overlay/point + push-to-talk companion UX (Cue Live).
- `mediar-ai/fazm` — AX-first macOS reader/automation (Cue Live take-control).
- `screenpipe/screenpipe` — local-first screen capture (Cue Live scoped-watch).
- `baryhuang/mcp-remote-macos-use` / `CursorTouch/MacOS-MCP` — macOS-control **MCP** action layer.

### Setup
```bash
git clone https://github.com/manav1125/hum.git && cd hum
git apply ../cue-rebrand.patch        # Phase-1 rebrand (or git am)
./setup.sh && source ~/.bashrc
# verify the rebrand builds + tests pass:
bun test
# run the desktop app (macOS) per apps/macos/README.md
```

## 2. COMPLETE feature matrix — existing functions (keep / redesign)
Disposition key: **Keep** (works, restyle only) · **Redesign** (new Cue UX per v0.2) · **Extend** (new capability added).

### 2a. Runtime domains — `assistant/src/*` (60+; product-relevant)
| Domain(s) | Function | Disposition |
| --- | --- | --- |
| `memory/` | 8-type memory, extraction, recall, dedup, staleness | **Extend** (people memory, desktop+meeting capture writes) |
| `agent/`, `prompts/` (SOUL) | Identity/personality | **Keep** — persona = "Cue", reflected in onboarding |
| `conversations/`, `context/` | Threads, compaction, overflow recovery | Keep |
| `heartbeat/`, `background-wake/`, `followups/`, `signals/`, `work-items/`, `tasks/`, `schedule/`, `playbooks/`, `sequence/` | Proactivity engine | **Extend** → feed the new unified **next-moves queue** |
| `live-voice/`, `stt/`, `tts/`, `calls/` | Real-time voice, dictation, phone calls | **Extend** → voice mode, meeting capture, Cue Live voice |
| `channels/`, `telegram/`, `email/`, `messaging/`, `inbound/`, `outbound-proxy/` | Multi-channel, one memory | Keep (rebrand strings) |
| `tools/`, `browser/`, `browser-session/`, `media/`, `documents/`, `filing/`, `workspace/` | Computer use, browse, files | **Extend** → Cue Live action substrate |
| `skills/`, `plugins/`, `plugin-api/`, `bundler/`, `mcp/` | 67-skill catalog + MCP | **Extend** → curate business skills (Phase 4) |
| `security/`, `permissions/`, `approvals/`, `credential-execution/` (CES), `credential-health/`, `oauth/` | Trust, approvals, secret isolation | **Extend** → power the **trust console** + Cue Live checkpoints |
| `contacts/`, `a2a/`, `acp/` | Contacts, agent-to-agent | **Extend** → people memory + A2A UI |
| `subagent/` | Child agents | Keep (avatar chips) |
| `avatar/` | Animated character | **Redesign** → aperture avatar (states: idle/listening/thinking/speaking/acting) |
| `daemon/`, `runtime/`, `backup/`, `export/`, `usage/`, `telemetry/`, `embedded/`, `home/`, `watcher/`, `providers/` | Lifecycle, multi-provider LLM, backup, usage | Keep |

### 2b. UI surfaces — `apps/web/src/domains/*` (one React app → web + macOS Electron + iOS Capacitor)
All **Redesign** to Cue per `design/cue-design-system-v2.html` unless noted.
| Surface | Function | Design source |
| --- | --- | --- |
| `onboarding/` | welcome → hatching → api-key → hosting → privacy → terms | v0.2 §01 |
| `home/` | greeting, recap, suggestion pills, **feed**, detail panel | v0.2 §02 |
| `chat/` | conversation, composer, inspector, subagent, **inline approvals**, doc viewer | v0.2 §03 / v0.3 |
| `intelligence/` | identity(SOUL) · memories/memory-v2 · skills · plugins | v0.2 §04 |
| `library/` | install catalog (apps/skills) | v0.2 §05 |
| `workspace/` | files | v0.2 §06 |
| `contacts/` | contacts, connect, **A2A invites**, trusted access | v0.2 §07 |
| `terminal/` | computer-use session/stream | v0.2 §10 |
| `logs/` | emails, system-events, trace, **usage/billing** | restyle |
| `settings/` | general, **voice**, devices, integrations, notifications, schedules, privacy, sounds, developer, advanced | v0.2 §11 |
| `account/` | login/signup/oauth/password | restyle |
| components: `avatar`, `command-palette`, `nudges`, `integrations`, `charts`, `app-viewer` (embedded skill UIs), credits modals | — | restyle to tokens; avatar→aperture |

## 3. NET-NEW features to build (tech specs)
| Feature | Build on | Spec | Phase |
| --- | --- | --- | --- |
| **Meeting capture → action items → memory** | `live-voice`+`stt`+`memory`; NEW capture-session model, live extraction, recap surface | v0.3 §01 | 3 |
| **Unified next-moves queue** | aggregate `email`/`chat`/`tasks`/`followups`/`approvals`/`calls` into one ranked surface | v0.3 §02 | 3 |
| **Trust & consent console** | surface `security`/`permissions`/`approvals`; NEW capture-consent + audit UX | v0.3 §03 | 3 (precedes always-on) |
| **Relationship / people memory** | compose `memory`+`contacts`+capture; NEW per-person rollup | v0.3 §04 | 3–4 |
| **Cue Live (desktop presence)** | native helper (AX + ScreenCaptureKit + overlay + CGEvent) + **MCP action layer**; reuse approvals/CES | **`CUE-LIVE-SPEC.md`** | 3–4 |
| **Wearable ingestion** | same capture→memory pipeline, always-on | ROADMAP §Phase 5 | 5 |

## 4. Cross-cutting invariants — DO NOT BREAK (from `ARCHITECTURE.md`)
- **Public ingress is gateway-only**; external webhooks/APIs live in `gateway/`.
- **Credentialed outbound goes through CES** (`make_authenticated_request` / `run_authenticated_command`) — never hand-roll token plumbing in feature code.
- **LLM calls go through the provider abstraction**, not provider SDKs in feature code.
- **Notifications emit via `emitNotificationSignal()`** (preserves decisioning/audit).
- **Memory extraction/recall enforces actor-role provenance gates** for untrusted actors.
- **Feature flags** live in `meta/feature-flags/feature-flag-registry.json` (kebab-case keys); a flag OFF removes the skill from all surfaces. New surfaces/skills must register flags.
- **Permission-controls-v2**, **context-overflow recovery**: keep the existing handling.
- **Design tokens are the single source** (`packages/design-library/src/tokens.css`) — already on Cue. Don't hardcode colors.
- Respect **multi-local instance isolation** + per-assistant data dirs.

## 5. Phase 1b — deep identifier rename (after cosmetic rebrand)
Coordinated migration (NOT find/replace), tracked in `BRAND.md`: `@vellumai/*` scope (823 files),
`VELLUM_*` env vars, `vellum.ai` domains (164), `~/.vellum` data dir + lockfile, the `vellum` CLI
binary + its dialogs, deep-link schemes (`vellum`/`vellum-assistant`), `.vellum` UTI/extension,
`Vellum-Organization-Id` wire header, `appId`. Each needs code + data-migration handling. Do as its
own PR series with the guard/build tests green.

## 6. Master build sequence
1. **Apply `cue-rebrand.patch`**, verify `bun test` + macOS build. (Phase 1)
2. **`design-library` primitives + token audit** — Card, Nudge, Chip, FocusCard, SourceTag, the **aperture avatar** component, VoiceOrb.
3. **v0.2 surface redesign** in `apps/web/src` — Home(feed) → Chat → Intelligence → Library/Workspace/Contacts → Terminal/Logs → Settings → Onboarding. (Lands web + macOS together.)
4. **Mobile responsive layout** + tab bar (iOS via Capacitor).
5. **v0.3 flagships** — meeting capture → next-moves queue → trust console → people memory.
6. **Cue Live** — companion (guide-only) → scoped-watch → guided take-control → autonomous (AX-rich) → always-on. (Per `CUE-LIVE-SPEC.md`.)
7. **Phase 1b deep rename** (can run in parallel once stable).
8. **Skill curation** (Phase 4) and **self-host deploy** (below).
9. **Wearable** (Phase 5).

## 7. Verification expectations (every PR)
- `bun test` green; update tests in lockstep with source (see how the rebrand patch did it).
- Respect existing **guard tests** (feature-flag format, architecture boundaries).
- For each redesigned surface: build the app and visually diff against the matching v0.2/v0.3 mock.
- Cue Live: test AX targeting on AX-rich apps; verify Stop/pause/checkpoint; verify no capture of secure fields.

## 8. Self-host deploy (high-level; full IaC to come)
Three runtime images — **assistant**, **gateway**, **CES** (must stay process-isolated) — plus the
egress proxy; persistent volumes for per-assistant workspace/memory and the CES security volume;
OAuth callbacks + webhooks via gateway only. Target your own cloud (GCP/AWS — to be chosen). The
managed Vellum Platform is NOT our target. Detailed infra + CI/CD spec is a separate deliverable.

## 9. Open decisions to lock (don't block Phase 1–3)
- Cloud provider for self-host (GCP vs AWS) → drives IaC.
- Voice/TTS persona + provider (ElevenLabs/other).
- Local model for Cue Live observation gate.
- iOS-native (Swift) vs Capacitor long-term.
- Always-on capture privacy/legal framework (before Phase 5).

---
_This handoff is comprehensive but indexes detail rather than duplicating it — follow the linked
specs/mocks. Build to the design system; ask upstream (design) for any screen that needs more than
the existing patterns provide._
