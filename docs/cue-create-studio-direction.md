# Cue Create — Studio (templates · styles · brand) — Direction & Design Brief

Date: 2026-07-05. Author: Claude (with Manav). Status: direction for review → Claude Design → build.

## The problem with Create today

Every Create mode and template terminates in a **text prompt** that seeds a thread. The
"template" is just prompt copy. There is no way to pick a *real* deck template, a design
style, or to make output come out *in the user's brand*. This is thin compared to what the
Mira fork already proves is possible.

## What Mira already built (and what we lift)

Recon of `github.com/manav1125/mira-ai`:

- **18 real HTML deck templates** — `backend/core/templates/presentations/{startup, elevator_pitch,
  minimalist, portfolio, architect, premium_black, colorful, textbook, …}` — each a folder of
  1920×1080 `slide_NN.html` + `metadata.json` + image assets.
- **A visual picker overlay** — `suna-modes-panel.tsx`: each mode carries an `options.items[]`
  of `{id, name, image, description}`; a modal grid of thumbnail cards; selection is a Zustand
  atomic setter → **embeds the choice into the prompt text** ("Create a presentation using the
  Startup template") + a `mode` field. Thumbnails in `public/images/{presentation-templates,
  image-styles, video-styles}` (18 + 15 + 6 assets).
- **The "brought to life" mechanism** (`sb_presentation_tool.py`), two tiers:
  - `load_template_design()` copies the template, hides the original HTML in `.template_reference/`,
    and **extracts a design system** (fonts, color palette, layout patterns, CSS classes) from it.
  - **Tier A — design-contract:** `create_slide()` generates *new* researched content that
    *inherits* that palette/fonts/layout.
  - **Tier B — pixel-faithful:** `populate_template_slide()` does exact DOM text/image
    replacement in the real template HTML (BeautifulSoup find/replace).
- **No brand system.** `presentation_styles_config.py` had ~40 theme palettes — all commented out.
  No logo, no per-user brand, no auto-apply.

## What Cue already has (the injection points)

- `app-builder` skill builds decks from `references/SLIDES.md` (8 named layout types) + a
  `DESIGN_SYSTEM.md` of `--v-*` tokens (`--v-accent`, `--v-font-family`, palettes). **This is
  design-contract generation already — it just has no pinned template or brand.**
- Create modes (`create-templates.ts` / `create-form-templates.ts`) → a `skill` + prompt.
- Structured Image/Video templates already route to the real `replicate` skill.

So the whole ask decomposes into **three layers that sit on top of what we have** — additive,
never a replacement.

---

## Layer 1 — The gallery (templates & styles power-tools)

**UX.** Selecting a mode (or clicking a "Browse templates / styles" affordance) opens a **gallery
overlay**: a grid of visual thumbnail cards. Slides → deck templates. Image/Video → design /
cinematographic styles. Data → chart types + output format. Docs → doc type + example. Pick one →
a chip appears in the composer ("Template: Startup", "Style: Isometric") and it rides into
generation. The user can **ignore the gallery entirely and take AI direction**, or open it, browse,
and combine with their own prompt.

**Data model — improve on Mira.** Mira embeds the choice in prompt *text* and re-parses it in the
backend (lossy). Because we own the stack, carry a **structured selection** alongside the prompt:

```ts
type CreateIntent = {
  mode: string;                 // slides | image | video | data | docs | …
  templateId?: string;          // "startup"  → resolves a TemplateSpec
  styleId?: string;             // "isometric" → resolves a StyleSpec
  chartTypes?: string[];        // data mode
  brandKitId?: string | null;   // Layer 2
};
```

The skill loads the real contract by id — no string-matching.

- **`TemplateSpec`** (slides / dashboards / docs): `{ id, name, thumbnail, category, palette,
  fonts, layoutRhythm, coverTreatment, sourceHtmlDir? }`. Two fidelity tiers:
  - **Tier 1 (ship first) — design-contract.** Extract each Mira template's palette + fonts +
    layout into a `TemplateSpec` JSON; inject as a pinned contract into `app-builder` (which already
    honors design tokens). Covers all 18 templates with low effort, renders the user's real content
    in that look. "Inspired by," not pixel-exact.
  - **Tier 2 (later) — pixel-faithful.** Ship the real HTML skeletons + port `populate_template_slide`
    (DOM fill) for exact reproduction where it matters (investor deck, brand report).
- **`StyleSpec`** (image / video): `{ id, label, thumbnail, promptFragment, model? }`. Selection
  appends `promptFragment` to the `replicate` / image prompt. Lift Mira's 15 image + 6 video
  thumbnails; author the fragments.

**Reuse map:** 18 deck HTML templates + 18+15+6 thumbnails come straight from Mira. We write the
`TemplateSpec`/`StyleSpec` registries + the overlay + the skill wiring.

---

## Layer 2 — Brand Kit (the crown jewel; user idea #2)

Neither Mira nor Cue has this. It is what actually makes a template come alive *in the user's
brand*, and it is the biggest differentiator.

**Brand Profile (stored, per assistant):**

```ts
type BrandProfile = {
  id, name;
  palette: { primary, accent, bg, surface, text, … };
  fonts:   { heading, body };
  logo:    { light, dark, mark };
  voice:   { tone, doList[], dontList[], boilerplate };  // company one-liner, tagline
  assets:  [];                                            // approved imagery
  source:  "upload" | "website" | "guided";
};
```

**Three load paths (a guided UX journey):**
1. **Upload** a deck / PDF / brand-guidelines file → auto-extract dominant palette, fonts, logo,
   and voice (LLM reads it).
2. **From your website** → browser-use scrapes CSS colors, fonts, logo, and meta copy → same profile.
3. **Guided visual journey** → pick colors, upload a logo, choose fonts, describe voice — for users
   with no existing kit.

All three converge on a **review/edit screen** (swatches, font specimens, logo on light/dark, voice
do/don't), then "Save & apply everywhere."

**Injection (silent, everywhere):** overrides the `--v-*` tokens in app-builder decks/dashboards/docs;
feeds `voice` into copy generation across all modes; drops the logo on covers; seeds the brand palette
into image-gen prompts. A pitch-deck template + a brand kit = the user's colors, logo, and voice —
not a generic demo.

**Placement:** introduced in onboarding ("connect your world" already exists), lives in a **Brand**
section (Settings, or a light top-level destination), applied automatically to every Create output
with a small "In your brand ✓ / Off" toggle on the composer.

---

## Layer 3 — Extend to dashboards, PRDs, docs, email

Same registry, same `CreateIntent`. Ship a small set of **real example structures** per mode:
dashboard layouts (KPI grid, exec summary, funnel), PRD/doc skeletons (one-pager, full PRD, tech
spec), email layouts. Each is a `TemplateSpec` the doc/app skills honor. The Brand Kit applies here
too, so a PRD comes out in-brand.

---

## Additional ideas to make Create world-class (user idea #3)

1. **Reference / "make it look like this."** Per-generation, drop an image or URL → extract its
   palette/composition as a one-off style (distinct from the saved Brand Kit).
2. **Remix on any output.** Every generated asset gets *Restyle · Rebrand · Make variations* —
   re-skin a deck into another template, re-render in the brand, spin N variants. Turns one-shot
   generation into iteration.
3. **Multi-format fan-out (asset kits).** One brief → deck + one-pager + 3 social images in a single
   pass, all in-brand. The "campaign in a click."
4. **Grow the library from your own work.** "Save as template" on any output; Cue learns the user's
   house style over time and pre-suggests it.
5. **Live preview in the gallery.** Hover a template → see *your* content/brand previewed in it, not
   the demo thumbnail.
6. **Auto design-critic pass.** Run the existing `design-critique` skill post-generation to check
   contrast / hierarchy / brand adherence before presenting — quality guardrail.
7. **Context-smart defaults.** If the work is filed under a mission/project with a known brand or
   audience, pre-select the fitting template/style.
8. **Prompt enhancer.** A "refine my brief" step that expands a terse ask into a full creative brief
   before generation (optional, one tap).

---

## Claude Design brief — screens to design

1. **Gallery overlay** (per mode): grid of thumbnail cards, hover/selected states, a "Take AI
   direction" escape hatch, category tabs, the composer selection chip. Variants for Templates
   (Slides/Dashboards/Docs), Styles (Image/Video), and Chart/Format (Data). Desktop + mobile.
2. **Brand Kit journey**: the three-path entry (Upload / From website / Guided), each path's flow,
   and the shared Brand Profile review/edit screen (palette, fonts, logo light/dark, voice do/don't).
   The "applied everywhere" indicator + composer toggle.
3. **Output actions**: Restyle / Rebrand / Make variations on a generated asset.
4. **(Optional) Live-preview-in-gallery** and the **reference-drop** affordance.

All to the existing `--mv1-*` token system (dark free). Mobile alongside every screen.

---

## Recommended sequencing

1. **Gallery + Slides Tier-1 (design-contract) + StyleSpec for Image/Video** — highest impact,
   reuses app-builder + Mira assets. Ships the visible "power tools."
2. **Brand Kit** — the differentiator; unlocks "in your brand" across everything already shipped.
3. **Dashboards/PRD/doc example templates** — same registry.
4. **Tier-2 pixel-faithful decks + remix/variations + multi-format** — depth.

## Decisions (LOCKED 2026-07-05)
- **Deck fidelity: both together** — design-contract for most modes + pixel-faithful for the few
  that must be exact (investor deck, brand report).
- **First build scope: gallery + Brand Kit together** — templates come out in-brand from day one.
- **Brand Kit home: onboarding + Settings** — introduced in "connect your world", editable in a
  Brand section of Settings, applied everywhere via a composer toggle. No new top-level nav item.
- **Visuals: route through Claude Design** — hand off the standalone brief
  (`docs/cue-create-studio-design-brief.md`), build to the returned mocks. (Matches HQ flow.)
