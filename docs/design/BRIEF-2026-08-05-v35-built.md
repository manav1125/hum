# v35 is built and live — 2026-08-05, from code

All four lanes shipped and deployed to production. This is what we found while
building, where we deviated and why, and the four things still open.

Your opening line — *"your three deviations were all correct; each one is the
never-fake-number rule applied better than our frames applied it"* — set the bar
for this round. Everything below is in that spirit: where the data would not
support the frame, we changed the frame and said so.

---

## Shipped

| Lane | |
|---|---|
| **V1** full-screen voice | three states, three controls, engine toggle moved off, transcript contract |
| **V2** valve's three doors | HQ label-as-control · mission chip · Guardrails band |
| **V3** rings | status-only, blocked cycle count |
| **Q2** | `since` built — the filed label can say TODAY |
| **Q5** | Library search finds uploads in their own section |
| **Tokens** | named for ground and role |

---

## Five findings you should have, because they change the drawing

### 1 · The tool name did not exist. We built the pipe rather than fake it

V1 asks the thinking state to name *"the tool it's touching."* That signal
reached the voice bridge, was logged, was handed to the phone event sink — and
stopped. The client genuinely could not know, so the only options were an
invented string or nothing.

We wired it end to end, and the surface now has **three honest outcomes**: a real
phrase when we have copy for that tool, **"Using a tool…"** when a tool truly
started but we have no phrase for it, and **"Thinking…"** when nothing was
reported at all. Please draw the second and third — they are not edge cases, they
are what a new tool looks like on the day it ships.

### 2 · We took your dark muted stop exactly, and not your light one

You specified light text `#6B6B60`. That value is measured on HQ's warm paper
(`#F4F3EF`/`#E8E6E0`) — it appears 12× in the v35 answers and 0× in the mobile
file. Mobile's canvas is the cool `#F2F3F7`, where your own frames use
`#5A6672`. Same role, same contrast band (5.29 vs 4.86).

Typing the paper value onto the cool canvas would have been your own complaint,
one axis over. **Worth deciding whether the two grounds should have separately
named stops** so this cannot recur.

The rename found **four live bugs**, which is the argument for having asked:
`--mv3-faint` was 68 `color:` uses at **2.62:1**; white sat on amber at
**3.76:1** in three places; the primary gradient's light stop was **3.88:1**; and
`--mv3-accent-text` measured **4.28:1 in dark** beneath a comment asserting it
cleared 5.1–8.4:1, with a test pinning it there. A test can hold a bug more
firmly than no test.

The names were inverted from what they claimed: `--mv3-violet-on-fill` read as
ink and held a *background*; `--mv3-violet-fill` read as a ground and held the
bright mark colour. Exactly the failure you predicted.

### 3 · "34 senders demoted" was not readable — and the obvious number is the wrong one

The only endpoint that returned what the ✕ had taught was the one that *records*
a dismissal, so asking the question changed the answer. We added a read route.

The choice worth your attention: it reports what the **banding rules actually
quiet** (`learnedDownSenders`), not how many dismissals have been recorded.
Those differ — the raw count includes senders corrected once and senders since
taken back, so it would overstate what the person has achieved. On this account
the honest answer today is **zero, with nothing taught yet**, and the surface
says that in words rather than printing `0` as though it were a result.

### 4 · The rings needed a fourth state, not three

Before this round, **nine live runs and a week of total silence both drew a calm
green tick**. We added `moving` (a real rollup: `running > 0`) with a long blue
segment and live bars. Arc length is now a constant per state and test-pinned, so
two blocked missions draw identically and geometry can never be misread as
progress.

### 5 · "Today" was worth building — the gap is bigger than it sounds

On a production-shaped corpus the trailing 24h reported **101 arrived** where the
actual local day held **65**. Saying "today" over the old number would have
overstated the day by **55%**.

The label is derived from the bound the response reports, never from the request
— so if `since` is ever dropped it reverts to `· 24H` on its own. Hardcoding
"FILED TODAY" breaks three tests.

---

## Four things still open

### A · Cue's own voice turns are not yet 🎙 bubbles

Your transcript contract says user turns *and* Cue turns land as 🎙 italic
bubbles. User turns do. **Cue's do not** — the wire restricts the voice marker to
user rows and the assistant persist path has no metadata channel. That needs core
agent-loop plumbing, so it is filed rather than half-built. Nothing is lost
today; it renders as an ordinary assistant bubble.

### B · Mobile Guardrails has no valve section

Door 3 landed on desktop. The mobile rules page is a separate component tree and
was being edited concurrently. **Does the mobile Guardrails need the full
REACHING YOU band, or a reduced form?** The phone cannot hold the overrides list
comfortably.

### C · A wrong sentence we cannot currently avoid

`listFeedback()` and `learnedDownSenders()` swallow database errors and return
empty. So a broken table makes Guardrails say *"you haven't used the ✕ yet"* when
it means *"couldn't read."* It fails in the safe direction — Cue gets louder,
never quieter — but the sentence is untrue.

**Do you want a third state drawn for "we could not read what the ✕ taught"?**
Our instinct is yes, by the same rule that gave every number an unavailable twin.

### D · The six mobile confirmations

Ruling 8 says *"send the list; ruled in one pass."* We do not have those six
enumerated anywhere in the repo — they were passed over directly and we cannot
reconstruct them accurately, and guessing would waste your pass.

**Please restate them and we will answer in one go.**

---

## Adopted as standing rules on our side

- Every frame with a number ships with its unavailable twin. A pending number is
  an em-dash, never a confident zero. We removed four violations this round.
- The valve fails open and the UI says so. No surface presents "filtered" as a
  default or empty state.
- A design stop is never a workaround for a code defect. Your Q1 ruling is now
  how we think about the relevance judge: fix the judge, don't tighten the stop.
