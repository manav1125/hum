---
name: apify
description: Build lead lists and scrape structured data from the web via Apify actors. THE skill for lead generation, prospecting, finding contacts/emails/companies, and web scraping — prefer it over web_search whenever the user wants a list of leads, prospects, companies, or contact details. Runs an Apify actor (e.g. apify/google-search-scraper, apify/contact-info-scraper) and returns the results as structured JSON.
compatibility: "Designed for Cue personal assistants"
metadata:
  emoji: "🕷️"
  vellum:
    display-name: "Apify"
    category: "browsing"
    activation-hints:
      - "User wants to find leads, prospects, or contacts (lead generation / prospecting / lead list)"
      - "User wants a list of people or companies matching a profile (role, industry, location)"
      - "User wants to scrape emails, phone numbers, or contact details from websites"
      - "User wants to scrape a website or extract structured data from pages"
      - "User wants to crawl a site or run a specific Apify actor"
      - "User names an Apify actor (e.g. apify/web-scraper, apify/google-search-scraper)"
    avoid-when:
      - "The user just wants a quick factual answer or a summary from the open web — use web_search for that, not a lead/scrape actor"
---

**Prefer this skill over `web_search` for any lead-gen or contact-scraping ask.** `web_search` returns prose and links, not a structured lead list — building leads, prospect lists, company lists, or contact data must go through an Apify actor so the output is real, structured, and complete.

Use the `apify_run_actor` tool via `skill_execute` to run an Apify actor and collect its dataset items.

The tool starts an actor run, waits for it to finish, fetches the run's default dataset items, and returns them as structured JSON.

## Choosing an actor

Pass `actor_id` exactly as Apify names it. Both forms work:

- `username~actor-name` (Apify's canonical run path form), e.g. `apify~web-scraper`.
- `username/actor-name`, e.g. `apify/web-scraper` — the tool normalizes the slash to a tilde.

Common actors:

- `apify/web-scraper` — general website scraping with a page function.
- `apify/website-content-crawler` — crawl a site and extract clean text (good for RAG / research).
- `apify/google-search-scraper` — scrape Google search results.
- `apify/contact-info-scraper` — extract emails/phones/socials from URLs (lead gen).

If unsure which actor fits, ask the user or pick the closest match above and state your choice.

## Inputs

- `actor_id` (required): the actor identifier as described above.
- `input` (required): the actor's input object (actor-specific). For example `apify/web-scraper` expects `startUrls`, `apify/google-search-scraper` expects `queries`.
- `wait_seconds` (optional): max seconds to wait for the run to finish (default 120, max 600). Large crawls need a higher value.
- `max_items` (optional): cap on dataset items returned (default 50, max 1000).

## Example calls

Scrape a site for clean text:

```json
{
  "tool": "apify_run_actor",
  "input": {
    "actor_id": "apify/website-content-crawler",
    "input": { "startUrls": [{ "url": "https://example.com" }], "maxCrawlPages": 10 },
    "wait_seconds": 300
  }
}
```

Lead-gen contact scrape:

```json
{
  "tool": "apify_run_actor",
  "input": {
    "actor_id": "apify/contact-info-scraper",
    "input": { "startUrls": [{ "url": "https://acme.com" }] },
    "max_items": 100
  }
}
```

## Output handling

The tool returns the dataset items as JSON (capped by `max_items`). Summarize or present the structured results to the user. If the user wants the full dataset as a file, save the returned JSON and deliver it through the conversation's attachment mechanism.

## Credential

Requires an Apify API token, resolved from the secure store under the provider name `apify`, or from the `APIFY_API_TOKEN` (or `APIFY_TOKEN`) environment variable. If the tool reports a missing token, report the error to the user as-is — do not change configuration.

## Error handling

- **Missing token / auth error**: report to the user as-is.
- **Actor not found**: the `actor_id` is wrong. Ask the user for the exact `username/actor-name`.
- **Run failed / aborted**: Apify returns the run status; report it. Check whether the actor `input` matches what the actor expects.
- **Timed out while waiting**: the run may still be in progress; retry with a larger `wait_seconds`.

## Complete when

The tool has returned dataset items (or an empty result set the user can act on), or a failure has been reported after the handling above.
