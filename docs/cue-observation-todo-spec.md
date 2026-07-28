# Cue: Watch → Learn → To-do → Execute — Combined Spec (Screenpipe, Unlimited-OCR, Cue Live)

**Date:** 2026-07-10
**For:** the Cue builder.
**Scope:** how Cue should get "watch what the user does → learn → create to-dos/SOPs → hand to agents for execution," assessed against **Screenpipe** (github.com/mediar-ai/screenpipe), and how **Unlimited-OCR** and the existing **Cue Live** voice work fit the same spine.
**Companions:** `docs/cue-live-voice-research.md` + `docs/cue-live-voice-execution-brief.md` (voice), `docs/cue-ocr-document-vision-plan.md` (documents).

---

## 0. The unifying model

All three initiatives are input modes feeding **one spine Cue already owns**: *observation → understanding → to-do → execution*, where the to-do is a **work-item** that triages into Cue's agent/Guardrails system.

| Input mode | What it observes | Status in Cue |
|---|---|---|
| **Cue Live (voice)** | an active spoken conversation | engine built (dormant); briefs written |
| **Screen observation** | what's on the user's screen, passively | **pipeline built (dormant); only the continuous driver is missing** |
| **Documents (OCR)** | PDFs/scans/attachments | gap is `extracted_text` plumbing, not a model |

The shared back-half — `extract → actionItemsToWorkItems/createWorkItem → triage → agents` — is done. Every mode should converge on it rather than grow its own executor.

**Headline finding:** Cue does **not** need Screenpipe to build the watch→to-do loop. Cue already built it (`assistant/src/cue-live/observation-capture.ts`, 948 lines + tests, dormant). Screenpipe is only better at the *front half* (continuous capture + durable searchable activity history), and its single most valuable idea — **accessibility-tree-first capture** — is a concept Cue can adopt natively without touching Screenpipe's now-commercial-licensed code.

---

## 1. Screenpipe assessment (verified from source @ main)

**What it is:** Mediar, Inc. (YC S26, ~20.6k★, ~6 people). A local-first Rust+Tauri app that continuously records screen + audio, extracts text, and exposes it as searchable memory that scheduled AI "pipes" act on. Sibling `mediar-ai/terminator` (Windows desktop automation, still MIT) is the "act" half of their thesis.

**The decisive fact — licensing blocks embedding.** Screenpipe relicensed **from MIT to a "Screenpipe Commercial License."** Free only for personal/non-commercial/eval use; §5 explicitly forbids, without a paid license, "embed or integrate the Licensed Work into a product offered to customers" and distributing it "as part of a commercial product." **Cue is for-profit, so bundling the binary as a sidecar or linking the crates requires a paid commercial deal with Mediar** (louis@screenpi.pe). This is the gating item — technical embeddability is easy; legal embeddability is not. (Old MIT-era snapshots exist but are unmaintained and legally/ethically murky — do not build on them.)

**Architecture (current, ~22-crate Cargo workspace):** `screenpipe-engine` (recorder + axum HTTP server, ships the `screenpipe` binary), `screenpipe-screen` (ScreenCaptureKit + OCR), `screenpipe-a11y` (accessibility-tree capture — now the *preferred* text source), `screenpipe-audio` (whisper.cpp STT), `screenpipe-db` (SQLite + FTS5). Capture is **event-driven** (frame-diff + power-profile idle interval 30-300s), not fixed-fps. Storage: `~/.screenpipe/db.sqlite` (FTS5 `frames.full_text` merging a11y + OCR text; audio transcriptions; meetings; speakers). Footprint: ~5-10% CPU, **0.5-3 GB RAM, ~20 GB/month**, downloads a Whisper model + needs ffmpeg.

**Embeddability (if licensed):** genuinely clean as a **headless sidecar** — `screenpipe record -p <port> --data-dir <path>` runs capture + server with no UI; Cue's daemon polls a **local REST API on `localhost:3030`**: `GET /search` (q, content_type ocr/audio/ui, time range, app_name…), `GET /activity-summary`, `POST /raw_sql` (read-only), or open the SQLite file directly with `better-sqlite3`. Pipes are a Screenpipe-internal agent runtime — Cue would bypass them and just consume the API. **Do not** plan to statically link the crates (not published, fast-moving). macOS perms: Screen Recording + Accessibility + Microphone (+ optional Automation) — a separately-signed sidecar prompts on its own TCC identity.

**The one big idea to steal (free — it's an approach, not code):** Screenpipe extracts screen text **accessibility-tree-first, OCR only as fallback.** Reading the OS AX tree (app/window/element text) is far cheaper, more accurate, and more private than screenshotting every interval into a vision-LLM. This is the highest-value insight for Cue.

**OCR is pluggable** in Screenpipe via a `Custom` engine (base64 frame → your HTTP `/ocr` endpoint) — so *if* Cue ever ran Screenpipe as a licensed sidecar, its fallback OCR could point at Unlimited-OCR. Noted, not recommended as the path.

**Community caveats:** resource/battery heavy (local Whisper is the biggest drain), OCR/STT accuracy gaps, agents that "confidently write slightly wrong updates," and privacy ethics of always-on recording (banking/health/passwords in-scope without careful exclusions).

---

## 2. What Cue already has (the reveal)

Verified on `cue/handoff-bundle`. The screen-observation → to-do pipeline is **built and wired, dormant** — same pattern as the voice engine.

- **`assistant/src/cue-live/observation-capture.ts`** (948 lines + `.test.ts`) — full **gate → extract → file** flow. GATE = config `enabled` + armed expiring session + extraction/item caps + `intervalSeconds` floor (min 15) + `observationDigest` change-fingerprint + `detectSensitiveScreen` deny-list. EXTRACT = `extractWithFlashLlm` (text → `conversationTitle` call site; frame → `cueLiveVision` call site) → `parseScreenTasksResponse`. FILE = each task → `createTask` + `createWorkItem` with `sourceType:"screen"`, `assignee:"Inbox"`, **`autoRunEligibility:"parked"` (never auto-runs)**, `sourceContext` evidence JSON, then `triageAndMaybeAutoRunWorkItem`. **Frames are never persisted** — only a sampled FNV-1a fingerprint survives one observation.
- **Routes** — `assistant/src/runtime/routes/cuelive-observation-routes.ts`: `POST cuelive/observation` (the ingest seam), session start/stop/view. Served over HTTP + IPC.
- **Capture primitive** — `apps/macos/native/mac-helper/.../CueLive.swift` uses **ScreenCaptureKit** (`captureScreen` RPC, permission via `CGRequestScreenCaptureAccess`), driven by `apps/macos/src/main/cue-live-service.ts`. Today it fires only on ⌥R/summon, never continuously.
- **Config** — `assistant/src/config/schemas/cue-live.ts`: all OFF by default (`enabled`, `intervalSeconds`, `sessionMaxMinutes` max 240, caps, `dedupeWindowMinutes`, `DEFAULT_SENSITIVE_APP_DENY_LIST`).
- **Native sidecar precedent** — `apps/macos/src/main/sidecar/mac-helper.ts` already spawns + supervises the Swift helper (length-prefixed IPC, `supervisor.ts`). The pattern for bundling any background capture binary exists.
- **Cadence primitives** — `assistant/src/heartbeat/heartbeat-service.ts` + `memory/jobs-worker.ts` + `schedule/scheduler.ts`.
- **Reuse spine** — `runtime/services/action-item-work-items.ts:actionItemsToWorkItems` (shared by voice + meeting-recap); `work-items/work-item-store.ts`; memory via `runGraphExtraction` (voice-intake already calls it best-effort).

**What's genuinely MISSING:** (1) a **continuous driver** (a cadence loop that captures + POSTs `cuelive/observation` while armed); (2) a **durable observation/activity store + timeline/digest** (today state is in-process only, no frames persisted, no "what did you do" history); (3) richer capture signal than a periodic screenshot.

---

## 3. The decision

**Build native on Cue's dormant pipeline; steal Screenpipe's accessibility-first idea; do not fork or embed Screenpipe's code.** Rationale: Cue already owns the valuable, well-integrated back-half (into work-items/agents/Guardrails — stronger than Screenpipe's pipes); Screenpipe's code is license-gated for commercial use, resource-heavy (0.5-3 GB RAM, ~20 GB/mo), and would duplicate a stack Cue mostly has. The part worth taking is the *approach*, which is free.

**Tiered:**

### Tier 0 — Turn on the dormant pipeline with a native continuous driver (do first)
Add the missing driver: while a capture session is armed, on a cadence (existing `heartbeat-service`/`jobs-worker` + the `CueLive.swift captureScreen` primitive), produce an observation and call the existing `kickScreenObservationCapture` / `POST cuelive/observation`. Everything downstream (extract → parked work-item → triage → Activity "Came-in" lane) already runs. Keep all existing privacy gates (sensitive-app deny-list, dedupe fingerprint, caps, interval floor) and keep it **opt-in / off by default**. This delivers watch→to-do with zero new capture tech.

### Tier 1 — Adopt accessibility-tree-first capture (the high-value steal)
Extend the Swift mac-helper to read the **OS accessibility tree + active app/window/URL context** and feed that *text* into the observation pipeline, using a screenshot→`cueLiveVision` frame only as fallback for apps that don't expose accessible text. Wins: far cheaper (no vision-LLM tokens every interval), more accurate, more private (text, not pixels), lower latency. This is the single biggest quality/cost upgrade and needs none of Screenpipe's code — just its method (`AXUIElement` APIs; same Accessibility TCC Cue may already hold for computer-use).

### Tier 2 — Durable activity store + digest/timeline (enables SOPs & pattern-learning)
Add a `screen_observations` (and/or activity) table via the standard migration pattern (`assistant/src/memory/migrations/NNN-*.ts`) to persist a **privacy-filtered, text-only** activity record (app, window, extracted intent, timestamps — not raw frames). This unlocks: a "what did you do today" digest, **SOP/workflow generation** from repeated observed sequences, and pattern-mined recurring-todo suggestions — the things Screenpipe's pipes do, but native and flowing into Cue's work-items. Surface via a periodic `jobs-worker` job ("summarize recent activity → propose parked to-dos / draft an SOP").

### Tier 3 — Optional: Screenpipe as a licensed power-user sidecar (only if/when)
If Cue later wants **full audio capture + diarized meeting transcripts + a rich searchable history** fast, and a **commercial license with Mediar is in place**, run `screenpipe record` headless as a sidecar (the `mac-helper.ts` spawn/supervise pattern fits) and have Cue's daemon consume `GET /search` + `GET /activity-summary` + `POST /raw_sql`, bridging results into the same observation pipeline. Reserve for when the audio/history value clearly beats the license cost + 0.5-3 GB RAM / ~20 GB/mo footprint. Not the first move.

---

## 4. Where Unlimited-OCR fits (and doesn't)

**Documents, not the live screen.** Screenpipe's own design confirms the live-screen path should be accessibility-first with *lightweight* OS OCR fallback — running a 3B document model per frame would be wrong (cost, latency, overkill). Unlimited-OCR stays scoped exactly as `docs/cue-ocr-document-vision-plan.md` recommends: Tier 0 `extracted_text` plumbing (unpdf + existing vision tier) for born-digital + scanned docs; Unlimited-OCR serverless for dense/long/structured documents; self-host only at volume/privacy scale. The only crossover: *if* Tier 3 (Screenpipe sidecar) ever happens, Screenpipe's `Custom` OCR engine could point at an Unlimited-OCR endpoint — a nice-to-have, not a driver of the decision.

---

## 5. Build plan (exact hooks + guardrails)

| WS | Goal | Cue hooks | Non-regression |
|---|---|---|---|
| **WS1 (P0)** | Continuous driver turns the dormant pipeline on | cadence via `heartbeat-service.ts`/`memory/jobs-worker.ts`; capture via `apps/macos/.../CueLive.swift captureScreen` + `cue-live-service.ts`; ingest via existing `kickScreenObservationCapture`/`POST cuelive/observation`; gates in `cue-live/observation-capture.ts` unchanged | opt-in, off by default; all existing caps/deny-list/dedupe/interval-floor honored; no auto-run (parked stays parked) |
| **WS2 (P1)** | Accessibility-first capture | extend `apps/macos/native/mac-helper` (Swift AX APIs) to emit app/window/element text; feed as observation `description` (text path), screenshot→`cueLiveVision` only as fallback | text path already supported by `observation-capture.ts`; frame path unchanged; Accessibility TCC prompt handled like existing perms |
| **WS3 (P1)** | Durable activity store + digest/SOP | new `screen_observations` table (migration `NNN-*.ts` + registry); periodic `jobs-worker` job → digest + parked to-dos / draft SOP; write facts via `runGraphExtraction` | text-only, privacy-filtered, never raw frames; additive migration; feature-flagged |
| **WS4 (P2)** | Converge filing paths | optionally extend `actionItemsToWorkItems` to accept parked/attribution options so voice + screen share one filer | keep screen-specific fields (`autoRunEligibility:"parked"`, `sourceContext`, `assignee:"Inbox"`) |
| **WS5 (later)** | Screenpipe sidecar (licensed) | spawn `screenpipe record` via `sidecar/mac-helper.ts` pattern; consume `localhost:3030` `/search`,`/activity-summary`,`/raw_sql`; bridge into observation pipeline | **requires a signed commercial license from Mediar**; separate TCC identity; resource budget accounted |

**Global guardrails:** opt-in and off by default; the `detectSensitiveScreen` deny-list + PII care are mandatory (banking/health/passwords/other people's data are the ethical/legal risk — this is always-on observation); never persist raw frames (text + fingerprints only); parked work-items never auto-run without Guardrails approval; feature-flag every surface with a verified OFF state; keep the `vellum` internal ids; test against the prod URL not the vite preview proxy; rebuild the macOS SPA after web changes.

---

## 6. Recommendation

1. **Ship WS1 + WS2 first:** turn on Cue's dormant observation pipeline with a continuous driver, and feed it **accessibility-tree text** instead of periodic screenshots. That delivers the "watch → learn → parked to-do → hand to agents" loop cheaply, accurately, and privately — using Cue's own, better-integrated spine.
2. **Add WS3** for the durable activity timeline + SOP/pattern generation — the genuinely new capability Cue lacks and Screenpipe demonstrates.
3. **Keep Unlimited-OCR document-scoped** (separate doc); it is not the screen-capture answer.
4. **Treat Screenpipe as an optional, licensed, later sidecar** for full audio+diarization+history — not a dependency to fork or embed now. The blocker there is commercial licensing with Mediar, not engineering.

**Bottom line:** the watch→to-do→execute product you want is ~one driver + one capture upgrade away, because Cue already built the pipeline. Steal Screenpipe's accessibility-first idea, not its (commercially-licensed, heavy) code; reserve the real Screenpipe as a paid power-user sidecar if and when audio/history justify it.
