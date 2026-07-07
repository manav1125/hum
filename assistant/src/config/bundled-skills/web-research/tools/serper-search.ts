/**
 * `serper_search` — Google SERP via Serper
 * (POST https://google.serper.dev/search, X-API-KEY auth).
 *
 * Direct HTTPS call from the daemon process. Key resolution: daemon config
 * (`toolApis.serperKey`) → `CUE_SERPER_API_KEY` env var. A missing key
 * returns a clean, actionable error — never a throw.
 */
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { resolveToolApiKey } from "../../_shared/tool-api-keys.js";

const SERPER_SEARCH_URL = "https://google.serper.dev/search";

const NUM_CAP = 20;
const DEFAULT_NUM = 10;

interface SerperOrganicResult {
  title?: string;
  link?: string;
  snippet?: string;
  date?: string;
  position?: number;
}

interface SerperSearchResponse {
  organic?: SerperOrganicResult[];
  answerBox?: { title?: string; answer?: string; snippet?: string };
  knowledgeGraph?: {
    title?: string;
    type?: string;
    description?: string;
    attributes?: Record<string, string>;
  };
  relatedSearches?: { query?: string }[];
}

/** Format Serper's SERP payload; optional blocks are guarded (not every query has them). */
function formatResults(response: SerperSearchResponse): string {
  const parts: string[] = [];

  const box = response.answerBox;
  if (box && (box.answer || box.snippet)) {
    parts.push(
      `Answer box${box.title ? ` (${box.title})` : ""}: ${box.answer ?? box.snippet}`,
    );
  }

  const kg = response.knowledgeGraph;
  if (kg?.title) {
    const attrs = kg.attributes
      ? Object.entries(kg.attributes)
          .map(([k, v]) => `${k}: ${v}`)
          .join("; ")
      : "";
    parts.push(
      `Knowledge graph: ${kg.title}${kg.type ? ` — ${kg.type}` : ""}${kg.description ? `. ${kg.description}` : ""}${attrs ? ` (${attrs})` : ""}`,
    );
  }

  const organic = response.organic ?? [];
  if (organic.length === 0) {
    parts.push("No organic results returned. Try a rephrased query.");
  } else {
    const lines = organic.map((r, i) => {
      const title = r.title?.trim() || "(untitled)";
      const date = r.date ? ` — ${r.date}` : "";
      return `${i + 1}. ${title}${date}\n   ${r.link ?? ""}\n   ${r.snippet?.trim() ?? ""}`;
    });
    parts.push(`Organic results (${organic.length}):\n${lines.join("\n")}`);
  }

  const related = (response.relatedSearches ?? [])
    .map((r) => r.query)
    .filter((q): q is string => typeof q === "string" && q.length > 0);
  if (related.length > 0) {
    parts.push(`Related searches: ${related.join(" · ")}`);
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

  const keyResolution = resolveToolApiKey("serper");
  if (!keyResolution.ok) {
    return { content: keyResolution.error, isError: true };
  }

  const num = Math.min(
    NUM_CAP,
    Math.max(1, Math.floor(Number(input.num) || DEFAULT_NUM)),
  );

  const body: Record<string, unknown> = { q: query.trim(), num };
  if (typeof input.gl === "string" && input.gl.trim()) {
    body.gl = input.gl.trim();
  }
  if (typeof input.hl === "string" && input.hl.trim()) {
    body.hl = input.hl.trim();
  }

  let response: SerperSearchResponse;
  try {
    const res = await fetch(SERPER_SEARCH_URL, {
      method: "POST",
      headers: {
        "X-API-KEY": keyResolution.key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: context.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      return {
        content: `Serper search failed (HTTP ${res.status}): ${text.slice(0, 500)}`,
        isError: true,
      };
    }
    response = JSON.parse(text) as SerperSearchResponse;
  } catch (err) {
    return {
      content: `Serper search request failed: ${(err as Error).message}`,
      isError: true,
    };
  }

  return {
    content: `Serper (Google) search for "${query.trim()}":\n\n${formatResults(response)}`,
    isError: false,
  };
}
