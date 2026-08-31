# Halo on mobile — onboarding, connection, and the day it produces

**30 August 2026** · For design · Companion to [`cue-halo-hardware-plan.md`](cue-halo-hardware-plan.md)
Target surface: `apps/web/src/mobile-v3/` · Build state: the ingest door is live (`/v1/chat/completions`, `/v1/audio/transcriptions`); no Halo screens exist yet.

---

## What we are designing

The moment somebody takes a Halo out of the box, and every moment after it where they need to know it is working. Then the surface that makes wearing it worth it: **their day, understood.**

This is not a settings page with a pair button. A device that listens to someone's life has to keep answering three questions, silently and continuously, or it gets taken off and left in a drawer:

1. **Is it on, and does Cue have what it heard?**
2. **What did it do with what it heard?**
3. **Can I stop it right now?**

Every screen below exists to answer one of those. If a screen answers none of them, cut it.

---

## The hardware truths that constrain every screen

These are verified against the firmware protocol spec, not assumed. Designing past any of them produces a screen we cannot build.

**It records; it does not stream.** No Bluetooth audio profile at all — the Clip is never a microphone the phone can open. Audio is written to the device, then synced. The best case is ~20-second segments arriving continuously while recording, so **Cue is always a little behind the room, never in it.** Nothing may imply live listening: no waveform that claims to be current, no "Cue is hearing this."

**One phone, forever.** The device bonds to exactly one central. Pairing it elsewhere clears the bond *and formats the card* — including audio not yet synced. Any screen that can trigger re-pairing is a destructive action and must be dressed as one.

**One button, one meaning.** Long-press records; **a single click while recording drops a bookmark**. There is no second gesture, no wake word, no push-to-talk. That click is the only thing a person can say to Cue with their hand, so the product should treat it as a first-class verb — "this matters" — and the UI should show that it landed.

**Nothing comes back out.** No speaker, and no way to put text on the device's own display. Every reply, confirmation and question happens on the phone. The device's only outputs are a vibration and its own status screen.

**Capture is bounded by battery and storage, not by the app.** ~14–18 h recording, ~250 h of audio buffered on-device. The buffer is a feature: the phone does not have to be in range, and sync catching up later is normal, not an error.

---

## Two phases, one design

**Phase A — the bridge (now).** Capture and sync happen in Seeed's SenseCraft Voice app; Cue receives the finished transcript through the OpenAI-shaped door. Cue owns understanding, not capture.

**Phase B — native (later).** Cue's own BLE plugin takes over pairing, sync and status; the other app disappears.

**Design for B, ship the screens that also work in A.** The steady-state surfaces — the Halo card, the Day, a capture detail — are identical in both. Only onboarding differs, and only in the middle. So: design the full flow, and mark the two or three steps that are stubbed in A. Do not design an A-shaped product; we would throw it away in six weeks.

The one thing to be honest about in A: **audio passes through Seeed's cloud on its way to Cue.** That is a fact about the bridge, not about Halo, and it must not be papered over on the privacy screen. It is also the strongest argument for B.

---

## Onboarding — the flow

Seven steps. The shape to protect is that **the device proves itself before it asks for anything.**

**1 · Recognise.** Cue notices a Halo nearby and offers to set it up, rather than making the person find a menu. In A this is a manual entry from You → Devices; design the automatic version and let the build downgrade it.

**2 · The promise, in one screen.** What it does, said plainly, before any permission is requested. This screen is where the product is either trusted or not, so it carries the three things people actually want to know: what is recorded, where it goes, and how to stop it. Not a wall of policy — three lines and a link.

**3 · Bluetooth permission.** Requested here and nowhere earlier, with the reason stated in the sentence above the system prompt. Design the denied state as a first-class screen, not a toast: iOS will not ask twice, so the only route back is Settings, and the screen has to say so.

**4 · Pairing, with the bond warning.** The single-bond rule surfaces here: *"Halo can only be linked to one phone. Setting it up here will erase anything it has not yet sent."* If the device is already bonded elsewhere, this is where that is discovered — and the recovery is destructive, so it needs a deliberate confirmation, not a default-styled button.

**5 · The first capture.** Not a settings toggle — a thirty-second guided recording. Ask them to say something real, press the button once to bookmark it, and watch it arrive. This is the step that teaches the only gesture the device has, and it is the first proof that the loop closes.

**6 · What Cue may do with it.** The autonomy question, asked once, in Halo's own terms: *Cue proposes, you approve* (the default, matching how screen observation already files everything parked), or *Cue acts on the obvious ones*. Not a permissions matrix. One choice, changeable later.

**7 · Wear it.** Where the button is, what the buzz means, how to pause, and what happens when the phone is out of range. Then out — into the Day, empty and waiting.

---

## The steady state — three surfaces

### A · The Halo card — "is it on, and does Cue have it?"

Lives on **Today** and in **You**. Small, glanceable, and honest about lag. It carries: recording or paused, battery, and **how far behind the sync is** — the number no consumer device shows and every wearer wants. "Up to date" and "12 minutes behind" are both fine; silence is not.

It is also the **pause control**. One tap, from the first screen, always reachable. A pause that takes three taps is a pause nobody uses, and an always-on recorder whose stop button is buried is a product people are right not to trust.

Consider the iOS Live Activity for an active capture — `live-activity-plan.ts` already owns this pattern for work-item runs, and "Halo is recording" is a better fit for the Island than most things in it.

### B · The Day — the reason any of this exists

The timeline of what was heard, as **episodes**, not a wall of transcript: a stretch of conversation with a start, the people in it, what was decided, and what Cue proposes to do. This is the surface with no precedent in Cue today — Mission Control is lanes, Notes is a rail, and neither is a day.

Design questions that matter more than the styling:

- **What is an empty hour?** Most of a day is silence. The timeline must compress it without making the day look empty, and without implying Cue was off.
- **What does a bookmark look like?** It is the only human signal in the whole stream and should be visually louder than anything Cue inferred.
- **How does a proposal read before it is accepted?** Everything Halo files is parked by default. The card has to show a proposal as a proposal — reviewable, dismissible, not yet real — or HQ fills with things nobody agreed to.
- **What happens to a wrong one?** Dismissal has to be one gesture, and it should teach: `swipe-archive-row` and `undo-toast` already exist.

### C · A capture — the detail view

One episode, opened: transcript, who spoke, the bookmarks, what Cue extracted, and the thread it created. Also where **delete** lives, and delete has to mean it — the audio and the transcript, gone.

---

## The states that get forgotten

Any device UI that omits these ships a product that looks broken when it is merely offline. Design each one; none should be a toast.

| State | What the person needs |
|---|---|
| Never paired | The setup door, from the same card |
| Out of range | Reassurance, not alarm — it is still recording, sync resumes |
| Sync behind | How far, and that it is moving |
| Bonded to another phone | The destructive-recovery path, dressed honestly |
| Battery low | Before it matters, not at 2% |
| Storage full | What Cue will delete, and when |
| Paused by the wearer | Unmistakable, and impossible to leave by accident |
| Bluetooth denied | The Settings route, spelled out |
| Transcription unavailable | Audio is safe, understanding is delayed |
| Nothing worth surfacing | An honest quiet day, not an error |

The last one is a product position: a day with nothing in it should look like a calm day, not a failure.

---

## What we are not designing

- No live waveform or "listening now" affordance. The hardware cannot honour it.
- No on-device replies. There is no speaker and no text output.
- No multi-device management. One person, one Halo, one phone.
- No transcript editor. Fix understanding at the proposal, not the words.
- No separate Halo tab. It is a source that feeds Today, Notes and Activity — a fifth tab would make it a destination, and it is not one.

---

## Decisions owed

1. **Where does the Halo card live** — Today, You, or both? Recommendation: both, one component.
2. **Is the Day a new surface or a mode of Today?** Recommendation: new surface, reached from the card, because a day has a shape Today does not.
3. **Default autonomy for Halo captures** — parked-and-propose, or auto-run the obvious? Recommendation: parked, matching screen observation, and revisit after a week of real use.
4. **Retention default** — keep audio, or transcribe-and-discard? Recommendation: discard, matching what the screen pipeline already does with frames, with keeping it an explicit choice.
5. **How loud is the privacy story on the phone?** A visible recording indicator in-app is easy; the device's own indicator is a hardware decision, and the Halo page already promises one.
