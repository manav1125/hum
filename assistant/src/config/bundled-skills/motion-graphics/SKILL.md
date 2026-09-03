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

2. **Render it inline with `hyperframes_render`.** You author a complete
   HyperFrames composition (HTML + GSAP) and call the tool once; it renders in
   Cue Design's engine and returns the finished MP4 as a chat attachment — the
   user never has to leave the conversation. This is the default path.

3. **Or send them to the studio for the template gallery.** When the user wants
   to browse and tweak visually, or start from a specific template (Glitch
   Title, Logo Outro, Light-Leak Cinema, animated data chart…), point them to
   the **Design** surface — those templates also appear in the Skills tab, and
   selecting one opens Cue Design.

## Composition contract (for `hyperframes_render`)

Author `html` as a COMPLETE document. The renderer drives a GSAP timeline you
register on `window.__timelines` and captures frames for the root's declared
duration. Minimum shape:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: 1920px; height: 1080px; overflow: hidden; background: #0b0b0c; }
      /* your scene styles */
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0"
         data-duration="4" data-width="1920" data-height="1080" data-fps="30">
      <!-- your scene elements, using the user's REAL content -->
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
      // build the animation on `tl` — e.g. tl.from("#title", { y: 40, opacity: 0, duration: 0.8, ease: "power3.out" });
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
```

Rules:
- **`data-duration`** (seconds) on the root sets the video length; keep the
  GSAP timeline within it. Set `data-fps` (default 30). For 9:16 or 1:1, change
  `data-width`/`data-height` and the body size to match.
- **Real content, brand-accurate.** Use the user's exact text/wordmark and the
  Cue brand system by default — paper `#f6f5f4`, ink `#1a2230`, accent
  `#3d6ee8`, DM Sans / Instrument Serif — unless they specify otherwise.
- **Self-contained.** Inline your CSS and SVG/data; GSAP loads from the CDN
  shown above. Keep the whole document under ~2MB.
- Tell the user the render takes tens of seconds; call `hyperframes_render`
  once and attach the result.

Do **not** try to approximate motion graphics with `replicate_run` or
`video-studio` — a text-to-video model cannot produce exact typography, precise
timing, or brand-accurate color, and users notice immediately.
