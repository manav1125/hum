/**
 * `firecrawl_scrape` — single page → clean markdown via Firecrawl
 * (POST https://api.firecrawl.dev/v1/scrape).
 *
 * Direct HTTPS call from the daemon process. Key resolution: daemon config
 * (`toolApis.firecrawlKey`) → `CUE_FIRECRAWL_API_KEY` env var. A missing key
 * returns a clean, actionable error — never a throw.
 */
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { resolveToolApiKey } from "../../_shared/tool-api-keys.js";

const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v1/scrape";

const DEFAULT_MAX_CHARS = 20_000;
const MAX_MAX_CHARS = 100_000;

interface FirecrawlScrapeResponse {
  success?: boolean;
  error?: string;
  data?: {
    markdown?: string;
    metadata?: {
      title?: string;
      description?: string;
      sourceURL?: string;
      statusCode?: number;
      error?: string;
    };
  };
}

/** Normalize a URL: assume https:// when the scheme is missing. */
export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const rawUrl = input.url;
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    return {
      content: "Provide a non-empty `url` string to scrape.",
      isError: true,
    };
  }
  const url = normalizeUrl(rawUrl);

  const keyResolution = resolveToolApiKey("firecrawl");
  if (!keyResolution.ok) {
    return { content: keyResolution.error, isError: true };
  }

  const maxChars = Math.min(
    MAX_MAX_CHARS,
    Math.max(1000, Math.floor(Number(input.max_chars) || DEFAULT_MAX_CHARS)),
  );

  let response: FirecrawlScrapeResponse;
  try {
    const res = await fetch(FIRECRAWL_SCRAPE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${keyResolution.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        formats: ["markdown"],
        onlyMainContent: input.only_main_content !== false,
      }),
      signal: context.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      const hint =
        res.status === 402
          ? " (Firecrawl credits exhausted — tell the user)"
          : "";
      return {
        content: `Firecrawl scrape failed (HTTP ${res.status})${hint}: ${text.slice(0, 500)}`,
        isError: true,
      };
    }
    response = JSON.parse(text) as FirecrawlScrapeResponse;
  } catch (err) {
    return {
      content: `Firecrawl scrape request failed: ${(err as Error).message}`,
      isError: true,
    };
  }

  if (response.success === false || !response.data) {
    return {
      content: `Firecrawl scrape of ${url} failed: ${response.error ?? "no data returned"}`,
      isError: true,
    };
  }

  const markdown = response.data.markdown ?? "";
  if (!markdown.trim()) {
    return {
      content: `Firecrawl scraped ${url} but returned no markdown content. The page may be empty or blocked; try plain web_fetch as a fallback.`,
      isError: true,
    };
  }

  const meta = response.data.metadata;
  const headerParts = [
    `Scraped: ${meta?.sourceURL ?? url}`,
    meta?.title ? `Title: ${meta.title}` : undefined,
    typeof meta?.statusCode === "number"
      ? `HTTP status: ${meta.statusCode}`
      : undefined,
  ].filter((p): p is string => p !== undefined);

  const truncated = markdown.length > maxChars;
  const body = truncated
    ? `${markdown.slice(0, maxChars)}\n\n[Truncated at ${maxChars} characters — re-run with a larger max_chars for more.]`
    : markdown;

  return {
    content: `${headerParts.join("\n")}\n\n${body}`,
    isError: false,
  };
}
