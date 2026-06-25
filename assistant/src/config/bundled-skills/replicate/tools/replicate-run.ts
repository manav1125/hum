import { resolveToolingProviderToken } from "../../../../providers/tooling-credentials.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

const REPLICATE_API_BASE = "https://api.replicate.com/v1";

/** Default and ceiling for how long to poll a prediction (seconds). */
const DEFAULT_WAIT_SECONDS = 120;
const MAX_WAIT_SECONDS = 600;
/** Delay between poll attempts (ms). */
const POLL_INTERVAL_MS = 2000;

/** A 64-char hex string is a bare Replicate version hash. */
const BARE_VERSION_RE = /^[0-9a-f]{64}$/i;

interface PredictionResponse {
  id: string;
  status: string;
  output?: unknown;
  error?: string | null;
  urls?: { get?: string };
}

/**
 * Build the request body + endpoint for creating a prediction.
 *
 * Replicate has two creation endpoints:
 *   - `owner/name` (no version): POST /models/{owner}/{name}/predictions
 *   - a version hash: POST /predictions with { version, input }
 * `owner/name:version` pins the version via the /predictions endpoint.
 */
function buildCreateRequest(
  model: string,
  input: Record<string, unknown>,
): { url: string; body: Record<string, unknown> } | { error: string } {
  const trimmed = model.trim();
  if (!trimmed) return { error: "model must not be empty" };

  // owner/name[:version]
  if (trimmed.includes("/")) {
    const [ownerName, version] = trimmed.split(":", 2);
    const [owner, name] = ownerName.split("/", 2);
    if (!owner || !name) {
      return {
        error: `Invalid model "${model}". Use 'owner/name', 'owner/name:version', or a 64-hex version hash.`,
      };
    }
    if (version) {
      return {
        url: `${REPLICATE_API_BASE}/predictions`,
        body: { version, input },
      };
    }
    return {
      url: `${REPLICATE_API_BASE}/models/${owner}/${name}/predictions`,
      body: { input },
    };
  }

  // bare version hash
  if (BARE_VERSION_RE.test(trimmed)) {
    return {
      url: `${REPLICATE_API_BASE}/predictions`,
      body: { version: trimmed, input },
    };
  }

  return {
    error: `Invalid model "${model}". Use 'owner/name', 'owner/name:version', or a 64-hex version hash.`,
  };
}

/** Flatten Replicate's `output` (string | string[] | object) to media URLs. */
function extractUrls(output: unknown): string[] {
  if (typeof output === "string") return [output];
  if (Array.isArray(output)) {
    return output.filter((o): o is string => typeof o === "string");
  }
  return [];
}

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const model = input.model;
  const modelInput = input.input;

  if (typeof model !== "string" || !model.trim()) {
    return {
      content:
        "Provide a Replicate `model` (e.g. 'black-forest-labs/flux-schnell').",
      isError: true,
    };
  }
  if (
    typeof modelInput !== "object" ||
    modelInput === null ||
    Array.isArray(modelInput)
  ) {
    return {
      content:
        'Provide an `input` object of model parameters (e.g. { "prompt": "..." }).',
      isError: true,
    };
  }

  const token = await resolveToolingProviderToken("replicate");
  if (!token) {
    return {
      content:
        "Replicate is not configured. Set a token via `assistant keys set replicate <token>` or the REPLICATE_API_TOKEN environment variable. Report this error to the user as-is; do not change configuration to fix it.",
      isError: true,
    };
  }

  const waitSeconds = Math.min(
    MAX_WAIT_SECONDS,
    Math.max(1, Number(input.wait_seconds) || DEFAULT_WAIT_SECONDS),
  );

  const created = buildCreateRequest(
    model,
    modelInput as Record<string, unknown>,
  );
  if ("error" in created) {
    return { content: created.error, isError: true };
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  // `Prefer: wait` asks Replicate to hold the create request open until the
  // prediction reaches a terminal state (or the sync window elapses), so fast
  // models (e.g. flux-schnell) return a finished prediction in a single round
  // trip instead of create-then-poll. Replicate caps the sync hold at 60s; if
  // the job outlives it the response comes back still "processing" and the
  // polling loop below takes over — so this is a pure latency win for short
  // image jobs with no downside for long video jobs.
  const createHeaders = {
    ...headers,
    Prefer: `wait=${Math.min(60, waitSeconds)}`,
  };

  let prediction: PredictionResponse;
  try {
    const res = await fetch(created.url, {
      method: "POST",
      headers: createHeaders,
      body: JSON.stringify(created.body),
      signal: context.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      return {
        content: `Replicate prediction request failed (HTTP ${res.status}): ${text.slice(0, 500)}`,
        isError: true,
      };
    }
    prediction = JSON.parse(text) as PredictionResponse;
  } catch (err) {
    return {
      content: `Failed to start Replicate prediction: ${(err as Error).message}`,
      isError: true,
    };
  }

  const getUrl =
    prediction.urls?.get ??
    `${REPLICATE_API_BASE}/predictions/${prediction.id}`;
  const deadline = Date.now() + waitSeconds * 1000;

  // Poll until terminal status or deadline.
  while (
    prediction.status !== "succeeded" &&
    prediction.status !== "failed" &&
    prediction.status !== "canceled"
  ) {
    if (context.signal?.aborted) {
      return { content: "Cancelled.", isError: true };
    }
    if (Date.now() >= deadline) {
      return {
        content: `Replicate prediction ${prediction.id} did not finish within ${waitSeconds}s (status: ${prediction.status}). The job may still be running; retry with a larger wait_seconds.`,
        isError: true,
        status: "timed out",
      };
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    try {
      const res = await fetch(getUrl, { headers, signal: context.signal });
      const text = await res.text();
      if (!res.ok) {
        return {
          content: `Replicate poll failed (HTTP ${res.status}): ${text.slice(0, 500)}`,
          isError: true,
        };
      }
      prediction = JSON.parse(text) as PredictionResponse;
    } catch (err) {
      return {
        content: `Failed to poll Replicate prediction: ${(err as Error).message}`,
        isError: true,
      };
    }
  }

  if (prediction.status !== "succeeded") {
    return {
      content: `Replicate prediction ${prediction.status}: ${prediction.error ?? "no error detail provided"}`,
      isError: true,
    };
  }

  const urls = extractUrls(prediction.output);
  if (urls.length === 0) {
    return {
      content: `Replicate prediction succeeded but returned no media URL. Raw output: ${JSON.stringify(prediction.output).slice(0, 500)}`,
      isError: false,
    };
  }

  const label = urls.length === 1 ? "1 output" : `${urls.length} outputs`;
  return {
    content: `Replicate model ${model} produced ${label}:\n${urls.join("\n")}`,
    isError: false,
  };
}
