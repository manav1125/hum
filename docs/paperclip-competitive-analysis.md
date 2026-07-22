# Paperclip — Competitive Analysis & What Cue Should Learn

**Date:** 2026-07-08
**Sources:** full read of github.com/paperclipai/paperclip @ v2026.707.0 (92MB monorepo, ~3,400 files, MIT), paperclip.ing / paperclip.inc, press/community coverage.
**Companion:** `docs/kortix-suna-competitive-analysis.md`, `docs/cue-kortix-execution-brief.md`.

---

## 1. Executive summary

Paperclip is a different animal from Kortix, and the difference is the whole lesson. Where Kortix is *the platform that hosts agents* and Cue is *the agent that does the work*, **Paperclip is the management layer that governs a team of agents you bring** — org charts with roles and reporting lines, tasks that carry full goal ancestry, per-agent token "salary" budgets with hard stops, heartbeats, immutable audit logs, typed human-approval gates, and importable whole-company templates. Its own tagline: *"If OpenClaw is an employee, Paperclip is the company."*

It's growing fast — **~73k GitHub stars** since a March 2026 launch (3.5× Kortix), MIT-licensed, boosted hard by Greg Isenberg, hosted tier at paperclip.inc (€19/€49/enterprise). Founders are semi-pseudonymous ("Dotta"), likely linked to AE Studio; no disclosed funding.

Three things matter for us:

1. **Paperclip is a shipped version of Cue's autonomous-OS north-star.** Our `[[cue-autonomous-os-direction]]` note is literally "goals→agents→sprints→review above projects." Paperclip built exactly that: `goals → org of agents → issues (with checkout/heartbeat/review) → approvals`. We should read it as a reference implementation of the architecture proposal we owe ourselves, not just a competitor.

2. **Its governance/budget/audit layer is our `[[cue-guardrails-initiative]]` made concrete.** Budget policies with soft-warn + hard-stop auto-pause, typed approval objects, low-trust sandbox presets, per-task/agent/model cost attribution, an immutable activity ledger — this is the exact "one rules surface (checkpoints/scopes/model pins/caps/ledger)" we scoped, already implemented and legible. We can lift the primitives almost verbatim.

3. **Its fatal weakness is our core strength — and vice versa.** Paperclip ships *no agent*. It orchestrates whatever you plug in (Claude Code, Codex, OpenClaw), so the honest community verdict is "productivity theater": great org chart, unreliable output, "nobody in the loop to say a statistic is made up." Cue has the opposite problem — a genuinely good agent, but a thin org/governance/cost layer. **Cue is the only one of the three that can credibly be both the employee and the company.** That's the position to take.

---

## 2. What they built (facts)

### 2.1 The control plane (a Linear-for-agents)

- **Stack:** Node + Express REST, React 19 + Vite + Tailwind v4 + shadcn/Radix, **Drizzle/Postgres** (embedded PGlite in local mode, external Postgres in prod), Better Auth, `ws` for realtime. ~97 DB tables.
- **Core entities:** `companies` (multi-tenant, data-isolated) → `goals` (self-referential hierarchy) → `projects` → `issues` (73 columns; the unit of work) with `agents`, `heartbeat_runs`, `cost_events`, `budget_policies`, `approvals`, `issue_comments`, `documents`, `routines`.
- **Org model:** `agents.reportsTo` (self-FK) gives an arbitrary-depth org chart; agents have `role`, `title`, `capabilities`, `budgetMonthlyCents`, `permissions`, `adapterType`. A human "board" hires agents (gated by `requireBoardApprovalForNewAgents`); CEO agent can't execute unapproved strategy.
- **Goal ancestry:** every `issue.goalId` chains up to the company mission; tasks carry the full "why," not just a title. `requestDepth` counts delegation hops.
- **Atomic execution (the hard part they got right):** a single assignee per issue (`assigneeAgentId` XOR `assigneeUserId`); moving to `in_progress` requires atomic checkout via `checkoutRunId`/`executionRunId` locks; concurrent checkout returns **409 with the current owner**; terminal runs compare-and-clear locks; a startup sweep reaps orphaned runs and resumes queued ones. No double-work, no lost work on reboot.
- **Heartbeats + liveness:** agents don't stream a chat — they *wake on a schedule or wake-request*, check their assigned work, act, and sleep. `heartbeat_runs` tracks `livenessState` (ok/suspicious/critical) from output-silence signals; a **task watchdog** re-checks a stopped issue subtree via a SHA fingerprint and only re-wakes on genuine change; **recovery issues** (`originKind` = stranded_issue_recovery / task_watchdog / liveness_escalation) are auto-created, bounded by retry caps, then escalated to a human. This is a mature answer to our hung-turn / daemon-restart gotchas.

### 2.2 Governance, budgets, trust (the standout layer)

- **Budget policies** (`budget_policies`): scope = company | agent | project, window = monthly | lifetime, `warnPercent` (soft alert, default 80%) and `hardStopEnabled` (auto-pause the scope + cancel queued work at 100%), producing a `BudgetIncident` a human resolves. Cost is attributed per `cost_events` row to agent/issue/project/goal/provider/model with input/cached/output tokens and `costCents`, plus a `billingCode` so cross-agent delegated work bills back to the requester.
- **Typed approval gates** (`approvals`): first-class objects with `type` (hire, code_review, budget_exception, skill_install), a `pending → approved | rejected | revision_requested` flow, linked issues, a deliberation comment thread, and a timestamped decider. Not ad-hoc "review this" — durable, auditable workflow steps.
- **Low-trust presets** (`trust-policy.ts`): an opt-in `low_trust_review` boundary for untrusted input that *forces* sandbox driver + isolated per-issue workspace, whitelists allowed secrets/agents/tool-classes (`git.read`, `github.pr.read`, `tests.local`), scopes access to an issue subtree (max depth 12), and quarantines output until explicitly promoted. Plus a Dockerized "untrusted PR review" harness.
- **Secrets:** AWS Secrets Manager provider — plaintext never in Paperclip's DB (only metadata/bindings/refs), resolved server-side at runtime, injected into the run env, **redacted from logs/comments/transcripts**, never exposed to the agent. Bootstrap via workload identity only.
- **Audit:** centralized activity log with redaction middleware, full tool-call tracing, secret-access events, budget incidents, approval decisions — an immutable "every decision explained" trail.
- **Deployment modes:** `local_trusted` (loopback, no login) vs `authenticated` (private/public), with a separate reachability axis (`loopback | lan | tailnet | custom`) — including native **Tailscale** binding for "manage from your phone."

### 2.3 Bring-your-own-agent adapter model

- **Adapter contract** (`ServerAdapterModule`): `execute(ctx)` + `testEnvironment()`, optional `listSkills/syncSkills`, `sessionCodec` (resume the same session across heartbeats), `getQuotaWindows`, `onHireApproved`. Three lifecycle ops: **invoke** (`execute`), **observe** (`onLog`/`onMeta`/`onRuntimeProgress` streaming), **cancel** (SIGTERM→SIGKILL via captured PID).
- **14 built-in adapters:** claude_local, codex_local, cursor, cursor_cloud, opencode_local, gemini_local, grok_local, pi_local, acpx_local, hermes_local, hermes_gateway, openclaw_gateway, process, http. External adapters load as npm packages via dynamic import.
- **agent-shim** (Go): `syscall.Exec` replaces itself with the resolved CLI so signals reach the agent cleanly in sandboxes.
- **MCP server the control plane exposes to agents** (~40 tools): `paperclipGetHeartbeatContext`, `paperclipCheckoutIssue`, `paperclipAddComment`, `paperclipSuggestTasks`, `paperclipAskUserQuestions`, `paperclipRequestConfirmation`, `paperclipCreateApproval`, `paperclipUpsertIssueDocument`, `paperclipControlIssueWorkspaceServices`, etc. This is how a foreign agent reads its task, posts work, requests approval, and logs spend.
- **Cost capture:** each adapter returns `usage` + `costUsd` + `billingType` (api/subscription/credits/…); normalized into `cost_events`, then budget-checked.

### 2.4 Distribution: skills, "agent companies," ClipHub

- **Skills:** Anthropic Agent-Skills-compatible `SKILL.md` (same format Cue and Kortix use). Built-ins: `paperclip` (the control-plane API runbook agents load), `paperclip-board`, `paperclip-create-agent`, `paperclip-converting-plans-to-tasks`, `para-memory-files` (a PARA-method three-layer file memory: knowledge graph + daily notes + tacit `MEMORY.md`, recalled via a `qmd` semantic+BM25 tool).
- **Agent company templates** (`agentcompanies/v1`, the killer concept): a markdown-first package — `COMPANY.md` / `TEAM.md` / `AGENTS.md` / `PROJECT.md` / `TASK.md` / `SKILL.md` + a `.paperclip.yaml` vendor sidecar (adapter config, secret *requirements*, routines) — that packages a **whole functioning org** (org chart + agents + seed projects/tasks + skills). Import instantiates a running company; export scrubs secrets and handles collisions. Bundled teams: core-exec, product-engineering (CTO+coder+QA), product-design, content-machine.
- **ClipHub** (`doc/CLIPHUB.md`): a hosted registry (Hono + Postgres + vector search + GitHub OAuth) to publish/browse/semantic-search company templates; `paperclipai install cliphub:<pub>/<slug>` spins up a company. Index-not-host, like Kortix.
- **Plugins:** a thin-core/rich-edges plugin SDK with UI slots (dashboard widgets, detail tabs, settings pages) and 60+ gated capabilities; sandbox providers (Cloudflare, Novita) ship as plugins.

---

## 3. The market map (why this matters)

Three open-source contenders, three layers of the same stack:

| Layer | Who owns it | The gap |
|---|---|---|
| **The worker** (agent that does the work) | Cue, OpenClaw, Claude Code | Paperclip has none — must BYO |
| **The platform** (hosts/runs agents, connectors, sandboxes) | Kortix | — |
| **The management layer** (org, goals, budgets, approvals, audit) | Paperclip | Cue's is nascent; Kortix's is thinner than Paperclip's |

Cue is the only one sitting on a strong *worker* that could grow up into the *management layer* on top of its own reliable output. Paperclip proves the management layer has huge pull (73k stars) — but its "productivity theater" criticism is a direct consequence of not owning the worker. **We can offer the org-and-governance dream without the unreliable-output punchline.**

---

## 4. Paperclip vs Cue — honest scorecard

**Where Paperclip is ahead (our gaps):**

| Area | Paperclip | Cue today |
|---|---|---|
| Per-agent/scope budget caps w/ hard-stop auto-pause | First-class, with incidents + cost attribution by task/model | Credits at HQ; no per-agent/task hard-stop; runaway history (`[[cue-conversation-runaway]]`) |
| Goal ancestry on every task | Every issue chains to company mission | Projects exist; tasks don't carry goal lineage |
| Atomic task checkout / execution locks | 409-on-conflict, crash-safe lock clearing | Single daemon; no concurrency primitive yet |
| Liveness / watchdog / recovery issues | Silence detection, fingerprinted re-checks, bounded auto-recovery | Known hung-turn + daemon-restart gotchas, handled ad hoc |
| Typed approval gates | hire/code_review/budget_exception/skill_install objects w/ revision flow + audit | Review lane approves work items; not typed/audited objects |
| Org chart / roles / delegation | reportsTo tree, titles, per-role budgets | Single assistant; no org model |
| Immutable audit + tool-call tracing + cost ledger | Centralized, redacted, per-decision | Partial; Guardrails ledger still building |
| Multi-company isolation | One deployment, many isolated companies | HQ is per-customer instance |
| Deployment/reachability model | local_trusted/authenticated + Tailscale bind | Local daemon + cloud; less formalized |
| Company/team templates | Import a whole org in one command | Marketplace ships skills (just built), not orgs |

**Where Cue is ahead (our moat):**

- **We own the worker.** Cue produces reliable, verified output (voice→action, video studio, Create Studio, computer control, real macOS presence). Paperclip's org chart wraps agents whose output people call unreliable.
- **Local-first + personal depth.** Cue lives on the Mac and phone, in the user's files and messages. Paperclip is a server dashboard; "mobile" is a responsive web view.
- **Single-user-to-team gradient that starts useful.** Cue is valuable for one person on day one. Paperclip's whole premise needs you to think like a CEO staffing a company — heavier activation, and the reason skeptics call it theater.
- **We don't need the "zero-human company" claim** that draws Paperclip's harshest criticism.

---

## 5. What to take — prioritized, mapped to our roadmap

Everything here folds into two initiatives we already have open: **Guardrails** (governance/cost/audit) and the **Autonomous-OS direction** (goals→agents→sprints→review). Paperclip gives us a reference implementation for both.

### P0 — Budget policies with hard-stop auto-pause (folds into Guardrails + HQ credits)

The single highest-value lift, and it fixes a real Cue scar (the 45k-conversation / 500MB runaway). Adopt their model almost verbatim:
- A `budget_policies` concept: scope (assistant | project | task | agent-role), window (daily/monthly/lifetime), `warnPercent` (soft notify) + `hardStopEnabled` (pause the scope, cancel queued work). Emit a **BudgetIncident** into the Review lane for a human to resume/raise.
- Attribute every LLM + tool call to a task/project/model as `cost_events` (we already meter OpenRouter at HQ — extend it to per-task attribution and surface it). This is also the data the Guardrails ledger needs.
- Surface a **Costs view** (spend by project/model/day, burn rate, incidents) in Mission Control / HQ.

### P0 — Goal ancestry + typed approval objects (folds into Autonomous-OS + Review lane)

- Give tasks a **goal lineage** field so the agent always receives the "why," not just the title. Cheap, and it measurably improves autonomous execution quality (the thing Paperclip's agents lack).
- Upgrade the **Review lane** from "approve this work item" to **typed approval objects** (`code_change`, `external_send`, `spend_exception`, `new_capability/skill_install`) with a `pending → approved | rejected | changes_requested` flow, linked artifacts, and a timestamped audit entry. This *is* the Guardrails checkpoints surface, given concrete shape.

### P1 — Heartbeat liveness + watchdog + recovery issues (folds into the work loop)

Our `[[cue-work-loop]]` and jobs-worker already do capture→triage→auto-run→review. Add Paperclip's robustness layer:
- **Liveness detection** on background runs (output-silence → suspicious → recovery), so a stuck agent is caught and re-woken instead of hanging (directly targets our hung-turn gotcha).
- A **watchdog** that re-checks a "finished" task tree by fingerprint and only re-acts on genuine change (avoids busy-looping).
- **Recovery items** auto-created with a retry cap, then escalated to the Review lane — no silent stalls, no infinite retries.

### P1 — Org/roles model for the autonomous OS (folds into Autonomous-OS)

When we build agents/sprints, adopt the **named-role + reportsTo + per-role budget** model even for a solo founder: a small roster (e.g. Researcher, Builder, Writer, Ops) each with a scope, a budget, and a reporting line to the human "board." It's the legible structure that makes multi-agent autonomy governable, and it's the UX Paperclip's 73k stars are voting for.

### P1 — Atomic task checkout before parallel agents

Before we ship parallel/sandboxed agents (the Kortix WS7 item), we need the **checkout lock** primitive: single-assignee tasks, atomic claim, conflict-rejection, crash-safe release. Cheap to add now, prevents double-work and lost state later.

### P2 — Agent *company/team* templates (extends the marketplace we just built)

Our new marketplace (Kortix brief WS1) ships skills. Extend the same index to **team/company templates**: a markdown bundle (goals + a roster of role-configured agents + seed projects/tasks + the skills they need) that instantiates a working setup in one click — "Install the SaaS Founder company," "Install the Content Studio team." This is a stronger version of Kortix's importable-project idea and a natural marketplace-2.0.

### P2 — Deployment/reachability polish (fits our local-first story)

Formalize Cue's modes like Paperclip: `local_trusted` (Mac, no login) vs `authenticated` (cloud), with a **Tailscale/tailnet** reachability option so a user can securely reach their own local Cue from their phone. Cue's local daemon + iOS app map onto this perfectly and it strengthens the "own your stack" pitch.

### Adopt internally (cheap wins)

- **`para-memory-files` pattern**: their three-layer file memory (entity knowledge-graph + daily notes + tacit `MEMORY.md`) with a `qmd` semantic+BM25 recall tool is a clean model worth comparing against our memory-v2 extraction pipeline.
- **Low-trust preset** as the shape for Guardrails' "untrusted input" mode (force sandbox + secret/tool whitelist + output quarantine) when Cue eventually handles inbound external content/PRs.
- **Cost attribution `billingCode`** so delegated sub-work bills back to the requesting task — useful once we have multi-agent delegation.

### Don't copy

- **BYO-agent as the core model.** Cue's edge is its own agent; adapters for external coding CLIs (Claude Code/Codex as heavy-lifting "workers" Cue dispatches under budget+review) are a *P2 option*, not the foundation. Don't invert into a runtime-agnostic shell and lose the worker advantage.
- **The 97-table Linear clone.** Adopt the *primitives* (goals, task ancestry, budgets, approvals, checkout) incrementally on our existing schema; don't rebuild Linear.
- **The "zero-human company" narrative.** It's what earns Paperclip the "productivity theater" reviews. Cue's honest frame — "an assistant that does real, verified work and governs its own spend and actions" — is more credible and more defensible.
- **Hard AWS Secrets Manager dependency.** We have Guardian/CES; keep it, borrow only the never-in-DB / redacted-everywhere / resolved-at-runtime discipline.

---

## 6. Strategic takeaway

Paperclip validated, with 73k stars in four months, that the **management layer for AI agents** is a category people want — org, goals, budgets, approvals, audit. It also demonstrated the trap: without owning the worker, the beautiful org chart wraps unreliable output and gets called theater.

Cue's move is to build that same governance-and-org layer **on top of its own reliable agent**, incrementally, through the two initiatives already in flight (Guardrails for the control primitives, Autonomous-OS for goals/roles/sprints). Do that and Cue is the only product that is simultaneously the employee *and* the company — the reliable worker Paperclip has to borrow, wrapped in the governance Paperclip proved everyone wants. Start with budget hard-stops and typed approvals (P0): they're small, they fix a real Cue scar, and they're the foundation everything else in the autonomous-OS direction stands on.

---

## Appendix: key file references (their repo)

- Data model / execution semantics: `packages/db/src/schema/` (97 tables), `doc/SPEC.md`, `doc/execution-semantics.md`, `doc/TASK-WATCHDOG.md`
- Budgets / cost: `server/src/services/budgets.ts`, `server/src/services/costs.ts`, `packages/db/src/schema/{budget_policies,cost_events}.ts`
- Governance / trust: `packages/shared/src/trust-policy.ts`, `server/src/services/{trust-preset-resolver,low-trust-runtime-containment,approvals}.ts`, `doc/LOW-TRUST-PRESETS.md`, `doc/UNTRUSTED-PR-REVIEW.md`, `doc/SECRETS-AWS-PROVIDER.md`
- Adapters / BYO-agent: `packages/adapter-utils/src/types.ts`, `server/src/adapters/`, `tools/agent-shim/main.go`, `packages/mcp-server/src/tools.ts`, `doc/{HERMES,OPENCLAW}_*.md`, `adapter-plugin.md`
- Company templates / distribution: `packages/teams-catalog/`, `packages/skills-catalog/`, `docs/companies/companies-spec.md`, `doc/CLIPHUB.md`, `server/src/services/company-portability.ts`
- UI: `ui/src/pages/` (~110 pages — Dashboard, OrgChart, Costs, Approvals, Agents, Routines, Secrets, ActiveAgentsPanel), `DESIGN.md`
- Product framing: `README.md`, `doc/GOAL.md`, `doc/PRODUCT.md`, `ROADMAP.md`, `doc/DEPLOYMENT-MODES.md`
