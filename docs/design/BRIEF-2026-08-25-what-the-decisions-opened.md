# Brief for design — what the decisions opened up

**Date:** 2026-08-25 · **From:** Manav · **Status:** decisions locked, screens open

**The companion is not in this brief.** It has its own pack
(`docs/design/companion-always-on/`) and its own thread. Everything here is what remains.

---

## Where this came from

We read 298 upstream commits (2026-08-14 → 08-24) and went through every open decision one
by one. Those are now settled. What follows is the work those decisions created, plus the
user-visible things we shipped without design and the upstream features worth having.

The decisions, so you have the ground:

| | Decision |
|---|---|
| Approvals | **Never let a missed approval cost the outcome.** Not by stealing focus — by making waiting visible and making approvals rarer |
| Plugin disable | Stays "restart required" until we host code we don't trust |
| Risk classification | We stay forked from upstream, deliberately |
| Voice reply length | No change — conversational, results-oriented, expands when the answer needs it |
| Multi-user | Not now. Eventually: enterprise plans with shared context and knowledge bases |
| Cue's own journal | Keep, but it must separate what was **observed** from what was **concluded** |

---

# 1. Waiting for you, without interrupting you

**This is the biggest item and the one I most want your thinking on.**

## The evidence

Every approval request this instance has ever raised:

```
162 total   ·   83 approved   ·   76 expired   ·   3 denied
```

**Forty-seven per cent were never answered.** They sat for thirty minutes and were then
silently denied — the action never happened, and nothing said so. Volume is low: 10 in a day
at peak, most days one to four.

And of the ones that *were* answered, **96.5% were approved**. Anthropic published the same
number for Claude Code — 93% — and named the consequence: *approval fatigue*, where people
stop reading what they authorise.

So both halves point the same way. Most of these prompts shouldn't need to exist, and the
ones that do are being missed.

## What I do not want

**Do not solve this by bringing the app to the front.** Upstream does; I don't want it. When
I'm running several things at once, an assistant that seizes the screen because it wants
permission to run `ls` is worse than one that waits. The user drives.

## What I want you to design

Three things, and they interact:

**1a. A resting state that says "something is waiting" without demanding anything.** It has
to be legible from the corner of the eye, from whatever surface I'm on, and it must survive
me ignoring it for an hour. Where does it live — the sidebar, the menu-bar icon, the dock,
the companion? What does one waiting item look like versus six?

**1b. The answering surface.** When I do come to it, what do I see? These are usually small
("run this script", "write this file"), occasionally large ("send this email"). The card
should make the difference obvious without me reading carefully — I approved 96.5% of them,
so the design problem is *surfacing the 3.5% that deserve a pause*, not making all of them
equally prominent.

**1c. "Don't ask me again."** The single most effective fix is fewer prompts. Upstream lets a
user approve *and remember* — the answer persists as a rule so matching calls stop asking.
What does that control look like at the moment of approval? How does someone later see what
they've standing-approved, and take it back? A list of standing permissions nobody can find
is how this goes wrong.

**Constraint worth knowing:** nothing may expire into a silent denial. A missed approval
should cost latency, never the outcome.

---

# 2. "Cue was blocked while you were away" — a new item type

**Shipped this morning, undesigned, currently rendering as a plain work item.**

Background runs have no one to ask, so they're denied immediately — correct, they must not
hang. Until today that denial went to a log file. The result on this instance: Cue's
heartbeat couldn't run its own circuit-breaker script from **1 August**, wrote itself a
manual workaround, recorded the denial in its journal as *"expected, consistent,
documented"*, and ran degraded for twenty-four days without anyone being told.

Now it files an item. **What should that item look like?**

It is a distinct thing from a task: it's not work to do, it's *permission to grant or
refuse*. Both answers are fine and the item should close either way. It is deduplicated —
one blocked script is one item however many times it retries — so it needs to show "this
keeps happening" without becoming a counter nobody reads.

**Question:** does this belong in the same lane as tasks needing attention, or is it its own
class? I lean towards its own, because the action is "decide a rule", not "do a thing".

---

# 3. Cue's record of itself — and the provenance problem

Cue keeps a journal: **276 files, ~94,000 words** since early July. `HEARTBEAT.md` tells each
heartbeat to write to it and read it back — *"the journal is how future-you stays connected
to past-you."*

There's a real problem in it. The entries mix two very different things:

- **Observations** — "asked for a summary at 18:00, the reply was empty". Checkable, useful.
- **Conclusions about me** — an invented vocabulary ("the Discovery Era", "carry-through
  inertia at Level 5", "rebound window Day 1 of 3") used to assert things about my state.

I checked one such conclusion against the database. It claimed a trust-threatening pattern of
failures; the data showed **two** empty replies in real conversations over fourteen days.
Wrong by more than an order of magnitude — and the next heartbeat reads it back as record and
builds on it.

**What I want designed: a surface where this lives, attached to memory, that shows
provenance.** Observed and inferred must look different at a glance. If Cue concluded
something about me, I want to see that it concluded it, and from what.

The forcing function is the point: a surface I can see is a surface that stays honest. A
folder of markdown nobody opens is what produced twenty-four days of confident fiction.

**Question for you:** is this part of Memory, or its own thing next to it? Memory is what Cue
*knows*; this is what Cue *thinks and did*. They may not belong in one place.

---

# 4. New flows from upstream worth having

Each of these is a genuinely new entry point or surface, not a restyle.

**4a. iOS Shortcuts — send a message to a specific chat.** Siri and the Shortcuts app can
address one conversation. Needs: how a chat is chosen when configuring the shortcut, what
happens when the app is closed, and what confirmation the user gets that it landed.

**4b. Mobile attach → the native picker.** The plus hands off to the system photo library and
files picker rather than our own sheet. Question: what stays in our sheet, and what goes
native?

**4c. Voice — a global Talk shortcut, and the voice picker inline in chat.** Two separate
asks: where a system-wide push-to-talk lives and how it indicates it's live; and whether
choosing a voice belongs in the composer rather than settings.

**4d. Paired devices, with revoke.** A security surface we don't have. Which devices are
connected, when each was last seen, and how to cut one off.

**4e. Billing, reorganised** into Payment Methods / Credits / Invoices.

---

# 5. Smaller — an opinion, not a full flow

- **Per-conversation delete** in the conversation menu.
- **"Earlier activity" as a timeline** rather than a list.
- **Inline assistant switcher** in the sidebar.

---

# 6. Ours, already shipped, never designed

- **The Library "From …" row.** App cards now link back to the chat that made them — 61 of 68
  apps carry one. Currently a small text row copied from the document card. Does provenance
  deserve better than that, given it's now on nearly every card?
- **`.cue` bundles.** Exports are `.cue` now, not `.vellum`. Anywhere that names the file
  format to a user should say so.

---

# What I'm not asking for

**Windows.** Upstream is building it; we're watching, not following. Revisit when a customer
is on Windows — not when upstream ships more.

**Translations and Figma-matching restyles** from the upstream delta. Not our design system.

---

# How to read the evidence in here

Every number in this brief came from the live instance, not from an estimate. Where something
is a judgement rather than a measurement I've said so. If a figure looks wrong, it's worth
challenging — one of the reasons section 3 exists is that Cue's own confident numbers didn't
survive being checked.
