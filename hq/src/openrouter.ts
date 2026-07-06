/**
 * Cue HQ — OpenRouter Provisioning API client (plain fetch, zero deps,
 * mirroring stripe.ts's style).
 *
 * A PROVISIONING key (never usable for inference) mints per-customer
 * runtime ("child") keys with hard credit limits at
 * https://openrouter.ai/api/v1/keys:
 *
 *   POST   /keys            { name, limit }        → { data: {hash,…}, key }
 *   GET    /keys/{hash}                            → { data: {…, usage} }
 *   PATCH  /keys/{hash}     { limit } | { disabled: true }
 *   DELETE /keys/{hash}
 *
 * `limit` / `usage` are in OpenRouter credits ≈ USD. HQ stores only the
 * key HASH (the management identifier) — the runtime key itself goes into
 * the instance env at provision time and is never persisted.
 *
 * Runs cleanly in "not configured" mode: without
 * OPENROUTER_PROVISIONING_KEY every operation returns a typed
 * "not configured" result. provisionLlmKey() then falls back to the shared
 * OPENROUTER_SHARED_KEY — capped ONLY by the instance's own guardrails,
 * not by a provider-side limit — and logs that loudly.
 *
 * Env contract:
 *   OPENROUTER_PROVISIONING_KEY — provisioning key (management only)
 *   OPENROUTER_SHARED_KEY       — fallback runtime key when unconfigured
 */

const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";

export function isOpenRouterConfigured(): boolean {
  return !!process.env.OPENROUTER_PROVISIONING_KEY;
}

// ── result types ─────────────────────────────────────────────────────────

export interface OpenRouterKeyInfo {
  hash: string;
  name: string;
  disabled: boolean;
  /** Credit limit in USD (null = unlimited). */
  limit: number | null;
  /** Cumulative spend against this key, in USD. */
  usage: number;
}

export type OpenRouterResult<T> =
  | ({ ok: true } & T)
  | { ok: false; reason: string };

// ── HTTP plumbing ────────────────────────────────────────────────────────

async function api(
  method: string,
  path: string,
  body: unknown | undefined,
  fetchImpl: typeof fetch,
): Promise<OpenRouterResult<{ payload: Record<string, unknown> }>> {
  if (!isOpenRouterConfigured()) {
    return { ok: false, reason: "openrouter_not_configured" };
  }
  let res: Response;
  try {
    res = await fetchImpl(`${OPENROUTER_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_PROVISIONING_KEY}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    return {
      ok: false,
      reason: `openrouter_fetch_failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return {
      ok: false,
      reason: `openrouter_error_${res.status}: ${text.slice(0, 300)}`,
    };
  }
  const payload = (await res.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  return { ok: true, payload };
}

function parseKeyInfo(data: Record<string, unknown>): OpenRouterKeyInfo {
  return {
    hash: String(data.hash ?? ""),
    name: String(data.name ?? ""),
    disabled: Boolean(data.disabled),
    limit: data.limit == null ? null : Number(data.limit),
    usage: Number(data.usage ?? 0),
  };
}

// ── key management ───────────────────────────────────────────────────────

/**
 * Mint a runtime child key capped at `limitUsd` of provider spend. The
 * returned `key` is shown exactly once — pass it into the instance env,
 * persist only the hash.
 */
export async function createCustomerKey(
  name: string,
  limitUsd: number,
  fetchImpl: typeof fetch = fetch,
): Promise<OpenRouterResult<{ key: string; info: OpenRouterKeyInfo }>> {
  const result = await api("POST", "/keys", { name, limit: limitUsd }, fetchImpl);
  if (!result.ok) return result;
  const key = String(result.payload.key ?? "");
  const data = (result.payload.data ?? {}) as Record<string, unknown>;
  if (!key || !data.hash) {
    return { ok: false, reason: "openrouter_create_unexpected_body" };
  }
  return { ok: true, key, info: parseKeyInfo(data) };
}

export async function getKey(
  keyHash: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OpenRouterResult<{ info: OpenRouterKeyInfo }>> {
  const result = await api("GET", `/keys/${keyHash}`, undefined, fetchImpl);
  if (!result.ok) return result;
  const data = (result.payload.data ?? {}) as Record<string, unknown>;
  return { ok: true, info: parseKeyInfo(data) };
}

/** Raise/lower the child key's spend cap (USD). */
export async function updateKeyLimit(
  keyHash: string,
  limitUsd: number,
  fetchImpl: typeof fetch = fetch,
): Promise<OpenRouterResult<{ info: OpenRouterKeyInfo }>> {
  const result = await api(
    "PATCH",
    `/keys/${keyHash}`,
    { limit: limitUsd },
    fetchImpl,
  );
  if (!result.ok) return result;
  const data = (result.payload.data ?? {}) as Record<string, unknown>;
  return { ok: true, info: parseKeyInfo(data) };
}

/** Disable the child key (suspend/churn — reversible, unlike delete). */
export async function disableKey(
  keyHash: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OpenRouterResult<{ info: OpenRouterKeyInfo }>> {
  const result = await api(
    "PATCH",
    `/keys/${keyHash}`,
    { disabled: true },
    fetchImpl,
  );
  if (!result.ok) return result;
  const data = (result.payload.data ?? {}) as Record<string, unknown>;
  return { ok: true, info: parseKeyInfo(data) };
}

export async function deleteKey(
  keyHash: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OpenRouterResult<object>> {
  const result = await api("DELETE", `/keys/${keyHash}`, undefined, fetchImpl);
  if (!result.ok) return result;
  return { ok: true };
}

// ── provision-time key resolution ────────────────────────────────────────

export interface LlmKeyProvision {
  /** Runtime key for the instance env — undefined when nothing is set. */
  apiKey?: string;
  /** Provisioned child-key hash to persist; null in shared/none modes. */
  keyHash: string | null;
  mode: "provisioned" | "shared" | "none";
}

/**
 * Resolve the OPENROUTER_API_KEY for a new instance: a limit-capped child
 * key when the provisioning key is configured, else the shared key (with a
 * loud warning — guardrails caps are then the ONLY spend control), else
 * nothing (BYO via providerEnv still works).
 */
export async function provisionLlmKey(
  name: string,
  limitUsd: number,
  fetchImpl: typeof fetch = fetch,
): Promise<OpenRouterResult<LlmKeyProvision>> {
  if (isOpenRouterConfigured()) {
    const created = await createCustomerKey(name, limitUsd, fetchImpl);
    if (!created.ok) return created;
    return {
      ok: true,
      apiKey: created.key,
      keyHash: created.info.hash,
      mode: "provisioned",
    };
  }
  const shared = process.env.OPENROUTER_SHARED_KEY;
  if (shared) {
    console.warn(
      `[openrouter] OPENROUTER_PROVISIONING_KEY not set — instance "${name}" gets the SHARED key. ` +
        "Spend is capped ONLY by the instance's own guardrails, not by a provider-side limit.",
    );
    return { ok: true, apiKey: shared, keyHash: null, mode: "shared" };
  }
  return { ok: true, keyHash: null, mode: "none" };
}
