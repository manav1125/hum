# Execution Brief: Paperclip-Inspired Governance & Autonomy Upgrades for Cue

**Date:** 2026-07-08 · **For:** the build thread on the Cue repo
**Companion docs:** `docs/paperclip-competitive-analysis.md` (full research), `docs/cue-kortix-execution-brief.md` (the prior, now-completed workstream — same conventions).
**Reference repo (read-only, on this machine):** `/Users/manavgupta/competitor-repos/paperclip` — a full copy of paperclipai/paperclip @ ~v2026.707.0 (MIT). Read it freely, copy/adapt patterns. If missing, `git clone --depth 1 https://github.com/paperclipai/paperclip.git`.

**Prime directive:** **additive and gap-filling only.** Cue already has agents, missions, budgets, guardrail checkpoints, work-items, cost attribution, and a heartbeat/recovery service (see §3). Do **not** rebuild any of that. Every task below *completes or hardens* an existing system using a proven Paperclip pattern. Nothing is removed or reshaped for current users.

---

## 1. Originating ask

The founder reviewed paperclipai/paperclip (open-source, MIT, ~73k stars — "if OpenClaw is an employee, Paperclip is the company"; an org/governance control plane for teams of agents) and asked what Cue can learn, what we haven't got right, and what to build to improve features/functionality — **building and improving what we already run, not removing or changing anything.**

## 2. The strategic frame (why these, in one paragraph)

Three open-source contenders own three layers: the **worker** (Cue, OpenClaw — the agent that does the work), the **platform** (Kortix — hosts agents), the **management layer** (Paperclip — org/goals/budgets/approvals/audit). Paperclip owns no agent, so its beautiful governance wraps unreliable output ("productivity theater"). Cue is the only one with a strong worker that can grow *into* the management layer on top of its own reliable output — being both the employee and the company. These workstreams add Paperclip's governance maturity to systems Cue already has, closing that gap.

## 3. What Cue ALREADY has (do NOT rebuild — verified 2026-07-08)

Read this first. The biggest risk is recreating existing scaffolding.

| System | Exists today (files) | Status |
|---|---|---|
| **Agent roster w/ roles** | `assistant/src/memory/schema/tasks.ts` (`agents`: name, emoji, domain, charter, tier, `capCents`, paused, model, toolScopes) + `assistant/src/work-items/agent-store.ts` (`getAgent/create/update/list`, `getAgentSpend`) | Multi-agent roster is live. House agent "cue" = null assignee. |
| **Missions w/ budget + hard-stop** | `assistant/src/memory/schema/missions.ts` (`budgetCents`, `spentCents`), `assistant/src/missions/mission-orchestrator.ts` (~L251–260: `spentCents >= budgetCents` → paused + `budget_stop`) | **Mission-level hard-stop already works.** |
| **Guardrail checkpoints** | `assistant/src/guardrails/checkpoint-store.ts` (`guardrail_checkpoints` table), `checkpoint-enforcement.ts` (pre-tool "ask"), `agent-tool-scopes.ts` (domain allowlist), migration `299-guardrails.ts` | Pre-execution ask-rules + per-agent model pins + tool scopes live. **No management UI yet.** |
| **Work-item loop** | `assistant/src/work-items/work-item-runner.ts` (`runWorkItemInBackground`, `buildWorkItemContextPreamble` ~L257–296, `extractWorkItemResult`), `work-item-store.ts` (`WorkItemStatus`), `work-item-events.ts`, schema in `tasks.ts` (`work_items`, incl. a stubbed `approvalStatus:"none"`) | Queue→run→awaiting_review→done live. `approvalStatus` field exists but is **never written**. |
| **Review lane** | `apps/web/src/domains/activity/sections/awaiting-review-section.tsx` (`ReviewRow`, approve=`workitemsByIdCompletePost`, redo=`workitemsByIdRunPost`), `command-center-page.tsx` ("Needs you"), routes `assistant/src/runtime/routes/work-items-routes.ts` | Post-completion review live; **no typed approval + reason/audit.** |
| **Cost attribution** | `assistant/src/work-items/agent-act-store.ts` (`agentActs`: `costCents`, `model`, `reversed`, `estMinutesSaved`), `assistant/src/usage/pricing.ts` (`buildPricingUsageFromResponse`), `llm_usage_events`, `assistant/src/guardrails/usage-rollup.ts` (workspace `totalCents`) | Per-act cost recorded. **No per-project/model Costs UI; agent `capCents` not enforced.** |
| **Liveness / recovery** | `assistant/src/heartbeat/heartbeat-service.ts` (`markStaleRunningAsError`), `assistant/src/daemon/turn-recovery.ts` + markers, `schedule/schedule-recovery.ts`, `calls/call-recovery.ts`, `util/process-liveness.ts` | Heartbeat + hung-turn recovery live. **No liveness/watchdog for background work-item runs specifically.** |
| **Projects ↔ missions** | `projects` table (`missionId`, `context`), `project-store.ts`, `projectKnowledge` | Projects link to missions. **Goal ancestry not threaded into agent context.** |
| **HQ credits** | `hq/src/credits.ts` (`grantMonthlyCredits`, `applyTopup`, `syncUsageFromInstance`), `hq/src/openrouter.ts` (`provisionLlmKey`, `monthlySpendLimitUsd`), `hq/src/db.ts` (`CreditEntry`) | Instance-level credit ledger + OpenRouter spend cap live. **Not reconciled with daemon per-task cost.** |

**Migration pattern:** additive files in `assistant/src/memory/migrations/`, registered in `migrations/registry.ts`; latest is `301-agent-tool-scopes.ts`, so new ones start at **`302-*`**. **Config block pattern:** add `assistant/src/config/schemas/<name>.ts` (Zod + defaults), import into `assistant/src/config/schema.ts`.

---

## 4. Workstreams

WS1–WS2 are P0. WS3–WS5 are P1. WS6–WS7 are P2 (design-note first). Each says: the gap → the Paperclip pattern (with a file to read) → exact Cue hooks → non-regression rules → acceptance.

---

### WS1 — Per-agent & per-task budget enforcement with incidents (P0)

**Gap:** `missions` hard-stop works, but `agents.capCents` is defined and **never enforced**, and there's no per-task budget. Runaway spend on a single agent/task is currently uncapped (cf. our conversation-runaway history).

**Paperclip pattern to copy:** `server/src/services/budgets.ts` + `packages/db/src/schema/budget_policies.ts` + `cost_events.ts`. Model: a policy has `scope` (company/agent/project), `window` (monthly/lifetime), `warnPercent` (soft alert, default 80%), `hardStopEnabled` (auto-pause scope + cancel queued work at 100%), producing a **BudgetIncident** a human resolves. Study how `budgets.ts` transitions `ok → warning → hard_stop` and how a hard stop pauses the scope.

**Cue hooks (extend, don't replace the mission pattern):**
1. Generalize the mission hard-stop into a small budget-checker used by all three scopes. New `assistant/src/guardrails/budget-enforcement.ts` exporting `checkBudget({scope: "agent"|"mission"|"task", id})` that reads spend (`agent-store.ts:getAgentSpend`, `missions.spentCents`, and a new per-task rollup from `agentActs` filtered by `workItemId`) against a cap.
2. Call it in `work-item-runner.ts` **before run start and at each turn boundary** (~L380, after model resolution) — mirror `mission-orchestrator.ts` L251–260. On `warn`: emit a soft notice event. On `hard_stop`: stop the run, set the work item to a new `blocked_budget` state (or reuse `failed` with a reason), and emit a **budget incident** into the Review lane (see WS2's event/table).
3. Add `warnPercent`/`hardStopEnabled` columns to `agents` and (optional) a `taskBudgetCents` to `work_items` via migration `302-budget-policies.ts` (additive, nullable; null/0 = unlimited = today's behavior).
4. Config block `assistant/src/config/schemas/budgets.ts` for workspace defaults (default warn 80%, hard-stop off unless a cap is set — so existing users see **no behavior change**).

**Non-regression:** null/0 cap = unlimited = current behavior (assert this). Mission hard-stop path must remain byte-for-byte behaviorally identical (refactor it to call the shared checker only if you can prove parity with a test). Budget incident is a new event type — do not alter existing `work_item_completed`/event consumers.

**Acceptance:** an agent with a low `capCents` running a multi-turn task stops mid-run at the cap, the work item shows `blocked_budget`, and a resolvable incident appears in Review; an agent with no cap behaves exactly as today; mission hard-stop still fires.

---

### WS2 — Goal ancestry in context + typed approval objects (P0)

Two tightly-related additions to the work-item/Review surface.

**2A — Goal ancestry (gap: agent sees the task, not the "why").**
- Paperclip pattern: `doc/execution-semantics.md` (every issue carries goal lineage to the company mission). Read the "goal ancestry / requestDepth" sections.
- Cue hook: `work-item-runner.ts:buildWorkItemContextPreamble` (~L257–296) already injects project brief + task context. Thread the **full chain** — mission `outcome`/`brief` (from `missions.ts`) → project `context` → task — into the preamble so the agent receives company→mission→project→task "why." Pure prompt-context addition; no schema change.
- Non-regression: additive to the preamble string only; if a work item has no mission/project, the preamble is unchanged from today.

**2B — Typed approval objects (gap: `approvalStatus` is a never-written stub; Review approve/redo captures no type/reason/audit).**
- Paperclip pattern: `packages/db/src/schema/` approval table + `server/src/services/approvals.ts`. Model: a typed object (`type`: code_change/external_send/spend_exception/skill_install/general), flow `pending → approved | rejected | changes_requested`, linked artifact, deliberation note, timestamped decider, immutable. Distinct from Cue's **pre-execution** checkpoints (which stay as-is) — this is **post-completion** review.
- Cue hooks: new `work_item_approvals` table (migration `303-work-item-approvals.ts`) or extend `work-item-events.ts` with an `approval` event carrying `{type, decision, reason, decidedBy, at}`. Write it from the Review actions in `work-items-routes.ts` (`/complete` → approved; add `/reject` and `/changes-requested`). Render type + reason + history in `awaiting-review-section.tsx`.
- Non-regression: the existing approve (`/complete` → done) and redo (`/run`) paths keep working; the approval record is written alongside, not instead. `changes_requested`/`reject` are new endpoints — additive. Keep the stubbed `approvalStatus` column in sync for backward reads.

**Acceptance:** approving a work item records a typed approval with reason + decider visible in the row's history; a "request changes" sends it back with a note the next run receives; an agent's run context shows the mission outcome it's serving.

---

### WS3 — Liveness + watchdog + recovery for background runs (P1)

**Gap:** heartbeat/turn-recovery exist for turns/schedules/calls, but a **background work-item run** that goes silent or hangs isn't specifically detected, bounded-retried, and escalated.

**Paperclip pattern:** `doc/execution-semantics.md` (§ liveness contract, stranded-issue recovery: no valid next-action path → recovery) + `doc/TASK-WATCHDOG.md` (SHA-fingerprint re-check of a stopped subtree; only re-wake on genuine change) + `heartbeat_runs.livenessState` (ok/suspicious/critical) in `packages/db/src/schema/`.

**Cue hooks:** extend `heartbeat-service.ts:markStaleRunningAsError`'s idea to work-item runs: add `livenessState` + `recoveryAttempts` fields to `work_items` (migration `304-*`), detect output-silence on a running work item, auto-requeue up to a bounded cap (config), then convert to a **recovery item surfaced in the Review lane** (reuse WS2's incident/event) instead of silently stalling. Reuse `turn-recovery.ts` markers where applicable.

**Non-regression:** bounded retries (config, default small); never auto-retry past the cap; recovery emits into Review, never silently reassigns; healthy runs are untouched (only silence/stall triggers it). Verify against our known hung-turn + daemon-restart gotchas.

**Acceptance:** a deliberately-hung background run is detected, retried up to the cap, then appears as a recovery item in Review; normal runs complete unchanged.

---

### WS4 — Costs view + reconcile daemon↔HQ ledger (P1)

**Gap:** `agentActs.costCents` and `usage-rollup.ts` exist but there's no per-project/per-model/per-day **Costs UI**, and the HQ credit ledger isn't reconciled with daemon cost attribution.

**Paperclip pattern:** `ui/src/pages/Costs.tsx` + `server/src/services/costs.ts` (rollups by provider/model/agent/window; `MetricCard`s, spend trend, incidents). Read how `cost_events` aggregate into the dashboard.

**Cue hooks:** extend `usage-rollup.ts` to group by project/agent/model/day; new Costs surface in web under Mission Control / `command-center` (reuse existing card primitives); optionally reconcile `hq/src/credits.ts:syncUsageFromInstance` against the daemon's summed `agentActs`.

**Non-regression:** read-only surface; no change to metering or credit deduction; if HQ is absent (self-host), the view degrades to daemon-local totals.

**Acceptance:** a Costs view shows spend by project/model/day and burn rate; totals match `usage-rollup` and (on cloud) the HQ ledger within rounding.

---

### WS5 — Guardrails management UI (P1)

**Gap:** checkpoints, model pins, tool scopes, caps all exist in schema/enforcement but there's **no user-facing surface to view/manage them** (only seeded defaults). This is the Guardrails-initiative console.

**Paperclip pattern:** `ui/src/pages/Approvals.tsx`, the `TrustPresetSection` in `AgentDetail.tsx`, and `Costs.tsx` — how they render policies/scopes/caps legibly. Also `doc/LOW-TRUST-PRESETS.md` for the boundary shape.

**Cue hooks:** new `apps/web/src/pages/guardrails/` surface reading/writing `checkpoint-store.ts` (list/create/edit/enable checkpoints, scopes everywhere/agent/mission), agent model pins + `capCents` (from `agent-store.ts`), and the spend ledger (`usage-rollup.ts`). Wire daemon routes as needed (follow `work-items-routes.ts` conventions).

**Non-regression:** enforcement logic is untouched — this is a management view over existing tables; seeded default checkpoints keep working; behind a `guardrails_ui` feature flag with a verified OFF state.

**Acceptance:** a user can see and toggle checkpoints, see each agent's model pin + cap + spend, and view the workspace spend ledger — with enforcement behavior identical to today.

---

### WS6 — Team/company templates (P2, extends the marketplace)

**Gap:** the marketplace (Kortix WS1, now shipped) installs skills; you can't install a **whole team** (a roster of role-configured agents + seed projects/tasks + the skills they need).

**Paperclip pattern:** `packages/teams-catalog/` + `docs/companies/companies-spec.md` (`agentcompanies/v1`: COMPANY/TEAM/AGENTS/PROJECT/TASK.md + `.paperclip.yaml` sidecar) + `server/src/services/company-portability.ts` (export with secret scrubbing + collision handling). Read the spec — it's the packaging format.

**Cue hooks:** extend the marketplace ingestion to a "team template" item type that bulk-creates agents (`agent-store.ts`), seed projects/tasks (`project-store.ts`, work-items), and installs required skills. Reuse the marketplace lock/consent flow from the Kortix brief.

**Design-note first:** write a short design note (format + install flow + collision/secret handling) for review before building.

---

### WS7 — Deployment/reachability modes (P2, design-note first)

**Paperclip pattern:** `doc/DEPLOYMENT-MODES.md` — `local_trusted` vs `authenticated` (private/public) × reachability `loopback | lan | tailnet | custom`, incl. native Tailscale binding for "reach my local Cue from my phone." Fits Cue's local-first Mac daemon + iOS app. Design-note only in this pass.

---

## 5. Global guardrails (every workstream)

1. **Complete, don't rebuild.** Reconfirm §3 before touching an area; extend existing stores/tables/services.
2. **Additive migrations only**, next index `302+`, registered in `migrations/registry.ts`; new columns nullable with defaults that preserve current behavior. No destructive migrations.
3. **Config blocks** via `assistant/src/config/schemas/<name>.ts` → `config/schema.ts`, defaults chosen so existing users see **zero behavior change** until they opt in.
4. **Feature-flag** every new user-visible surface; verify the OFF state renders nothing and changes no behavior.
5. **Rebrand boundary:** display "Cue"; keep `vellum` protocol/infra ids and table names.
6. **Secrets discipline:** keep Guardian/CES; no key in a tracked file, log, DB value, or context. (Do not adopt Paperclip's AWS Secrets Manager dependency — borrow only the never-in-DB/redacted-everywhere discipline.)
7. **Self-host parity:** every HQ-dependent feature (credits reconciliation, incidents) degrades gracefully when HQ is absent; test with the `local:` owner principal (actorPrincipalId undefined must not be silently rejected).
8. **Verification standard (no unverified handbacks):** exercise real routes with real payloads and assert persisted state; drive the real Review/Guardrails/Costs pages and assert DOM + network; **test against prod URL, not the vite preview proxy** (it 404s new daemon routes — known gotcha). Add a check per new surface to `assistant/qa/prod-smoke.ts` (budget hard-stop fires, approval recorded, recovery item appears, Costs/Guardrails render).
9. **macOS app** bundles a web SPA snapshot — rebuild it after web changes or the desktop app shows stale screens.
10. **When in doubt, smaller:** ship read-only before write (Costs/Guardrails views before edit); ship the enforcement behind an opt-in cap before making it default.

## 6. Sequencing & acceptance

| Order | Item | Done means |
|---|---|---|
| 1 | WS1 budget enforcement | Low-cap agent stops mid-run at cap → `blocked_budget` + resolvable Review incident; no-cap agent unchanged; mission hard-stop still fires; prod-smoke check added |
| 2 | WS2 goal ancestry + typed approvals | Agent context shows mission "why"; approve records typed approval + reason + history; "request changes" round-trips; legacy approve/redo unchanged |
| 3 | WS3 liveness/watchdog | Hung background run detected → bounded retry → Review recovery item; healthy runs untouched |
| 4 | WS4 Costs view | Spend by project/model/day matches rollup + HQ ledger; read-only |
| 5 | WS5 Guardrails UI | View/toggle checkpoints, per-agent pin/cap/spend, ledger; enforcement identical to today; flag OFF hides it |
| 6 | WS6 / WS7 | Design notes reviewed before any build |

Report per-workstream: what changed, what was verified (with real-surface evidence), what's unverified/risky — numbered, low-fluff.
