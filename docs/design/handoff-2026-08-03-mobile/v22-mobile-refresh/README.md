# v22 — mobile refresh (2026-08-03) · answers R1–R5

Eight frames at 390×844. **Your recommendations were right on R1, R2, R3** — taken as written. R4 and R5 ruled differently, both about consequence.

## The rulings

**R1 · Four tabs: HQ · ◉ · Work · People.** Library into the ⓶ menu's top group. **Agreed.** Adding to your reasoning: People is the only destination whose value is legible in a two-second glance — *"Sarah's going quiet"* lands on a phone in a way a file list never will.

**R2 · One name: Your Cue, both platforms.** **Agreed.** "You" wasn't a deliberate voice choice — it predates the door existing, and it's wrong twice: it's about *Cue's* setup, and the phone's leaf set had drifted. Same 18 leaves, same 5 groups, same order as v21's desktop shell; pushed list instead of leaf column.

**R3 · Same model, filters as a segmented control.** **Agreed.** One addition: when there's no search quote, **fall back to the last message's opening words**. That's data you have, and a bare title list is worse than an approximate preview.

**R4 · Both states come to the phone — and Approve is NOT inline.** You asked inline-or-sheet; the answer is **neither**. The row gets one **Review** button that opens a sheet showing amount, recipient, which ceiling was hit, and that it can't be recalled. An inline Approve on £4,200 is a mis-tap away from a real transfer, and a two-button row at 390px puts destructive and constructive 8px apart. In the sheet: **Approve is full-width and alone**; Not now / Decline share a second row.

**R5 · Bottom sheet, plus two changes.** The orbit **scales to 40% as the sheet rises** rather than being cropped — the brand moment survives the keyboard. Detents: 55% at rest, 90% with keyboard. And **consent becomes three cards, not one wall**: read-and-organise (on), draft-and-prepare (on), **send-and-spend (off)** — with the real norm stated, *"most people leave this off for the first week."*

## Frames
- **M1 HQ** — four tabs; paused-run row leads with single Review; ⌗ row with italic quote; §3 chrome fixes in-frame
- **M2 ⓶ menu** — two groups: Accumulating (Library, All conversations) then Your Cue's four most-touched leaves + door to all 18. **This is what lets you delete `CUE_NAV`.**
- **M3 People** — cards not rows; relationship state tints the card border
- **M4 Approval sheet** — the R4 resolution
- **M5 Your Cue** — pushed list, 18 leaves; **"Mac only"** on Cue Live is the honest label
- **M6 Conversations** — segmented control, "By thing" opens a sheet, recency buckets as headers
- **M7 Sign-in** — scaling orbit + sheet
- **M8 Consent** — three cards

## On §3
Two of the four were **design faults, not defects**: my spec put a settings door in the corner without ever drawing the corner. Fixed at source — the avatar *is* the door, in its own chrome row above the eyebrow.

**On the contrast note in §5:** **seventh** recurrence — and the seventh landed in this pack, on M5's ten disclosure chevrons, in the frame whose whole purpose was to demonstrate "pushed-list shape". The chevron *is* that shape signal, so an invisible chevron meant the frame failed to show the thing it was drawn to rule on. Fixed to `#9A9AA8`; Sarah Chen's avatar also darkened to the `#0A6A6A` text variant.

**This is now a build instruction, not a footnote.** Rename the tokens to carry their ground — `--muted-on-dark` / `--muted-on-light` — because a bare hex will keep being typed onto the wrong ground. Seven attempts at vigilance have failed; the fix has to be structural.

## The rule that prevents the next divergence
- **A desktop IA change is a mobile change** (§0 is the most useful thing in your brief). Any pack moving a destination must say what the phone does — even if that's "nothing".
- **Four tabs is the ceiling and it's full.** A fifth destination displaces one; it doesn't get added.
- **Consequence sets the interaction, not space.** Reversible actions can stay inline.
- **Pointer type, not width.** These frames assume coarse pointer.
