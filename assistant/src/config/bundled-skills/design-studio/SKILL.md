---
name: design-studio
description: Use when the user wants a design-PROJECT that belongs in a visual studio — a slide deck or pitch deck, a landing or marketing page, a UI prototype or screen flow, a dashboard mockup, a poster/flyer/one-pager, or any multi-artboard layout they will refine visually. Cue Design (the studio) is the right surface for these, not chat. Call `design_handoff` to create the project with the user's brief pre-loaded and the Cue brand attached, then give them the returned link to jump straight in. This is distinct from `motion-graphics` (animated video), `video-studio` (AI footage), and `frontend-design` (design-quality frontend code in a repo).
compatibility: "Designed for Cue personal assistants"
metadata:
  emoji: "🎨"
  vellum:
    display-name: "Design Studio"
    category: "content"
    activation-hints:
      - "User wants a slide deck, pitch deck, landing page, marketing page, prototype, screen flow, dashboard mockup, poster, flyer, or one-pager"
      - "User wants a visual design they will tweak and iterate on, not a one-shot answer in chat"
      - "User says \"design\", \"mock up\", \"lay out\", \"build a page/deck\", or references the Design surface"
    avoid-when:
      - "The user wants deterministic motion-graphics video (an animated title card, kinetic type, animated logo) — use the motion-graphics skill"
      - "The user wants AI-generated cinematic footage or a narrated explainer — use video-studio"
      - "The user wants design-quality frontend CODE inside an existing repo/project folder — use frontend-design"
      - "The user is only asking a quick question or wants a text answer — just answer in chat"
---

# Design Studio — hand off to Cue Design

Cue Design is the visual studio for design projects: decks, landing pages,
prototypes, dashboards, posters — multi-artboard work the user refines by hand.
It has the full generation pipeline, a template gallery, and live editing that
chat can't offer. Your job here is to set the user up for success and hand off.

## What to do

1. **Gather just enough for a strong brief.** You do not need everything — the
   user will refine in the studio — but the brief you pre-load should be
   concrete: what to make, for whom, the key content/sections, and any style
   direction. Pull real facts from the conversation and from what you know about
   the user's business; don't leave placeholders. Default to the **Cue** brand
   system (warm paper, ink navy, electric-blue accent, DM Sans / Instrument
   Serif) unless the user asks for another style. Ask at most one clarifying
   question if the request is too thin to brief well.

2. **Call `design_handoff`** with a short `title` and the full `brief`. It
   creates the project in Cue Design with the brief pre-loaded into the composer
   and the Cue brand attached, and returns an `openInCueDesign` link.

3. **Hand the user the link.** Tell them you've set up the project and give them
   the `openInCueDesign` link (present it as a clear call to action, e.g.
   "Open your deck in Cue Design →"). When they open it, the brief is already in
   the composer — one click to generate — and they can iterate visually from
   there.

Keep it smooth: one good brief, one link, and the user is in the studio ready to
create. Don't try to produce the deck or page yourself in chat — the studio does
it better and the user can edit it.
