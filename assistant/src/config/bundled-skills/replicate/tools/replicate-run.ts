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

export interface ReplicatePredictionOptions {
  /** Model identifier: `owner/name`, `owner/name:version`, or a 64-hex version hash. */
  model: string;
  /** Model-specific input parameters (e.g. `{ prompt: "..." }`). */
  input: Record<string, unknown>;
  /** Replicate API token (already resolved by the caller). */
  token: string;
  /** Max seconds to poll for completion. Clamped to [1, MAX_WAIT_SECONDS]. */
  waitSeconds?: number;
  /** Abort signal for the underlying HTTP requests. */
  signal?: AbortSignal;
}

export type ReplicatePredictionResult =
  | { ok: true; urls: string[]; output: unknown }
  | { ok: false; error: string; timedOut?: boolean };

/**
 * Create a Replicate prediction and poll it to a terminal state.
 *
 * Shared executor behind the `replicate_run` tool; also used by the
 * image-studio `media_generate_image` tool as its direct-Replicate fallback
 * when the managed proxy is unavailable. Returns a discriminated result
 * instead of a ToolExecutionResult so each call site can format its own
 * user/LLM-facing message.
 */
export async function executeReplicatePrediction(
  opts: ReplicatePredictionOptions,
): Promise<ReplicatePredictionResult> {
  const { model, token, signal } = opts;
  const waitSeconds = Math.min(
    MAX_WAIT_SECONDS,
    Math.max(1, Number(opts.waitSeconds) || DEFAULT_WAIT_SECONDS),
  );

  const created = buildCreateRequest(model, opts.input);
  if ("error" in created) {
    return { ok: false, error: created.error };
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
      signal,
    });
    const text = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        error: `Replicate prediction request failed (HTTP ${res.status}): ${text.slice(0, 500)}`,
      };
    }
    prediction = JSON.parse(text) as PredictionResponse;
  } catch (err) {
    return {
      ok: false,
      error: `Failed to start Replicate prediction: ${(err as Error).message}`,
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
    if (signal?.aborted) {
      return { ok: false, error: "Cancelled." };
    }
    if (Date.now() >= deadline) {
      return {
        ok: false,
        error: `Replicate prediction ${prediction.id} did not finish within ${waitSeconds}s (status: ${prediction.status}). The job may still be running; retry with a larger wait_seconds.`,
        timedOut: true,
      };
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    try {
      const res = await fetch(getUrl, { headers, signal });
      const text = await res.text();
      if (!res.ok) {
        return {
          ok: false,
          error: `Replicate poll failed (HTTP ${res.status}): ${text.slice(0, 500)}`,
        };
      }
      prediction = JSON.parse(text) as PredictionResponse;
    } catch (err) {
      return {
        ok: false,
        error: `Failed to poll Replicate prediction: ${(err as Error).message}`,
      };
    }
  }

  if (prediction.status !== "succeeded") {
    return {
      ok: false,
      error: `Replicate prediction ${prediction.status}: ${prediction.error ?? "no error detail provided"}`,
    };
  }

  return {
    ok: true,
    urls: extractUrls(prediction.output),
    output: prediction.output,
  };
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
        "Replicate is not configured. Replicate is a DIRECT api.replicate.com integration — it does NOT use Composio or any OAuth connection. Tell the user to set a Replicate API token via `assistant keys set replicate <token>` or the REPLICATE_API_TOKEN environment variable. Report this as-is; do NOT change configuration and do NOT attempt a Composio/OAuth 'Connect Replicate' flow to fix it.",
      isError: true,
    };
  }

  const result = await executeReplicatePrediction({
    model,
    input: modelInput as Record<string, unknown>,
    token,
    waitSeconds: Number(input.wait_seconds) || undefined,
    signal: context.signal,
  });

  if (!result.ok) {
    return {
      content: result.error,
      isError: true,
      ...(result.timedOut ? { status: "timed out" as const } : {}),
    };
  }

  const urls = result.urls;
  if (urls.length === 0) {
    return {
      content: `Replicate prediction succeeded but returned no media URL. Raw output: ${JSON.stringify(result.output).slice(0, 500)}`,
      isError: false,
    };
  }

  const label = urls.length === 1 ? "1 output" : `${urls.length} outputs`;
  return {
    content: `Replicate model ${model} produced ${label}:\n${urls.join("\n")}`,
    isError: false,
  };
}
