# Presentation Templates (Create Studio catalog)

Real, pixel-faithful deck skeletons staged under
`templates/presentations/<id>/` — each a set of `slide_NN.html` (1920×1080) plus a
`metadata.json` listing per-slide titles. Lifted from the Mira fork. Demo images
were intentionally **not** bundled (size); the HTML retains its `<img src="…">`
references, so for exact reproduction supply/replace image assets at fill time.

These back Create Studio's two fidelity tiers (see
`docs/cue-create-studio-direction.md`):

- **Tier 1 — design-contract** (ship first): a `TemplateSpec` (palette + fonts +
  layout, in `apps/web/src/domains/create/studio-specs.ts`) is injected as a pinned
  contract; app-builder renders the user's _real_ content in that look. "Inspired by,"
  not pixel-exact. No HTML needed.
- **Tier 2 — pixel-faithful** (later): fill the real skeleton below via DOM
  text/image replacement for exact reproduction. **Generation logic is not wired
  yet** — these files are staged as reference assets only.

`id` matches `TemplateSpec.id` / `sourceHtmlDir` in `studio-specs.ts`.

| id                         | Name                | Slides | Look                                               | When to use                                               |
| -------------------------- | ------------------- | :----: | -------------------------------------------------- | --------------------------------------------------------- |
| `startup`                  | Startup             |   15   | Electric-blue + white, Inter, gradient bars        | SaaS / venture pitch decks; confident, product-forward    |
| `elevator_pitch`           | Elevator Pitch      |   8    | Violet + mint on off-white, Inter                  | Short, punchy fundraise pitches; high energy              |
| `minimalist`               | Minimalist          |   13   | Slate + cream, Playfair Display / Lora serif       | Elegant editorial decks, brand stories, proposals         |
| `minimalist_2`             | Minimalist Blue     |   14   | Light grey + dusty blue, Work Sans                 | Calm modern corporate; soft accent, airy whitespace       |
| `premium_black`            | Premium Black       |   12   | White-on-black, Poppins, max contrast              | Luxury / premium brands, high-end product & agency        |
| `premium_green`            | Premium Green       |   10   | Sage + stone + mint, Gupter/Baskerville serif      | Refined organic brands — wellness, design, sustainability |
| `architect`                | Architect           |   17   | Off-white + slate-blue + burnt orange, Inter       | Architecture, construction, design-studio portfolios      |
| `portfolio`                | Portfolio           |   14   | Black + wine accent on white, Rubik                | Personal / studio portfolios, case-study showcases        |
| `professor_gray`           | Professor           |   13   | Charcoal + lime/pink pops, Playfair Display        | Lectures, research readouts, educational / thesis decks   |
| `textbook`                 | Textbook            |   10   | Kraft paper + orange/teal, Staatliches condensed   | Playful retro-editorial explainers, zine-style decks      |
| `hipster`                  | Hipster             |   16   | Acid-lime on black, Averia Serif Libre, giant type | Bold lifestyle / fashion / creative brand decks           |
| `colorful`                 | Colorful            |   19   | Teal + coral + cream, DM Serif Display             | Vibrant, expressive brand & campaign decks                |
| `green`                    | Forest Green        |   12   | Forest-green gradient on off-white, Space Grotesk  | Sustainability, nature, ESG, calm corporate               |
| `black_and_white_clean`    | Black & White Clean |   11   | Mono + mint sliver, Inter                          | Neutral all-purpose corporate; content leads              |
| `gamer_gray`               | Gamer               |   7    | Dark UI + green/blue HUD, Jersey 15 pixel          | Gaming, dev-tool, hacker-culture product decks            |
| `numbers_clean`            | Numbers Clean       |   11   | Light grey + single red accent, Inter              | Metric-heavy readouts, financials, KPI reviews (clean)    |
| `numbers_colorful`         | Numbers Colorful    |   11   | Grey + green/lavender/amber pastels, Inter         | Colorful dashboards & metric decks; friendly pop          |
| `competitor_analysis_blue` | Competitor Analysis |   7    | Electric blue + yellow, Lilita One poster type     | Competitive landscapes, positioning matrices, market maps |

**Total: 18 templates · 220 slide skeletons.**

## Structure of a staged template

```
templates/presentations/<id>/
  metadata.json     # { presentation_name, title, slides: { "N": { title, filename, … } } }
  slide_01.html     # full standalone 1920×1080 slide (inline <style>, Google Fonts @import)
  slide_02.html
  …
```

Each `slide_NN.html` is self-contained: an inline `<style>` block, a Google-Fonts
`@import`, and a `.slide-container` (or equivalent) root. Palettes and fonts here are
the _source of truth_ the Tier-1 `TemplateSpec`s were derived from — if you edit a
spec's colors/fonts, cross-check against the matching slide HTML.

## Honoring a design contract (Create Studio)

When a generation request is prefixed with a **`DESIGN CONTRACT`**, **`BRAND`**,
**`STYLE`**, or **`CHARTS`** block (compiled by `apps/web/src/domains/create/create-intent.ts`
from the user's gallery selection), treat it as binding constraints, in this order:

1. **DESIGN CONTRACT** — use the given palette hexes, fonts, layout rhythm, and cover
   treatment. If a `templates/presentations/<id>` path is named and exact reproduction is
   wanted, load and fill those slides; otherwise generate fresh slides that inherit the look.
2. **BRAND** — the brand's palette/fonts **override** the template defaults where they
   conflict; place the logo on cover/closing slides; write copy in the brand voice and
   respect its do/don't lists; weave in the boilerplate where natural.
3. **STYLE** — for image/video, append the style fragment to the generation prompt.
4. **CHARTS** — include the named chart types.

The user's own words (after the `---` divider) remain the primary instruction; the contract
shapes _how_ it's rendered, not _what_ is asked for. Absent any such block, build as usual.
