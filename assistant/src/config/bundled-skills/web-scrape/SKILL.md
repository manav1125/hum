---
name: web-scrape
description: High-fidelity clean-markdown extraction from web pages, and bounded multi-page site crawls (Firecrawl). COMPLEMENTS web_fetch rather than replacing it — for a single quick page read, plain web_fetch is fine; load this skill when a page needs proper clean-markdown extraction (JS-rendered apps, complex layouts, content web_fetch mangles) via `firecrawl_scrape`, or when the user needs content from MULTIPLE pages of one site (docs sites, blogs, competitor sites — hard-capped at 20 pages, depth 2) via `firecrawl_crawl`.
compatibility: "Designed for Cue personal assistants"
metadata:
  emoji: "📄"
  vellum:
    display-name: "Web Scrape"
    category: "browsing"
    activation-hints:
      - "User needs the full, clean content of a page that is JS-rendered or that web_fetch extracted poorly"
      - "User wants a page turned into clean markdown for a report, summary, or document"
      - "User asks to read/ingest a whole docs site, blog, or a site section (multiple pages of one domain)"
      - "User asks to 'crawl', 'scrape the whole site', or compare content across several pages of a competitor's site"
---

Use the `firecrawl_scrape` and `firecrawl_crawl` tools via `skill_execute` to convert web pages into clean markdown from the daemon.

Firecrawl is a DIRECT api.firecrawl.dev integration using a platform or user-configured API key — there is NO Composio toolkit, OAuth flow, or "connection" for it. If a tool reports a missing key, relay its message to the user as-is; never search Composio for "firecrawl" and never offer a Composio/OAuth connect flow.

## When to use which fetch path

| Need | Tool |
| --- | --- |
| Quick single-page read, simple article | plain `web_fetch` (no skill needed) |
| Clean markdown from a JS-rendered or complex page | `firecrawl_scrape` |
| Content from multiple pages of ONE site (docs, blog, site section) | `firecrawl_crawl` |
| Searching the web for pages to read | web-research skill (`tavily_search` / `serper_search`) |

Do not reach for `firecrawl_crawl` to answer a question one page answers — scrape the one page. Crawls cost credits per page.

## firecrawl_scrape

- `url` (required): the page to scrape.
- `only_main_content` (optional, default true): strip headers/navs/footers.
- `max_chars` (optional): truncate the returned markdown (default 20000, max 100000).

Returns the page as clean markdown plus metadata (title, source URL, HTTP status).

```json
{
  "tool": "firecrawl_scrape",
  "input": { "url": "https://docs.example.com/pricing" }
}
```

## firecrawl_crawl

Bounded site crawl: starts at `url`, follows child links, scrapes each page to markdown.

- `url` (required): the starting page.
- `max_pages` (optional): pages to crawl. **Hard-capped at 20 in the executor** — asking for more is clamped, not honored. Default 10.
- `max_depth` (optional): link depth from the start URL. **Hard-capped at 2 in the executor.** Default 1.
- `wait_seconds` (optional): max seconds to wait for the crawl job (default 180, max 600).

```json
{
  "tool": "firecrawl_crawl",
  "input": { "url": "https://docs.example.com", "max_pages": 15, "max_depth": 2, "wait_seconds": 300 }
}
```

The crawl runs as an async Firecrawl job; the tool polls until it completes or the wait elapses. Per-page markdown is truncated to keep the result manageable — scrape a specific page with `firecrawl_scrape` if you need its full text.

## Credentials

Both tools resolve the API key from daemon config (`assistant.json` → `toolApis.firecrawlKey`) or the `CUE_FIRECRAWL_API_KEY` environment variable. Missing key → the tool returns a clear message; report it as-is and do not change configuration.

## Error handling

- **Missing key**: relay the tool's message. Do NOT attempt a Composio/OAuth connection.
- **HTTP 401/403**: key invalid or exhausted — tell the user to check it.
- **HTTP 402**: Firecrawl credits exhausted — tell the user.
- **HTTP 429**: rate limited — wait and retry once.
- **Crawl timed out**: the job may still be running on Firecrawl; retry with a larger `wait_seconds` or reduce `max_pages`.
- **Scrape failed on a URL**: the site may block scraping; fall back to plain `web_fetch` for that URL before giving up.

## Complete when

The requested page(s) have been returned as markdown and used to answer the user, or a clear error has been reported per the handling above.
