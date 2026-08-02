# v9 — six answers back to engineering (2026-08-02)

Responds to `BRIEF-2026-08-02-back-to-design-v7-v8.md`. Three of these were corrections to my calls; engineering had information I didn't.

## Banned text tokens
`#5B5B68` is never a text colour (regressed 4× including the app). Dark muted text is **`#9A9AA8`**, light is **`#6B6B60`** — never `#8A8A7E` or `#A8A89C`. **Agreed with engineering: delete the dimmer tertiary slot entirely.** Two neutral text values per theme. If something must recede further, it recedes by *size or weight, never contrast*.

## Answers

**Q1 · Sender identity — conceded, engineering's rule adopted.** A stack is grouped by **registrable domain AND a structurally-automated local part** (`no-reply@`-shaped). Their constraint becomes the rule: **a stack can never contain a human's message.** Rejected: display name (breaks on `HSBC` vs `HSBC eStatement`) and bare domain (folds a colleague into their employer's robot). Their false-positive reasoning decides it — a bad merge *hides* an obligation; a bad split merely shows it twice. The three grouping concepts are cleanly separable: **stacks** = inbound robots · **threads** = one human conversation (exact address + thread id, already built; v7's BA example was a thread) · **batches** = outbound offers you accept.

**Q2 · HQ order before landing — neither (a) nor (b).** Ship the reorder *with the sentence*, not the whole landing screen. Interim HQ: delivery sentence → composer → needs-you → delivered → rest per v7. The sentence is a strict subset of the landing work (one line, already specified, no new surface), so delivered-first survives in compressed form and HQ never opens on obligations alone. When the landing ships, the sentence lifts out and becomes the door — no further reorder needed.

**Q3 · Comprehension failure — new state, and it isn't a task.** Frame **N1**. Two distinct admissions: *"I don't know where this goes"* (filing confidence → amber `?`) vs *"I don't know what this is"* (comprehension → the new `⌗` state). An un-comprehended arrival stays **in arrivals, not the task list** — it hasn't earned a task row. Subject shown in **italic quotation marks** (the typographic signal for *their words, not my summary*), one honest line "I couldn't tell what this needs", and the only action is **Open it** — Cue has no opinion, so it doesn't pretend to. The `⋯` still carries all eight verbs. Header counts it separately ("2 I couldn't read") so the failure rate is watchable.
  Stack line: **"1 I couldn't read"** — never merged with "1 may matter". One is a claim about the content, the other a claim about Cue.

**Q4 · Read-only — don't wait on Composio; the promise was mine to fix.** Frame **N2**. **Scope is Composio's, behaviour is ours.** Even with full OAuth, Cue starts in an app-enforced watch-only mode: *"Cue starts by watching only — it reads, files and drafts. It will not send, reply, book or spend anything until you turn that on."* Plus the ledger as proof and where to change it. More honest than a scope claim, since a read-only scope was never the real protection. **Ship regardless of what Composio says** — read-only scope becomes a quiet bonus, not the headline.

**Q5 · Missions don't start — the recruit moment.** Frame **N3**. Auto-recruiting on save is the most alarming thing the product could do; sitting inert is the second. Before Cue may move it states three things: **who** (agent, with receipts + tier), **the first three actions** — including where it will stop and ask — and **what it costs** in cadence and money. Then one **Go**. "Save it, don't start yet" uses the existing **parked ○** — no new state. Solves the missing control and a trust checkpoint in one screen.

**Q6 · Tab bar — three tabs: `HQ · ◉ · Work`.** Frames **N4 · N5 · N6**. Asked what the centre `C` points to, the first answer was *nothing* — a no-op on home, a duplicate elsewhere. Fixed by **centring the mark and making it the home tab itself**: real destination, real active state, fastest route back to talking, and it **pulses while agents are working** — one element doing three jobs. Voice → mic in the composer (+ long-press the mark). You → avatar top-right. History → `☰` top-left. Placement follows frequency of use; two of five old slots went to things touched weekly or less.

**N6 · Missions vs projects — navigation says "Work".** Our own mocks name the same three things twice (`Close the seed`/`Seed raise`, `Renew Acme`/`Acme renewal`, `Ship Halo`/`Halo launch`) — we built a two-level hierarchy and never produced example data respecting it. Prod agrees: 1 active mission, 1 abandoned, while projects are what people make.
  - **One list, sorted by completion semantic, not schema level.** *Finishing* = has an end, ring shows progress (what `projects` already holds). *Ongoing* = doesn't end, shows **health, never a percentage** — 68% of an endless goal is precisely the fake number our own rule forbids. Life sits under the same roof as a horizon row.
  - **Grouping becomes an offer, not a hierarchy.** When 3+ things ladder to one goal Cue proposes it like a batch offer; accepted, they nest under a header *inside the same list*. Nobody learns two levels on day one; those who need one get it when it starts paying.
  - Rejected: "Projects" (can't hold ongoing work or Life without lying) · "Missions" (a tab most users would find empty) · both tabs (spends a scarce slot on a distinction the user didn't ask for).
  - **Depth stays deep:** charter, agents, budget, rhythms, waiting, artifacts, spend all live one level down. The tab's only job is *get me into the right thing in one tap*.

## Supersedes
- v7 "stacks group by sender identity" → **Q1 rule here**
- v7 §B "never a subject line" → holds **for tasks**; N1 defines the no-task case
- v7 P4 "read-only to start" → **N2**
- v8 mobile tab bar → **N4 · N5 · N6** (`HQ · ◉ · Work`; the no-centre-button version is shown as superseded, the duplicate-C version as rejected)
- "Missions" as a navigation label → **N6** ("Work"). The mission *concept* survives as an offered grouping.

Everything else in v7 and v8 stands.
