/**
 * Provider env-var lookup helpers.
 *
 * Two sources of truth feed these helpers:
 *
 *   1. LLM providers — names come from `PROVIDER_CATALOG` in
 *      `model-catalog.ts`. `getLlmProviderEnvVar` consults the catalog
 *      directly.
 *   2. Search providers — names come from `SEARCH_PROVIDER_CATALOG` in
 *      `search-provider-catalog.ts`. `getSearchProviderEnvVar` consults
 *      the catalog directly.
 *
 * Use `getLlmProviderEnvVar` when you're scoped to LLM providers,
 * `getSearchProviderEnvVar` when you're scoped to search providers, and
 * `getAnyProviderEnvVar` (LLM-first, then search) when you accept either
 * kind — e.g. the generic `getProviderKeyAsync` env-var fallback.
 *
 * Each helper returns `undefined` for keyless providers (e.g. Ollama),
 * unknown IDs, and providers outside the helper's scope.
 */
import { PROVIDER_CATALOG } from "./model-catalog.js";
import { SEARCH_PROVIDER_CATALOG } from "./search-provider-catalog.js";

/**
 * Search-provider env var names, derived from `SEARCH_PROVIDER_CATALOG`.
 * Adding a BYOK provider to the catalog automatically extends this map —
 * managed providers (no `envVar`) are filtered out.
 */
const SEARCH_PROVIDER_ENV_VAR_NAMES: Record<string, string> = Object.freeze(
  Object.fromEntries(
    SEARCH_PROVIDER_CATALOG.filter((p) => p.envVar !== undefined).map((p) => [
      p.id,
      p.envVar!,
    ]),
  ),
);

export function getLlmProviderEnvVar(providerId: string): string | undefined {
  return PROVIDER_CATALOG.find((p) => p.id === providerId)?.envVar;
}

export function getSearchProviderEnvVar(
  providerId: string,
): string | undefined {
  return SEARCH_PROVIDER_ENV_VAR_NAMES[providerId];
}

/**
 * STT-provider env var names. STT credential providers that are also LLM
 * providers (openai, gemini, xai) resolve via the LLM catalog; only Deepgram
 * is STT-exclusive, so it's declared here. This lets a Deepgram key supplied
 * via DEEPGRAM_API_KEY survive restarts on deployments whose credential store
 * is not durable across restarts.
 */
const STT_PROVIDER_ENV_VAR_NAMES: Record<string, string> = Object.freeze({
  deepgram: "DEEPGRAM_API_KEY",
});

export function getSttProviderEnvVar(providerId: string): string | undefined {
  return STT_PROVIDER_ENV_VAR_NAMES[providerId];
}

/**
 * Tooling / generation provider env var names. These providers (Replicate for
 * image+video generation, Apify for web-scraping / lead-gen actors) are not
 * part of the LLM/search/STT catalogs but back agent skills that call their
 * HTTP APIs directly.
 *
 * Honouring these env vars is **required** on deployments whose credential
 * store is not durable across restarts: an `assistant keys set replicate ...`
 * value is lost on restart, but `REPLICATE_API_TOKEN` / `APIFY_API_TOKEN`
 * supplied via the process environment survive.
 *
 * Apify is documented under two env var names in the wild (`APIFY_API_TOKEN`
 * is the canonical one, `APIFY_TOKEN` is the older short form). Only one value
 * can be returned for the secure-store fallback, so the canonical name wins;
 * the alias is honoured separately by {@link getToolingProviderEnvKey}.
 */
const TOOLING_PROVIDER_ENV_VAR_NAMES: Record<string, string> = Object.freeze({
  replicate: "REPLICATE_API_TOKEN",
  apify: "APIFY_API_TOKEN",
});

/**
 * Additional accepted env var aliases for tooling providers, tried in order
 * after the canonical name in {@link TOOLING_PROVIDER_ENV_VAR_NAMES}. Used by
 * the skill tools to resolve a key from any of the documented env var spellings.
 */
const TOOLING_PROVIDER_ENV_VAR_ALIASES: Record<string, readonly string[]> =
  Object.freeze({
    apify: ["APIFY_TOKEN"],
  });

/**
 * Canonical list of tooling/generation provider ids that are API-key
 * addressable via `assistant keys set <provider> <key>`. Consumed by
 * `provider-secret-catalog.ts` to extend the known-provider set.
 */
export const TOOLING_API_KEY_PROVIDERS: readonly string[] = Object.freeze(
  Object.keys(TOOLING_PROVIDER_ENV_VAR_NAMES),
);

export function getToolingProviderEnvVar(
  providerId: string,
): string | undefined {
  return TOOLING_PROVIDER_ENV_VAR_NAMES[providerId];
}

/**
 * Resolve a tooling provider's API token from any accepted env var spelling,
 * trying the canonical name first then any documented aliases. Returns
 * `undefined` when none of the env vars are set or the provider is unknown.
 */
export function getToolingProviderEnvKey(
  providerId: string,
): string | undefined {
  const names = [
    TOOLING_PROVIDER_ENV_VAR_NAMES[providerId],
    ...(TOOLING_PROVIDER_ENV_VAR_ALIASES[providerId] ?? []),
  ].filter((n): n is string => Boolean(n));
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return undefined;
}

/**
 * Resolve a provider env-var name from any source — LLM catalog first, then
 * the search-provider mirror, then STT providers, then tooling/generation
 * providers (Replicate, Apify). Returns `undefined` when no provider scope
 * declares an env var for the given ID (keyless LLM providers like Ollama,
 * unknown IDs, etc.).
 */
export function getAnyProviderEnvVar(providerId: string): string | undefined {
  return (
    getLlmProviderEnvVar(providerId) ??
    getSearchProviderEnvVar(providerId) ??
    getSttProviderEnvVar(providerId) ??
    getToolingProviderEnvVar(providerId)
  );
}
