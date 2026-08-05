# Cue — v37 answers to code (2026-08-05) · upstream waves

Response to `BRIEF-2026-08-05-upstream-waves-for-design.md`. One file: **cue-design-answers-v37.html** (the rendered HTML is the spec).

## 1 · The voice surface system — complete, port can start

**The room already exists** — v35 drew it (the mark IS the state: breathes listening · contracts + orbits thinking · steady + waveform speaking; three controls; transcript-to-thread contract). **Do not port upstream's eyes** — Cue's avatar language is the open ring, and it's already load-bearing across the product.

**W1 · The state ladder** (one surface visible at a time):
- **Room** — v35, unchanged.
- **Minimized bar** — sits above a *fully usable* composer (typing mid-call is a feature). Keeps: mark + ripple, level-driven bars (**animate from real audio levels** — adopt that upstream behaviour, it's the honesty rule for sound), state word, `▤` thing chip, timer, mute · end · ⤢ expand.
- **Title-bar pill** — on navigate-away: level bars + "Cue · speaking" + timer + ✕. Click anywhere except ✕ to return to the room. Mobile's pill is the Dynamic Island — same content, platform shape.
- Transitions: room ⤓→ bar (same view) → pill (other views); returning promotes back up. Demotion never interrupts audio.

**W2 · Mid-call reveal:** only after the sentence finishes (adopt upstream's determinism). **Voice announces, screen follows** — Cue says "Here's the pricing table", *then* the room collapses to the bar and the surface takes the space. Getting back: ⤢ on the bar. If the user starts scrolling the surface, the room doesn't fight for space.

**W2 · Mid-call approval:** room minimizes immediately. **The fixed phrase, in Cue's voice: "That one needs your okay — take a look."** Fixed is correct — a sensitive moment is the wrong place for generative variety. Card: amber `‖` treatment, the why in one line of trust language ("this is the part I can't do alone"), and three answers — Approve · Deny · **"Ask me after"** (parks it without ending the call; deferring is first-class).

**W3 · Mobile:** voice room = bottom sheet (v35 states, sheet-shaped). Live Activity / Island / Android notification content: phase word · participle label · timer · the mark. **Lock-screen privacy rule adopted verbatim:** present participles only ("reading your calendar"), no tool names, no arguments, no person names. v36's named-tool copy is in-app only.

**W3 · Spoken copy (paste-ready now, for C-4):**
- `ack-phrases.ts`: "On it." · "Give me a second." · "Let me look." · "Pulling that up now." · "Checking."
- `progress-phrases.ts`: "Searched the web — reading through it now." · "Found the thread, reading back." · "Going through your calendar." · "Still on it — this one's long." · "Nearly there."
- Fallbacks: "Still with you — give me a moment." · "Taking longer than it should. Hold on." · "That didn't come through — let me try again."
- Tone block for `front-decision.ts` (paste as-is): *"Speak like a capable colleague mid-task: brief, first person, plain. Name what you're doing in participles ('reading', 'checking'), never tool names. No enthusiasm about your own work — no 'great', no 'happy to'. Never apologise twice. If a number isn't certain, don't say a number. One sentence is the ceiling; silence is fine under three seconds."*

## 2 · Memory import — the onboarding moment (W4)
Three steps drawn:
1. **The drop** — "Been somewhere else? Bring it with you." + "Nothing leaves your machine during import."
2. **The ingest** — live counts as they're found ("48 things you told it about yourself · 31 people mentioned often · working through 2024…"). The ingest is the first demo of "Cue reads so you don't."
3. **"You didn't start from zero."** — kept-memory count with the honest split ("83 kept — the rest was chat, not you"), people added, one button: "See what Cue learned" → the constellation, imported nodes pulsing once — then they're just memories.

**Provenance ruling: badge in the detail, not the list.** Memory detail carries "imported from ChatGPT · Aug 2026" (inspectable, same rule as ✨ filing); lists and constellation don't segregate — the promise is "Cue knows you", not "Cue has two classes of knowing you." Onboarding placement: one optional card in the connect step, skippable, never a gate.

## The four polish rulings
- **3 · Bookmarks → conversations, not Settings.** "Bookmarked" filter at the top of All conversations (desktop rail + mobile ☰). Settings leaf retires. Mobile: bookmark joins the existing long-press row — no new chrome. Empty state: "Nothing saved yet — long-press any message to keep it here."
- **4 · System cards = the daemon speaks quietly.** Centered, no avatar, no bubble: hairline-bounded row + DM Mono microlabel ("COMPACTED · 41 MESSAGES → 1 SUMMARY") + muted text + timestamp. The daemon states facts and **never says "I"** — that pronoun is reserved for Cue. One spec covers summarize/compact/clean + future error/skipped notices.
- **5 · Decided approval cards:** shared wording, per-surface glyphs. Approved (✓ green · "Approved · by you · 14:02") · Denied (✕ red) · **Expired (◷ grey · "Expired · never answered — nothing was sent")** — the consequence must be stated, "expired" alone is ambiguous about whether the action ran. Status line replaces buttons in place, everywhere (Telegram behaviour generalised).
- **6 · Yes — rebrand display-facing skill copy to Cue for alpha.** Protocol ids stay `vellum`. Phrasing: "Cue" / "the Cue desktop app" / "Cue on iPhone". Add the rule to the skills authoring doc so new skills don't inherit the old convention.

## Deliberately not answered (matching your not-requested list)
Request-diagnostics UI · memory-graph overhaul · unified skills+plugins page — agreed on all three, with one note: if the skills/plugins split resurfaces, v21's "who works for you" group is where a unified view would live.

---

## v37.1 · Reconciled against the reference pack (behaviour doc + island source)
The reference confirmed the ladder, the one-surface invariant, reveal-after-speech, and the audio-driven waves as drawn. Four precision folds so the port lands on real numbers:

1. **Third filler category — the escalation bridge.** Fast model → big model handoff speaks one holding sentence (own words, first-sentence / 140-char cap); the big model is told the exact phrase so it never re-announces. Cue-voice fallback: *"Let me sit with that a second."* Distinct from the ack and progress lists in W3. New file alongside those: it pairs with upstream's `front-decision.ts` escalation path.
2. **Filler triggers are work-driven — adopt the thresholds.** Ack at 2.5s-no-audio or tool-start (one/turn, 600ms budget, silence on fail). Progress at ≥3 tool ops / one ≥15s op / ≥35s silence; suppressed within 6s of any speech and entirely while awaiting approval. **Narrations are audio-only — never in the transcript.**
3. **Mid-call approval fail-safe:** unanswered after **45s** → existing guardian behaviour (auto-allow per the mission's tier), never a hang; narration suppressed the whole wait; screenless phone calls never prompt. Card + "Ask me after" unchanged.
4. **Dynamic Island is quieter than drawn.** Most-shown form is the **minimal** slot: a single accent-tinted **phase glyph**, not the avatar (mic privacy dot forces the shared presentation all call). **No in-island controls** — tap-to-return is the only affordance, matching "the room's ✕ is the only exit". **Timer is the liveness signal** (counts with no push); on stale, drop phase label + activity line + timer, keep identity. Glyph-per-phase may vary natively because a glyph isn't copy. Lock-screen labels stay present-participle, no tool names/args (already in W3).

**Held firm against the reference:** the talking-avatar is Cue's **open ring**, not upstream's eyes / "void look" — the brief asked for our language and the ring is already load-bearing. The mid-call phrase stays **"That one needs your okay — take a look."** (Cue register) over upstream's "I need your okay for that one." One adopted detail: the mobile room **slides up already wearing its avatar** — pre-warmed, never a placeholder.
