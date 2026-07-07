# Cue Create Studio — Claude Design brief, round 2 (additions)

Round 1 (`Cue-Create-Studio.html`) is approved and being built. This round asks only for the
**gaps and extensions** — same visual language (`--mv1-*`, dark-first + light, serif/DM-Mono,
~15px cards), desktop + 390px mobile, static HTML like before. Everything from round 1 stays.

## 1. Gallery variants not yet drawn (Video · Canvas)
Round 1 covered Slides, Image, Data, Docs. Add the two remaining modes, same overlay pattern:
- **Video → "Choose a style"** — cinematographic style cards (Cinematic, Product, Animation,
  Nature, Abstract, Adventure), square video-still thumbnails, same header/tabs/"Take AI direction"
  /"In your brand" toggle / composer chip as the Image picker.
- **Canvas → "Choose an action"** — action cards (Create new · Edit image · Upscale · Remove
  background), each a small illustrative tile. Simpler than a style grid.

## 2. Reference drop — "make it look like this" (optional in round 1, please add now)
A composer affordance to borrow a look for ONE generation (distinct from the saved Brand Kit):
- The drop target in/near the composer (drag an image or paste a URL).
- The resulting **"Reference: <thumbnail>"** chip alongside the Template/Style chips.
- The tiny "extracting the look…" state.

## 3. Live preview in the gallery (optional in round 1, please add now)
Hovering (desktop) or long-pressing (mobile) a template card swaps the demo thumbnail for **the
user's own content/brand** rendered in that template. Show: the default card, the hover/preview
state, and a small "previewing your content" label.

## 4. "Make variations" result (round 1 showed the trigger, not the result)
After tapping **Make variations** on an output: a **grid of N alternates** to compare, each a card
with a select control, plus a **"Pick this" / "Merge selected"** action bar. Desktop + mobile.

## 5. Multi-format fan-out / "asset kit" (GREEN-LIT — in scope)
One brief → several coordinated assets (e.g. deck + one-pager + 3 social images), all in-brand,
produced together. Design:
- The **"Also make…" chooser** in/near the composer — pick the extra formats up front (a compact
  multi-select of Deck / One-pager / Social set / Doc / …), shown as a chip like "Kit: deck +3".
- The **kit result view** — the set shown together (a labeled grid/stack), each asset previewable +
  downloadable, with a per-asset **"regenerate"** control and a top-level **"regenerate all in
  brand"**. Show the in-progress state (assets filling in one by one) and the done state.
- Desktop + 390px mobile.

## Anything else that would help the build
- **Fidelity control on a template card** when a template supports both exact + inspired renders:
  a small toggle or segmented control on the card ("Exact | Inspired") rather than a static badge.
- **The gallery entry point on the Create page** — a clear **"Browse templates / styles →"**
  affordance beside the existing mode chips (the chips stay as inline filters; the affordance opens
  the overlay). One small state for that button.

Deliver dark-first (light where it matters), desktop + 390px mobile.
