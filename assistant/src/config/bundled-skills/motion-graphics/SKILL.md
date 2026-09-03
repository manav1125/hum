---
name: motion-graphics
description: Use when the user wants DETERMINISTIC, code-driven motion graphics — an animated title card, kinetic typography, a lower-third, an animated logo sting/outro, a glitch/CRT title, an animated chart or data-viz reveal, a light-leak or liquid-gradient hero, or any short precise HTML/CSS/GSAP animation rendered to MP4. This is distinct from `video-studio`, which produces AI-generated cinematic FOOTAGE; motion graphics are exact, repeatable, brand-controlled animations (no model hallucination), produced in Cue Design's HyperFrames renderer (HTML+GSAP → headless-Chrome frames → MP4). Route the user there; do not attempt to fake motion graphics with a text-to-video model.
compatibility: "Designed for Cue personal assistants"
metadata:
  emoji: "✨"
  vellum:
    display-name: "Motion Graphics"
    category: "content"
    activation-hints:
      - "User wants an animated title card, kinetic typography, lower-third, logo sting/outro, or animated wordmark"
      - "User wants an animated chart / data-viz reveal, a glitch or CRT title, a light-leak or liquid-gradient hero, or any precise short motion-graphics clip"
      - "User wants a brand-exact, repeatable animation (not AI-generated footage) rendered to MP4"
    avoid-when:
      - "The user wants AI-generated cinematic footage, a narrated explainer, a multi-scene promo, or a montage — use `video-studio` instead"
      - "The user wants a still image or a static frame — use image generation"
---

# Motion Graphics — via Cue Design (HyperFrames)

Deterministic motion graphics are **code-driven animations**, not generated
footage. They are authored as HTML + CSS + GSAP compositions and rendered
frame-by-frame in headless Chromium to an MP4 — so the output is exact,
repeatable, and brand-controlled (the same input always renders the same
video, with no model drift). This is the right tool for title cards, kinetic
type, animated logos, data-viz reveals, and stylized title treatments.

This capability lives in **Cue Design** (the Design surface), which has the
HyperFrames renderer and 15 curated motion templates:

- **Titles / transitions:** Glitch Title, Logo Outro, Light-Leak Cinema
- **Type / editorial:** kinetic-typography and editorial title treatments
- **Data:** NYT-style animated data chart, flowchart reveal
- **Backgrounds:** Liquid-Gradient Hero, and more

## What to do

1. **Confirm it's motion graphics, not footage.** If the user wants real-world
   or cinematic *footage* (people, places, camera moves, "make a video of…"),
   that's `video-studio` — hand off there instead. Motion graphics is for
   designed, animated *graphics*.

2. **Route the user into Cue Design.** Tell them this is a Cue Design job and
   point them to the **Design** surface in the rail (or the Motion Graphics /
   HyperFrames templates that now appear in the Skills tab — selecting one
   opens Cue Design). Cue Design's agent authors the composition from the
   chosen template with the user's real content and renders the MP4.

3. **Give a strong starting brief.** When you hand off, summarize what the user
   wants so they can paste it straight into Cue Design: the exact text/wordmark,
   brand colors and fonts (default to the Cue brand system unless they specify),
   aspect ratio (1920×1080 unless stated), duration, and the template or style
   that fits (e.g. "Glitch Title for a cyberpunk hero", "Logo Outro for the end
   card").

Do **not** try to approximate motion graphics with `replicate_run` or
`video-studio` — a text-to-video model cannot produce exact typography, precise
timing, or brand-accurate color, and users notice immediately.
