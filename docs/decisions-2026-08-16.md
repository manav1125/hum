# Open decisions — 16 August 2026

Everything currently waiting on a judgement call, in plain English. Nothing here is blocked on
engineering: the work is either done, or it is small and waiting on which way you want it.

Fourteen decisions, grouped by who can actually make them.

- **1–4** are yours alone — security, money, and autonomy. Nobody else can make these.
- **5–10** are product calls. Section "For design" at the end is the forwardable version.
- **11–14** are direction: what Cue becomes next.

---

# Part A — Only you can decide these

## 1. Rotate three secrets

**What happened.** On 10 August I ran a command on your production machine that printed its
environment, which dumped three live secrets into our conversation: the token signing key, the
OpenRouter API key, and the ElevenLabs API key. That was my error.

**Where it stands.** They have not been rotated. They have been sitting exposed for six days.

**What each one is worth to someone who has it.** The signing key mints tokens that impersonate you
to your own instance. The OpenRouter key spends your money. The ElevenLabs key spends your money.

**The decision.** Not really whether — when. The only real question is whether you want me to walk
you through it or do the parts I can while you handle the vault.

**My recommendation.** Do it this week. The exposure is in a private transcript, not a public repo,
which is why this is urgent rather than an emergency.

---

## 2. Let Cue click things in your browser when you are not watching

**What happened.** Your `✈️ CX784 Check-in` task on 31 July failed, and now we know exactly why.
Cue could see the airline site perfectly — it navigated, took snapshots, read the page — but every
single click was refused with *"requires user approval but no interactive client is connected."*
It then spent fifteen minutes trying to hack around a site that needed a button pressed.

**Why.** Browser clicks and typing count as medium-risk actions. Background tasks — anything running
without you present — automatically deny anything above your approval threshold, and yours is set
to Strict with no exceptions defined. So a background browser task can look but never touch. Always.
By design, just not a design anyone chose deliberately.

**Your options.**

- **(a) A narrow rule.** Allow only `browser_click`, `browser_type` and `browser_press_key` to run
  unattended. Everything else — email, money, files — stays exactly as strict as today.
- **(b) Raise the background threshold to medium.** Simpler, but it lifts the floor for *every*
  medium-risk tool, not just the browser.
- **(c) Leave it.** Unattended browser tasks keep failing. Browser work only happens while you watch.

**The honest risk.** This is a real loosening. After the July incident where a background run emailed
a partner without approval, you set this posture deliberately. A browser click can do consequential
things — submit a form, confirm a booking, accept terms. The difference from July is that this is
scoped to one narrow class of action rather than a trust rank that turned out to cover sending.

**My recommendation.** (a). It fixes the actual failure with the smallest possible widening, and
keeps every irreversible category untouched. But I did not want to make this one for you.

---

## 3. Turn on the daemon privilege drop

**What it is.** Today Cue's main process runs as root inside its container — full privileges. The
privilege drop makes it run as an ordinary user instead, so that if anything ever went wrong, the
blast radius is much smaller. The gateway keeps the sensitive material; the daemon can no longer
read it.

**Where it stands.** Ready. It broke production once when we tried it in August, that cause is
fixed, and the rehearsal this week found and fixed a second one — a storage path that would have
silently disabled all memory features while the health check stayed green. Both fixed and shipped.

**The decision.** Whether to flip it, and when. It is one command with an identical one-command
rollback, no rebuild needed either way.

**The risk.** The failure mode is quiet. A health check will say everything is fine while something
underneath is broken — that is exactly what the rehearsal caught. So it should be flipped while
someone is watching the first boot, not last thing at night.

**My recommendation.** Do it, but at a moment when you can give it ten minutes. I will watch the
specific lines that matter.

---

## 4. Reconnect Notion and HubSpot

Both connectors are expired. Anything Cue produces can be sent to Google Docs and Drive today, but
not to those two. It is an OAuth reconnect in settings — a few minutes, and only you can do it.

Related: **Slack file delivery** needs a choice between two credentials — the Composio connection
(already authorised, works today) or Cue's own Slack bot token (never configured on production).
My recommendation is Composio, because it needs no new secret and is already working. Say if you
would rather it went through Cue's own bot.

---

# Part B — Product calls

## 5. What counts as "a memory" when we say a memory was used

**The goal.** Memory entries should show how often they have actually been used — "applied 12 times".
It makes memory feel alive instead of a static list, and it tells you which memories are earning
their place.

**The problem.** We have two different systems that both have a claim to being "a memory", and
there is no link between them.

- The Memory screen displays one kind of record — the concepts in the graph you can see and click.
- The only real usage history we keep is recorded against a *different* identifier — a page slug
  like `people/alice`.

There is no join between the two. So:

- **Count the thing on screen:** correct against what you are looking at, but every existing memory
  starts at zero and the counts build from today.
- **Count the slug:** real numbers immediately, but they describe a slightly different object than
  the one displayed, so a count could look wrong next to the memory it sits under.

**Why it is not just an engineering choice.** Whichever we pick becomes the identity of a memory
throughout extraction, consolidation and routing. It is hard to change later.

**One thing to ignore.** There is a third table that looks like it already solves this. It does not —
it gets pruned on compaction, so the count *falls* as a memory gets used more. It is written down so
nobody rediscovers it and trusts it.

**My recommendation.** Count the thing on screen and accept starting from zero. Honest and simple,
and "applied 12 times" is only meaningful going forward anyway.

---

## 6. Should Cue name the AI companies it uses?

**The situation.** In Settings → Voice, a card lists which service transcribes your speech, naming
"Google Gemini", "OpenAI Whisper" and "xAI" directly. There is an automated guard in the codebase
whose job is to catch exactly this and force someone to decide, rather than letting vendor names
appear by accident. That guard has been failing since 12 August because nobody registered a decision.

**The tension.** Cue is a product with its own identity — it never says it was "trained by Google",
and voice explicitly refuses to mention Gemini. But this card is telling you a factual thing about
your own setup: which company's servers hear your voice. Hiding that arguably serves the brand at
your expense.

**Your options.** (a) Keep the real names, and record the exemption with the reason. (b) Use neutral
descriptions. (c) Hide the card unless you are in developer mode.

**My recommendation.** (a). Which company hears your voice is a privacy fact, not branding, and this
is a settings screen for the owner. But the guard exists to make this deliberate, so it should be
written down either way.

---

## 7. Slack messages on your phone hide their own actions

**What happens.** On a phone, tapping a message reveals its action row — summarise, bookmark, fork.
Tapping a message that came from Slack instead jumps you straight to Slack, so **you can never reach
those actions for any Slack message on mobile.**

**The catch.** This is deliberate — there is a test pinning that behaviour on purpose. The row
already contains its own "Open in Slack" button, so revealing it would lose nothing.

**Your options.** (a) Tap reveals the row, and "Open in Slack" inside it does the jump. (b) Leave
as is. (c) Long-press reveals, tap still jumps.

**My recommendation.** (a). The jump is still one tap away, and it makes every message behave the
same way. Already being fixed in a background session — say if you want it differently.

---

## 8. Wide tables in PowerPoint

**Context.** We fixed Word breaking numbers in half on wide tables — `$174,000` rendering as `$1740`
and `00` on the next line. The fix shrinks the text until every column fits.

**The same bug exists in PowerPoint, and we deliberately did not apply the same fix.** On a slide
there is a hard readability floor around 10–11pt. Shrinking a ten-column table until it fits makes a
slide nobody can read from across a room — technically correct, practically useless.

**Your options.** (a) Split wide tables across slides. (b) Apply the same shrink and accept small
type. (c) Refuse and tell you the table is too wide for a slide, suggesting a document instead.

**My recommendation.** (c) now, (a) later. Being told "this belongs in a document" immediately beats
an unreadable slide, and splitting well is real work.

---

## 9. A colour that drifted in dark mode

Two colour tokens are meant to be identical in dark mode and are not. Purely a design call — I am
not guessing at a brand colour. Detail in the design section.

---

## 10. Voice: finish the fast path, or delete it

**How voice works today.** Two engines, and they trade against each other.

- **Realtime** is what you use. Google's speech-native model hears you and speaks back in about two
  seconds. Fast and natural — but it is a small model doing its own thinking with a limited toolset.
  This is why voice answers shallowly while chat answers well. Same question, different brain.
- **Classic** transcribes you, sends it to Cue's real brain, then speaks the answer. Much better
  answers, about eight seconds to first sound — too slow to feel like conversation.

**What the "front door" was.** An attempt to get both: a tiny fast model that detects the instant you
stop speaking so the real brain can start answering earlier. We built it. It has never been switched
on, and right now it *cannot* be — a missing piece means its internal decision markers would leak
into your chat transcript. Meanwhile upstream deleted the file ours is built on and replaced it with
a different design.

**Your options.**

- **(a) Make it switchable** (small), then decide with it in front of you.
- **(b) Delete our version** and stop carrying code that does nothing.
- **(c) Adopt upstream's new design** (large) — their approach starts the real answer immediately and
  uses its first token to decide whether you had finished talking.

**My recommendation.** (a) first — it is small, and it turns an abstract argument into something you
can try. Then decide between (b) and (c) having heard it.

**Separately, the real lever on answer quality** is that voice gets 14 tools and a small model while
chat gets everything. That is worth its own decision once you have made a real call on the new
prompt — the fixes shipped this week are unproven until you do.

---

# Part C — Direction

## 11. Do you want more than one person in Cue?

**What upstream has, since you asked.** Almost nothing. I checked their code directly rather than
trusting our notes, and I had told you the opposite twice, so this is corrected.

Their "organisation" is a **billing container**, not a team. It holds credits, subscription and
invoices, and a list of assistants. It does not hold conversations, memory, connectors or skills.
Their entire platform API has **zero** mentions of member, role, permission, invite or seat. Their
gateway — the part that decides who may talk to the assistant — has no organisation logic at all.

Their actual multi-person model is one **guardian** plus **contacts**: contacts can message the
assistant, get no memory access, and everything escalates to the guardian. Their own code says:

> "Each assistant instance serves exactly one guardian. Multi-guardian is not supported and will
> never be."

So one instance per person is their deliberate stance, not a gap we are behind on. And our `hq/`
already does the same job as their platform.

**Which means this is a genuine product decision, not a catch-up.** Four shapes, costed honestly in
`docs/upstream-multiuser-2026-08-16.md`:

- **(a) Contacts as they are.** Colleagues can message your Cue. Nearly free, deliberately weak.
- **(b) Shared memory or connectors between separate instances.** Everyone keeps their own Cue but
  some knowledge is common. **Caveat: this removes a trust gate by construction** — worth reading
  before choosing.
- **(c) An org layer in `hq/`** above independent instances — shared billing, shared provisioning,
  separate assistants.
- **(d) True multi-tenancy** — one instance, many users. The largest, and the one that changes the
  security model most.

**No recommendation.** You said you wanted to see options, and this one depends on what you want Cue
to be. Worth saying: nobody upstream is building this, so it is greenfield either way.

---

## 12. Four upstream features I should not have closed

I marked these closed in my recommendation. That was overstepping — you were right to call it.
Reopened as options, honestly labelled:

- **Discord.** Upstream has a working Discord channel — mention-only, with an operator allowlist
  where an empty list admits nobody. Same shape as our other channels. Real, shipped code.
- **Teleport.** Upstream has real flag-gated code for it. **I know it exists and is not roadmap; I do
  not know what it does functionally.** I would rather find out than guess — say the word.
- **Splitting logs into their own database.** I called this obsolete because we already have log
  retention. That was my judgement, not a fact.
- **Memory map next steps.** Worth flagging: the "phases 3–4" I have been citing **do not exist** in
  the code. The 3D map is built; that label was mine, not a real plan. So the question is what you
  want it to do, not whether to finish something.

---

## 13. Chrome Web Store — submit or stay sideloaded

Your browser extension works and is paired right now. It has **never been submitted to the Chrome Web
Store**, so it is installed as an unpacked development extension. That works, but Chrome nags about
developer extensions and it will not survive a clean profile.

**Your options.** (a) Submit it. (b) Stay sideloaded.

If you submit, the store assigns a new id that has to be reconciled in two places in our code, and
there is one stale build artifact that should be deleted first — it carries the same version number
as the working one but cannot pair with a cloud instance at all, which would strand anyone who
installed it.

---

## 14. How closely to track upstream

Today we re-analyse upstream every two to three weeks. The evidence says that is too often: in the
most recent window, of 182 upstream commits only nine were candidates for us and five were already
done. Nearly half their work was web churn and translations, and they shipped nothing at all to
Slack, Telegram, WhatsApp, email, phone or Discord.

**Your options.** (a) Monthly, narrowed to security, the core loop, and voice. (b) Keep the current
cadence. (c) Only look when something specific prompts it.

**My recommendation.** (a). We are not behind them; we are paying to keep checking.

---

# For design

Five items. Everything below is either a visual decision or a question about how a surface should
behave — none of it is blocked on engineering.

### D1. Slack messages hide their own action row on mobile
Tapping any message on a phone reveals its actions. Tapping a Slack-sourced message jumps to Slack
instead, so those actions are unreachable for Slack messages. The row contains its own "Open in
Slack" button. **Question:** should tap reveal the row like every other message, or is jumping
straight out the intended behaviour? (Engineering view: reveal — nothing is lost.)

### D2. Dark-mode colour drift
Two tokens meant to be identical in dark mode are not: `--mv1-blue` resolves to `#86a9f2` where
`--mv1-blue-text` expects `#3d6ee8`. **Question:** which is correct?

### D3. Naming AI vendors in settings
The Settings → Voice card names Google, OpenAI and xAI as the services that transcribe speech.
**Question:** real names, neutral descriptions, or hidden behind developer mode? Context: Cue never
names vendors elsewhere, but this is a privacy-relevant fact about the owner's own setup.

### D4. Wide tables on slides
Tables too wide for a slide currently break. Shrinking type until they fit produces unreadable
slides. **Question:** split across slides, shrink and accept, or refuse and recommend a document?

### D5. Still outstanding from the mobile brief — the biggest one
The **Morning Brief** and the **Weekly review** are both finished, data-bound surfaces with **no way
to reach them**. The Brief opens only from an iOS push; the Weekly review has no entry point at all.
Both are time-based rituals — a morning beat and a Friday beat — and mobile has three tabs and never
a fourth. **Question:** where do they live? Options drawn previously: a time-aware slot on Today, a
dated entry in the HQ header, or a "rituals" grouping in the ⋯ menu.

Also still open from that brief: whether the desktop-organizer remote is worth completing or should
be withdrawn until its backend exists, and whether the Create surface's "v27 mock" is still the
reference.

### Not a design question, but design should know
The Create gallery had nested buttons, which meant the EXACT/INSPIRED toggle could not be reached by
keyboard and the card had no accessible name at all. Fixed this week — the gallery is pixel-identical,
verified by measuring all 301 elements before and after.
