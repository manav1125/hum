# Pre-alpha adoption program — "Parity+" (proposed 2026-07-21, pending lock)

Mandate: fold the valuable half of upstream's ~2,200 post-fork commits into Cue before the alpha,
accepting a few days' slip, so the launch feature set is world-class and competitive. Table stakes
per the user: plugins, Chrome extension, voice cluster, watchers+playbooks, phone channel, plus the
full U1–U3 map and the desktop-control unification.

**Estimated program: 6–7 working days** with parallel agent fleets, shipping in 5 staged deploys
(each gated by typecheck/tests/smoke + a prod verification pass). Alpha gate at the end: full
regression sweep + one clean quiet day.

## Day 1 — WS-A: Resilience & security core (U1)  [deploy 1]
- Crash recovery / auto-resume interrupted turns (`01d6ea39ca`, migration renumbered) — kills the
  hung-turn class for good.
- Streamed tool-call JSON retry (`085b64f28e`) + tool-name aliasing (`c6e3338969`) + skill tools
  first-class (`a2e5513be9`) — the DeepSeek reliability package.
- Security trio: consolidation anti-injection, prompt-path confinement, DMARC/DKIM sender auth.
- Wake-content fencing (`--external-content`).
Risk: LOW. All small, mapped, test-covered picks.

## Days 2–3 — WS-B: Send-path, providers, supervision (U2 core)  [deploy 2]
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

## Days 5–7 — WS-H: Desktop-control unification (research in flight)
- Thesis: one substrate (host proxies — already in our daemon) with two faces: Cue Live (visible,
  interactive, premium) and quiet capability (file access, terminal, app control) usable from ANY
  conversation including cloud→Mac. Adopt upstream's post-fork client maturation; our Electron app
  gains the host_file/host_bash/host_cu executors it lacks; directory-scoped trust rules gate file
  ops.
- Alpha demo: "clean up my Desktop / organize my downloads / pull the files for this project" from
  chat, with a review-before-move plan card.
- Scope finalizes when the deep-dive agent reports; held to fit days 5–7.
Risk: MEDIUM-HIGH (touches user files — plan-first UX + trust rules mandatory).

## Sprinkle (inside other waves)
Followups tracker (fits filing/commitments) · in-conversation search · retry-turn button · iOS
edge-gesture pack · LLM-inspector cache-diff panel · memory injection gate (flag OFF, evaluate).

## Hard rules for every pick
Renumber all migrations into our registry · never adopt UUIDv7/requestId/flat-content wire changes
this program · strip WorkOS/velay/credits references · exclude memory-relocation churn · every
workstream lands with tests + a prod smoke + rollback notes.

## Lock decisions needed
1. **Program window**: ~6–7 working days before alpha invites. (User pre-approved "a few more
   days" — confirm the week.)
2. **Advisor brain**: (a) open-weight strong model via OpenRouter (kimi-k3 / glm-5 quality tier —
   zero new deps, recommend to start) or (b) fund the stored Anthropic key and use Claude. Can flip
   later via config.
3. **Phone channel**: provide Twilio account/number now (small recurring cost) or slip WS-G to
   post-alpha.
4. **Extension distribution**: OK to submit to Chrome Web Store under your developer account
   (one-time $5 fee if not registered) + sideload zip for alpha meanwhile?
5. **Plugins curation**: we curate + pin the alpha catalog (3 seeds), community submissions
   post-alpha. OK?
