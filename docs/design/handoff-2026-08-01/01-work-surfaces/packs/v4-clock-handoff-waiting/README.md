# Cue work surfaces v4 — direct, don't just respond

One self-contained file: **cue-work-surfaces-v4.html**. 4 frames. Builds on v3 (Life lens, volume, task detail). v1–v3 built a surface you *respond* to; v4 adds the verbs that let you *direct*.

## ⚠ Fixed component — do not drop
**The HQ capture bar** (ring mark + "Tell Cue what you need…" + ⌘K + ◎ mic, directly under the greeting) has now been accidentally regressed twice. It is a permanent part of HQ. The core loop is "talk to Cue anywhere" — the centrepiece cannot be read-only. In v4 its placeholder also teaches delegation: *"or 'take the Halo pricing research' to hand it straight over."*

## Frames
- **Y1 · HQ with the day rail** — 46px rail: commitments, now-marker, **named free block**, and the offer to spend it on the highest-leverage blocked item. Needs-you rows inherit time — "before your 10:30 call — 47 min" (urgency) and "fits this afternoon" (fit). Free-block teal `#0E8C8C`; time is never an alarm state, so it never borrows amber.
- **Y2 · Hand off** — the eighth verb (**H**). Three decisions: *who* (receipts + honest availability — Growth shows busy), *how far it can go* (trust dial scoped to this job, not global; spend cap, check-in, deadline), *when you hear back*. Handed items leave the deck and return only as a result, question, or failure. Gesture lives on row ⋯, multi-select, triage key H, capture bar, and mobile long-press. Census bar gains a fifth segment.
- **Y3 · Waiting** — four states with different right answers: **going cold** (amber, age + "you asked twice" + the person's habit), **on time** (green, "Cue will chase Thu"), **already chased** (escalate, don't re-nudge), **waiting on a system** (nothing to do — saying so is the value). Drafted nudge timed from relationship memory. "Always chase after 5 days" converts a one-off into a standing rule.
- **Y4 · Later** — most laters are **conditional, not chronological**: "after the Acme call", "when Rachel replies", "when the pricing decision lands". Learned default highlighted and explained. **Return contract:** items return with their reason · conditions that never fire surface anyway ("this never happened — still want it?") · snoozed work stays counted in the census and a "Later · 6" filter · snoozing defers *your attention*, not the agent.

## Schema cost
Calendar read (exists via connector) · `delegated_to` + leash record on the work item · `waiting_on` contact ref with last-chased timestamp · snooze storing *either* a timestamp *or* a condition reference. Nudge drafting, free-block suggestion and learned snooze defaults all ride the existing agent loop.

## Still open (second tier)
Recurring work · search results screen · related-item batching · weekly review.
