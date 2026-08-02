# v19 — five surfaces with nowhere to go, and one finding

**2026-08-02.** Adopting v19. Two things back.

---

## 1 · Five existing surfaces are not in Your Cue's eleven

v19 names eleven tabs. The app today has an Intelligence shell — which is
structurally the same thing and the natural base for Your Cue — carrying **five
more that the eleven do not account for**:

| Surface | What it is today | Our guess, offered only so you can reject it |
|---|---|---|
| **Channels & Agents** | where a source gets connected (Gmail, WhatsApp, Slack) | folds into **Watching** — connecting is the setup half of what Watching reports on |
| **Connections** | the contact/channel binding list | folds into **People** — it is the plumbing under a relationship |
| **Cue Live** | the live voice/screen session | not config at all. A *mode*, like Voice — belongs on the composer |
| **Workspace** | working directory, file roots, sandbox config | **Preferences** |
| **Plugins** | installed extensions | **Marketplace** or **Tools & apps** — probably the same shelf |

We have deliberately not moved any of them. Under your own rule the answer is
not obvious in at least two cases, and these are real surfaces with real state
behind them:

- **Channels & Agents does not clearly "only change one thing and leave."**
  Connecting a source is configuration, but the page also shows what is
  connected and whether it is healthy — which accumulates.
- **Cue Live is the one we are most confident about and least sure you intended.**
  It is not configuration in any sense; treating it as a tab would be the same
  category error v19 corrects for People. But v19 does not mention it, and
  putting a live session on the composer is a bigger move than a nav one.

**What we need:** where each of the five goes. If the answer for some is "delete
it", that is a fine answer and we would rather hear it than quietly bury them in
a twelfth tab.

**Why we are asking rather than deciding:** v19's cap is asymmetric on purpose —
a twelfth config surface costs a tab, a sixth destination has to prove it
accumulates. Five surfaces arriving at once is exactly the pressure that cap
exists to resist, and we would rather not be the ones who quietly spend it.

---

## 2 · People cannot carry a destination slot yet, and we found out why

v19 promotes People on the rule that it **accumulates**. That is the right rule,
and it is the right answer for what People *should* be. On the owner's live
instance:

| | |
|---|---|
| Contacts | **2** |
| Contact memories | **0** |
| `contact_memory_extract` jobs, all completed | **697** |

Six hundred and ninety-seven successful extraction jobs that wrote nothing. Years
of real correspondence through a working mail watcher, and Cue has learned about
nobody.

**Your own spec describes this bug.** v17 E3's no-op card reads *"Contact
extraction ran 718× and found nothing — that's a bug, not a quiet week."* You
wrote that as an illustration. It is live.

So N2's frame is not wrong — it is a description of a surface whose data pipeline
is broken. We are fixing extraction first and promoting People afterwards, on the
same reasoning that made us delete an empty CHANNELS heading from the rail last
night: a prominent destination with two rows in it teaches people to ignore that
slot, and the slot is expensive.

**No design change requested.** Flagging it because it affects sequencing, and
because the honest-empty-state work you specced turns out to be load-bearing
rather than decorative — it is the mechanism that would have surfaced this in a
day instead of months.

---

## 3 · Adopted without question

The rule itself. *"Does the data accumulate"* replaces *"does it demo well"*, and
your reason for the swap is the part worth keeping: demo value is a judgement
call and it drifted. Accumulation is a property you can check, which is why the
cap can be asymmetric without being arbitrary.

Also adopted: retiring People-as-a-Memory-tab. Memories about a person inform
People; they are not the interface to it. That was our open question from the
last round and it is now closed.
