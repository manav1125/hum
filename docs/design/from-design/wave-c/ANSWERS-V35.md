# Cue — v35 answers to code (2026-08-04)

Response to `BRIEF-2026-08-04-for-design.md`, in your priority order. One file: **cue-design-answers-v35.html** (open at full width; the rendered HTML is the spec — inspect inline styles for exact values).

## First: your three deviations were all correct
Each one is the never-fake-number rule applied better than our frames applied it. Keep going.

---

## V1 · Full-screen voice (your Q4) — build this
Three states. **The mark IS the state — no spinners, no state labels doing the motion's job:**
- **Listening** — ring breathes outward, blue ripples, live caption of the current sentence only.
- **Thinking** — ring contracts and dims (violet), one orbiting dot, **the tool it's touching named in words** ("Checking the pricing model…") — the voice version of "from your pricing model".
- **Speaking** — steady ring + teal waveform, "tap anywhere to interrupt".

**Exactly three controls: mute · end · collapse.** Nothing else on the call screen.

**Transcript contract:** the call lands in its thread as 🎙 italic bubbles (user turns + Cue turns), artefacts as cards. Ending a call drops you into that thread at the transcript's end. **No separate call history exists.** Nothing said in voice is ever lost.

**Engine toggle comes OFF this screen** → Your Cue → Preferences row. Debug access: long-press the call timer. Nobody changes engines mid-sentence.

**Collapse ⤓** returns to inline — same call, same socket (your architecture already guarantees this; the design promise is expand/collapse never interrupts audio).

## V2 · The valve's home (your Q7) — three doors, one daemon state
1. **HQ itself** — "Reaching you: Needs you ▾" at the top of Deck's rail; a small ⚙ at the end of Glance's strip. The label tells the truth about the surface AND is the control. The menu shows **honest per-stop counts**: "Everything · 94 a day" / "Needs you ✓ · 57 now, shrinks as Cue learns" / "Only urgent · deadlines & errors". Footer: "Filtered items stay in Work — this changes what interrupts, not what's kept."
2. **Mission header** — per-mission override as a chip on the mission's own header. **Amber while overridden** so the exception is visible; offers to reset when the mission completes.
3. **Your Cue → Guardrails** — the policy page: three stops explained, active overrides listed, what the ✕ has taught ("34 senders demoted"), and the fail-open rule in product language: *"If Cue can't score something, it treats it as urgent — turning this off makes Cue louder, not quieter."*

## V3 · Rings (your Q3) — answer is (a), redrawn status-only
The arc is the status, not a quantity:
- **On track** — full green ring + ✓
- **Moving** — blue arc segment + live activity bars
- **Blocked** — red stub + ◼ + **cycle count** ("BLOCKED 12c" — a real number you have)

If a mission later gets a real connected metric (dollars committed, seats sold), the % returns **for that mission only**.

---

## The seven questions
- **Q1 · Default stop stays. No fourth stop.** 57 is the honest number; show it. A tighter stop would paper over the broken relevance judge (5/161) — fix the judge and the ~37/day drains. **A design stop must never be a workaround for a code defect** — it survives the fix.
- **Q2 · Build `since`.** "Today" is worth the parameter — people think in days. "FILED · 24H" was the right interim; label returns to TODAY when `since` lands.
- **Q3 · (a)** — above.
- **Q4** — above.
- **Q5 · The cut is right; findability is the fix.** Library scope stays "made with Cue". But Library **search** also returns uploads, in a separated section "Things you sent · in their chats" linking to the thread.
- **Q6 · Sheet on mobile, rail on desktop.** The v15 sidebar (pinned + 5 recents + "All conversations ›") is the persistent desktop rail — build that; ☰ sheet is mobile-only. Keeping ☰ beside the back chevron in-thread was correct — never delete an exit.
- **Q7** — above.

## The eight rulings
1. **⌗ unreadable** → the Came-in tile/sheet ("12 filed · 13 I couldn't read ›"), auto-archive 48h. Removing dead-end rows was right; the honest destination is the arrivals lane, not All work.
2. **Your Cue wins as the one shell** — 18 leaves, v21's five groups. Settings dies as a shell; the four duplicated leaves merge (Connectors, Guardrails, Workspace, Usage & spend). v21 is the IA of record.
3. **Final nav** — v15's five-row sidebar stands, amended: HQ's badge shows the post-valve needs-you count; the rail expansion shows the five lanes, not raw items.
4. **Action board dies, confirmed.** The 07:30 push is inherited by **the daily brief** — payload is Glance's headline ("Your next move + N need you"), opens Glance.
5. **Going-quiet → inbound-only**: "quiet lately" = their inbound gap vs their own baseline (computable today). "You owe a reply" waits for outbound capture rather than faking it.
6. **Calendar-conflict token dies** — a conflict is work, renders as a task.
7. **Second device** → real HQ with a "catching up…" skeleton while state syncs. **Empty-states are for empty accounts, not empty caches** — copy must never confuse server truth with local cache.
8. **The six mobile confirmations** — send the list; ruled in one pass.

## Your two constraints, adopted as standing rules
- **Every frame with a number now ships with its unavailable twin.** A pending number is an em-dash with a pulse, never a confident zero.
- **The valve fails open, and the UI says so** (the Guardrails sentence). No frame will ever show "filtered" as a default or empty state.

## One more for your backlog
Ninth recurrence of the muted-token class this round. Build the tokens **named for ground and role** — `--muted-on-light` / `--muted-on-dark`, `--violet-fill` / `--violet-on-fill` — so the wrong value can't be typed into the right slot. Values: light text `#6B6B60` (never `#8A8A7E`/`#A8A89C`), dark text `#9A9AA8` (never `#5B5B68`); fills carrying white text use text variants `#534AB7` · `#8A5A08` · `#0A6A6A` · `#2B53C4`.
