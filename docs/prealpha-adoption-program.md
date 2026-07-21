# Pre-alpha adoption program — "Parity+" (proposed 2026-07-21, pending lock)

Mandate: fold the valuable half of upstream's ~2,200 post-fork commits into Cue before the alpha,
accepting a few days' slip, so the launch feature set is world-class and competitive. Table stakes
per the user: plugins, Chrome extension, voice cluster, watchers+playbooks, phone channel, plus the
full U1–U3 map and the desktop-control unification.

**Estimated program: 6–7 working days** with parallel agent fleets, shipping in 5 staged deploys
(each gated by typecheck/tests/smoke + a prod verification pass). Alpha gate at the end: full
regression sweep + one clean quiet day.

## Day 1 — WS-A: Resilience & security core (U1)  [deploy 1] ✅ SHIPPED 2026-07-21
Deployed (image deployment-01KY1P91FD006VW51P0HWZP3P6). Migration 310 applied on prod (both
columns verified). Crash-recovery armed (conversations.resumeProcessingOnStartup=true; activates
on next restart). Finding: crash recovery was ENTIRELY ABSENT in our fork (in-memory only) — every
daemon restart silently dropped in-flight turns. 8 picks, 31 tests, typecheck+lint clean.

- Crash recovery / auto-resume interrupted turns (`01d6ea39ca`, migration renumbered) — kills the
  hung-turn class for good.
- Streamed tool-call JSON retry (`085b64f28e`) + tool-name aliasing (`c6e3338969`) + skill tools
  first-class (`a2e5513be9`) — the DeepSeek reliability package.
- Security trio: consolidation anti-injection, prompt-path confinement, DMARC/DKIM sender auth.
- Wake-content fencing (`--external-content`).
Risk: LOW. All small, mapped, test-covered picks.

## Days 2–3 — WS-B: Send-path, providers, supervision (U2 core)  [deploy 2] ✅ SHIPPED 2026-07-21
Deployed with WS-C (image deployment-01KY1SJFV7CRG9JFY42Y08X53F). Advisor live (code default:
enabled, kimi-k3/glm-5.2). Prod turns verified clean post-deploy (send-path no regression). This
restart also ACTIVATED WS-A crash recovery. turn-finalize deferral shipped flag-OFF (A/B later).

- Turn-finalize deferral off the send path + in-flight delta file + WAL hygiene +
  synchronous=NORMAL — the durable latency architecture.
- Provider-error normalization + explainable resolution preflight (outage-day killer).
- Resource-monitor process (OOM supervision, event-loop watchdog) — Fly 2GB insurance.
- **Advisor escalation**: main brain consults a stronger model mid-task. Model choice is a lock
  decision (below). Wire via our existing call-site routing.
- DEFERRED to post-alpha: attached logs/memory DBs (L, migration-heavy; retention already bounds
  the runaway), Qdrant lexical index (scale we don't have).
Risk: MEDIUM (send-path touches the hot loop — flag-gated, A/B against current latency).

## Days 2–4 — WS-C: Plugins platform  [deploy 3]
- Subsystem sync as a block: plugin lifecycle (install/uninstall/upgrade hooks), declared deps,
  GitHub-URL install w/ 3-way merge, routes served under /x/plugins/, plugin-bundled apps,
  enable/disable, richer plugin-api — EXCLUDING their memory relocation (our memory stays put).
- Marketplace: curated `plugins/marketplace.json` pinned to commit SHAs (index-not-host), plugins
  search/install/publish CLI, mobile+desktop Plugins surface listing installed/available.
- Seed catalog for alpha: model-router, agent-wrapped (viral loop), simple-memory (reference).
  Curation policy: we review + pin; direct-GitHub installs marked untrusted.
Risk: MEDIUM-HIGH (biggest merge surface; their memory-as-plugin refactor must be surgically
excluded). Mitigation: worktree integration + full test sweep before merge.

## Days 3–5 — WS-D: Chrome extension (Cue Browser Relay)  [deploy 4 partial]
- Our daemon+gateway already carry the Phase-2 relay architecture (ChromeExtensionRegistry,
  /v1/browser-relay, capability-token pairing). Work = fork `clients/chrome-extension`, rebrand
  (protocol ids stay vellum per the boundary), point pairing at our gateway HMAC flow (replacing
  WorkOS PKCE for cloud), deterministic IDs, adopt their post-fork extension fixes.
- Distribution: submit to Chrome Web Store immediately (review latency is days–weeks) AND ship a
  sideload zip for alpha users day one.
- Unlocks: browser tools driving the user's real logged-in Chrome; later the commerce-class skills.
Risk: MEDIUM (store review timing external; sideload mitigates).

## Days 3–4 — WS-E: Voice cluster  [deploy 4]
- Semantic endpointing + front-decision/ack-phrases (presence layer), barge-in during thinking +
  read-only barge-in continuation, self-interruption reduction + pause sensitivity config,
  STT/TTS credential preflight. Same file skeleton as ours — mappable.
- Lands in both voice mode and Cue Live's conversational layer.
Risk: MEDIUM (live-audio behavior needs device QA; ship behind liveVoice config flags).

## Days 4–5 — WS-F: Watchers + Playbooks  [deploy 5]
- Watchers: watermarked polling monitors (Gmail/Outlook/GitHub/GCal/Linear) feeding the came-in
  lane — the event-driven layer our cadence-based missions lack.
- Playbooks: trigger→action rules per channel with autonomy levels (auto/draft/notify) + priority —
  integrates with guardrails (playbook autonomy ≤ dial) and filing (outputs are work items).
Risk: MEDIUM (new standing pollers = quota/token spend; ship with conservative default intervals +
per-watcher toggles; guardian trust rules apply).

## Days 5–6 — WS-G: Phone channel (flag-gated)  [deploy 5]
- Twilio + ElevenLabs receptionist: inbound answers + outbound calls, transcripts as conversations,
  mid-call guardian consult. Voice stack already keyed (ElevenLabs + Deepgram).
- Needs from user: Twilio account + a number (~$1–15/mo + usage) — lock decision below.
Risk: MEDIUM (telephony edge cases; flag-gated, receptionist-only for alpha).

## Days 5–7 — WS-H: Desktop-control unification (scope FINAL, deep-dive complete)
Finding: the daemon substrate (host_bash/file/transfer/cu/browser/app_control proxies, directory-
scoped trust rules, cloud→Mac routing) is COMPLETE in our fork, and bash/file/transfer/browser
already execute in our Electron app — cloud conversations can drive Mac files/terminal TODAY. The
gap is the computer-use/app-control EXECUTORS (our Electron stubs return "not implemented"; the
Swift stack sits unported in the retiring clients/macos).
1. Port the CU/app-control stack into apps/macos per upstream `92fc32090b`: mac-helper
   ComputerUse/AppControl Swift (source exists in our clients/macos — includes upstream's new
   ActionVerifier verify→execute→settle→observe), shared-cu-helper sidecar, the two thin executors.
   Same signed helper binary → inherits Cue Live's existing TCC grants, zero new permission
   prompts. Effort M (not L).
2. Re-platform Cue Live "act" onto the computer_use_* loop: goals become real conversation turns —
   gaining AX-element grounding (click-by-element, not raw pixels), per-action approvals + trust
   rules, step caps + loop detection, ActionVerifier, Mission Control visibility. Cue Live keeps
   guidance/look as-is and keeps its moat (summon hotkey, POINT overlay, phone remote pause — the
   pause generalizes to any host-proxy run). Upstream has NOTHING like Cue Live's co-present mode.
3. `desktop-organizer` skill (alpha demo): read-only inventory pass → categorized plan card →
   MOVE-NEVER-DELETE into ~/Desktop/Cue Archive/<date>/ with a moves.tsv manifest (one-command
   undo); consent contract adopted from upstream's system-storage-cleanup (exact path + size +
   consequence, protected-path denylist); the demo moment = one "Always allow in ~/Desktop/*"
   directory-scoped rule, then it runs unattended.
4. Small adopts: folder drag-drop as path-reference (`0606da42cd` — "drop a folder, say organize
   this"), TCC identity fixes, forged-host-event security block (`9be578154d`), flapping-SSE
   tolerance, symlink-resolve risk classification if missing.
Risk: MEDIUM (was MEDIUM-HIGH — the substrate being done + move-never-delete + existing TCC grants
de-risk it).

## Sprinkle (inside other waves)
Followups tracker (fits filing/commitments) · in-conversation search · retry-turn button · iOS
edge-gesture pack · LLM-inspector cache-diff panel · memory injection gate (flag OFF, evaluate).

## Hard rules for every pick
Renumber all migrations into our registry · never adopt UUIDv7/requestId/flat-content wire changes
this program · strip WorkOS/velay/credits references · exclude memory-relocation churn · every
workstream lands with tests + a prod smoke + rollback notes.

## Lock decisions
1. **Program window** — ✅ LOCKED: ~6–7 working days, "do it right." User offers design help for
   mobile / web / OS X (see the design-ask list below).
2. **Advisor brain** — ✅ LOCKED: **kimi-k3 primary, glm-5.2 configured fallback**. Both probed on
   the prod OpenRouter key (2026-07-21): tools + 1M ctx, both reason well; kimi-k3 sharper, glm-5.2
   ~5× cheaper input ($0.95 vs $3/M). Advisor fires selectively to bound cost. Anthropic/Claude
   remains a later config flip if desired. Wire in WS-B via our call-site routing
   (CUE_ADVISOR_MODEL / config).
3. **Phone channel** — ✅ LOCKED: user provides Twilio (account SID + auth token + a purchased
   number). WS-G proceeds; needs the creds during the week to verify inbound/outbound. Store creds
   as prod secrets (never in config doc).
4. **Extension distribution** — ✅ LOCKED: submit to Chrome Web Store. User has no Chrome dev
   account yet → user must register it themselves (account creation + the $5 fee are user actions I
   cannot perform). RECOMMEND registering under a Cue/company Google account (not personal) so the
   listing isn't tied to an individual. I prep: extension zip, listing copy, screenshots, 128px
   icon, privacy-policy page. Alpha users sideload the zip regardless of listing timing.
5. **Plugins curation** — ✅ LOCKED + EXPANDED: user wants this COMPREHENSIVE and scalable like the
   skills marketplace (which indexes SKILL.md across multiple GitHub repos). So WS-C's marketplace
   is not a 3-seed stub — it's a **multi-repo plugin registry**: a curated set of GitHub repos/orgs
   whose plugin manifests (package.json + @vellumai/plugin-api) are indexed into the same embedding
   space as skills, commit-pinned, security-reviewed. Seed with our own + upstream's marketplace
   plugins + a curated allowlist of source repos; community-submitted repos post-alpha via PR.
   This makes plugins scale the way skills already do. (See [[cue-kortix-competitive-analysis]] +
   [[cue-overnight-moat-sprint]] for the skill-embedding-space precedent.)

## Design-ask list (user offered to help — prioritized per platform)
**Mobile (v3 grammar):** Plugins surface (browse/installed/detail/permissions — reuse skill-detail
sheet grammar) · Watchers+Playbooks config (a watcher = a monitor card; a playbook = trigger→action
w/ autonomy dial) · desktop-organizer plan card (the review-before-move UI) · phone-channel setup
sheet (like Telegram's).
**Web (serif HQ):** plugin marketplace + detail on desktop HQ · watchers/playbooks board ·
phone-channel + call-transcript surfaces · desktop-control consent/plan cards.
**OS X (Cue Live overlay):** the unified act-loop states — "about to do X" pre-action affordance,
approval prompt in-overlay, ActionVerifier progress/settle states, desktop-organizer live progress
overlay. This is the highest-value design surface (net-new interaction model).
