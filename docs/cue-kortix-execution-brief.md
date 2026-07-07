# Execution Brief: Kortix-Inspired Platform Upgrades for Cue

**Date:** 2026-07-07 · **Prepared for:** a fresh build thread on the Cue repo
**Companion docs:** `docs/kortix-suna-competitive-analysis.md` (full research), `docs/kortix-suna-competitive-analysis.md` §6 (Pipedream/tool-API addendum)
**Prime directive:** every change is **additive and feature-flagged**. Nothing here may alter existing skill loading, Composio routing, conversation flow, or provisioning behavior for current customers. Enhance, never break.

---

## 1. The originating ask (verbatim intent from the founder)

> Review https://github.com/kortix-ai/suna — it's doing a lot of what we're doing with a strong offering, platform, and onboarding. They launched kortix.com/marketplace connecting their own skills plus 7,000+ from third-party providers. Read their code and functionality, find what we can learn from, improve on, and copy to make Cue more world-class.

Follow-up decisions made in the research thread:

1. **Agreed** to the full recommendation set below (marketplace, onboarding, tools, Slack, config-as-code, growth loops).
2. **Pipedream:** considered as a second connector broker (3,000+ apps) — **decided NO for now**. Workday acquired Pipedream (closed Dec 2025); platform risk. Stay Composio-primary, fill gaps with MCP/OpenAPI/raw-HTTP later. Revisit only with a concrete user-requested gap list.
3. **Tool APIs (Tavily, Firecrawl, Serper, Replicate, Context7, ElevenLabs):** **decided YES** — copy Kortix's *delivery model*: platform-held keys, routed server-side through the daemon, metered against Cue credits on cloud, BYO-key on self-host. Replicate is already integrated direct; do not touch it.

## 2. Research summary (what Kortix built — the parts we're adopting)

- **Marketplace = index-not-host.** `packages/registry` in their repo is a shadcn-style registry format. Any public GitHub repo containing SKILL.md files is ingestible as a "source" with zero ceremony. Their 7,013 skills = 87 official + ~70 community repos (davila7/claude-code-templates 871, ComposioHQ/awesome-claude-skills 864, alirezarezvani/claude-skills 767, anthropics/skills + knowledge-work-plugins, vendor repos from Google/Stripe/Supabase/Cloudflare…). Install = write files + a lock entry (`source`, `sourceType`, `skillPath`/git ref, `computedHash` per file). Updates re-resolve and show a diff; never silent. Capability manifests (declared secrets/connectors/network/writes) with install-time consent are their design but **still roadmap on their side** — we can ship it first.
- **Bundled tool keys.** Their cloud tier includes Tavily (search), Firecrawl (scrape/crawl→markdown), Serper (SERP+images), Replicate, Context7 (library docs), ElevenLabs (TTS) — platform keys, credit-billed, so output quality is high on turn one with zero signup walls.
- **Onboarding.** Post-signup wizard: pay-with-what-you-have (ChatGPT/Claude subscription / BYOK / credits) → connect tools (searchable 3,000+ grid, all skippable) → default model → tool keys → first chat. Project home shows build-out tiles with live counts (Integrations n · Scheduled tasks n · Skills n · Team · Agent) plus 6 starter chips.
- **Slack channel.** "Add to Slack" → @mention spawns an agent session bound to a project, results return in-thread; slash commands select project/agent/model.
- **Everything-as-code.** Project config (agents, skills, memory, triggers) are files in a git repo; changes merge via reviewed change requests. We adopt the principle incrementally (export + diff review), not the full branch-per-session architecture.
- **Growth.** Referral codes (credits on friend's first paid action, capped), shareable template pages with OG tags and "requires these integrations."

## 3. Workstreams

Build in this order. WS1–WS3 are P0. WS4–WS6 are P1. WS7 is P2 design-first — do not start it without a design doc reviewed by Manav.

---

### WS1 — Skill Marketplace with open GitHub ingestion (P0)

**Goal:** Cue users can browse/search a catalog of thousands of skills aggregated from GitHub "sources," install into their assistant with hash-pinned locking and capability consent, and add any public SKILL.md repo as a custom source.

**Existing machinery to build ON (do not replace):**
- Skill sources today: bundled (`assistant/src/config/bundled-skills/{name}/`), managed (`$VELLUM_WORKSPACE_DIR/skills/{id}/SKILL.md`, installed by `autoInstallFromCatalog()` in `assistant/src/skills/catalog-install.ts`), workspace, plugin.
- Catalog: `skills/catalog.json` at repo root (~71 skills), read by `loadSkillCatalog()` in `assistant/src/config/skills.ts`.
- Loading: `skill_load` tool in `assistant/src/tools/skills/load.ts` → `loadSkillBySelector()`. **Its semantics (includes resolution, tool projection via `<loaded_skill>` tags, TOOLS.json formatting) must not change.**

**Build:**
1. **Source registry (daemon):** new module `assistant/src/skills/marketplace/` with a `sources.json` in the workspace dir (`{ address, kind: "github", ref?, label?, enabled }[]`). Indexer fetches a repo tree via the GitHub API (unauthenticated w/ etag caching; optional token from config), finds `**/SKILL.md`, parses frontmatter (name/description) — reuse the existing frontmatter parser used by `loadSkillBySelector`, do not write a second one. Cache index per source with 24h TTL under `$VELLUM_WORKSPACE_DIR/marketplace-cache/`.
2. **Install path:** installing a marketplace skill writes into the **existing managed dir** (`skills/{id}/SKILL.md` + any sibling files under the skill's folder in the source repo) so `skill_load` picks it up with zero changes. Namespace ids as `{owner}--{repo}--{skillName}` to avoid collisions with catalog ids; the display name stays clean.
3. **Lock file:** `$VELLUM_WORKSPACE_DIR/skills-lock.json` — per installed item: `{ source, sourceType: "github", ref, skillPath, computedHash (sha256 per file), installedAt }`. Adopt Kortix's schema (see analysis doc §2.2). `updates` check = re-fetch, compare hashes, present diff; apply only on explicit confirm.
4. **Capability manifest + consent:** parse optional frontmatter keys (`secrets:`, `connectors:`, `network:`, `writes:`) if present; ALWAYS show an install confirmation card listing whatever is declared (or "no declared capabilities — third-party skill, review before use" when absent). Record consent in the lock entry. Skills with a `tools/` dir or executable content from third-party sources are **v1 out of scope: install SKILL.md + markdown/text assets only; skip and disclose anything executable.** This is the safety boundary — do not relax it in this pass.
5. **Daemon API:** new routes (follow existing route conventions in the daemon's HTTP layer): `GET /v1/assistants/{id}/marketplace/items?query=&source=`, `GET .../items/{id}` (detail + file preview), `GET/POST/DELETE .../marketplace/sources`, `POST .../marketplace/install`, `GET .../marketplace/installed`, `GET .../marketplace/updates`, `POST .../marketplace/update`.
6. **Web UI:** new page `apps/web/src/pages/marketplace/` — three tabs: **Explore** (search grid, per-source filter chips, streaming per-source load), **Sources** (list + Add source + Browse + remove), **Installed** (with update badges). Match the HQ kit styling used by `apps/web/src/pages/projects/projects-page.tsx` (serif display, mono microlabels). Link it from the command-center rail next to Skills.
7. **Seed sources (ship enabled-by-default, order matters):** `anthropics/skills`, `anthropics/knowledge-work-plugins`, `ComposioHQ/awesome-claude-skills`, `davila7/claude-code-templates`, `alirezarezvani/claude-skills`, `github/awesome-copilot`, `obra/superpowers`, plus a "Cue official" source pointing at our own `skills/catalog.json` entries. **Check each repo's license before featuring; drop any without a permissive license.**

**Non-regression rules:** `skills/catalog.json` flow untouched (marketplace is a parallel acquisition path into the same managed dir); `skill_load`, includes, and bundled-tool-registry generation untouched; no new deps in the skill-load hot path (indexing is lazy/on-demand); everything behind a `marketplace` feature flag in `assistant/src/config/schemas/skills.ts` default ON for dev, and verify OFF state renders no UI and registers no routes' side effects.

---

### WS2 — Bundled tool APIs: Firecrawl, Tavily, Serper (+ ElevenLabs P1, Context7 P2)

**Goal:** research/creation output quality jumps because the brain has first-class scrape/search/SERP tools with platform keys on cloud and BYO keys on self-host. **Replicate already exists — leave `assistant/src/config/bundled-skills/replicate/` alone.**

**Build:**
1. **Three new bundled skills** following the exact replicate pattern (`bundled-skills/{name}/SKILL.md` + `TOOLS.json` + `tools/*.ts`, then regenerate via `bun run assistant/scripts/generate-bundled-tool-registry.ts` — contract in `assistant/src/config/bundled-skills/AGENTS.md`):
   - `web-research`: `tavily_search` (query → cited results), `serper_search` (SERP), `serper_images`.
   - `web-scrape`: `firecrawl_scrape` (URL → markdown), `firecrawl_crawl` (bounded: maxPages ≤ 20, depth ≤ 2 — hard caps in the executor, not just the prompt).
   - (P1) `voice-synth`: `elevenlabs_tts` — output files land in the workspace like video-studio outputs; compose with the existing video-studio skill for voiceovers.
2. **Key resolution order** (implement once, in a shared helper in the new skills' tools): daemon config (`assistant.json` → new optional `toolApis: { tavilyKey?, firecrawlKey?, serperKey?, elevenlabsKey? }` in `assistant/src/config/schemas/`) → env var (`CUE_TAVILY_API_KEY` etc.). Tools make **direct HTTPS calls from the daemon process** exactly like `replicate-run.ts`. **Never add these keys to `SAFE_ENV_VARS` in `assistant/src/tools/terminal/safe-env.ts`** — they must not reach bash/child processes.
3. **HQ provisioning:** add the four env vars to `InstanceSpec` (`hq/src/providers/driver.ts`) and `buildInstanceEnv()` (`hq/src/secrets.ts`); platform master keys live in HQ's env; declare in `render.yaml` (and the fly config when the cutover lands). Existing instances: additive env update via driver `update()` on next deploy — do not force-restart fleets for this.
4. **Metering:** record per-call usage events through the same path that records LLM/credit usage (`hq/src/credits.ts` ledger — investigate the exact event write used for OpenRouter usage and mirror it; if per-call server-side metering isn't reachable from the daemon today, log usage locally and batch-report through the existing telemetry/event channel; do NOT invent a new billing pipeline in this pass).
5. **Brain awareness:** the skills' frontmatter descriptions must name their surface clearly (lesson from the surface-routing bug: the brain only routes to what descriptions name). E.g. web-research description: "Search the live web (Tavily/Serper) for current information, news, prices, and images. Load whenever the user asks about anything current or external."

**Non-regression rules:** if no key resolves, tools return a clean, actionable error ("Tavily key not configured — add it in Settings or set CUE_TAVILY_API_KEY") rather than throwing; skill descriptions must not overlap/steal routing from existing skills (check against `web_fetch` usage — scrape complements it, doesn't replace it); zero changes to existing bundled skills; bundled-tool-registry regeneration must produce a diff containing ONLY the new entries.

---

### WS3 — Onboarding: Connect-your-tools step + BYO-key choice + build-out tiles (P0)

**Existing flow to extend (do not restructure):** 5-step HQ setup wizard in `apps/web/src/pages/hq-onboarding/setup-page.tsx` (fork → name → connect → brand/direction → mission/team), progress in `setup-state.ts` (`cue:hq-setup-progress` localStorage), data hooks in `use-setup-data.ts`, gating in `apps/web/src/domains/onboarding/gate.ts`.

**Build:**
1. **Upgrade the existing "connect" step** (don't add a new one): searchable grid of Composio-connectable apps (fetch the toolkit list from Composio's API server-side and cache; fall back to a static curated list of ~30 top apps if the API is unavailable), Easy connect (Composio OAuth via the existing `composio-oauth.ts` path) / Custom tabs, every card skippable, footer copy: "Connect a few now, or skip and add them anytime."
2. **New optional step "How Cue thinks"** between name and connect: three cards — **Cue credits (default, recommended)** / **Bring your own OpenRouter key** / (visual placeholder, disabled: "Use your Claude subscription — coming soon"). BYO key: input → validate with a cheap models-list call → store via daemon config (`assistant.json` llm schema already supports key/model override — wire to the existing `CUE_OPENROUTER_MODEL`/key override path from commit 5dcc0ba242's mechanism; do not build a second LLM-config path). Update `markStep()` step count consistently — the Home setup meter reads N-of-total from `useSetupProgress()`.
3. **Build-out tiles** on the command center (`apps/web/src/pages/command-center/command-center-page.tsx`): a compact tile row with live counts — Integrations (from connectors state) · Scheduled tasks (existing schedules count) · Skills (installed managed+marketplace count) · Team/Channels · Marketplace. Each deep-links to its surface. Render only when HQ setup is complete (don't fight the setup meter for attention).

**Non-regression rules:** the wizard must remain fully skippable end-to-end (current behavior); localStorage schema changes must be backward-readable (users mid-onboarding on the old step list must not get re-gated — version the progress key if needed); no changes to `gate.ts` semantics beyond reading the new step; mobile welcome screen (recently fixed — commit 869f159673) must be visually verified after any shared-component change.

---

### WS4 — Slack channel bot (P1)

**Goal:** "Add to Slack" per customer instance; @mention → new conversation on their daemon; replies stream back in-thread.

**Build sketch:** a small Slack event router — recommend as a new HQ-adjacent service (`hq/src/channels/slack/` or standalone `channels/` workspace) since it needs a public webhook URL and HQ already knows customer↔instance mapping and mints daemon-compatible actor tokens (`mintActorToken()` in `hq/src/secrets.ts`). Slack app (org-level, one app, multi-workspace OAuth): events `app_mention`, `message.im`; store team→customer binding at install (HQ DB, new table via additive migration). On mention: resolve customer instance URL → `POST /v1/assistants/{id}/conversations` with the message text + a `channel: slack` metadata tag → poll/stream result → post reply in thread. Slash command `/cue` with `status | new | help` only in v1. Signature verification mandatory; dedupe on `event_id`.

**Non-regression rules:** zero daemon changes required in v1 beyond (if needed) a metadata field on conversation-create — if that field doesn't exist, add it as optional. All Slack state lives HQ-side. Feature-flag per customer (HQ instance row), default OFF until QA'd.

---

### WS5 — Config-as-code export + Review-lane diffs (P1)

**Goal:** every customer's durable config (installed skills list + lock, assistant.json sans secrets, personas/company profile, schedules/triggers, memory files) is materialized as files and committed to a per-customer git history; config-changing events surface as diffs in the Review lane.

**Build sketch:** daemon-side exporter (`assistant/src/config-repo/`): serialize the config surface to a deterministic file tree under `$VELLUM_WORKSPACE_DIR/config-repo/`, commit with a message naming the actor+cause after each mutating event (skill install, schedule change, profile edit, memory-file write). Local git only in v1 (bare repo in workspace; HQ push is v2). **Redaction is the critical requirement:** keys/tokens/credentials must never be written — reuse the safe-env allowlist mindset; write a redaction test that greps the exported tree for known secret patterns and the actual configured key values. Review lane: emit a work item in `awaiting_review` for config changes made autonomously (not user-clicked), with `output.highlights` = the diff summary — this rides the existing work-items pipeline (`assistant/src/memory/jobs-worker.ts` schema + `apps/web/src/domains/activity/sections/awaiting-review-section.tsx`) with **no schema changes**; approve = no-op ack, redo = revert commit.

**Non-regression rules:** exporter is observe-only (never the source of truth in v1 — assistant.json/DB remain canonical); failures must be swallowed-and-logged, never block the mutating operation; flag-gated OFF by default on self-host.

---

### WS6 — Growth loops: referrals + shareable skill/template pages (P1)

**Build sketch:** HQ-side. Referrals: `referral_codes` + `referral_redemptions` tables (additive migrations in `hq/src/db.ts` style), code on customer row, validate at checkout (Stripe metadata), award credits on referee's first paid invoice via the existing Stripe webhook path (`hq/src/stripe.ts`), cap total earnable per customer (config constant). Shareable pages: public, unauthenticated routes on the marketing/app domain (`justcue.ai/skills/{slug}`) rendering marketplace skill detail with OG meta tags and an install CTA into the app — static-generated from the seed-source indexes so no daemon involvement.

**Non-regression rules:** public pages must not expose any customer data or daemon endpoints; Stripe webhook additions must be idempotent (existing handler patterns) and covered by a replay test.

---

### WS7 — P2, design-doc first (do NOT build yet)

1. **Sandbox-per-task parallel agents** on Fly Machines via the InstanceDriver seam (`hq/src/providers/`) with task-scoped branches over the WS5 config repo.
2. **Executor-style unified connector gateway:** generic `discover/describe/call` tools with server-side credential resolution and a per-call audit ledger feeding the Guardrails console; adds MCP/OpenAPI/raw-HTTP connector types beyond Composio.

Each needs an architecture doc reviewed before implementation.

---

## 4. Global guardrails (apply to every workstream)

1. **Rebrand boundary:** display strings say "Cue"; protocol/infra identifiers (`VELLUM_WORKSPACE_DIR`, `vellum` protocol ids, table names) stay `vellum`. Never rename existing ids.
2. **Secrets discipline:** no API key ever enters `SAFE_ENV_VARS`, child-process env, logs, or the WS5 export. New keys flow: HQ env → `buildInstanceEnv()` → daemon process env → direct HTTPS from daemon code.
3. **DB changes are additive-only** (new tables/columns with defaults; migrations in the established pattern — 200+ existing migrations in `assistant/src/memory/`; HQ migrations in `hq/src/db.ts` style). No destructive migrations, no altering existing rows' semantics.
4. **Feature flags:** every user-visible surface behind a flag (daemon: `assistant/src/config/schemas/`; web: `useConfig()`), and the OFF state must be verified, not assumed.
5. **Self-host parity:** every cloud-key feature has a BYO-key path; every HQ-dependent feature degrades gracefully when HQ is absent (the self-host `local:` principal — remember gates must not silently reject it; test with actorPrincipalId undefined).
6. **Verification standard (adopted from Kortix's AGENTS.md — apply it):** no unverified handbacks. API changes: exercise the real route with real payloads and assert response fields + persisted state. Web changes: drive the real page (preview tools), assert DOM/network, screenshot as evidence. **Prod-affecting checks must run against the prod URL, not the vite preview proxy** (the preview proxy 404s new daemon routes — known gotcha). Add a check per new surface to `assistant/qa/prod-smoke.ts` (marketplace routes, new tools present, onboarding step renders).
7. **macOS app:** it bundles a web SPA snapshot — after web changes land, rebuild the SPA bundle or the desktop app shows stale screens.
8. **Licensing:** before featuring any third-party skill source, verify repo license permits redistribution/indexing; attribute source (`owner/repo`) on every marketplace card (Kortix does this — copy it).
9. **When in doubt, smaller:** ship the read-only version (browse/search) before the write version (install); ship install-markdown-only before anything executable.

## 5. Suggested sequencing & acceptance

| Order | Item | Done means |
|---|---|---|
| 1 | WS2 tools (tavily/serper/firecrawl) | Brain answers a "what's the latest…" query with cited live results in a real conversation; keys absent → clean guidance; prod-smoke check added |
| 2 | WS1 marketplace (Explore/Sources/Installed + install + lock) | Install `anthropics/skills` item from the UI → `skill_load` uses it in the next conversation; lock has hashes; update flow shows diff; flag OFF hides everything |
| 3 | WS3 onboarding | New user completes wizard incl. connect-tools grid and BYO-key path; existing mid-onboarding users unaffected; mobile welcome verified |
| 4 | WS6 referrals + share pages | Code redeemable end-to-end in Stripe test mode; share page renders with OG tags, no auth leakage |
| 5 | WS4 Slack | @mention in a test workspace returns an in-thread answer from a real instance |
| 6 | WS5 config-as-code | Config mutations produce commits; redaction test green; autonomous changes appear in Review lane |

Report progress per-workstream with what changed, what was verified (with the real-surface evidence), and what remains — numbered, low-fluff.
