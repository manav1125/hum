# Desktop regression sweep — QA night 2026-07-19

**Scope:** Verify the mobile-v3 program's "desktop byte-identical" claim by walking the desktop app at 1280×800 against real prod data (`web-vs-prod` vite proxy → manav.justcue.app). Dark theme primary, light spot-checked on 4 surfaces. Read-mostly; the two chat writes were QA-NIGHT-tagged and archived afterward.

**Headline verdict: PASS — no mobile-v3 styling or behavior leaked into desktop.** Serif deck typography, dark console styling, and all desktop-only layouts are intact everywhere checked. The v3 ledger/scopes/rules branches are correctly gated behind `useIsMobile` (verified in `apps/web/src/domains/guardrails/guardrails-page.tsx:218-239` and confirmed live: desktop `?view=ledger` still renders the three-band console). A handful of small, non-v3-related issues were found (ranked below).

## Per-surface verdicts

| Surface | Verdict | Notes |
|---|---|---|
| HQ / Today | PASS | Serif greeting ("Good evening. A calm one — 27 things I'd glance at."), capture bar, how-it-works card, Needs-you `Your next move`, mission cards, Running/Needs-you/Review(26)/Done lanes all render. Live indicator + setup banner OK. |
| Projects | PASS | Serif "Projects", Personal/Professional sections, next-move rows, add-project tiles. Tour tooltip dismisses. |
| Project detail (Bali Home Rennovation) | PASS | Serif title, context brief, knowledge panel (3 PDFs), kanban lanes, 3 review cards. |
| Task drawer | PASS | Mono TASK header, Approve/Redo/Open thread, Filed-To selector, Context notes, Source, Trail with state transitions + cycle time. Due renders via `DueChip` in the meta row (task had no due date); labels render as chips when present — no dedicated editors in this drawer, matching current design. |
| All-work | PASS | Serif "Everything, one list."; status/project/due groupings all regroup correctly (Review 26 · by-project AEF 1/Bali 3/none 29 · Overdue 3/No-date 30). Rows are read-only by design. |
| Chat | PASS | Sent "QA-NIGHT ping — reply 'pong'" → got "pong" (+thought process). Composer settings popover (access levels + model profiles incl. Claude Opus 4.8 / DeepSeek V4 Pro✓) renders; slash popup renders (/commands /compact /clean /models /status /btw); conversation actions menu (Pin/Rename/Archive/Mark unread/Open in New Window) works — used Rename + Archive for cleanup. See issues 2–3. |
| Create | PASS | Serif headline, all 10 mode chips, style-borrow drop zone, template gallery; "Investor pitch deck" fill&build form opens with all fields. |
| Voice overlay | PASS | Desktop orb page opens: TAP TO TALK, hold-to-talk hint, ElevenLabs voice selector, Classic toggle. (Mic not tapped — permissions.) |
| Library | PASS | Serif "Everything you and Cue have made together.", filters, deck/app cards with real prod artifacts. |
| Memory | PASS (slow) | Populates to "Cue remembers 1,416 things", 8 type chips with counts, rows with Edit/Forget, provenance rail. See issue 1 (long 0-state). |
| Connectors (Tools & Apps) | PASS | Serif banner, 7-of-500 progress, light tile palette with crisp brand logos — light palette correct on desktop in both themes. |
| Skills + detail | PASS | "Cue knows 96 skills", category rail, light cards; ACP detail renders SKILL.md preview/code toggle + enable switch. |
| Agents org (hq/agents) | PASS | Serif "Your company, staffed by agents.", You→org chart, agent cards with charters, tiers, spend meters, open role slot. `/assistant/agents` → HQ redirect is intentional (routes.tsx). |
| Guardrails | PASS | Three-band console intact: stat row (20 acts / $31.73 / 95% reversible), Checkpoints band with toggles, checkpoint composer (3-step: trigger/scope/name) opens+cancels, Agent Scopes band, ledger band with Reverse buttons, Usage & Spend with model mix + serif "Cue did 20 things for $31.73". See issue 5. |
| Ledger `?view=ledger` | PASS | Desktop correctly ignores the mobile-only view param and keeps the console; v3 `Mv3LedgerPage` only mounts under `useIsMobile`. |
| Settings | PASS | Sidebar shell (General…Advanced), Models & Services (DeepSeek V4 Pro profile, Tavily web-search w/ masked key), Brand (serif "Set up your brand" + 3 entry cards). No Notifications item on web build; `/settings/notifications` falls back to General. See issue 4. |
| Meeting | PASS | Serif "Capture → action items → memory", Start-capture card, recap panel. |
| Mission control / activity / dashboard / next-moves | PASS (by design) | All redirect to HQ — folded into the deck (routes.tsx comments confirm intentional). |
| Light theme (HQ, Projects, Connectors, Chat) | PASS | Clean light palette, serif intact, no dark-token bleed. |
| Console errors | CLEAN | Zero browser console errors across the whole sweep. One dev-only vite proxy error (issue 7). |

## Ranked issues (none are v3 leakage; none block)

1. **P3 — Memory page sits on "Cue remembers 0 things" + shimmer skeletons for ~10–15s** before snapping to 1,416. The 200-item fetch is slow on prod and the zero-count header renders as if final. Wants a loading state on the count ("counting…") or a smaller first page. `apps/web/src/domains/intelligence/memories-page.tsx`.
2. **P3 — Composer accepts input before the conversation shell is wired.** Typing + Enter into the "New conversation" skeleton during load silently dropped the message; a later stray keystroke fired `/status` into a fresh untitled conversation (became "QA-NIGHT Ping 2", archived). Composer should be disabled (or buffer reliably) until ready.
3. **P4 — Enter-to-send inconsistent on the new-conversation empty-state composer.** Settings has "Send with Cmd+Enter" OFF (i.e. Enter should send), and Enter submits in an existing conversation, but on the empty-state/home composer Enter did nothing — send required clicking the arrow. Repro'd twice.
4. **P4 — Settings → General card says "No assistant found. Hatch an assistant to get started."** while fully connected to the prod assistant (every other surface resolves it). Stale resolution in that card only.
5. **P4 — Guardrails composer CTA reads "+ Add your first checkpoint"** even with 4 default checkpoints present. Copy should switch to "Add a checkpoint" once any exist.
6. **P5 — Slash-command popup lingers**: it stays open behind/over the rename dialog and after focus leaves the composer; only clears on submit/full clear. Cosmetic overlay stacking.
7. **P5 (dev-only) — vite preview proxy error** on `GET /v1/assistants/self/conversations?...&conversationType=background` (known preview-proxy gotcha; prod unaffected).

## Observations (not filed as issues)
- Chat first-reply latency ~45–60s on prod (known, tracked in the chat-latency workstream). `/status` shows 93,597 input tokens on a 2-message conversation — the injected-context weight is the visible cause.
- Prod data contains a leftover project "🧪 QA-NIGHT — safe to delete" from a previous QA run (visible in task-drawer Filed-To). Data cleanup candidate.
- Skill-detail header text renders very low-contrast for a beat during its entrance fade — settles fine.

## Cleanup ledger
- Conversation "QA-NIGHT ping test — safe to archive" (the ping/pong turn): renamed + **archived**.
- Conversation "QA-NIGHT Ping 2" (stray `/status` from issue 2): **archived**.
- No other writes performed; all editors were opened and cancelled.
