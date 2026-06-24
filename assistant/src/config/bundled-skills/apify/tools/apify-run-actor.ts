import { resolveToolingProviderToken } from "../../../../providers/tooling-credentials.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

const APIFY_API_BASE = "https://api.apify.com/v2";

/** Default and ceiling for how long to wait for a run (seconds). */
const DEFAULT_WAIT_SECONDS = 120;
const MAX_WAIT_SECONDS = 600;
/** Delay between run-status polls (ms). */
const POLL_INTERVAL_MS = 3000;

/** Default and ceiling for dataset items returned. */
const DEFAULT_MAX_ITEMS = 50;
const MAX_MAX_ITEMS = 1000;

interface RunResponse {
  data: {
    id: string;
    status: string;
    defaultDatasetId?: string;
  };
}

/** Apify run paths use `username~actor-name`; normalize a slash form to it. */
function normalizeActorId(actorId: string): string {
  return actorId.trim().replace("/", "~");
}

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const actorId = input.actor_id;
  const actorInput = input.input;

  if (typeof actorId !== "string" || !actorId.trim()) {
    return {
      content:
        "Provide an Apify `actor_id` (e.g. 'apify/web-scraper' or 'apify~web-scraper').",
      isError: true,
    };
  }
  if (
    typeof actorInput !== "object" ||
    actorInput === null ||
    Array.isArray(actorInput)
  ) {
    return {
      content:
        'Provide an `input` object with the actor\'s parameters (e.g. { "startUrls": [...] }).',
      isError: true,
    };
  }

  const token = await resolveToolingProviderToken("apify");
  if (!token) {
    return {
      content:
        "Apify is not configured. Set a token via `assistant keys set apify <token>` or the APIFY_API_TOKEN (or APIFY_TOKEN) environment variable. Report this error to the user as-is; do not change configuration to fix it.",
      isError: true,
    };
  }

  const waitSeconds = Math.min(
    MAX_WAIT_SECONDS,
    Math.max(1, Number(input.wait_seconds) || DEFAULT_WAIT_SECONDS),
  );
  const maxItems = Math.min(
    MAX_MAX_ITEMS,
    Math.max(1, Number(input.max_items) || DEFAULT_MAX_ITEMS),
  );

  const normalized = normalizeActorId(actorId);
  const authHeader = { Authorization: `Bearer ${token}` };

  // Start the run.
  let runData: RunResponse["data"];
  try {
    const res = await fetch(`${APIFY_API_BASE}/acts/${normalized}/runs`, {
      method: "POST",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify(actorInput),
      signal: context.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      return {
        content: `Apify run request failed (HTTP ${res.status}): ${text.slice(0, 500)}`,
        isError: true,
      };
    }
    runData = (JSON.parse(text) as RunResponse).data;
  } catch (err) {
    return {
      content: `Failed to start Apify actor run: ${(err as Error).message}`,
      isError: true,
    };
  }

  const runId = runData.id;
  const deadline = Date.now() + waitSeconds * 1000;

  // Poll the run until terminal status or deadline.
  while (runData.status === "READY" || runData.status === "RUNNING") {
    if (context.signal?.aborted) {
      return { content: "Cancelled.", isError: true };
    }
    if (Date.now() >= deadline) {
      return {
        content: `Apify run ${runId} did not finish within ${waitSeconds}s (status: ${runData.status}). The run may still be in progress; retry with a larger wait_seconds.`,
        isError: true,
        status: "timed out",
      };
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    try {
      const res = await fetch(`${APIFY_API_BASE}/actor-runs/${runId}`, {
        headers: authHeader,
        signal: context.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        return {
          content: `Apify run poll failed (HTTP ${res.status}): ${text.slice(0, 500)}`,
          isError: true,
        };
      }
      runData = (JSON.parse(text) as RunResponse).data;
    } catch (err) {
      return {
        content: `Failed to poll Apify run: ${(err as Error).message}`,
        isError: true,
      };
    }
  }

  if (runData.status !== "SUCCEEDED") {
    return {
      content: `Apify run ${runId} ended with status ${runData.status}. Check that the actor input matches what the actor expects.`,
      isError: true,
    };
  }

  const datasetId = runData.defaultDatasetId;
  if (!datasetId) {
    return {
      content: `Apify run ${runId} succeeded but exposed no default dataset.`,
      isError: false,
    };
  }

  // Fetch dataset items.
  try {
    const res = await fetch(
      `${APIFY_API_BASE}/datasets/${datasetId}/items?clean=true&format=json&limit=${maxItems}`,
      { headers: authHeader, signal: context.signal },
    );
    const text = await res.text();
    if (!res.ok) {
      return {
        content: `Apify dataset fetch failed (HTTP ${res.status}): ${text.slice(0, 500)}`,
        isError: true,
      };
    }
    const items = JSON.parse(text) as unknown[];
    const count = Array.isArray(items) ? items.length : 0;
    return {
      content: `Apify actor ${actorId} run ${runId} returned ${count} item${count === 1 ? "" : "s"}:\n${JSON.stringify(items, null, 2)}`,
      isError: false,
    };
  } catch (err) {
    return {
      content: `Failed to fetch Apify dataset items: ${(err as Error).message}`,
      isError: true,
    };
  }
}
