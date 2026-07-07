---
name: web-research
description: Search the live web (Tavily/Serper) for current information, news, prices, facts, and images. Load whenever the user asks about anything current or external — "what's the latest…", today's news, live prices, competitor moves, recent events, product research, or finding images on the web. Use `tavily_search` for research-grade results with cited source snippets, `serper_search` for a Google SERP (organic results, answer box, knowledge graph), and `serper_images` for image search.
compatibility: "Designed for Cue personal assistants"
metadata:
  emoji: "🔎"
  vellum:
    display-name: "Web Research"
    category: "browsing"
    activation-hints:
      - "User asks about anything current, recent, or external — latest news, today's prices, live scores, a recent event"
      - "User asks a factual question the assistant may not know or that may have changed since training"
      - "User wants research on a company, product, market, person, or competitor"
      - "User asks to find images of something on the web"
      - "User says 'search the web', 'google', 'look up', or 'what's the latest'"
---

Use the `tavily_search`, `serper_search`, and `serper_images` tools via `skill_execute` to search the live web from the daemon.

These are DIRECT API integrations (api.tavily.com / google.serper.dev) using platform or user-configured API keys — there is NO Composio toolkit, OAuth flow, or "connection" for them. If a tool reports a missing key, relay its message to the user as-is; never search Composio for "tavily" or "serper" and never offer a Composio/OAuth connect flow.

## Choosing a tool

| Need | Tool |
| --- | --- |
| Research-grade answer with cited source snippets (default for questions) | `tavily_search` |
| Google-style SERP: organic links, answer box, knowledge graph, related searches | `serper_search` |
| Images of a subject (photos, product shots, logos, diagrams) | `serper_images` |

`tavily_search` is the default for "answer this from the live web" — its results include content snippets you can cite directly. `serper_search` is better when the user wants links/rankings ("what ranks for X", "find the official site") or a quick knowledge-graph fact. Results from either can be followed up with `web_fetch` (or the web-scrape skill for clean markdown) to read a specific page in full.

## tavily_search

- `query` (required): the search query.
- `max_results` (optional): 1–20, default 5.
- `topic` (optional): `general` (default), `news`, or `finance`.
- `time_range` (optional): restrict recency — `day`, `week`, `month`, or `year`. Use for "latest/today" questions.
- `include_answer` (optional, default true): include Tavily's short synthesized answer alongside the raw results.

Example:

```json
{
  "tool": "tavily_search",
  "input": { "query": "EU AI Act enforcement timeline 2026", "topic": "news", "time_range": "month" }
}
```

## serper_search

- `query` (required): the search query.
- `num` (optional): number of organic results, 1–20, default 10.
- `gl` (optional): country code for geo-targeting (e.g. "us", "sg").
- `hl` (optional): interface language code (e.g. "en").

Example:

```json
{
  "tool": "serper_search",
  "input": { "query": "best CRM for solo founders", "num": 10 }
}
```

## serper_images

- `query` (required): what to find images of.
- `num` (optional): number of images, 1–20, default 10.

Returns image URLs (`imageUrl`), thumbnails, and the source page for each hit. Present the URLs to the user; fetch one and attach it if the user wants the file itself.

## Citing results

When you answer from search results, cite the source URLs you actually used. Prefer quoting or paraphrasing the returned snippets over inventing detail — if the snippets don't answer the question, say so and fetch the most promising URL for the full text.

## Credentials

Each tool resolves its API key from daemon config (`assistant.json` → `toolApis.tavilyKey` / `toolApis.serperKey`) or the `CUE_TAVILY_API_KEY` / `CUE_SERPER_API_KEY` environment variables. Missing key → the tool returns a clear message; report it as-is and do not change configuration.

## Error handling

- **Missing key**: relay the tool's message. Do NOT attempt a Composio/OAuth connection.
- **HTTP 401/403**: the key is invalid or exhausted — tell the user to check it.
- **HTTP 429**: rate limited — wait and retry once, or reduce result count.
- **No results**: rephrase the query (fewer, more general terms) before telling the user nothing was found.

## Complete when

You have answered the user's question grounded in the returned results (with source URLs), or reported a clear error per the handling above.
