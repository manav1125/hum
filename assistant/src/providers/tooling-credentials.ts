/**
 * Credential resolution for tooling/generation providers (Replicate, Apify).
 *
 * These providers back agent skills that call third-party HTTP APIs directly.
 * Their tokens resolve from the secure credential store first, then fall back
 * to the provider's env var(s) — which is what keeps them working on
 * deployments whose credential store is not durable across restarts.
 *
 * `getProviderKeyAsync` already does store-then-env resolution for the
 * canonical env var (`getAnyProviderEnvVar` now includes tooling providers).
 * For providers with multiple accepted env var spellings (e.g. Apify's
 * `APIFY_API_TOKEN` / `APIFY_TOKEN`), this helper additionally tries the
 * aliases via `getToolingProviderEnvKey`.
 */
import { getProviderKeyAsync } from "../security/secure-keys.js";
import { getToolingProviderEnvKey } from "./provider-env-vars.js";

/**
 * Resolve a tooling provider's API token. Checks the secure store and the
 * canonical env var (via `getProviderKeyAsync`), then any additional env var
 * aliases declared for the provider. Returns `undefined` when no token is
 * available from any source.
 */
export async function resolveToolingProviderToken(
  providerId: string,
): Promise<string | undefined> {
  const stored = await getProviderKeyAsync(providerId);
  if (stored) return stored;
  return getToolingProviderEnvKey(providerId);
}
