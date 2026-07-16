# Cue — Design brief for Claude Design

_Prepared 2026-07-16. Two parts: (1) my verdict on the attached `cue-autonomy-states.html` mock, and (2) the specs to hand Claude Design so it comes back with options._

---

## Part 1 — Verdict on the attached mock (`cue-autonomy-states.html`)

**Approve, ship it as the visual spec.** It is faithful to what we actually built this week and it solves the one thing our surfaces have never had: a single, legible vocabulary for _the work loop_. Specifics:

**What's right and should not change**

- **The state taxonomy is exactly our system.** Picked up → Running → Needs you → Review → Done maps 1:1 to the shipped work-item lifecycle (capture → auto-run gate → approval prompt → `awaiting_review` → completed). The mock isn't inventing states; it's naming ones that already exist in the runner. That's why it reads as honest.
- **Colour semantics are disciplined.** Blue for autonomous motion (Picked up / Running), amber for "Needs you," violet for Review, green for Done, and **red reserved strictly for failure**. Reserving red is the correct call — most dashboards burn red on "attention needed" and then have nothing left for real errors. Keep this rule.
- **Agent identity as a first-class token** (Ops = teal, Growth = violet, Inbox = blue, with the little emoji chip) is the single highest-leverage element. Our moat is "work gets picked up and done _by a named agent_" — putting the agent's face on every card is what makes autonomous execution feel accountable rather than mysterious. This directly matches the roster we just reconciled in prod (Ops / Growth / Builder / Inbox, draft-only charters).
- **The approval-timeout card copy is exactly our behaviour and beautifully honest**: _"Last step waited for your OK and timed out — so Cue stopped instead of sending."_ This is the literal, user-facing rendering of the `approval_timeout` event we shipped. It turns a safety stop into a trust-building moment. Ship this string more or less verbatim.
- **"Make it a rule" Trust card** is the right escalation surface — it's the natural home for the per-category autonomy policy and would let a user promote a one-off approval into standing permission without hunting through settings.
- **Mobile collapse** ("lanes → one stream ordered by what needs you, same badges, same verbs") is the correct reduction. Same tokens, fewer columns.

**Minor notes / what to improve**

1. **State 6 (skill-discovery chat card) — leave for later, but define it.** The mock's own HANDOFF note scopes it low-priority; agreed. When we do it, it should visualize `skill_search` finding a capability the user doesn't have installed ("I can do X if you install the Y skill") — a discover-and-offer card, not an error.
2. **"why" affordance on Running cards** ("5 of 8 sources · why") is great but needs a defined expanded state — hovering/tapping should reveal the sources and the agent's plan. Ask Design to spec that popover.
3. **Empty/first-run states are missing.** The mock shows a full board. We need the zero-state for each lane (esp. "Needs you" empty = the reassuring state) and a first-run "here's how the loop works" moment. This is our long-open task #17.
4. **Failure state is reserved but not drawn.** Red is allocated; show the actual failed-card design (what the user sees, and the one-tap "retry / tell Cue what went wrong" affordance). We now stamp real failure reasons, so the card can be specific.
5. **Cross-surface consistency.** These tokens must also govern the macOS app and the existing Activity/Home surfaces — right now those predate this language. Design should deliver the token sheet as something we can retrofit, not just a Mission Control skin.

Net: this is the strongest single design artifact we have for the moat. Approve, and use it as the source of truth for the specs below.

---

## Part 2 — Specs for Claude Design (bring back options)

**The ask:** take the approved autonomy-state language above and turn it into a complete, retrofittable design system for Cue's work loop, then apply it across the primary surfaces. Come back with **2–3 directions** where a genuine choice exists (noted inline), not one locked answer.

### Product context (one paragraph)
Cue is a self-hosted AI chief-of-staff. Its differentiator vs. a chat LLM is the **autonomous work loop**: Cue captures commitments from your channels (Slack/email/SMS/WhatsApp), triages what matters, runs the work in the background via named agents (Ops/Growth/Inbox), pauses for approval on anything consequential, and surfaces finished work for review. Everything the user sees should reinforce _controlled autonomy_: it acts, but you always know what it did, who did it, and where it stopped.

### Deliverables

**A. Token sheet (foundational — do this first).**
- Finalize the state palette (Picked up / Running / Needs you / Review / Done + Failure) as named design tokens with light + dark values, meeting WCAG AA on both themes.
- Agent-identity tokens: colour + emoji/glyph per agent, plus the rule for agents beyond the seeded four.
- Type scale, spacing, card radii/elevation for the board and the mobile stream.
- Deliver as a values table we can wire to CSS variables (the app is a React SPA; tokens should map to existing theme vars).

**B. The card system (the core component).**
One card component, parameterized by state. Spec every state's variant:
- Picked up (with source provenance — "Rachel · Slack ''…''" — and Confirm/dismiss)
- Running (progress, agent chip, "N of M sources · why" with the **expanded why-popover** — option space: inline expand vs. side panel vs. hover card)
- Needs you (the approval ask + the approval-**timeout** variant with our honest copy)
- Review (artifact preview + Approve/Redo-with-notes)
- Done (agent attribution + how it ran: "auto" vs "you approved")
- **Failure** (reason + retry affordance) — currently undrawn
- Include the **zero-state** for each lane.

**C. The board + the mobile stream.**
- Desktop: the 5-lane Mission Control board, light + dark.
- Mobile: the single collapsed stream ordered by "what needs you."
- **Option space:** how much the board should animate state transitions (a card moving Picked up → Running → Review). Bring a restrained option and a more expressive option; motion should signal progress without being a casino.

**D. Trust / "Make it a rule."**
- The escalation card (promote a one-off approval to a standing rule) and where standing rules live afterward (a Trust surface). Tie to our per-category autonomy policy.

**E. First-run + empty states (task #17).**
- A first-run explainer of the loop (ideally 3 cards, not a wall of text).
- Reassuring empty states, especially "Needs you: nothing — you're clear."

### Constraints
- **Retrofittable, not a one-off.** Must apply to Mission Control, Home, Activity, and the macOS wrapper (Electron over the same web SPA). Deliver tokens + components we can adopt incrementally.
- Light + dark, desktop + mobile (390px), all AA.
- Honest by default: never show motion or a "done" state the backend hasn't actually reached. States must correspond to real work-item lifecycle values.
- Red = failure only.
- Keep copy in Cue's voice: plain, calm, first-person-from-Cue where the mock already models it ("so Cue stopped instead of sending").

### What to bring back
- The token sheet (A) as a single decision.
- For B/C/D/E: **2–3 directions where flagged**, each as a rendered frame (light+dark, desktop+mobile), with a one-line rationale and the trade-off. We'll pick per-section.
