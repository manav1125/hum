---
name: video-studio
description: Use whenever the user wants a COMPLETE video produced — an explainer, product promo, social reel/short, montage, slideshow video, trailer, ad, or any multi-scene and/or narrated video. This skill runs a full pipeline (script → scene plan → generate visuals/voiceover/music with replicate_run → assemble with video_compose) and returns a finished mp4. For a single raw clip with no script/narration/assembly, plain replicate_run is enough — use this skill when the result should be an edited, watchable video rather than one generated shot.
compatibility: "Designed for Cue personal assistants"
metadata:
  emoji: "🎬"
  vellum:
    display-name: "Video Studio"
    category: "media"
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

2. **Generate the visuals.** For each scene call `replicate_run`:
   - **Stills (default — fast, cheap, reliable):** `model: "black-forest-labs/flux-schnell"`, `input: { "prompt": "<scene visual>", "aspect_ratio": "<16:9|9:16|1:1>" }`. Use a consistent style phrase across every prompt (e.g. "cinematic, warm lighting, shallow depth of field") so scenes feel like one piece.
   - **Motion clips (when the user wants real movement):** use a text-to-video model, e.g. `model: "minimax/video-01"`, `input: { "prompt": "<scene>" }`, and raise `wait_seconds` (e.g. 300). Generate motion clips only for the scenes that need them — they are much slower and costlier than stills.
   - Keep the output URL of each scene **in order**.

3. **Voiceover (optional).** If the video should be narrated, call `replicate_run` with a text-to-speech model (e.g. `model: "minimax/speech-02-turbo"` or `model: "jaaari/kokoro-82m"`) and `input: { "text": "<the full narration>" }`. Produce ONE narration track for the whole video (concatenate your per-scene narration lines into one script). Keep its URL. If a TTS model rejects the input keys, read its error and adjust the key name (most use `text`).

4. **Music (optional).** If the user wants a music bed, call `replicate_run` with a music model (e.g. `model: "meta/musicgen"`, `input: { "prompt": "<mood/genre>", "duration": <seconds> }`). Keep its URL.

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
| Voiceover (TTS) | `minimax/speech-02-turbo` / `jaaari/kokoro-82m` | `text` |
| Background music | `meta/musicgen` | `prompt`, `duration` |

These are sensible defaults — if the user names a model or you know a better current one, use it. Replicate is a direct integration (no Composio); a missing token surfaces a clear message from `replicate_run` that you relay to the user.

## Aspect ratio

Match the destination: **16:9** for standard/landscape/YouTube (default), **9:16** for TikTok/Reels/Shorts/Stories, **1:1** for square social. Generate the visuals at the SAME `aspect_ratio` you pass to `video_compose` so nothing is letterboxed.

## Tips

- Keep total length short (15–45s reads best). More scenes of a few seconds beats a few long static holds.
- Use a single consistent visual style across scene prompts for cohesion.
- Captions are burned only if the host ffmpeg supports text rendering; `video_compose` reports when it had to skip them — the video is still produced.
- For a quick "slideshow" video you can skip motion clips entirely: stills + captions + music compose into a clean result fast.

## Anti-patterns

- **Don't** try to assemble, concatenate, or mux video yourself, or write your own ffmpeg — always finish through `video_compose`.
- **Don't** call `video_compose` before you have the scene URLs — generate first, then compose once.
- **Don't** use this for a single raw clip with no editing — call `replicate_run` directly for that.
- **Don't** generate motion clips for every scene by default — stills are the fast path; reserve video models for scenes that need movement.
