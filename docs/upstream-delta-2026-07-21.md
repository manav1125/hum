# Upstream delta — vellum-ai/vellum-assistant → Cue (2026-07-21)

Three-stream research: repo delta (scratchpad clone, our tree untouched), full docs+releases sweep
(v0.5.14→v0.10.8), plugins+extension product analysis. Standing watch: Cue schedule "Upstream
watch: vellum-assistant releases" (Mondays 09:00 WITA) files a Review item on new releases.

## Headline facts

- **Fork point:** `63127a2cc0` (2026-06-13). Upstream since: **~2,214 commits in 5.4 weeks
  (~410/week, accelerating)**. Re-run the deep delta every 2–3 weeks.
- **Structural drift that forbids blind merges:** memory moved into their plugin system
  (`plugins/defaults/memory/`); workspace migration IDs collide from 103 (ours ≠ theirs — always
  renumber); contacts/guardian tables moved assistant→gateway; wire changes (UUIDv7 ids,
  requestId/userMessageId merge, flat-content removal) break client compat if half-adopted;
  deep SaaS coupling (WorkOS, velay, credits) to strip.
- **Where we lead:** WhatsApp (upstream has none, not even planned), multi-user/team control plane
  (HQ, missions/agents — their "team visibility" is roadmap-only), mobile v3 native UI, filing
  system, connector health probe, marketplace-over-embeddings, morning brief ritual, Cue Live.
- **Where they lead:** plugin code-extension surface, trust-rules maturity, memory v3 + injection
  gate, crash recovery, send-path latency architecture, voice endpointing/barge-in, phone channel,
  watchers/playbooks, followups, advisor escalation, commerce-via-browser-session skills.

## Adoption program (phased)

### U1 — small, safe, high-value cherry-picks (pre-alpha, ~2 days)
1. **Crash recovery / auto-resume interrupted turns** (`01d6ea39ca`) — solves our open hung-turn
   message-loss bug. Remap persistence paths; renumber the migration. (M)
2. **Retry unparseable streamed tool-call JSON** (`085b64f28e`) — providers/retry.ts, clean. (S)
3. **Security trio** — memory-consolidation anti-injection framing (`f30edc6717`), prompt-path
   workspace confinement (`4afc603288`), DMARC/DKIM sender-auth hardening (`24eba1f4ae`+
   `cc55361ea0`). All map cleanly. (S)
4. **Tool-name aliasing + skill tools first-class** (`c6e3338969`, `a2e5513be9`) — directly
   targets DeepSeek fumbled tool calls. (S–M)
5. **Wake-content fencing** `--external-content` (`247eff884e`). (S–M)

### U2 — perf + resilience (alpha week, ~1 week)
6. **Send-path latency cluster**: turn-finalize deferral off the send path (`6f808914a4`),
   in-flight delta file off the SQLite writer lock (`9114548c9e`), WAL hygiene + synchronous=NORMAL
   (`50f2f83bcc`, `590433ef9c`) — the durable version of our 07-18 latency fixes. (M–L)
7. **Provider-error normalization + resolution preflight** (`63f618ee5c`, M6 series) — would have
   cut our maxTokens/ToS outages from days to minutes. (M)
8. **Attached logs/memory DBs** (llm_request_logs out of assistant.db — the structural fix for the
   500MB runaway) + **resource-monitor process** (OOM supervision, event-loop watchdog). (L)
9. **Advisor escalation** — consult a stronger model mid-task (our call-site routing makes this
   cheap: DeepSeek main + Claude advisor via CUE_ANTHROPIC_CALLSITES once funded). (M)

### U3 — platform bets (post-alpha)
10. **Plugin subsystem sync** (lifecycle, GitHub installs, routes/apps serving, plugin-api) as a
    block — excluding their memory relocation — then the **index-not-host marketplace** (curated
    marketplace.json pinned to commit SHAs + publish CLI). Matches our Kortix recommendation. (L)
11. **Chrome extension fork/rebrand** — CDP relay driving the user's logged-in browser; source is
    MIT in the ancestor (`clients/chrome-extension/`); needs gateway WS relay + our token mint
    replacing WorkOS PKCE + our own Web Store listing. Unlocks the commerce skills
    (Amazon/DoorDash-class). (3–5 days + store review)
12. **Voice cluster**: semantic endpointing/front-decision, barge-in during thinking, STT/TTS
    credential preflight (`b18908c718` et al.) — same file skeleton as ours, mappable. (M–L)
13. **Watchers + Playbooks** (event-driven layer our cadence-based missions lack), **Followups**
    tracker (fits commitment capture), **phone channel** (Twilio+ElevenLabs — we have the voice
    stack, no PSTN), **memory v3 injection gate** (perf + quality). (each M–L)

### Never merge blindly
Workspace migrations ≥103 (renumber always) · gateway data migrations m0007+ (table moves) ·
UUIDv7/requestId/wire-format commits (coordinate clients first) · anything touching `vellum`
managed connection / velay / WorkOS / credits · their memory-relocation churn commits.

## Sources
Upstream clone at scratchpad `upstream-vellum` (delete anytime). Docs raw copies in scratchpad
(`releases.txt`, `llms.txt`, `docs/`). Chrome extension: Web Store id `hphbdmpffeigpcdjkckleobjmhhokpne`
(v0.10.5, 463 users). Plugin docs: vellum.ai/docs/extensibility/plugins.
