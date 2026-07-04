import { createHash } from "node:crypto";

import { getOllamaBaseUrlEnv } from "../config/env.js";
import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import type { AssistantConfig } from "../config/types.js";
import { PLATFORM_PROVIDER_META } from "../providers/platform-proxy/constants.js";
import { resolveManagedProxyContext } from "../providers/platform-proxy/context.js";
import { getProviderKeyAsync } from "../security/secure-keys.js";
import { getLogger } from "../util/logger.js";
import { GeminiEmbeddingBackend } from "./embedding-gemini.js";
import { OllamaEmbeddingBackend } from "./embedding-ollama.js";
import { OpenAIEmbeddingBackend } from "./embedding-openai.js";
import {
  type EmbeddingBackend,
  type EmbeddingInput,
  embeddingInputContentHash,
  type EmbeddingProviderName,
  type EmbeddingRequestOptions,
  type MultimodalEmbeddingInput,
  normalizeEmbeddingInput,
  type SparseEmbedding,
  type TextEmbeddingInput,
} from "./embedding-types.js";
import { SPARSE_VOCAB_SIZE, tokenHash, tokenize } from "./sparse-tokenize.js";

export type { EmbeddingInput, MultimodalEmbeddingInput, TextEmbeddingInput };

const log = getLogger("memory-embeddings");

// Tracks whether the local embedding backend has permanently failed to load
// (e.g., onnxruntime-node missing in a compiled binary). Once set, `auto` mode
// skips `local` as primary, avoiding repeated fallback latency and cost.
let localBackendBroken = false;

/**
 * Lazy wrapper around LocalEmbeddingBackend that dynamically imports the
 * module on first use. This avoids eagerly loading @huggingface/transformers
 * (which statically imports onnxruntime-node) at module evaluation time.
 * In compiled binaries where onnxruntime-node isn't bundled, the static
 * import would crash the entire daemon at startup. By deferring the import,
 * the failure is contained and other embedding backends can be used instead.
 */

class LazyLocalEmbeddingBackend implements EmbeddingBackend {
  readonly provider = "local" as const;
  readonly model: string;
  private delegate: EmbeddingBackend | null = null;
  private initPromise: Promise<EmbeddingBackend> | null = null;

  constructor(model: string) {
    this.model = model;
  }

  async embed(
    inputs: EmbeddingInput[],
    options?: EmbeddingRequestOptions,
  ): Promise<number[][]> {
    const backend = await this.getDelegate();
    try {
      return await backend.embed(inputs, options);
    } catch (err) {
      // The onnxruntime-node failure surfaces here during the first embed() call
      // (via LocalEmbeddingBackend.initialize()). Mark broken so auto mode stops
      // selecting local on subsequent requests.
      if (!localBackendBroken && isInitializationError(err)) {
        localBackendBroken = true;
        log.warn(
          { err },
          "Local embedding backend permanently unavailable; auto mode will skip it",
        );
      }
      throw err;
    }
  }

  dispose(): void {
    this.delegate?.dispose?.();
  }

  resetForRetry(): void {
    if (!this.delegate) {
      this.initPromise = null;
    }
  }

  private async getDelegate(): Promise<EmbeddingBackend> {
    if (this.delegate) return this.delegate;
    if (!this.initPromise) {
      this.initPromise = (async () => {
        try {
          const { LocalEmbeddingBackend } =
            await import("./embedding-local.js");
          this.delegate = new LocalEmbeddingBackend(this.model);
          return this.delegate;
        } catch (err) {
          localBackendBroken = true;
          log.warn(
            { err },
            "Local embedding backend permanently unavailable; auto mode will skip it",
          );
          throw err;
        }
      })();
    }
    return this.initPromise;
  }
}

/** Detect errors thrown by LocalEmbeddingBackend.initialize() so we can
 *  distinguish permanent init failures from transient embed-time errors. */
function isInitializationError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes("Local embedding backend unavailable");
}

/** Global cache of embedding backend instances, keyed by "provider:model". */
const backendCache = new Map<string, EmbeddingBackend>();

// ── In-memory embedding vector cache ──────────────────────────────
// LRU cache keyed by sha256(provider + model + text) → embedding vector.
// Avoids redundant API calls / local compute for identical content.
// Eviction is based on estimated byte size (32 MB cap) rather than entry count,
// since vector dimensions vary across providers/models.
const VECTOR_CACHE_MAX_BYTES = 33_554_432; // 32 MB
const vectorCache = new Map<string, number[]>();
let vectorCacheBytes = 0;

/** Estimate in-memory byte cost of a single cache entry. */
function estimateEntryBytes(key: string, vector: number[]): number {
  // key: UTF-16 chars (2 bytes each) + vector: 8 bytes per float64
  return key.length * 2 + vector.length * 8;
}

function vectorCacheKey(
  provider: string,
  model: string,
  input: EmbeddingInput,
  extras?: string[],
): string {
  const contentHash = embeddingInputContentHash(input);
  const suffix = extras && extras.length > 0 ? `\0${extras.join("\0")}` : "";
  return createHash("sha256")
    .update(`${provider}\0${model}\0${contentHash}${suffix}`)
    .digest("hex");
}

function getFromVectorCache(
  provider: string,
  model: string,
  input: EmbeddingInput,
  extras?: string[],
): number[] | undefined {
  const key = vectorCacheKey(provider, model, input, extras);
  const v = vectorCache.get(key);
  if (v !== undefined) {
    // LRU refresh: move to end of insertion order
    vectorCache.delete(key);
    vectorCache.set(key, v);
  }
  return v;
}

function putInVectorCache(
  provider: string,
  model: string,
  input: EmbeddingInput,
  vector: number[],
  extras?: string[],
): void {
  const key = vectorCacheKey(provider, model, input, extras);
  // If replacing an existing entry, subtract its old cost first
  const existing = vectorCache.get(key);
  if (existing !== undefined) {
    vectorCacheBytes -= estimateEntryBytes(key, existing);
    vectorCache.delete(key);
  }
  const entryBytes = estimateEntryBytes(key, vector);
  // Evict oldest entries until we have room
  while (
    vectorCacheBytes + entryBytes > VECTOR_CACHE_MAX_BYTES &&
    vectorCache.size > 0
  ) {
    const oldest = vectorCache.keys().next().value;
    if (oldest === undefined) break;
    const oldVec = vectorCache.get(oldest)!;
    vectorCacheBytes -= estimateEntryBytes(oldest, oldVec);
    vectorCache.delete(oldest);
  }
  vectorCache.set(key, vector);
  vectorCacheBytes += entryBytes;
}

/** Clear cached embedding backends and the in-memory vector cache. */
export function clearEmbeddingBackendCache(): void {
  for (const backend of new Set(backendCache.values())) {
    try {
      backend.dispose?.();
    } catch (err) {
      log.warn(
        { err, provider: backend.provider, model: backend.model },
        "Failed to dispose embedding backend during cache clear",
      );
    }
  }
  backendCache.clear();
  vectorCache.clear();
  vectorCacheBytes = 0;
  localBackendBroken = false;
  lastLoggedSelection = undefined;
}

/** Reset the sticky local-backend failure flag without evicting live backends. */
export function resetLocalEmbeddingFailureState(): void {
  localBackendBroken = false;
  for (const backend of new Set(backendCache.values())) {
    if (backend instanceof LazyLocalEmbeddingBackend) {
      backend.resetForRetry();
    }
  }
}

function cacheKey(provider: string, model: string, extras?: string[]): string {
  if (extras && extras.length > 0) {
    return `${provider}:${model}:${extras.join(":")}`;
  }
  return `${provider}:${model}`;
}

function getCachedOrCreate<T extends EmbeddingBackend>(
  provider: string,
  model: string,
  create: () => T,
  extras?: string[],
): T {
  const key = cacheKey(provider, model, extras);
  const existing = backendCache.get(key);
  if (existing) return existing as T;
  const instance = create();
  backendCache.set(key, instance);
  return instance;
}

/**
 * Look up a previously cached backend instance. Returns undefined when no
 * cached entry exists. Used as a fallback when a provider key lookup
 * returns undefined — a transient credential-store outage should not
 * disable a provider whose backend is already warmed in memory. Explicit
 * key deletion triggers `clearEmbeddingBackendCache()` which empties the
 * cache, so a stale backend is never returned after intentional removal.
 */
function getCached(
  provider: string,
  model: string,
  extras?: string[],
): EmbeddingBackend | undefined {
  return backendCache.get(cacheKey(provider, model, extras));
}

function geminiCacheExtras(config: AssistantConfig): string[] {
  const extras: string[] = [];
  if (config.memory.embeddings.geminiTaskType) {
    extras.push(`task=${config.memory.embeddings.geminiTaskType}`);
  }
  if (config.memory.embeddings.geminiDimensions != null) {
    extras.push(`dim=${config.memory.embeddings.geminiDimensions}`);
  }
  return extras;
}

/** Build (or reuse) the direct-API Gemini backend for the given key. */
function getDirectGeminiBackend(
  config: AssistantConfig,
  geminiKey: string,
): EmbeddingBackend {
  return getCachedOrCreate(
    "gemini",
    config.memory.embeddings.geminiModel,
    () =>
      new GeminiEmbeddingBackend(
        geminiKey,
        config.memory.embeddings.geminiModel,
        {
          taskType: config.memory.embeddings.geminiTaskType,
          dimensions: config.memory.embeddings.geminiDimensions,
        },
      ),
    geminiCacheExtras(config),
  );
}

/**
 * Build (or reuse) the managed-proxy Gemini backend, or return undefined
 * when the managed proxy prerequisites (platform URL + assistant API key)
 * are not satisfied.
 */
async function tryGetManagedGeminiBackend(
  config: AssistantConfig,
): Promise<EmbeddingBackend | undefined> {
  const proxyCtx = await resolveManagedProxyContext();
  const meta = PLATFORM_PROVIDER_META["gemini"];
  if (!proxyCtx.enabled || !meta?.managed || !meta.proxyPath) return undefined;
  const managedBaseUrl = `${proxyCtx.platformBaseUrl}${meta.proxyPath}`;
  return getCachedOrCreate(
    "gemini",
    config.memory.embeddings.geminiModel,
    () =>
      new GeminiEmbeddingBackend(
        proxyCtx.assistantApiKey,
        config.memory.embeddings.geminiModel,
        {
          taskType: config.memory.embeddings.geminiTaskType,
          dimensions: config.memory.embeddings.geminiDimensions ?? 3072,
          managedBaseUrl,
        },
      ),
    [...geminiCacheExtras(config), "managed"],
  );
}

export interface EmbeddingBackendSelection {
  backend: EmbeddingBackend | null;
  reason: string | null;
}

/**
 * Last logged "provider:model" (or "none:<reason>") selection. Guards the
 * per-selection info log below so the resolved embedding path is announced
 * once at first use (and again only when it changes), not on every embed
 * call. Ops can grep `embedding_backend_selected` to see which provider a
 * deployment actually resolved.
 */
let lastLoggedSelection: string | undefined;

export async function selectEmbeddingBackend(
  config: AssistantConfig,
): Promise<EmbeddingBackendSelection> {
  const selection = await selectEmbeddingBackendInner(config);
  const signature = selection.backend
    ? `${selection.backend.provider}:${selection.backend.model}`
    : `none:${selection.reason ?? "unknown"}`;
  if (signature !== lastLoggedSelection) {
    lastLoggedSelection = signature;
    log.info(
      {
        provider: selection.backend?.provider ?? null,
        model: selection.backend?.model ?? null,
        reason: selection.reason,
        requested: config.memory.embeddings.provider,
      },
      "embedding_backend_selected",
    );
  }
  return selection;
}

async function selectEmbeddingBackendInner(
  config: AssistantConfig,
): Promise<EmbeddingBackendSelection> {
  const requested = config.memory.embeddings.provider;
  if (requested === "local") {
    return {
      backend: getCachedOrCreate(
        "local",
        config.memory.embeddings.localModel,
        () =>
          new LazyLocalEmbeddingBackend(config.memory.embeddings.localModel),
      ),
      reason: null,
    };
  }
  if (requested === "ollama") {
    const ollamaKey = (await getProviderKeyAsync("ollama")) ?? undefined;
    return {
      backend: getCachedOrCreate(
        "ollama",
        config.memory.embeddings.ollamaModel,
        () =>
          new OllamaEmbeddingBackend(config.memory.embeddings.ollamaModel, {
            apiKey: ollamaKey,
          }),
      ),
      reason: null,
    };
  }

  // When managed proxy prerequisites are satisfied, insert managed-proxy Gemini
  // at the front of the auto chain so platform assistants use Vellum-managed
  // Gemini embeddings.
  if (requested === "auto" || requested === "gemini") {
    const managed = await tryGetManagedGeminiBackend(config);
    if (managed) {
      return { backend: managed, reason: null };
    }
  }

  // Auto order: local → openai → gemini → ollama
  const order: EmbeddingProviderName[] =
    requested === "auto"
      ? ["local", "openai", "gemini", "ollama"]
      : [requested];

  for (const provider of order) {
    switch (provider) {
      case "local":
        if (localBackendBroken) continue;
        return {
          backend: getCachedOrCreate(
            "local",
            config.memory.embeddings.localModel,
            () =>
              new LazyLocalEmbeddingBackend(
                config.memory.embeddings.localModel,
              ),
          ),
          reason: null,
        };
      case "openai": {
        const openaiKey = await getProviderKeyAsync("openai");
        if (!openaiKey) {
          // Preserve cached backend on transient credential-store failures.
          // Explicit key deletion clears the cache via clearEmbeddingBackendCache().
          const cached = getCached(
            "openai",
            config.memory.embeddings.openaiModel,
          );
          if (cached) return { backend: cached, reason: null };
          continue;
        }
        return {
          backend: getCachedOrCreate(
            "openai",
            config.memory.embeddings.openaiModel,
            () =>
              new OpenAIEmbeddingBackend(
                openaiKey,
                config.memory.embeddings.openaiModel,
              ),
          ),
          reason: null,
        };
      }
      case "gemini": {
        const geminiKey = await getProviderKeyAsync("gemini");
        if (!geminiKey) {
          // Check managed cache variant first so a warm managed backend
          // survives transient proxy-context blips, then non-managed.
          const cached =
            getCached("gemini", config.memory.embeddings.geminiModel, [
              ...geminiCacheExtras(config),
              "managed",
            ]) ??
            getCached(
              "gemini",
              config.memory.embeddings.geminiModel,
              geminiCacheExtras(config),
            );
          if (cached) return { backend: cached, reason: null };
          continue;
        }
        return {
          backend: getDirectGeminiBackend(config, geminiKey),
          reason: null,
        };
      }
      case "ollama": {
        if (!(await isOllamaConfigured(config))) continue;
        const ollamaKey = (await getProviderKeyAsync("ollama")) ?? undefined;
        return {
          backend: getCachedOrCreate(
            "ollama",
            config.memory.embeddings.ollamaModel,
            () =>
              new OllamaEmbeddingBackend(config.memory.embeddings.ollamaModel, {
                apiKey: ollamaKey,
              }),
          ),
          reason: null,
        };
      }
    }
  }

  const reason =
    requested === "auto"
      ? "No embedding backend configured"
      : `Embedding backend "${requested}" is not configured`;
  return { backend: null, reason };
}

export async function getMemoryBackendStatus(config: AssistantConfig): Promise<{
  enabled: boolean;
  degraded: boolean;
  provider: EmbeddingProviderName | null;
  model: string | null;
  reason: string | null;
}> {
  if (config.memory.enabled === false) {
    return {
      enabled: false,
      degraded: false,
      provider: null,
      model: null,
      reason: "memory.disabled",
    };
  }
  const selection = await selectEmbeddingBackend(config);
  if (!selection.backend) {
    return {
      enabled: true,
      degraded: config.memory.embeddings.required,
      provider: null,
      model: null,
      reason: selection.reason,
    };
  }
  return {
    enabled: true,
    degraded: false,
    provider: selection.backend.provider,
    model: selection.backend.model,
    reason: null,
  };
}

export async function embedWithBackend(
  config: AssistantConfig,
  inputs: EmbeddingInput[],
  options?: EmbeddingRequestOptions,
): Promise<{
  provider: EmbeddingProviderName;
  model: string;
  vectors: number[][];
}> {
  const selection = await selectEmbeddingBackend(config);
  if (!selection.backend) {
    throw new Error(
      selection.reason ?? "No memory embedding backend configured",
    );
  }

  const expectedDim = config.memory.qdrant.vectorSize;
  const { provider: primaryProvider, model: primaryModel } = selection.backend;

  // ── Lazy fallback backend list ──────────────────────────────────
  // Resolved only when the primary backend fails or can't handle the input
  // (multimodal on a text-only primary). Building the chain requires
  // credential-store reads (`getProviderKeyAsync` per provider); doing that
  // eagerly put several credential round-trips on EVERY embed call even when
  // the primary succeeded — on deployments with a degraded credential
  // backend those reads dominated per-turn latency.
  //
  // In auto mode the chain covers all configured backends (excluding the
  // primary) so multimodal inputs can fall through to Gemini even when the
  // primary is local or openai.
  //
  // A managed-proxy Gemini primary can fail at the proxy (e.g. a stale or
  // revoked platform credential) while a valid direct Gemini key sits in the
  // credential store. The provider-level chain never includes Gemini when
  // Gemini IS the primary, so the direct-key backend is appended explicitly
  // for that case.
  let fallbacksPromise: Promise<EmbeddingBackend[]> | undefined;
  const getFallbacks = (): Promise<EmbeddingBackend[]> => {
    if (!fallbacksPromise) {
      fallbacksPromise = (async () => {
        const list: EmbeddingBackend[] =
          config.memory.embeddings.provider === "auto" &&
          selection.backend!.provider !== "gemini"
            ? await selectFallbackBackends(config, selection.backend!.provider)
            : [];
        if (
          selection.backend instanceof GeminiEmbeddingBackend &&
          selection.backend.managed
        ) {
          const geminiKey = await getProviderKeyAsync("gemini");
          if (geminiKey) {
            list.push(getDirectGeminiBackend(config, geminiKey));
          }
        }
        return list;
      })();
    }
    return fallbacksPromise;
  };

  // ── Compute provider-specific vector cache extras ───────────────
  const vectorExtras =
    primaryProvider === "gemini" ? geminiCacheExtras(config) : undefined;

  // ── In-memory cache check (primary provider only) ──────────────
  const cached: (number[] | null)[] = inputs.map((input) => {
    const v = getFromVectorCache(
      primaryProvider,
      primaryModel,
      input,
      vectorExtras,
    );
    if (v && v.length === expectedDim) return v;
    return null;
  });
  const uncachedIndices: number[] = [];
  for (let i = 0; i < cached.length; i++) {
    if (!cached[i]) uncachedIndices.push(i);
  }
  if (uncachedIndices.length === 0) {
    return {
      provider: primaryProvider,
      model: primaryModel,
      vectors: cached as number[][],
    };
  }

  // ── Embed uncached inputs ───────────────────────────────────────
  // The primary is tried first; the fallback chain is resolved lazily and
  // only walked when the primary fails or can't handle the input.
  let lastErr: unknown;
  let anyBackendAttempted = false;

  const tryBackend = async (
    backend: EmbeddingBackend,
    isPrimary: boolean,
  ): Promise<{
    provider: EmbeddingProviderName;
    model: string;
    vectors: number[][];
  } | null> => {
    // For the primary backend, only embed uncached inputs and merge with cached.
    // For fallback backends, embed ALL inputs since the cache was keyed to the primary.
    const inputsToEmbed = isPrimary
      ? uncachedIndices.map((i) => inputs[i])
      : inputs;

    // Skip text-only backends for multimodal inputs
    const hasNonText = inputsToEmbed.some(
      (i) =>
        typeof i !== "string" && normalizeEmbeddingInput(i).type !== "text",
    );
    if (backend.provider !== "gemini" && hasNonText) {
      return null;
    }

    try {
      anyBackendAttempted = true;
      const vectors = await backend.embed(inputsToEmbed, options);
      if (vectors.length !== inputsToEmbed.length) {
        throw new Error(
          `Embedding backend returned ${vectors.length} vectors for ${inputsToEmbed.length} inputs`,
        );
      }
      for (const vec of vectors) {
        if (vec.length !== expectedDim) {
          throw new Error(
            `Embedding backend "${backend.provider}" (model ${backend.model}) returned vectors of dimension ${vec.length}, but Qdrant collection expects ${expectedDim}`,
          );
        }
      }

      // Populate cache with freshly embedded vectors
      const backendExtras =
        backend.provider === "gemini" ? geminiCacheExtras(config) : undefined;
      for (let i = 0; i < inputsToEmbed.length; i++) {
        putInVectorCache(
          backend.provider,
          backend.model,
          inputsToEmbed[i],
          vectors[i],
          backendExtras,
        );
      }

      if (isPrimary) {
        const merged = [...cached] as number[][];
        for (let i = 0; i < uncachedIndices.length; i++) {
          merged[uncachedIndices[i]] = vectors[i];
        }
        return {
          provider: backend.provider,
          model: backend.model,
          vectors: merged,
        };
      }
      return { provider: backend.provider, model: backend.model, vectors };
    } catch (err) {
      lastErr = err;
      log.warn(
        { err, provider: backend.provider },
        "Embedding backend failed, trying next",
      );
      return null;
    }
  };

  const primaryResult = await tryBackend(selection.backend, true);
  if (primaryResult) return primaryResult;

  for (const backend of await getFallbacks()) {
    const result = await tryBackend(backend, false);
    if (result) return result;
  }

  if (!anyBackendAttempted) {
    const hasMultimodal = inputs.some(
      (i) =>
        typeof i !== "string" && normalizeEmbeddingInput(i).type !== "text",
    );
    if (hasMultimodal) {
      throw new Error(
        "No available embedding backend supports multimodal inputs. Gemini API key is required for image/audio/video embeddings.",
      );
    }
  }
  throw lastErr;
}

async function selectFallbackBackends(
  config: AssistantConfig,
  exclude: EmbeddingProviderName,
): Promise<EmbeddingBackend[]> {
  const backends: EmbeddingBackend[] = [];
  const order: EmbeddingProviderName[] = ["openai", "gemini", "ollama"];
  for (const provider of order) {
    if (provider === exclude) continue;
    switch (provider) {
      case "openai": {
        const openaiKey = await getProviderKeyAsync("openai");
        if (openaiKey) {
          backends.push(
            getCachedOrCreate(
              "openai",
              config.memory.embeddings.openaiModel,
              () =>
                new OpenAIEmbeddingBackend(
                  openaiKey,
                  config.memory.embeddings.openaiModel,
                ),
            ),
          );
        } else {
          // Preserve cached backend on transient credential-store failures.
          const cached = getCached(
            "openai",
            config.memory.embeddings.openaiModel,
          );
          if (cached) backends.push(cached);
        }
        break;
      }
      case "gemini": {
        const geminiKey = await getProviderKeyAsync("gemini");
        if (geminiKey) {
          backends.push(getDirectGeminiBackend(config, geminiKey));
        } else {
          // Try managed proxy Gemini as fallback when no direct key exists.
          const managed = await tryGetManagedGeminiBackend(config);
          if (managed) {
            backends.push(managed);
          } else {
            // Check managed cache variant first, then non-managed, so a warm
            // managed backend survives transient proxy-context blips.
            const cached =
              getCached("gemini", config.memory.embeddings.geminiModel, [
                ...geminiCacheExtras(config),
                "managed",
              ]) ??
              getCached(
                "gemini",
                config.memory.embeddings.geminiModel,
                geminiCacheExtras(config),
              );
            if (cached) backends.push(cached);
          }
        }
        break;
      }
      case "ollama": {
        if (await isOllamaConfigured(config)) {
          const ollamaKey = (await getProviderKeyAsync("ollama")) ?? undefined;
          backends.push(
            getCachedOrCreate(
              "ollama",
              config.memory.embeddings.ollamaModel,
              () =>
                new OllamaEmbeddingBackend(
                  config.memory.embeddings.ollamaModel,
                  {
                    apiKey: ollamaKey,
                  },
                ),
            ),
          );
        }
        break;
      }
    }
  }
  return backends;
}

/**
 * Returns true when the active (primary) embedding backend can handle
 * multimodal inputs (images, audio, video). Today only Gemini supports
 * multimodal.
 *
 * Only returns true when Gemini is the primary selected backend — not when
 * it's merely available as a fallback. Writing multimodal embeddings via a
 * fallback provider while queries go through the primary text backend would
 * mix incompatible vector spaces, making retrieval unreliable.
 */
export async function selectedBackendSupportsMultimodal(
  config: AssistantConfig,
): Promise<boolean> {
  const { backend } = await selectEmbeddingBackend(config);
  if (!backend) return false;
  return backend.provider === "gemini";
}

async function isOllamaConfigured(config: AssistantConfig): Promise<boolean> {
  return (
    resolveCallSiteConfig("mainAgent", config.llm).provider === "ollama" ||
    Boolean(await getProviderKeyAsync("ollama")) ||
    Boolean(getOllamaBaseUrlEnv())
  );
}

// ── TF-IDF sparse embedding ───────────────────────────────────────
// Simple tokenizer + TF-IDF sparse encoder. Produces a SparseEmbedding
// with term indices (hashed to a fixed vocabulary) and TF-IDF weights.
// Can be upgraded to a learned sparse encoder (e.g. SPLADE) later.
// Tokenization primitives (`tokenize`, `tokenHash`, `SPARSE_VOCAB_SIZE`) live
// in `./sparse-tokenize.ts` so the BM25 encoder can share them without
// transitively depending on this module.

/**
 * Bump this version whenever the sparse embedding algorithm changes
 * (e.g. hash function fix, tokenizer change). Now inert metadata — the v1
 * Qdrant sentinel was decoupled from this constant, so a bump no longer
 * forces an automatic rebuild. Operators must explicitly run
 * `assistant memory v2 reembed` to rematerialize the v2 sparse index.
 */
export const SPARSE_EMBEDDING_VERSION = 4;

/**
 * Generate a TF-IDF-based sparse embedding for the given text.
 *
 * Term frequency is computed from the input. IDF is approximated using
 * sub-linear TF weighting (1 + log(tf)) since we don't have a corpus-level
 * document frequency table. This still produces useful sparse vectors for
 * lexical matching via Qdrant's sparse vector support.
 */
export function generateSparseEmbedding(text: string): SparseEmbedding {
  const tokens = tokenize(text);
  if (tokens.length === 0) {
    return { indices: [], values: [] };
  }

  // Count term frequencies per hash bucket
  const tf = new Map<number, number>();
  for (const token of tokens) {
    const idx = tokenHash(token, SPARSE_VOCAB_SIZE);
    tf.set(idx, (tf.get(idx) ?? 0) + 1);
  }

  // Convert to sub-linear TF weights: 1 + log(tf)
  const indices: number[] = [];
  const values: number[] = [];
  for (const [idx, count] of tf) {
    indices.push(idx);
    values.push(1 + Math.log(count));
  }

  // L2-normalize the sparse vector so scores are comparable
  let norm = 0;
  for (const v of values) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < values.length; i++) {
      values[i] /= norm;
    }
  }

  return { indices, values };
}
