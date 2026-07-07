import { z } from "zod";

/**
 * API keys for bundled tool providers (web-research / web-scrape skills).
 *
 * Resolution order for each provider is: this config block first, then the
 * corresponding `CUE_*_API_KEY` environment variable (see
 * `bundled-skills/_shared/tool-api-keys.ts`). All keys are optional — when a
 * key resolves from neither source, the tool returns a clean, actionable
 * error instead of throwing. That absent-key state IS the feature-off state.
 *
 * These keys are read by daemon-process executors making direct HTTPS calls.
 * They must NEVER be added to `SAFE_ENV_VARS` (tools/terminal/safe-env.ts) —
 * they must not reach bash/child processes.
 */
export const ToolApisConfigSchema = z
  .object({
    tavilyKey: z
      .string({ error: "toolApis.tavilyKey must be a string" })
      .optional()
      .describe(
        "Tavily API key for the web-research skill's tavily_search tool. Falls back to the CUE_TAVILY_API_KEY environment variable.",
      ),
    firecrawlKey: z
      .string({ error: "toolApis.firecrawlKey must be a string" })
      .optional()
      .describe(
        "Firecrawl API key for the web-scrape skill's firecrawl_scrape / firecrawl_crawl tools. Falls back to the CUE_FIRECRAWL_API_KEY environment variable.",
      ),
    serperKey: z
      .string({ error: "toolApis.serperKey must be a string" })
      .optional()
      .describe(
        "Serper API key for the web-research skill's serper_search / serper_images tools. Falls back to the CUE_SERPER_API_KEY environment variable.",
      ),
  })
  .describe(
    "API keys for bundled tool providers (Tavily search, Firecrawl scrape/crawl, Serper SERP). Config takes precedence over the CUE_*_API_KEY env vars; a missing key disables the corresponding tool with an actionable error.",
  );

export type ToolApisConfig = z.infer<typeof ToolApisConfigSchema>;
