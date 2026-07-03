import { getConfig } from "../../../../config/loader.js";
import { resolveImageGenCredentials } from "../../../../media/image-credentials.js";
import {
  describeImageModels,
  resolveImageModel,
} from "../../../../media/image-models.js";
import {
  generateImage,
  mapImageGenError,
  providerForModel,
} from "../../../../media/image-service.js";
import { getFilePathBySourcePath } from "../../../../memory/attachments-store.js";
import { resolveToolingProviderToken } from "../../../../providers/tooling-credentials.js";
import type { ImageContent } from "../../../../providers/types.js";
import { getDaemonRuntimeMode } from "../../../../runtime/runtime-mode.js";
import { sandboxPolicy } from "../../../../tools/shared/filesystem/path-policy.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { executeReplicatePrediction } from "../../replicate/tools/replicate-run.js";

/**
 * Model used when the managed proxy is unavailable and the deployment has a
 * direct Replicate token instead (typical for self-hosted deployments).
 */
const REPLICATE_FALLBACK_MODEL = "black-forest-labs/flux-schnell";

/**
 * Guidance appended to fallback failures so the LLM reports the live result
 * instead of asserting stale conclusions ("Replicate is broken") from earlier
 * conversation memory.
 */
const FALLBACK_FRESHNESS_NOTE =
  "A Replicate token IS configured and was used for this attempt — this is a fresh, live result from just now. Report THIS error to the user as-is. Do not claim Replicate is unconfigured or 'known broken' based on earlier conversation memory, do not offer a Composio/OAuth 'Connect Replicate' flow (Replicate is a direct api.replicate.com integration), and do not change service configuration.";

/**
 * Generate images via the direct Replicate integration (flux-schnell) and
 * return them the same way the managed path does: inline base64 content
 * blocks. Used only when managed-proxy credentials are unavailable but a
 * Replicate token resolves.
 */
async function generateViaReplicateFallback(opts: {
  prompt: string;
  variants?: number;
  token: string;
  signal?: AbortSignal;
}): Promise<ToolExecutionResult> {
  const numOutputs = Math.min(
    4,
    Math.max(1, Math.trunc(Number(opts.variants) || 1)),
  );
  const result = await executeReplicatePrediction({
    model: REPLICATE_FALLBACK_MODEL,
    input: {
      prompt: opts.prompt,
      num_outputs: numOutputs,
      output_format: "png",
    },
    token: opts.token,
    signal: opts.signal,
  });

  if (!result.ok) {
    return {
      content: `Managed proxy is unavailable, so image generation fell back to Replicate (${REPLICATE_FALLBACK_MODEL}) — and that attempt failed: ${result.error}\n\n${FALLBACK_FRESHNESS_NOTE}`,
      isError: true,
    };
  }
  if (result.urls.length === 0) {
    return {
      content: `Replicate fallback (${REPLICATE_FALLBACK_MODEL}) succeeded but returned no media URL. Raw output: ${JSON.stringify(result.output).slice(0, 500)}\n\n${FALLBACK_FRESHNESS_NOTE}`,
      isError: true,
    };
  }

  const contentBlocks: ImageContent[] = [];
  for (const url of result.urls) {
    try {
      const res = await fetch(url, { signal: opts.signal });
      if (!res.ok) {
        return {
          content: `Replicate fallback generated an image but downloading it failed (HTTP ${res.status}) from ${url}.\n\n${FALLBACK_FRESHNESS_NOTE}`,
          isError: true,
        };
      }
      const mimeType =
        res.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
      const data = Buffer.from(await res.arrayBuffer()).toString("base64");
      contentBlocks.push({
        type: "image",
        source: { type: "base64", media_type: mimeType, data },
      });
    } catch (err) {
      return {
        content: `Replicate fallback generated an image but downloading it failed: ${(err as Error).message}\n\n${FALLBACK_FRESHNESS_NOTE}`,
        isError: true,
      };
    }
  }

  const imageCount = contentBlocks.length;
  return {
    content: `Generated ${imageCount} image${imageCount !== 1 ? "s" : ""} using ${REPLICATE_FALLBACK_MODEL} (direct Replicate fallback; the managed proxy is unavailable on this deployment).`,
    isError: false,
    contentBlocks,
  };
}

/**
 * Actionable error for the managed-proxy-unavailable case when no Replicate
 * token resolves either. Tailored by deployment shape: containerized daemons
 * without managed-proxy prereqs are self-hosted, where "log in to Cue"
 * is a dead end — the fix is a direct provider key.
 */
function managedUnavailableHint(): string {
  const keyOptions =
    "To enable image generation, either set a Replicate API token (direct api.replicate.com integration — NOT Composio, no OAuth 'connection') via `assistant keys set replicate <token>` or the REPLICATE_API_TOKEN environment variable, or configure a Gemini/OpenAI API key in Settings → Models & Services and switch image generation to Your Own mode.";
  if (getDaemonRuntimeMode() === "docker") {
    return `Image generation is not configured on this self-hosted deployment: the Cue managed proxy is not available here, and logging in to Cue will not fix it. ${keyOptions}`;
  }
  return `Managed proxy is not available. Please log in to Cue or switch to Your Own mode. ${keyOptions}`;
}

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const config = getConfig();
  const svc = config.services["image-generation"];
  let modelOverride = input.model;
  // Resolve tier aliases (fast, quality, openai) to concrete model IDs via
  // the registry. Unknown values get an error listing the current catalog so
  // callers can self-correct without a stale schema enum.
  if (typeof modelOverride === "string" && modelOverride) {
    const entry = resolveImageModel(modelOverride);
    if (!entry) {
      return {
        content: `Unknown model "${modelOverride}". Available models and aliases:\n${describeImageModels()}\n\nRetry with one of the aliases above, or omit the model parameter to use the configured default.`,
        isError: true,
      };
    }
    modelOverride = entry.id;
  }
  // Derive provider from the explicit model when supplied so that requesting
  // e.g. `gpt-image-2` while config.provider === "gemini" routes to OpenAI
  // instead of silently falling back to the Gemini default model.
  const provider = providerForModel(modelOverride, svc.provider);
  const { credentials, errorHint } = await resolveImageGenCredentials({
    provider,
    mode: svc.mode,
  });

  const prompt = input.prompt as string;
  const mode = (input.mode as "generate" | "edit") ?? "generate";
  const sourcePaths = input.source_paths as string[] | undefined;

  if (!credentials) {
    // Managed mode with no managed proxy (typical self-host deployment):
    // fall back to the direct Replicate integration when a token resolves,
    // instead of dead-ending on "log in to Cue".
    if (svc.mode === "managed") {
      const replicateToken = await resolveToolingProviderToken("replicate");
      if (replicateToken) {
        if (mode === "edit") {
          return {
            content: `The managed proxy is unavailable on this deployment, and the direct Replicate fallback (${REPLICATE_FALLBACK_MODEL}) only supports text-to-image generation, not edits. To edit images, configure a Gemini/OpenAI API key in Settings → Models & Services and switch image generation to Your Own mode. Report this to the user as-is; do not change service configuration yourself.`,
            isError: true,
          };
        }
        return generateViaReplicateFallback({
          prompt,
          variants: input.variants as number | undefined,
          token: replicateToken,
          signal: context.signal,
        });
      }
      return {
        content: `${managedUnavailableHint()}\n\nReport this error to the user as-is. Do not change service configuration (managed/your-own mode or default provider/model settings) to try to fix it.`,
        isError: true,
      };
    }
    return {
      content: `${errorHint ?? "Image generation is not configured."}\n\nReport this error to the user as-is. Do not change service configuration (managed/your-own mode or default provider/model settings) to try to fix it.`,
      isError: true,
    };
  }
  const model =
    typeof modelOverride === "string" && modelOverride
      ? modelOverride
      : config.services["image-generation"].model;
  const variants = input.variants as number | undefined;

  // Resolve source images from file paths (sandboxed to workingDir, edit mode only)
  let sourceImages: Array<{ mimeType: string; dataBase64: string }> | undefined;

  if (mode === "edit" && sourcePaths && sourcePaths.length > 0) {
    const errors: string[] = [];
    const validPathImages: Array<{ mimeType: string; dataBase64: string }> = [];
    for (const filePath of sourcePaths) {
      let resolvedPath: string;
      const pathCheck = sandboxPolicy(filePath, context.workingDir);
      if (!pathCheck.ok) {
        // Fallback: if the source path is outside the sandbox (e.g. an image
        // attached from ~/Desktop), check if the attachment store has a
        // workspace-internal copy stored under its original source_path.
        const storedPath = getFilePathBySourcePath(
          filePath,
          context.conversationId,
        );
        if (!storedPath) {
          errors.push(pathCheck.error);
          continue;
        }
        const fallbackCheck = sandboxPolicy(storedPath, context.workingDir);
        if (!fallbackCheck.ok) {
          errors.push(pathCheck.error);
          continue;
        }
        resolvedPath = fallbackCheck.resolved;
      } else {
        resolvedPath = pathCheck.resolved;
      }
      const file = Bun.file(resolvedPath);
      if (!(await file.exists())) {
        errors.push(`File not found: ${filePath}`);
        continue;
      }
      const buffer = Buffer.from(await file.arrayBuffer());
      validPathImages.push({
        mimeType: file.type,
        dataBase64: buffer.toString("base64"),
      });
    }
    if (validPathImages.length === 0) {
      return {
        content: `None of the specified file paths could be read.\n${errors.join("\n")}`,
        isError: true,
      };
    }
    sourceImages = validPathImages;
  }

  try {
    const result = await generateImage(provider, credentials, {
      prompt,
      mode,
      sourceImages,
      model,
      variants,
    });

    const imageCount = result.images.length;
    let content = `Generated ${imageCount} image${imageCount !== 1 ? "s" : ""} using ${result.resolvedModel}.`;
    if (result.text) {
      content += `\n\n${result.text}`;
    }

    const contentBlocks: ImageContent[] = result.images.map((img) => {
      const block: ImageContent = {
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: img.mimeType,
          data: img.dataBase64,
        },
      };
      if (img.title) {
        (block as unknown as Record<string, unknown>)._title = img.title;
      }
      return block;
    });

    return {
      content,
      isError: false,
      contentBlocks,
    };
  } catch (error) {
    // Echo the model that failed so callers (including the skill's retry
    // branch) can key off the error text instead of remembering their input.
    return {
      content: `${mapImageGenError(provider, error)}\n\nFailed model: ${model}\n\nDo not change service configuration (managed/your-own mode or default provider/model settings) to try to fix it. Retrying this call once with a different model parameter is allowed; follow the skill's error handling instructions.`,
      isError: true,
    };
  }
}
