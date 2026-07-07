/**
 * `firecrawl_crawl` — bounded site crawl → per-page markdown via Firecrawl
 * (POST https://api.firecrawl.dev/v1/crawl, then poll GET /v1/crawl/{id}).
 *
 * Direct HTTPS calls from the daemon process. Key resolution: daemon config
 * (`toolApis.firecrawlKey`) → `CUE_FIRECRAWL_API_KEY` env var. A missing key
 * returns a clean, actionable error — never a throw.
 *
 * SAFETY: crawl bounds are HARD-CAPPED here in the executor (maxPages ≤ 20,
 * depth ≤ 2) — whatever the model passes is clamped. Do not relax these caps;
 * they are the cost/abuse boundary, not a tunable.
 */
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { resolveToolApiKey } from "../../_shared/tool-api-keys.js";
import { normalizeUrl } from "./firecrawl-scrape.js";

const FIRECRAWL_CRAWL_URL = "https://api.firecrawl.dev/v1/crawl";

/** Hard executor-enforced caps — clamped regardless of model input. */
export const MAX_PAGES_HARD_CAP = 20;
export const MAX_DEPTH_HARD_CAP = 2;

const DEFAULT_MAX_PAGES = 10;
const DEFAULT_MAX_DEPTH = 1;

const DEFAULT_WAIT_SECONDS = 180;
const MAX_WAIT_SECONDS = 600;
const POLL_INTERVAL_MS = 3000;

/** Per-page markdown truncation to keep the aggregate result manageable. */
const PER_PAGE_MAX_CHARS = 4000;

/**
 * Clamp requested crawl bounds into the executor's hard caps.
 * Exported for tests — this is the enforcement point for the ≤20 pages /
 * ≤2 depth safety boundary.
 */
export function clampCrawlBounds(
  maxPages: unknown,
  maxDepth: unknown,
): { limit: number; maxDepth: number } {
  const requestedPages = Math.floor(Number(maxPages));
  const requestedDepth = Math.floor(Number(maxDepth));
  return {
    limit: Math.min(
      MAX_PAGES_HARD_CAP,
      Math.max(
        1,
        Number.isFinite(requestedPages) && requestedPages > 0
          ? requestedPages
          : DEFAULT_MAX_PAGES,
      ),
    ),
    maxDepth: Math.min(
      MAX_DEPTH_HARD_CAP,
      Math.max(
        1,
        Number.isFinite(requestedDepth) && requestedDepth > 0
          ? requestedDepth
          : DEFAULT_MAX_DEPTH,
      ),
    ),
  };
}

interface CrawlCreateResponse {
  success?: boolean;
  error?: string;
  id?: string;
  url?: string;
}

interface CrawlPage {
  markdown?: string;
  metadata?: {
    title?: string;
    sourceURL?: string;
    statusCode?: number;
    error?: string | null;
  };
}

interface CrawlStatusResponse {
  status?: string; // "scraping" | "completed" | "failed"
  total?: number;
  completed?: number;
  creditsUsed?: number;
  error?: string;
  data?: CrawlPage[];
}

function formatPages(pages: CrawlPage[]): string {
  return pages
    .map((page, i) => {
      const title = page.metadata?.title?.trim() || "(untitled)";
      const source = page.metadata?.sourceURL ?? "(unknown URL)";
      const markdown = (page.markdown ?? "").trim();
      const body =
        markdown.length > PER_PAGE_MAX_CHARS
          ? `${markdown.slice(0, PER_PAGE_MAX_CHARS)}\n[Page truncated at ${PER_PAGE_MAX_CHARS} chars — firecrawl_scrape this URL for the full text.]`
          : markdown || "(no markdown content)";
      return `--- Page ${i + 1}: ${title}\n${source}\n\n${body}`;
    })
    .join("\n\n");
}

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const rawUrl = input.url;
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    return {
      content: "Provide a non-empty `url` string to crawl.",
      isError: true,
    };
  }
  const url = normalizeUrl(rawUrl);

  const keyResolution = resolveToolApiKey("firecrawl");
  if (!keyResolution.ok) {
    return { content: keyResolution.error, isError: true };
  }

  // HARD caps enforced here, regardless of what the model passed.
  const bounds = clampCrawlBounds(input.max_pages, input.max_depth);
  const waitSeconds = Math.min(
    MAX_WAIT_SECONDS,
    Math.max(1, Number(input.wait_seconds) || DEFAULT_WAIT_SECONDS),
  );

  const headers = {
    Authorization: `Bearer ${keyResolution.key}`,
    "Content-Type": "application/json",
  };

  // Start the crawl job.
  let created: CrawlCreateResponse;
  try {
    const res = await fetch(FIRECRAWL_CRAWL_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        url,
        limit: bounds.limit,
        maxDepth: bounds.maxDepth,
        scrapeOptions: { formats: ["markdown"], onlyMainContent: true },
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
        content: `Firecrawl crawl request failed (HTTP ${res.status})${hint}: ${text.slice(0, 500)}`,
        isError: true,
      };
    }
    created = JSON.parse(text) as CrawlCreateResponse;
  } catch (err) {
    return {
      content: `Failed to start Firecrawl crawl: ${(err as Error).message}`,
      isError: true,
    };
  }

  if (created.success === false || !created.id) {
    return {
      content: `Firecrawl crawl of ${url} was not accepted: ${created.error ?? "no job id returned"}`,
      isError: true,
    };
  }

  // Poll the job to a terminal state.
  const statusUrl = `${FIRECRAWL_CRAWL_URL}/${created.id}`;
  const deadline = Date.now() + waitSeconds * 1000;
  let status: CrawlStatusResponse = {};

  while (true) {
    if (context.signal?.aborted) {
      return { content: "Cancelled.", isError: true };
    }
    if (Date.now() >= deadline) {
      return {
        content: `Firecrawl crawl ${created.id} did not finish within ${waitSeconds}s (status: ${status.status ?? "unknown"}, ${status.completed ?? 0}/${status.total ?? "?"} pages). The job may still be running; retry with a larger wait_seconds or fewer max_pages.`,
        isError: true,
        status: "timed out" as const,
      };
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    try {
      const res = await fetch(statusUrl, { headers, signal: context.signal });
      const text = await res.text();
      if (!res.ok) {
        return {
          content: `Firecrawl crawl status poll failed (HTTP ${res.status}): ${text.slice(0, 500)}`,
          isError: true,
        };
      }
      status = JSON.parse(text) as CrawlStatusResponse;
    } catch (err) {
      return {
        content: `Failed to poll Firecrawl crawl status: ${(err as Error).message}`,
        isError: true,
      };
    }

    if (status.status === "completed" || status.status === "failed") break;
  }

  if (status.status === "failed") {
    return {
      content: `Firecrawl crawl of ${url} failed: ${status.error ?? "no error detail provided"}`,
      isError: true,
    };
  }

  const pages = (status.data ?? []).filter(
    (p) => (p.markdown ?? "").trim().length > 0 || p.metadata?.sourceURL,
  );
  if (pages.length === 0) {
    return {
      content: `Firecrawl crawl of ${url} completed but returned no pages with content. Check the URL, or try firecrawl_scrape on the page directly.`,
      isError: true,
    };
  }

  const summary = `Crawled ${url}: ${pages.length} page(s) (limit ${bounds.limit}, depth ${bounds.maxDepth}${typeof status.creditsUsed === "number" ? `, ${status.creditsUsed} credits used` : ""}).`;
  return {
    content: `${summary}\n\n${formatPages(pages)}`,
    isError: false,
  };
}
