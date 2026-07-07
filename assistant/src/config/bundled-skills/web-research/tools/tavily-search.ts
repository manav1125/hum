/**
 * `tavily_search` — research-grade web search via Tavily
 * (POST https://api.tavily.com/search).
 *
 * Direct HTTPS call from the daemon process (same pattern as
 * replicate/tools/replicate-run.ts). Key resolution: daemon config
 * (`toolApis.tavilyKey`) → `CUE_TAVILY_API_KEY` env var. A missing key
 * returns a clean, actionable error — never a throw.
 */
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { resolveToolApiKey } from "../../_shared/tool-api-keys.js";

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";

/** Tavily accepts 0-20; we clamp requests into [1, 20]. */
const MAX_RESULTS_CAP = 20;
const DEFAULT_MAX_RESULTS = 5;

const VALID_TOPICS = new Set(["general", "news", "finance"]);
const VALID_TIME_RANGES = new Set(["day", "week", "month", "year"]);

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
}

interface TavilySearchResponse {
  query?: string;
  answer?: string;
  results?: TavilyResult[];
  response_time?: number;
}

/** Format the Tavily response as an LLM-friendly cited-results block. */
function formatResults(response: TavilySearchResponse): string {
  const parts: string[] = [];
  if (response.answer) {
    parts.push(`Answer: ${response.answer}`);
  }
  const results = response.results ?? [];
  if (results.length === 0) {
    parts.push("No results returned. Try a broader or rephrased query.");
  } else {
    const lines = results.map((r, i) => {
      const title = r.title?.trim() || "(untitled)";
      const url = r.url ?? "";
      const content = r.content?.trim() ?? "";
      const score =
        typeof r.score === "number" ? ` (relevance ${r.score.toFixed(2)})` : "";
      return `${i + 1}. ${title}${score}\n   ${url}\n   ${content}`;
    });
    parts.push(`Results (${results.length}):\n${lines.join("\n")}`);
  }
  return parts.join("\n\n");
}

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const query = input.query;
  if (typeof query !== "string" || !query.trim()) {
    return {
      content: "Provide a non-empty `query` string to search for.",
      isError: true,
    };
  }

  const keyResolution = resolveToolApiKey("tavily");
  if (!keyResolution.ok) {
    return { content: keyResolution.error, isError: true };
  }

  const maxResults = Math.min(
    MAX_RESULTS_CAP,
    Math.max(1, Math.floor(Number(input.max_results) || DEFAULT_MAX_RESULTS)),
  );

  const body: Record<string, unknown> = {
    query: query.trim(),
    max_results: maxResults,
    include_answer: input.include_answer !== false,
  };
  if (typeof input.topic === "string" && VALID_TOPICS.has(input.topic)) {
    body.topic = input.topic;
  }
  if (
    typeof input.time_range === "string" &&
    VALID_TIME_RANGES.has(input.time_range)
  ) {
    body.time_range = input.time_range;
  }

  let response: TavilySearchResponse;
  try {
    const res = await fetch(TAVILY_SEARCH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${keyResolution.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: context.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      return {
        content: `Tavily search failed (HTTP ${res.status}): ${text.slice(0, 500)}`,
        isError: true,
      };
    }
    response = JSON.parse(text) as TavilySearchResponse;
  } catch (err) {
    return {
      content: `Tavily search request failed: ${(err as Error).message}`,
      isError: true,
    };
  }

  return {
    content: `Tavily search for "${query.trim()}":\n\n${formatResults(response)}`,
    isError: false,
  };
}
