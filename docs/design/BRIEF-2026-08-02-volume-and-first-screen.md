# Design brief — the volume problem, and the first screen

**2026-08-02. For the next design turn.**

The previous turn produced the canonical work surfaces (deliverable 01) and they
are now built: K1's nine-row reading order, the eight verbs, Life as a lens,
waiting-on-people, provenance. The layout is not the problem.

This brief is about two things the last turn could not have known, because the
product had never run against a real inbox.

---

## 1. The volume reality

Measured on the live instance, 2026-08-02:

| | |
|---|---|
| Queued work items | **116** |
| Sourced from Gmail | **104 (90%)** |
| With no project | **103 (89%)** |
| In the Life lens | **0** |
| Distinct senders | **74** |
| Sender contains no-reply / notification / newsletter / marketing | **64** |
| Titled literally `Email from <sender>: <subject>` | **134 of 134** |
| Missions | 1 active, 1 abandoned |

Concentration in the tail: **15** separate items from one bank's notification
address. **4** from an airline. HSBC appears under three different sender
addresses as three unrelated stacks.

### What this means for design

**Do not design for 103 items.** Two engineering changes are landing that
change the input to your problem:

- A **relevance gate** now filters arrivals before they become work. On its
  first live arrival it filed a newsletter by header rule, with a reason in the
  owner's words, and minted no work item. A retro-run over the existing backlog
  is being built.
- **Comprehension and grouping** are being built: an arrival becomes a task with
  a verb-phrase title ("Renew the annual return"), thread replies collapse into
  one item, and recurring notifications from one sender collapse into one row
  with a count.

So the realistic steady state to design for is **single-digit to low-teens items
needing the user**, not 100+. If HQ still feels heavy at that volume, that is a
design problem worth solving. At 103 it was an engineering problem wearing a
design problem's clothes, and rearranging it would have wasted your turn.

**The question for you:** given 8–12 real items, one or two missions, and a day
of commitments — what does HQ show, and what does it refuse to show? The owner's
words are *"i still feel very overwhelmed when i look at hq"*. The current deck
renders every module always, stating a reason where data is missing (that rule
is deliberate and load-bearing — see §14 honest empty states). It is possible
that "always render" is correct for trust and wrong for calm, and we would like
your judgement on that tension specifically.

### A finding worth your attention

Every single Gmail-sourced item is titled `Email from <sender>: <subject>`. Not
one was turned into a task. Cue was not converting mail into work; it was
relabelling mail as work — an inbox with extra steps.

Engineering owns the fix. But it raises a design question: **once an arrival
becomes a real task, what does the row show?** The task, the origin, the
deadline, the sender, the "why is this here" — these compete for one line. The
provenance affordance exists now; how much of it belongs on the row versus
behind it is yours to decide.

---

## 2. The first screen

The owner's ask, verbatim:

> we have to simplify the first screen the user sees as well and i'm thinking
> like every llm we need to consider the new conversation screen as its clean
> (we also need to clean ours up as there is too much going on — check accio
> work and even the suna / mira project we created and see how simple they
> were) — maybe this is also a job for design and the other contextual items
> (showing we know what the user has on) can be there but hidden with a button
> to open up

The shape he is describing: open on a **clean new-conversation surface**, with
the "here is what you have on" context available behind a control rather than
presented on arrival.

The tension to resolve, and it is a real one: Cue's whole claim is that it has
been working while you were away. A first screen that shows nothing throws away
the one thing that distinguishes it from a chat box. A first screen that shows
everything is what we have now, and it overwhelms.

Our instinct — but this is exactly the judgement we want from you — is that the
opening line is a *single sentence of delivery* ("While you slept: 3 things
done, 2 need you") above a clean composer, with everything else one click away.
The receipts principle survives; the wall does not.

Please look at the Accio work and the Suna/Mira projects for the restraint the
owner is pointing at.

---

## 3. Not design's problem — engineering owes these

Listing them so the turn is not spent on them:

1. **Moving a project between Work and Life.** The `domain` column shipped
   2026-08-01; this is wiring.
2. **Cancel / remove from HQ.** The `archive` and `done elsewhere` verbs exist
   and are specified; no HQ row calls them yet.
3. **Forcing connector setup in onboarding.** A gate. *Design does own how it
   feels* — being blocked on arrival is a hostile first impression if handled
   badly, and Cue genuinely is useless without at least one source connected.
   Worth a frame.
4. **Missions not spinning up agents.** A created mission currently sits there.
   Under investigation; may change what mission surfaces need to show.

---

## 4. What has changed since your last turn

Built and deployed: canonical K1 (all nine rows), the six missing modules, the
eight verbs with one keyboard binding and session-wide undo, Life by horizon,
waiting-on-people with §7's four states, provenance on every work surface, the
ledger reachable from desktop, and the arrivals digest — now reading real
dispositions rather than inferring them.

Two rules from the last turn proved their worth and should survive this one:

- **Never a fake number.** A lane we cannot answer is absent, not zero.
- **A no-op is not a success.** Three separate bugs in two days were invisible
  precisely because something silently did nothing and reported nothing. The
  auto-filer had filed nothing for twelve hours; the only symptom was a user
  staring at 103 unfiled items.
