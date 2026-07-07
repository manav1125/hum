/**
 * Shared API-key resolution for the bundled tool-API skills
 * (web-research: Tavily/Serper, web-scrape: Firecrawl).
 *
 * Resolution order:
 *   1. daemon config — `assistant.json` → `toolApis.{tavilyKey,firecrawlKey,serperKey}`
 *      (schema: src/config/schemas/tool-apis.ts)
 *   2. environment variable — `CUE_TAVILY_API_KEY` / `CUE_FIRECRAWL_API_KEY` /
 *      `CUE_SERPER_API_KEY`, read from the DAEMON process env (on HQ-provisioned
 *      instances these arrive via buildInstanceEnv() passthrough).
 *
 * This function NEVER throws. When no key resolves it returns a clean,
 * actionable error string the executor hands back to the LLM verbatim —
 * absent-key is the feature-off state, not a failure.
 *
 * SECURITY: these env vars are deliberately NOT in `SAFE_ENV_VARS`
 * (src/tools/terminal/safe-env.ts). They are only readable by daemon-process
 * code making direct HTTPS calls; they must never reach bash/child processes.
 * Do not add them there.
 */
import { getConfigReadOnly } from "../../loader.js";
import type { ToolApisConfig } from "../../schemas/tool-apis.js";

export type ToolApiProviderId = "tavily" | "firecrawl" | "serper";

interface ProviderSpec {
  /** Human-facing provider name used in error messages. */
  label: string;
  /** Key inside the `toolApis` config block. */
  configKey: keyof ToolApisConfig;
  /** Daemon-process env var fallback. */
  envVar: string;
}

export const TOOL_API_PROVIDERS: Record<ToolApiProviderId, ProviderSpec> = {
  tavily: {
    label: "Tavily",
    configKey: "tavilyKey",
    envVar: "CUE_TAVILY_API_KEY",
  },
  firecrawl: {
    label: "Firecrawl",
    configKey: "firecrawlKey",
    envVar: "CUE_FIRECRAWL_API_KEY",
  },
  serper: {
    label: "Serper",
    configKey: "serperKey",
    envVar: "CUE_SERPER_API_KEY",
  },
};

export type ToolApiKeyResolution =
  | { ok: true; key: string }
  | { ok: false; error: string };

/**
 * Resolve a tool-API provider key: daemon config first, env var second.
 * Never throws; a missing key yields `{ ok: false, error }` with guidance.
 *
 * `overrides` exists for tests only (inject a config block / env map without
 * touching the global config or process.env).
 */
export function resolveToolApiKey(
  provider: ToolApiProviderId,
  overrides?: {
    config?: ToolApisConfig;
    env?: Record<string, string | undefined>;
  },
): ToolApiKeyResolution {
  const spec = TOOL_API_PROVIDERS[provider];

  // 1. daemon config (assistant.json → toolApis.*)
  let config = overrides?.config;
  if (config === undefined) {
    try {
      config = getConfigReadOnly().toolApis;
    } catch {
      // Config load failure must not break key resolution — fall through
      // to the env var.
      config = undefined;
    }
  }
  const fromConfig = config?.[spec.configKey]?.trim();
  if (fromConfig) return { ok: true, key: fromConfig };

  // 2. daemon process env var
  const env = overrides?.env ?? process.env;
  const fromEnv = env[spec.envVar]?.trim();
  if (fromEnv) return { ok: true, key: fromEnv };

  return {
    ok: false,
    error: `${spec.label} key not configured — add it in Settings (toolApis.${String(spec.configKey)} in assistant.json) or set the ${spec.envVar} environment variable. Report this to the user as-is; do NOT attempt a Composio/OAuth connection — ${spec.label} is a direct API-key integration.`,
  };
}
