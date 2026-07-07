# Kortix (Suna) — Competitive Analysis & What Cue Should Take From It

**Date:** 2026-07-07
**Sources:** full read of github.com/kortix-ai/suna @ v0.9.98 (215MB monorepo, ~5,150 files), kortix.com public pages, press/community coverage.

---

## 1. Executive summary

Kortix (formerly Suna, the April-2025 "open-source Manus") has pivoted into almost exactly Cue's territory: **an autonomous company OS** — agents + skills + connectors + triggers + memory in one command center, delivered via web/mobile/desktop/CLI/Slack. They are ~9–10 people (Lisbon → SF), ~20k GitHub stars, thin funding (~$3M valuation per third-party estimators, ~$990K est. revenue), $40/seat + pooled credits, Elastic License 2.0 open-core.

Three things stand out and are worth taking seriously:

1. **The marketplace is an indexing trick, not a content moat.** The "7,013 skills" is 87 official Kortix skills + ~70 third-party GitHub repos ingested as "sources." Any public repo of SKILL.md files is a registry with zero ceremony. This is cheap to replicate and Cue is unusually well positioned to do it (our skills are already SKILL.md-shaped).
2. **"A company is a git repository."** Every project *is* a repo: agents, skills, memory, triggers, config as files. Every session boots an isolated microVM sandbox on its own git branch; work merges back to `main` only via human-reviewed change requests. This gives them versioning, rollback, auditability, parallelism (50 agents = 50 branches), and a credible enterprise story in one move.
3. **They out-execute on packaging, not on intelligence.** Onboarding wizard, Slack-first channels, starter chips, project build-out tiles, referral loop, white-label seam, SOC2-grade CI — the agent itself is a fairly standard OpenCode loop. The gap between them and Cue is mostly productization, and it's closable.

Their weaknesses: cloud pricing complaints ("too expensive," tasks failing after consuming credits), self-host is genuinely hard (3+ hours, many keys), marketplace quality is uneven (aggregated prompt-markdown of wildly varying quality), tiny team spread across an enormous surface (web+mobile+desktop+CLI+whitelabel+enterprise), and a positioning that has changed three times in 15 months.

---

## 2. What they built (facts)

### 2.1 Architecture

- **Stack:** Hono + Bun API, Next.js 15/React 19 web, Drizzle/Postgres (Supabase auth), pnpm monorepo, one `@kortix/sdk` that web/mobile/whitelabel all consume as thin shells.
- **Session model:** every session provisions a **microVM sandbox** (Daytona, or their own "Platinum" compute — pluggable `SandboxProvider` interface). The sandbox boots `kortix-sandbox-agent-server`, which clones the project repo, cuts a session-named branch, and starts the **OpenCode** agent runtime inside. Clients reach the agent through an API reverse proxy (`/v1/p/{sandboxId}/{port}/…`), SSE for turns, WebSocket for terminal PTY. Idle sandboxes auto-stop at 15 min.
- **Change requests:** the agent commits on its branch; durable work reaches `main` only through a reviewed CR. Rollback = `git revert`. Memory (`.kortix/memory/*.md`), agent personas, skills, triggers — all files in the repo, all diffable.
- **Executor gateway (their connector layer):** agent-side MCP tools (`connectors / discover / describe / call / connect`) hit `/v1/executor/call` on the API, which resolves credentials **server-side** (scoped per user/group), calls upstream (Pipedream for 3,000+ OAuth apps, plus MCP / OpenAPI / GraphQL / raw HTTP connector types), and writes an audit event. **Raw tokens never enter the sandbox** — one scoped session token per run.
- **LLM gateway:** pluggable transports (Bedrock for Claude, OpenRouter for the rest), tier-based auto-selection (flagship/balanced/fast), circuit breakers + fallback chains, managed models billed as credits with markup, or BYOK — including **piggybacking the user's existing ChatGPT/Claude subscription**.
- **Channels:** Slack is first-class — "Add to Slack" OAuth install, @mention → session in the bound project, results back in-thread, slash commands (`/kortix switch|agent|model|policy|sessions`), per-channel agent/model bindings, plus a BYO-Slack-app path. Teams/Telegram/email/SMS are in the connector taxonomy.
- **Triggers:** cron + signed webhooks, scheduled by a leader-elected worker; a trigger spawns a fresh session with an initial prompt.

### 2.2 The marketplace (the part you asked about)

The engine is `packages/registry` — "a shadcn-compatible registry format plus the primitives to turn any Kortix repo into a registry."

- **Item types:** one format covers `registry:skill|agent|command|tool|trigger|connector|memory|bundle|project` — skills, whole agents, and whole importable projects use the same install machinery.
- **Sources:** a source is any GitHub repo (or URL/local path) with either an explicit `registry.json` or just SKILL.md files (auto-discovered via `buildRegistry()`). Users click "Add source" with a repo address; the API indexes it (24h TTL cache, progressive per-source resolution so the UI streams results).
- **The 7,013 number:** 87 official Kortix skills (baked into the starter, no network needed) + 2 default Anthropic sources + ~70 "featured" community repos — davila7/claude-code-templates (871), ComposioHQ/awesome-claude-skills (864), alirezarezvani/claude-skills (767), github/awesome-copilot (526), anthropics/knowledge-work-plugins (212), vendor repos from Google/HuggingFace/Stripe/Supabase/Cloudflare, etc. **They host nothing** — Kortix stores an index + checksums; files live in the authors' repos.
- **Install:** plans transitive deps, shows a **capability manifest** (declared secrets, connectors, network egress domains, tools, write targets) for consent, then atomically commits the files + `registry-lock.json` into the project repo (`feat(marketplace): add <Title>`). Lock pins source + git ref + per-file content hash; `updates` diffs installed hashes vs. source; updates are explicit, never silent.
- **Trust model (partly roadmap):** tiers — your repo (no review) → company registry (org policy) → community (automated gates + 72h cooldown) → verified (signed, spot-checked). Static gates (secret scanning, capability-honesty diffing, dangerous-pattern scan) are P2 roadmap, i.e. **not built yet**.
- **Runtime:** installed skills land in `.kortix/opencode/skills/`; symlinks make the same directory readable by OpenCode, Claude Code (`.claude`), and Codex (`.agents`). Skill bodies load progressively into the agent's context.

### 2.3 Onboarding & growth

- **Setup wizard** (post-signup modal, progress dots): welcome → choose how to pay for inference (ChatGPT subscription / BYOK / Kortix credits) → OAuth-connect providers → auto-topup config → default model picker → tool API keys (Tavily, Firecrawl, Serper, Replicate, Context7, ElevenLabs — "included with Kortix credits" on cloud) → launch an onboarding chat.
- **Connect-your-tools step:** searchable 3,000+ app grid (Easy connect via Pipedream OAuth / Custom for MCP/OpenAPI/HTTP), "Connect a few now, or skip and add them anytime."
- **Project home:** "Give *X* something to do" + composer + 6 starter chips (Onboard your agent / Build a landing page / Research competitors / Create a pitch deck / Draft a contract / Analyze a spreadsheet) + build-out tiles with live counts (Integrations · Scheduled tasks · Skills 68 · Slack · Your team · Agent).
- **Growth loops:** referral codes with credit rewards + caps; public template pages (`/templates/[shareId]`) with OG tags, download counts, and listed integration requirements; Slack install as viral wedge.
- **White-label:** `apps/whitelabel-demo` — a one-file brand seam (name/tagline/accent/apiUrl) + optional BFF proxy mode where the partner's backend holds the Kortix API key. Explicitly aimed at agencies ("a franchise for the part of the economy that's about to get rebuilt" — MANIFESTO).

### 2.4 Ops maturity

37 DB migrations, 25+ GitHub Actions workflows (blue/green EKS deploy with gates, QA nightly, DB drift, CodeQL, secret scan, Drata SOC2 evidence), EKS prod + warm-standby ECS Fargate failover behind a Cloudflare Worker, Better Stack logs/traces, Sentry, PostHog, chaos tests (Toxiproxy/Pumba), pentest/mutation/visual/a11y suites, enterprise entitlements (SSO/SCIM/RBAC/audit-export) gated by `requireEntitlement()` with an unlockable demo mode. Their AGENTS.md enforces a "verify end-to-end with real surfaces, no mocks" standard and dotenvx-encrypted secrets committed to git.

---

## 3. Kortix vs Cue — honest scorecard

**Where they're ahead:**

| Area | Them | Us |
|---|---|---|
| Skill distribution | Open ingestion marketplace, 7k+ indexed, lock-file pinning, capability consent | ~dozens of seeded/bundled skills, no marketplace, no third-party ingestion |
| Config as code | Whole project is a git repo; CR review flow; rollback | assistant.db-centric state; Review lane exists but not diff/git-native |
| Parallel agents | N sessions = N isolated sandboxes on N branches | One long-lived daemon per customer; parallelism is a north-star (autonomous OS direction), not shipped |
| Connector breadth | 3,000+ via Pipedream + MCP/OpenAPI/GraphQL/HTTP behind one audited gateway token | Composio proxy (good!) but narrower surface, no unified discover/describe/call + audit layer |
| Channels | Slack first-class (@mention→session, slash commands, per-channel bindings) | No shipped Slack story |
| Onboarding | Polished wizard incl. "pay with your existing ChatGPT/Claude subscription" | HQ orientation gating is new; no connect-tools step, no BYO-subscription |
| Growth loops | Referrals, shareable template pages w/ OG/SEO, white-label seam | None shipped |
| Enterprise/ops | SSO/SCIM/RBAC entitlements, SOC2 pipeline, chaos/pentest CI | Early; Guardrails initiative in flight |

**Where Cue is ahead or differentiated:**

- **Local-first hybrid:** Cue lives on the customer's Mac (fast local daemon, computer control, files, iMessage-adjacent presence) *and* in the cloud. Kortix is cloud-sandbox-only; their "computer" connector is a paid reverse tunnel bolt-on.
- **Personal/SMB depth vs. company-repo abstraction:** voice magic (talk→thread→action items), video studio, Create Studio brand kits, Mission Control's real-time five-lane activity OS, memory extraction pipeline. Kortix's memory is "markdown files the agent reads on demand" — honest but shallow.
- **Unit economics:** we've already done the Fly Machines ~$2/customer work; their users complain the cloud is expensive and self-host is painful. Cue can win on "actually affordable."
- **Focus:** they're 10 people maintaining 6 apps + enterprise + a compute platform (Platinum.dev). Surface-area risk is real; several pillars (trust gates, company registries, marketplace P2–P5) are roadmap, not reality.

---

## 4. What to take — prioritized

### P0 — Skill marketplace via open ingestion (highest leverage, ~1–2 sprints)

Cue already treats skills as markdown with descriptions (skill_load). Copy the index-not-host model:

1. **Source ingestion:** "Add source" = any public GitHub repo; auto-discover SKILL.md files (Anthropic's format — the same one the community repos use). Index name/description/categories/files into the daemon or HQ; 24h cache.
2. **Lock + pinning:** per-project `skills-lock.json` with source, ref, per-file content hash; explicit diff-and-confirm updates. (Steal their schema outright — it's good.)
3. **Seed the catalog** with the same public repos they feature (anthropics/skills, knowledge-work-plugins, davila7, ComposioHQ, awesome-copilot…). That's a 5,000+ skill catalog on day one for the cost of an indexer. Check licenses per repo before featuring.
4. **Marketplace UI:** Explore / Sources / Installed tabs — reuse the template-library dashboard patterns we already built.
5. **Capability manifest + consent at install** (declared secrets, connectors, network, write targets) — this is *literally the Guardrails initiative's* rules surface applied to skills, and we can ship it before they do (theirs is roadmap).

Why this matters: it converts Cue's skill system from "what we ship" to "everything the ecosystem ships," and the Claude-skills ecosystem is compounding weekly.

### P0 — Onboarding: connect-tools + starter economics (~1 sprint)

- Add a **"Connect your tools"** wizard step backed by the Composio catalog (searchable grid, Easy/Custom tabs, skip-friendly copy: "Connect a few now, or add them anytime").
- Add **"bring your own key / subscription"** as a first-class onboarding choice next to Cue credits. Their ChatGPT/Claude-subscription piggyback removes the single biggest objection ("another AI subscription?") — investigate feasibility for Claude subscription via OAuth; BYO OpenRouter key is trivial for us today.
- **Project build-out tiles with live counts** (Integrations n · Scheduled tasks n · Skills n · Team · Agent) on the cowork Projects home — cheap, and it converts an empty screen into a checklist.

### P1 — Slack channel (~1–2 sprints)

"Add to Slack" → @mention spawns a thread against the customer's Cue instance, results return in-thread; slash commands for project/agent selection. For Cue's SMB/founder ICP this is the distribution wedge: every teammate who sees the bot answer in-channel is a lead. HQ already mints daemon-compatible tokens — the bridge is a Slack event router service.

### P1 — Config-as-code export + reviewed changes (foundation for the autonomous OS)

Don't rebuild Cue around git overnight, but adopt the principle:

- Materialize each customer's **skills, agent personas, triggers, and memory as files in a per-customer git repo** (HQ-side bare repo is fine). Every mutation = a commit. Gives us diff, rollback, audit, and portability ("your Cue is yours — clone it") — a marketing and enterprise weapon they've validated.
- Extend the existing **Review lane** to show diffs of config/memory changes with approve/revert. That's 80% of their change-request story without per-session branching.

### P1 — Growth loops (~1 sprint, mostly product surface)

- **Referral codes** with credit rewards + cap (they have the exact schema: code, validate-on-signup, credits-on-first-paid-action).
- **Shareable template/skill pages** with OG tags and "requires these integrations" — SEO surface + viral loop, and it composes with the marketplace above.

### P2 — Session sandboxes for parallel agents

When the autonomous-OS work lands agents/sprints, adopt **sandbox-per-task on Fly Machines** (our InstanceDriver abstraction is exactly their `SandboxProvider` seam) with task-scoped branches in the customer repo. This is the "run 50 agents that can't corrupt shared state" unlock; Fly's per-second billing matches their ~$0.10/hr metered-compute model at better economics.

### P2 — Executor-style unified connector gateway

Evolve the Composio proxy toward their shape: agent sees generic `discover/describe/call` tools; the server resolves credentials, enforces per-user scoping, and writes an **audit event per call** (feeds Guardrails ledger). Add connector types beyond Composio: raw MCP, OpenAPI-from-spec, raw HTTP with auth templates.

### Adopt internally (engineering practice, ~free)

- Their **AGENTS.md verification standard** ("you CAN run everything end-to-end — real HTTP, real UI, real CLI; no unverified handbacks") — adapt for the Cue repo.
- **dotenvx-encrypted env files committed to git** — would end our recurring lost-key problems (OpenRouter/Replicate keys).
- **One repo version, everything releases together**; route-manifest-driven E2E coverage gate (their ke2e) as the model for prod-smoke's evolution.

### Skip / don't copy

- **Platinum.dev-style compute platform** — building a Daytona competitor at our stage is a distraction; Fly is fine.
- **Six client apps at once** — their thin-SDK discipline is admirable, but we should not match their surface area; macOS + web + iOS is already a lot.
- **Elastic License switch** — no need to change licensing posture now.
- **Per-session git branches everywhere immediately** — adopt config-as-code first; full branch-per-session is P2+ and only pays off with true parallel agents.

---

## 5. Positioning takeaway

Kortix's story converged on **"own your AI company: everything is code, everything is reviewed, run it anywhere."** It's a strong enterprise/developer story and it's working (20k stars) despite modest revenue. Cue's defensible counter is the layer they can't reach from a cloud sandbox: **the agent that lives where you actually work** — on your Mac, in your files, on your phone, with your voice — with the same own-your-data credibility (self-host lineage, Fly single-tenant) at a materially lower price. The marketplace and channels work above closes their packaging lead; the local+personal depth is the moat they'd have to rebuild from scratch.

---

## 6. Addendum (2026-07-07): Pipedream and the bundled tool APIs

**Pipedream — hold, don't adopt yet.** Verified numbers: Pipedream ≈ 3,000+ apps / 10,000+ tools; Composio ≈ 1,000+ toolkits / 20,000+ tools. The raw app-count gap is real but smaller than it looks — Composio's coverage is deeper per app and agent-optimized, and most of Pipedream's long tail is apps our ICP never touches. The decisive fact: **Workday acquired Pipedream (closed Dec 2025)**. Kortix bet on Pipedream *before* that; a startup building on it *now* takes on enterprise-owner risk (pricing, self-serve access, roadmap reprioritization toward Workday's agent ecosystem). Recommendation: keep Composio as the primary broker; close gaps with the P2 executor-gateway connector types (raw MCP, OpenAPI-from-spec, raw HTTP) which cover any API without a broker; revisit Pipedream Connect only if a concrete gap list (apps requested by users that Composio + MCP can't serve) justifies a second broker.

**Bundled tool APIs — yes, adopt the model.** The thing to copy from Kortix is less the specific vendors than the delivery: platform-held keys, routed server-side, **included in cloud credits** (metered), BYO-key on self-host. This directly raises output quality for chat/research/creation with near-zero UX cost. Priority for Cue:

| Tool | What it adds | Priority |
|---|---|---|
| Firecrawl | Any URL/site → clean markdown (scrape + crawl). Biggest uplift to research/competitive outputs. | P0 |
| Tavily | Research-grade web search with citations. | P0 (or keep current search if parity) |
| Serper | Cheap Google SERP + image search (~$0.3–1/1k). | P0 alongside Tavily |
| ElevenLabs | TTS/voices — video-studio voiceovers, spoken replies. | P1, composes with video-studio |
| Replicate | Image/video gen. **Already integrated direct in Cue.** | Done ✓ |
| Context7 | Up-to-date library docs for codegen — app-builder quality. | P2 |

Wire these as brain tools behind an HQ metering layer (same credit ledger as LLM usage), not as per-user signups — six API-key signup walls is exactly the onboarding friction Kortix's cloud tier removes.

---

## Appendix: key file references (their repo)

- Marketplace engine: `packages/registry/` (`schema.ts`, `build.ts`, `install.ts`, `lock.ts`), philosophy in `packages/registry/MARKETPLACE.md`
- Catalog + 70 featured sources: `apps/api/src/marketplace/catalog.ts`; install: `apps/api/src/marketplace/install-service.ts`
- Sandbox daemon: `apps/kortix-sandbox-agent-server/src/main.ts`; providers: `apps/api/src/platform/providers/`
- Executor gateway: `apps/api/src/executor/`, `packages/executor-sdk/`
- LLM gateway: `packages/llm-gateway/`, catalog `packages/llm-catalog/`
- Slack channel: `apps/api/src/channels/slack/` (routes, commands, dispatch)
- Onboarding wizard: `apps/web/src/components/onboarding/setup-wizard.tsx`; starter chips: `apps/web/src/lib/starter-prompts.ts`; project tiles: `apps/web/src/features/workspace/project-layout/project-home.tsx`
- Referrals: `apps/web/src/lib/api/referrals.ts`; white-label seam: `apps/whitelabel-demo/src/config/brand.ts`
- Manifesto (worth reading in full): `MANIFESTO.md`; dev standard: `AGENTS.md`
