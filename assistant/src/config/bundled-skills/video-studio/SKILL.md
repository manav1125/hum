---
name: video-studio
description: Use whenever the user wants a COMPLETE video produced — an explainer, product promo, social reel/short, montage, slideshow video, trailer, ad, or any multi-scene and/or narrated video. This skill runs a full pipeline (script → scene plan → generate visuals/voiceover/music with replicate_run → assemble with video_compose) and returns a finished mp4. For a single raw clip with no script/narration/assembly, plain replicate_run is enough — use this skill when the result should be an edited, watchable video rather than one generated shot.
compatibility: "Designed for Cue personal assistants"
metadata:
  emoji: "🎬"
  vellum:
    display-name: "Video Studio"
    category: "content"
    activation-hints:
      - "User asks to make/create/produce a video, explainer, promo, ad, trailer, montage, slideshow video, social reel/short, or narrated video"
      - "User wants several scenes, on-screen captions, a voiceover, and/or background music combined into one finished video"
      - "User wants to turn a script, product, or idea into a watchable edited video (not just a single generated clip)"
    avoid-when:
      - "The user only wants ONE raw generated clip with no narration/captions/editing — call replicate_run directly instead"
      - "The user wants to analyze, summarize, or extract clips from an EXISTING video — use the media-processing tools"
---

Produce finished videos by orchestrating generation (via `replicate_run`) and assembly (via `video_compose`). You are the director: you write the script, plan the scenes, generate each asset, then compose them into one mp4.

## The pipeline

Run these stages in order. Tell the user what you're doing as you go; generation can take a while, especially video.

1. **Script & scene plan.** From the user's request, write a short script and break it into **scenes** (aim for 4–8 scenes, each 3–6 seconds, total ≤ 60s unless asked otherwise). For each scene decide: a **visual prompt**, an optional one-line **caption**, and (if narrated) a **narration line**. Confirm the plan with the user only if the brief is ambiguous; otherwise proceed.

2. **Generate the visuals.** When the user asked for a **video**, the default is REAL MOTION — a text-to-video model per scene, not stills. A stitched slideshow of stills is NOT a video and users call it out as "just 4 screens."
   - **Motion clips (DEFAULT for any "video" request):** `model: "minimax/video-01"`, `input: { "prompt": "<scene, describe the camera move and motion>" }`, and set `wait_seconds: 600` (each clip takes ~2–3 minutes to render). Use a consistent style phrase across every prompt (e.g. "cinematic slow dolly, warm lighting, shallow depth of field, 24fps film look") so scenes feel like one piece. Because each clip is slow, keep the scene count low for motion videos (**2–4 scenes**) unless the user accepts a longer wait; tell the user the render will take a few minutes.
   - **Stills (opt-in — only for an explicit slideshow, a fast draft/preview, or when the user says stills are fine):** `model: "black-forest-labs/flux-schnell"`, `input: { "prompt": "<scene visual>", "aspect_ratio": "<16:9|9:16|1:1>" }`. Say plainly that a stills slideshow is not true motion.
   - Keep the output URL of each scene **in order**.

3. **Voiceover (optional).** If the video should be narrated, call `replicate_run` with a text-to-speech model (e.g. `model: "minimax/speech-02-turbo"` or `model: "jaaari/kokoro-82m"`) and `input: { "text": "<the full narration>" }`. Produce ONE narration track for the whole video (concatenate your per-scene narration lines into one script). Keep its URL. If a TTS model rejects the input keys, read its error and adjust the key name (most use `text`).

4. **Music (optional).** If the user wants a music bed, call `replicate_run` with a music model. `meta/musicgen` is a community model, so pin a version: `model: "meta/musicgen:671ac645ce5e552cc63a54a2bbff63fcf798043055d2dac5fc9e36a837eedcfb"`, `input: { "prompt": "<mood/genre>", "duration": <seconds> }`. Keep its URL. If music generation errors, skip it rather than blocking the video.

5. **Compose.** Call `video_compose` ONCE with everything:
   ```json
   {
     "segments": [
       { "source": "<scene1 url>", "duration_seconds": 4, "caption": "Optional line" },
       { "source": "<scene2 url>", "duration_seconds": 5, "caption": "Another line" }
     ],
     "narration_url": "<tts url, if any>",
     "music_url": "<music url, if any>",
     "aspect_ratio": "16:9",
     "output_title": "Product teaser"
   }
   ```
   It renders, stitches, mixes audio, and returns the finished mp4 as an attachment for the user. Relay the result and offer quick follow-ups (re-render a scene, change music, make a vertical cut, etc.).

## Model cheat-sheet

| Need | Model (`replicate_run`) | Key input |
| --- | --- | --- |
| Still image scene | `black-forest-labs/flux-schnell` | `prompt`, `aspect_ratio` |
| Motion video scene | `minimax/video-01` | `prompt` (raise `wait_seconds`) |
| Voiceover (TTS) | `minimax/speech-02-turbo` | `text` |
| Background music | `meta/musicgen:671ac645ce5e552cc63a54a2bbff63fcf798043055d2dac5fc9e36a837eedcfb` | `prompt`, `duration` |

**Official vs community models:** official models (flux-schnell, the `minimax/*` family) run by bare `owner/name`. Community models (e.g. `meta/musicgen`) are NOT runnable by bare name and must be pinned as `owner/name:version` — otherwise `replicate_run` returns a 404. The defaults above are verified working; if the user names a model or you know a better current one, use it. Replicate is a direct integration (no Composio); a missing token surfaces a clear message from `replicate_run` that you relay to the user.

## Aspect ratio

Match the destination: **16:9** for standard/landscape/YouTube (default), **9:16** for TikTok/Reels/Shorts/Stories, **1:1** for square social. Generate the visuals at the SAME `aspect_ratio` you pass to `video_compose` so nothing is letterboxed.

## Tips

- Keep total length short (15–45s reads best). More scenes of a few seconds beats a few long static holds.
- Use a single consistent visual style across scene prompts for cohesion.
- **Captions** burn in reliably (Cue ships a caption-capable ffmpeg). Offer them — they make explainers and social clips far more watchable. Add a short `caption` per scene to `video_compose`; the user can opt out (pass `captions: false`) for clean visuals. Keep captions to a line or two so they don't crowd the frame.
- Only when the user explicitly wants a slideshow (or a fast draft) skip motion clips: stills + captions + music compose quickly — but say plainly it is a slideshow, not real motion.

## Honoring a design contract (Create Studio)

When the request is prefixed with a **`STYLE`**, **`BRAND`**, or **`DESIGN CONTRACT`** block (compiled by Create Studio, above a `---` divider), thread it through the whole pipeline:

- **STYLE** — fold the style fragment into your consistent per-scene visual phrase so every generated shot matches it.
- **BRAND** — steer every scene prompt to the brand's palette/mood; write captions and narration in the brand voice; keep the aspect ratio the destination wants. If a logo asset is named, add a short opening or closing scene that leaves clean space for it.
- Keep one cohesive look across all scenes — the contract defines that look.

The user's words after the `---` are the subject; the contract shapes the look and voice. Absent any such block, direct it as usual.

## Anti-patterns

- **Don't** try to assemble, concatenate, or mux video yourself, or write your own ffmpeg — always finish through `video_compose`.
- **Don't** call `video_compose` before you have the scene URLs — generate first, then compose once.
- **Don't** use this for a single raw clip with no editing — call `replicate_run` directly for that.
- **Don't** deliver a stills slideshow when the user asked for a "video" — that reads as "just screens, not a video." Generate real motion clips by default; use stills only for an explicit slideshow or a fast draft the user agreed to.
