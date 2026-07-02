# Presentation Slide Design

Slides are a different domain from apps. Skip app-specific patterns (contextual headers, search/filter, toast notifications, form validation, custom routes). Slides are static content — build navigation and layouts with custom HTML/CSS.

## Key principles

- One idea per slide — understood in 3 seconds
- Layout variety — 3+ different types per deck, never consecutive same-type
- 8 layout types: Title, Stats, Bullets, Quote, Comparison, Timeline, Visual/Immersive, Closing/CTA
- Bold backgrounds — dark, gradient, or strongly tinted
- Max 6 bullets per slide, max 3 sentences body text
- Never go below 15px for any visible text

## Navigation

Build slide navigation as your own component. Common patterns:

- Keyboard: `ArrowLeft` / `ArrowRight` / `Space` / `Escape`
- Click affordances at left/right edges
- Slide counter pill in a corner (e.g. `3 / 12`)
- Optional progress bar at the top

## Layout templates

- **Title** — Centered headline, optional subtitle, no body. Full-bleed background or gradient.
- **Stats** — One huge number, label below, supporting paragraph optional.
- **Bullets** — Heading + 3–6 short bullets. Avoid wall-of-text.
- **Quote** — Pull quote in large italic type, attribution below, contrasting background.
- **Comparison** — Two columns (before/after, us/them, problem/solution). Visual symmetry matters.
- **Timeline** — Horizontal or vertical sequence with dates and milestones.
- **Visual/Immersive** — Full-bleed image, gradient, or generated graphic with minimal text overlay.
- **Closing/CTA** — Headline + single call to action. Mirror the title slide aesthetic.

## What to avoid

- Generic Keynote / PowerPoint aesthetic (default white background, sans-serif body, bullet lists everywhere)
- Tiny text below 15px — slides are read across rooms
- Same layout type used 3+ times in a row — vary the rhythm
- Body paragraphs longer than 3 sentences — split into multiple slides

## PDF export contract (required)

Every deck must be exportable to a shareable PDF via `deck_export_pdf` (one
slide per page, 1280×720). That only works when the deck ships this print
contract — include it in EVERY deck's CSS:

```css
@page {
  size: 1280px 720px;
  margin: 0;
}
@media print {
  .slide {
    display: block !important;
    position: static !important;
    width: 1280px;
    height: 720px;
    page-break-after: always;
    break-after: page;
    overflow: hidden;
  }
  .nav,
  .progress,
  .counter,
  [data-chrome] {
    display: none !important;
  }
}
```

Rules that make the contract hold:

- Author slides at a fixed 1280×720; each slide's root element carries the
  class `slide`.
- On-screen show/hide must be class/CSS-based (not inline `style.display`
  writes) so the `!important` print overrides win.
- No external network assets — inline or data-URI everything (network is
  blocked during export).
- Navigation chrome (arrows, progress bars, counters) gets the `.nav`,
  `.progress`, `.counter` classes or a `data-chrome` attribute so it
  disappears in print.

After building or revising a deck, offer the export: "Want this as a PDF to
send?" — pitch decks intended for investors should always end with that
offer. `.pptx` export is not supported yet; PDF is the shareable format.
