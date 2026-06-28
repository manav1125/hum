---
name: replicate
description: THE tool for image AND video generation. Use `replicate_run` to generate or create an image, make or render a video, or run any Replicate-hosted model (flux, SDXL, upscalers, video models, etc.) when a Replicate token is configured. Handles plain requests like "generate an image of X", "create a picture of Y", and "make a video of Z" — not only when the user names a specific model. Runs the model on Replicate and returns the output media URL(s).
compatibility: "Designed for Cue personal assistants"
metadata:
  emoji: "🛰️"
  vellum:
    display-name: "Replicate"
    category: "content"
    activation-hints:
      - "User asks to generate, create, draw, or render an image from a text prompt"
      - "User asks to make, generate, or render a video from a text prompt or image"
      - "User names a specific Replicate model (e.g. black-forest-labs/flux-schnell, stability-ai/sdxl)"
      - "User wants to upscale, restyle, or otherwise transform media via a Replicate model"
---

Use the `replicate_run` tool via `skill_execute` to generate images and video on Replicate.

This is the preferred path for image and video generation whenever a Replicate token is configured (secure store under provider `replicate`, or the `REPLICATE_API_TOKEN` env var). For a plain "generate / create an image" or "make a video" request, default to `replicate_run` with the model defaults below — you do NOT need the user to name a model first. Image Studio (`media_generate_image`) stays available for editing an existing image the user provides (background/watermark removal, in-painting, retouch) and multi-variant runs; reach for it only when the request is explicitly an edit.

Replicate is the universal backend for image and video generation. Given a model identifier plus a prompt and parameters, the tool calls Replicate's predictions API, polls until the prediction succeeds or fails, and returns the output media URL(s).

## Choosing a model

Pass the `model` exactly as Replicate names it:

- **Owner/name** (resolves to the model's latest version): `black-forest-labs/flux-schnell`, `stability-ai/sdxl`.
- **Owner/name:version** (pins an exact version hash): `stability-ai/sdxl:39ed52f2a78e934b3ba6e2a89f5b1c712de7dfea535525255b1aa35c5565e08b`.
- **Bare version hash** (64-hex): runs that exact version directly.

Common defaults when the user does not name one:

- Image: `black-forest-labs/flux-schnell` (fast) or `black-forest-labs/flux-dev` (higher fidelity).
- Video: `minimax/video-01` or another text/image-to-video model the user requests.

If you are unsure a model exists, ask the user for the exact `owner/name` rather than guessing a version hash.

## Inputs

- `model` (required): the model identifier as described above.
- `input` (required): an object of model-specific parameters. The prompt key varies by model — most use `prompt`. Pass through whatever the model documents (e.g. `prompt`, `aspect_ratio`, `num_outputs`, `image`, `seed`, `width`, `height`).
- `wait_seconds` (optional): max seconds to poll for completion (default 120, max 600). Long video jobs may need a higher value.

## Example calls

Image (flux):

```json
{
  "tool": "replicate_run",
  "input": {
    "model": "black-forest-labs/flux-schnell",
    "input": { "prompt": "A neon-lit Tokyo alley in the rain, 35mm photo", "aspect_ratio": "16:9", "num_outputs": 1 }
  }
}
```

Video (text-to-video):

```json
{
  "tool": "replicate_run",
  "input": {
    "model": "minimax/video-01",
    "input": { "prompt": "A drone shot flying over a misty mountain range at sunrise" },
    "wait_seconds": 300
  }
}
```

## Output handling

The tool returns the output media URL(s) Replicate produced. Present the URL(s) to the user. If the user wants a file in the conversation, fetch the URL and deliver it through the conversation's attachment mechanism.

## Credential

Requires a Replicate API token. It is resolved from the secure store under the provider name `replicate`, or from the `REPLICATE_API_TOKEN` environment variable. If the tool reports a missing token, report the error to the user as-is — do not change configuration.

**Replicate is a DIRECT integration, NOT a Composio connector.** It calls `api.replicate.com` with a bearer token; there is no Composio toolkit, OAuth flow, or "connection" to set up. If Replicate is not configured, the ONLY correct response is to tell the user to set a Replicate API token (`REPLICATE_API_TOKEN` or the secure store). NEVER search Composio for "replicate", and NEVER offer or initiate a Composio/OAuth "Connect Replicate" link. The same rule applies to other direct tooling providers such as Apify.

## Error handling

- **Missing token / auth error**: report to the user as-is. Do NOT attempt a Composio or OAuth connection — Replicate is a direct token integration (see Credential).
- **Model or version not found**: the model identifier is wrong. Ask the user for the exact `owner/name` (or `owner/name:version`).
- **Prediction failed**: Replicate returns an error string. Report it. Do not silently retry on the same model with the same input.
- **Timed out while polling**: the job may still be running on Replicate; retry with a larger `wait_seconds`.

## Complete when

The tool has returned at least one output URL and the user can see it, or a failure has been reported after the handling above.
