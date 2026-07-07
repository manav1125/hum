# Cue Create Studio — Claude Design brief

Hand this to Claude Design. It asks for a set of screens (desktop + mobile) that add a **visual
template/style gallery** and a **Brand Kit** to Cue's existing Create surface. This is an ADDITION
to the current prompt/form flow — do not redesign what exists; design the new surfaces so they slot
in beside it.

## About Cue (context for the designer)

Cue is an AI chief-of-staff. **Create** is where users produce assets — slide decks, dashboards,
docs, images, video, research — by picking a mode (Slides / Data / Docs / Canvas / Video / Research /
Image) and a template, then generating. Today's Create page: a serif hero ("What do you want to get
done?"), a row of mode chips, a "Templates · fill & generate" section of cards, and a "Quick start"
section of preview cards below.

**Visual language (match it exactly):**
- Theme-aware `--mv1-*` token system; **dark mode is the default to design in**, light must also work.
- Serif display headings; sans body; DM Mono for microlabels (uppercase, letter-spaced).
- Card anatomy already in use: tinted preview band + serif title + a mono chip + a ⟡ provenance tag.
- Rounded cards (~15px radius), hairline borders, restrained blue accent, generous whitespace.
- Every screen needs a **390px mobile** version alongside desktop.

---

## Screen set 1 — The gallery overlay

When a user selects a mode (or taps a "Browse templates / styles" affordance on the Create page),
a **gallery overlay** opens: a grid of visual thumbnail cards to choose a concrete template or style.
The user can pick one (it becomes a chip in the composer) OR dismiss and just type a prompt / take AI
direction. Design these variants:

1. **Slides → "Choose a template"** — grid of real deck-template thumbnails (e.g. Startup, Elevator
   Pitch, Minimalist, Portfolio, Architect, Premium Black, Colorful, Textbook — ~18 total). Each card:
   a landscape 16:9 deck preview image + the template name. Show hover + **selected** states, and a
   subtle "fidelity" hint where a template can render *exact* vs *inspired-by*.
2. **Image → "Choose a style"** — grid of square style thumbnails (Photorealistic, Watercolor, Digital
   Art, Oil Painting, Minimalist, Isometric, Vintage, Comic Book, Neon, Pastel, Geometric, Abstract,
   Anime, Impressionist, Surreal — ~15). Square card: sample image + style name.
3. **Video → "Choose a style"** — cinematographic styles (Cinematic, Product, Animation, Nature,
   Abstract, Adventure — ~6). Same card pattern, video-still thumbnails.
4. **Data → "Choose output & chart types"** — output format (Dashboard / Report / Sheet / Slides) +
   multi-select chart types (bar, line, pie, scatter, heatmap, area, …).
5. **Docs → "Choose a document"** — doc types with a small structural preview (PRD, One-pager, Tech
   spec, Proposal, Report, Meeting notes, …).

**Shared requirements for the overlay:**
- A header with the mode icon + title ("Choose a template" / "Choose a style"), a close ✕.
- Category tabs or filters if the set is large.
- A persistent **"Take AI direction →"** escape hatch (skip the gallery, let Cue choose).
- **Selected state** → the overlay closes and a **chip appears in the composer**: e.g.
  `▣ Template: Startup ✕` or `▣ Style: Isometric ✕` (dismissible).
- A visible **"In your brand ✓ / Off"** toggle in/near the composer (ties to Screen set 2).
- Empty/loading states for thumbnails.
- Desktop = modal grid (3–4 cols). Mobile = full-screen sheet, 2 cols, sticky header + escape hatch.

---

## Screen set 2 — Brand Kit

A **Brand Kit** stores the user's brand (palette, fonts, logo, voice) and Cue applies it to every
Create output. Design the full journey:

**A. Entry (three paths) — "Set up your brand".** A chooser screen offering:
   1. **Upload** — drop a deck / PDF / brand-guidelines file; Cue auto-extracts palette, fonts, logo,
      voice. Show the upload + an "extracting…" state.
   2. **From your website** — enter a URL; Cue pulls colors, fonts, logo, and copy. Show input + scan.
   3. **Guided** — build it by hand: pick colors, upload a logo, choose fonts, describe your voice.

**B. Brand Profile review/edit** (the shared destination all three paths converge on):
   - **Palette** — swatches (primary, accent, background, surface, text) with edit/add.
   - **Type** — heading + body font specimens.
   - **Logo** — shown on **light and dark**; slots for full logo + mark.
   - **Voice** — tone, a do-list / don't-list, and a one-line boilerplate / tagline.
   - A **live "applied" preview**: the same sample deck cover rendered *in this brand*.
   - Primary action: **"Save & apply everywhere."**

**C. Placement:**
   - **Onboarding** — a step in the existing "connect your world" flow that offers the three entry
     paths (skippable). Design the onboarding card/step.
   - **Settings → Brand** — the review/edit screen as a settings section, plus "Add another brand"
     (a user may have >1 brand).
   - **Composer indicator** — the "In your brand ✓" toggle (from Screen set 1) reflects the active kit.

Mobile versions for the entry chooser, each path, and the review screen.

---

## Screen set 3 — Output actions (remix)

On a **generated asset** (a finished deck / image / doc in the result view), design an actions row:
**Restyle** (swap to a different template/style), **Rebrand** (re-render in a/another Brand Kit),
**Make variations** (generate N variants). A small, tasteful control cluster — not a heavy toolbar.

## Optional / nice-to-have (design only if time)

- **Live preview in the gallery** — hovering a template shows *the user's* content/brand in it rather
  than the demo thumbnail.
- **Reference drop** — a "make it look like this" affordance in the composer (drop an image/URL to
  borrow its style for one generation).

---

## What NOT to touch
- The existing Create hero, mode chips, "fill & generate" cards, and "Quick start" preview cards —
  those stay. The gallery is opened *from* this page; it doesn't replace it.
- The `--mv1-*` tokens, the tab bar, and other surfaces (HQ, Projects, People, Voice).

## Deliverable
Dark-first mocks (light variants where it matters) for Screen sets 1–3, desktop + 390px mobile, in
Cue's visual language. Static HTML like previous rounds is ideal.
