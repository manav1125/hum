/**
 * web-scrape bundled skill — hard crawl caps + missing-key behavior.
 *
 * The crawl bounds (maxPages ≤ 20, depth ≤ 2) are a safety boundary enforced
 * IN THE EXECUTOR (clampCrawlBounds), not just in the prompt — these tests
 * pin that contract. Missing-key behavior mirrors web-research: a clean
 * actionable error result, never a throw. No live network calls here.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { ToolContext } from "../../../../tools/types.js";
import {
  clampCrawlBounds,
  MAX_DEPTH_HARD_CAP,
  MAX_PAGES_HARD_CAP,
  run as firecrawlCrawl,
} from "../tools/firecrawl-crawl.js";
import {
  normalizeUrl,
  run as firecrawlScrape,
} from "../tools/firecrawl-scrape.js";

const context = { conversationId: "test", workingDir: "/tmp" } as ToolContext;

let savedKey: string | undefined;

beforeEach(() => {
  savedKey = process.env.CUE_FIRECRAWL_API_KEY;
  delete process.env.CUE_FIRECRAWL_API_KEY;
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.CUE_FIRECRAWL_API_KEY;
  else process.env.CUE_FIRECRAWL_API_KEY = savedKey;
});

describe("clampCrawlBounds (executor-enforced hard caps)", () => {
  test("hard caps are the documented values", () => {
    expect(MAX_PAGES_HARD_CAP).toBe(20);
    expect(MAX_DEPTH_HARD_CAP).toBe(2);
  });

  test("oversized model input is clamped, regardless of what was passed", () => {
    expect(clampCrawlBounds(1000, 99)).toEqual({ limit: 20, maxDepth: 2 });
    expect(clampCrawlBounds(Number.MAX_SAFE_INTEGER, 50)).toEqual({
      limit: 20,
      maxDepth: 2,
    });
  });

  test("absent/invalid input falls back to safe defaults", () => {
    expect(clampCrawlBounds(undefined, undefined)).toEqual({
      limit: 10,
      maxDepth: 1,
    });
    expect(clampCrawlBounds("banana", null)).toEqual({
      limit: 10,
      maxDepth: 1,
    });
    expect(clampCrawlBounds(0, -3)).toEqual({ limit: 10, maxDepth: 1 });
  });

  test("in-bounds requests pass through", () => {
    expect(clampCrawlBounds(15, 2)).toEqual({ limit: 15, maxDepth: 2 });
    expect(clampCrawlBounds(1, 1)).toEqual({ limit: 1, maxDepth: 1 });
  });
});

describe("normalizeUrl", () => {
  test("assumes https:// when the scheme is missing", () => {
    expect(normalizeUrl("example.com/docs")).toBe("https://example.com/docs");
    expect(normalizeUrl("  http://example.com ")).toBe("http://example.com");
    expect(normalizeUrl("https://example.com")).toBe("https://example.com");
  });
});

describe("executors with a missing key", () => {
  test("firecrawl_scrape returns the clean error and does not throw", async () => {
    const result = await firecrawlScrape(
      { url: "https://example.com" },
      context,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Firecrawl key not configured");
    expect(result.content).toContain("CUE_FIRECRAWL_API_KEY");
  });

  test("firecrawl_crawl returns the clean error and does not throw", async () => {
    const result = await firecrawlCrawl(
      { url: "https://example.com", max_pages: 500 },
      context,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Firecrawl key not configured");
    expect(result.content).toContain("CUE_FIRECRAWL_API_KEY");
  });
});

describe("input validation (before any key or network use)", () => {
  test("firecrawl_scrape rejects an empty url", async () => {
    const result = await firecrawlScrape({ url: " " }, context);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("url");
  });

  test("firecrawl_crawl rejects a missing url", async () => {
    const result = await firecrawlCrawl({}, context);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("url");
  });
});
