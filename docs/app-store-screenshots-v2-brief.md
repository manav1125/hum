# Screenshot brief v2 — remove the device frames

**Why this exists:** Apple rejected Cue 1.0 on **Guideline 2.3.10 — Accurate Metadata**.
Their instruction, verbatim:

> Revise the app's screenshots to remove non-iOS device images.

Everything else about the v1 set was fine. Captions, colour-per-story, composition,
content — all of it survives. **This is a frame problem, not a design problem.**

---

## What went wrong

The v1 set placed every screen inside a device mockup, and the design notes chose that
frame deliberately:

> Neutral dark bezel with a pill notch — generic, no brand marks.

That was reasoned as *safe* (no Apple marks to infringe, no hardware Apple doesn't sell).
It backfired. A bezel that is deliberately **not** an Apple device reads to a reviewer as
a **non-Apple device** — which is exactly what 2.3.10 prohibits. Frame `08-control` is the
clearest case: three generic handsets fanned together.

The trap: there is no safe middle. A generic frame looks non-iOS; an Apple-accurate frame
risks the opposite objection and has to track current hardware.

## The fix

**Ship frameless.** No bezel, no notch, no device silhouette, no hand holding a phone, no
laptop or monitor behind. Just the app's own interface.

This is what most App Store galleries do, and it removes the entire category of objection
rather than trading one risk for another.

### Two ways to lay it out — either is fine

1. **Full-bleed.** The app UI fills the whole 1284 × 2778 frame. Headline and subhead
   overlay the art, or sit in a band at the top over the app's own background.
2. **Inset card.** The app UI as a plain rounded rectangle (corner radius ~48px at this
   size), floating on the story colour, with the headline above it. No bezel, no notch
   cutout, no camera dot, no side buttons — a screenshot, not a device.

Option 2 keeps the v1 composition almost intact: take each existing frame, delete the
bezel layer, and let the screen art become a plain rounded card. That is likely the
fastest path and preserves the caption rhythm.

## What must NOT change

The v1 set was reviewed and approved by the owner. Keep:

- All nine frames, same order, same filenames (`01-today.png` … `09-voice.png`)
- The captions exactly as they are
- The colour-per-story scheme, the accessory rows (chip rails, stat bands, callouts)
- The fictional content — Alex, Dana, Sarah Chen, Acme. **No real names or data.**

## Hard specs — unchanged from v1

| Spec | Value |
|---|---|
| Size | **1284 × 2778 px** portrait (6.5" slot) |
| Also required | **1320 × 2868 px** (6.9" slot) — rescale from the 6.5" masters |
| Format | PNG, **no alpha channel**, sRGB |
| Count | 9 |
| Naming | `01-today.png` … `09-voice.png` |

⚠️ **No alpha.** The v1 delivery had an alpha channel on every file (fully opaque, but
present) and App Store Connect rejects that. Export flattened, or it needs stripping again
before upload.

## One content fix while you're in there

Frame **02-create** shows garbled in-product copy on the Investor pitch deck card:

> ✧ files onto Close the seed

It is a real string from a capture, not a design error, but it reads as broken text and
02 is one of the three frames on the install sheet. Recapture that card with sensible copy
or crop it out.

## Also fixed in this round (context, no action needed)

The other rejection was **2.1(a)** — the reviewer could not sign in without a mailbox.
That is fixed in the app itself: a sign-in link can now be pasted directly into the
"Enter your Cue address instead" field. No screenshot needs to show this.
