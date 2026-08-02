# v12 — the partner (2026-08-02)

Final review, read against *"a partner in crime"* rather than against the spec. Four findings. One is a surface we forgot to draw.

## The headline
**The app opens on a composer, and we never designed what happens after you type into it.** Every frame across v1–v11 shows the moment before a conversation or the artefacts after it. The conversation itself — the most-used surface in the app, and the only place Cue's character is visible — is a blank.

The other three findings are the same shape: we specified **what Cue does** exhaustively and **who Cue is** almost not at all.

---

## 1 · The conversation surface (frame P1) — highest priority
Not a chat log. A place where **talking and working are the same activity.** Four things happen that don't happen in a chatbot:
- **Cue answers from your data**, sources collapsed underneath ("from your pricing model, Dana's last email") — not pasted in.
- **It asks instead of guessing** when ambiguity is real ("Rachel's thread or Dana's?").
- **Work appears in the thread as a card** with its verb on it — never text you must copy out of a bubble.
- **It volunteers one adjacent thing it noticed** — *"While I was in there, the security questionnaire is still open with Rachel, six days now."* That bubble is the whole product.

**Rules:** answer then show sources, never lead with them · ask once when genuinely ambiguous, never to seem careful · anything sendable/savable renders as an artefact card · at most one adjacent offer, only from what it just touched · a conversation belongs to a thing (header shows `▤ Renew Acme`, so output lands in the right place) · work over ~30s leaves the chat as a task with a live line — the conversation never blocks.

## 2 · Welcome back (frame P2)
312 arrivals after eight days away, shown as **three numbers and one button**. The partner move: **Cue leads with what it got wrong**, unprompted, before you could find it — *"Two I should have escalated… Both my call, both wrong."* Then offers to walk you through the rest conversationally rather than dumping a queue.

**Four user states we never designed for**, all using signal we already have:
- **Away** — know it from the calendar, batch instead of interrupt, hold for the welcome-back. One setting, no new UI.
- **Slammed** — back-to-back calendar shrinks the deck to one item.
- **Avoiding something** — skipped 5×, stop re-showing it identically: *"is it the wrong question, or the wrong time?"*
- **Quiet** — say it, don't leave an empty deck.

## 3 · Cue's voice — the spec we never wrote
Our own copy drifts between a log line and a person. Pick the person.
- Brief, not curt · **first person for its own actions, always** (passive voice is where products hide) · never enthusiastic about its own work (no "Great news!") · warm at the edges, plain in the middle (a cheerful status row is exhausting by the fortieth read) · has opinions and gives them once · never apologises twice, never grovels.

**Cheapest item on the list, largest change in how the product feels.** No new screens — a spec page and a copy pass.

## 4 · Show the relationship deepening
Day 200 looks like day 1 with more rows. Three moments, no new surfaces:
- **Notices patterns out loud** — *"You've never once done admin on a Friday. I'll stop putting it there."*
- **Milestones, sparingly and specifically** — *"Acme renewed. 47 days, 61 things, 3 of them yours."* Not confetti; a real number showing what it carried. Once per finished thing, never per task.
- **Trust growth narrated** — *"Three months ago you checked everything I sent. Now you check the ones over £1,000."*

**The discipline that stops this becoming slop:** every one is a specific checkable fact. The moment it becomes "You're doing great this week!" it's worse than silence. Same rule as everywhere: never a fake number.

---

## Build priority
1. **The conversation surface** — non-negotiable; everything else is scaffolding around it.
2. **Voice spec + copy pass** — cheapest, biggest felt change.
3. **Welcome back** — one screen, converts sceptics, and the only defence against the deck reading as an accusation.
4. **Pattern-noticing and milestones** — turns retention into affection.

## The honest summary of twelve versions
We built something unusually careful: it never fakes a number, never hides a failure, never buries a live item, never grows past what a person can read. That foundation is genuinely rare. **But careful isn't the same as loved** — what's missing is the part where Cue is a *someone*, and it's four items, three of which are copy and one of which is a screen we forgot to draw.
