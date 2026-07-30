/**
 * Cue HQ — per-instance secret generation + actor-token minting.
 *
 * Token compatibility: mirrors the daemon/gateway JWT implementation in
 * assistant/src/runtime/auth/token-service.ts and
 * gateway/src/auth/guardian-bootstrap.ts —
 *   header  {"alg":"HS256","typ":"JWT"}
 *   claims  { iss: "vellum-auth", aud: "vellum-gateway",
 *             sub: "actor:<assistantName>:<guardianPrincipalId>",
 *             scope_profile: "actor_client_v1", policy_epoch: 1,
 *             exp, iat, jti }
 *   signature HMAC-SHA256 over "<header>.<payload>" with the instance's
 *   ACTOR_TOKEN_SIGNING_KEY (32 bytes, hex-encoded in env).
 *
 * The gateway's revocation check (gateway/src/auth/actor-token-revocation.ts)
 * is fail-open for tokens without a DB record, so an HQ-minted token with a
 * valid signature is accepted. The guardian principal, however, must exist —
 * so provisioning first calls POST /v1/guardian/init (with the instance's
 * GUARDIAN_BOOTSTRAP_SECRET) to create the guardian binding and learn its
 * guardianPrincipalId; magic-link re-issuance then mints offline.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// ── constants mirroring the daemon/gateway auth layer ────────────────────

export const TOKEN_ISSUER = "vellum-auth";
export const TOKEN_AUDIENCE = "vellum-gateway";
export const TOKEN_SCOPE_PROFILE = "actor_client_v1";
export const CURRENT_POLICY_EPOCH = 1;
/** Matches gateway ACCESS_TOKEN_TTL_SECONDS (30 days). */
export const ACTOR_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Matches render.yaml VELLUM_ASSISTANT_NAME (→ getExternalAssistantId()). */
export const DEFAULT_ASSISTANT_NAME = "Cue";

// ── per-instance secret generation ───────────────────────────────────────

/** The secret material HQ generates for one instance (stored in secretsJson). */
export interface InstanceSecrets {
  /** One-time bootstrap secret for POST /v1/guardian/init. */
  guardianBootstrapSecret: string;
  /** 64-hex-char (32-byte) HMAC key — the instance's crown jewel. */
  actorTokenSigningKey: string;
  /** Inter-service tokens (render.yaml cue-shared-tokens group). */
  cesServiceToken: string;
  assistantApiKey: string;
  gatewayJwt: string;
  /** Learned from guardian/init after first boot; needed to mint tokens. */
  guardianPrincipalId?: string;
}

export function generateInstanceSecrets(): InstanceSecrets {
  return {
    guardianBootstrapSecret: randomBytes(24).toString("hex"),
    // resolveSigningKey() requires exactly 64 hex chars.
    actorTokenSigningKey: randomBytes(32).toString("hex"),
    cesServiceToken: randomBytes(24).toString("hex"),
    assistantApiKey: randomBytes(24).toString("hex"),
    gatewayJwt: randomBytes(24).toString("hex"),
  };
}

/**
 * Bundled tool-API platform keys (web-research / web-scrape skills) that HQ
 * passes through to every instance when set in HQ's own environment. The
 * daemon reads these directly (assistant bundled-skill executors); they are
 * deliberately NOT in the assistant's SAFE_ENV_VARS allowlist, so they never
 * reach bash/child processes on the instance. Unset here = the corresponding
 * tool on the instance reports a clean "not configured" message.
 */
export const TOOL_API_PASSTHROUGH_ENV_VARS = [
  "CUE_TAVILY_API_KEY",
  "CUE_FIRECRAWL_API_KEY",
  "CUE_SERPER_API_KEY",
] as const;

/**
 * Brain-selection env HQ forwards to every instance when set in its own
 * environment. None of these are secrets — they are model ids and OpenRouter
 * routing preferences, and all are allowlisted in the assistant's
 * `safe-env.ts`.
 *
 * Why this list exists: an instance's LLM routing lived entirely in
 * machine-level env on the one hand-tuned production machine, so a
 * newly provisioned instance inherited none of it and fell back to the
 * hardcoded defaults in `assistant/src/config/llm-resolver.ts`. Forwarding
 * these from HQ makes the fleet's brain steerable from one place — change HQ's
 * env and every subsequently provisioned instance follows, with no image
 * rebuild.
 *
 * Unset here ⇒ the instance uses the resolver's own defaults
 * (`DEFAULT_OPENROUTER_MODEL` / `DEFAULT_OPENROUTER_FLASH_MODEL`), which are
 * the pair production runs. Deliberately NOT set to a value here: leaving
 * `CUE_OPENROUTER_PROVIDER_ORDER` / `..._ALLOW_FALLBACKS` unset lets OpenRouter
 * pick and fall back freely, which is the more robust default for a fleet
 * nobody is watching. `..._REQUIRE_PARAMS` must never be "true" — it caused a
 * total inference outage once (open-weight models cap max_tokens near 16k).
 */
export const BRAIN_PASSTHROUGH_ENV_VARS = [
  "CUE_OPENROUTER_MODEL",
  "CUE_OPENROUTER_FLASH_MODEL",
  "CUE_OPENROUTER_BASE_URL",
  "CUE_OPENROUTER_PROVIDER_ORDER",
  "CUE_OPENROUTER_PROVIDER_ALLOW_FALLBACKS",
  "CUE_OPENROUTER_PROVIDER_REQUIRE_PARAMS",
  // Advisor escalation tier (the "consult a stronger model before a
  // high-stakes action" path). Defaults live in assistant/src/agent/advisor.ts.
  "CUE_ADVISOR_MODEL",
  "CUE_ADVISOR_FALLBACK_MODEL",
] as const;

/** Collect the tool-API passthrough env pairs present in `source`. */
export function toolApiPassthroughEnv(
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  return collectPassthrough(TOOL_API_PASSTHROUGH_ENV_VARS, source);
}

/** Collect the brain-selection passthrough env pairs present in `source`. */
export function brainPassthroughEnv(
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  return collectPassthrough(BRAIN_PASSTHROUGH_ENV_VARS, source);
}

function collectPassthrough(
  keys: readonly string[],
  source: Record<string, string | undefined>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of keys) {
    const value = source[key]?.trim();
    if (value) env[key] = value;
  }
  return env;
}

/**
 * Assemble the per-instance env contract (mirrors the `cue-app` service in
 * the repo-root render.yaml). Provider/channel secrets (OPENROUTER_API_KEY,
 * REPLICATE_API_TOKEN, …) come from `providerEnv` — HQ never hardcodes them.
 * Bundled tool-API keys (CUE_TAVILY_API_KEY, CUE_FIRECRAWL_API_KEY,
 * CUE_SERPER_API_KEY) and brain selection (CUE_OPENROUTER_MODEL and friends,
 * see BRAIN_PASSTHROUGH_ENV_VARS) pass through from HQ's own env when set;
 * `providerEnv` can still override them per-instance.
 */
export function buildInstanceEnv(
  secrets: InstanceSecrets,
  providerEnv: Record<string, string> = {},
): Record<string, string> {
  return {
    // shared tokens
    CES_SERVICE_TOKEN: secrets.cesServiceToken,
    ASSISTANT_API_KEY: secrets.assistantApiKey,
    GATEWAY_JWT: secrets.gatewayJwt,
    GUARDIAN_BOOTSTRAP_SECRET: secrets.guardianBootstrapSecret,
    ACTOR_TOKEN_SIGNING_KEY: secrets.actorTokenSigningKey,
    // Managed-mode flag: HQ-provisioned instances run the fully managed
    // LLM plan (BYO hidden). Not a secret — allowlisted in
    // assistant/src/tools/terminal/safe-env.ts so the SPA/daemon can read it.
    CUE_MANAGED: "1",
    // topology (mirrors render.yaml cue-app envVars)
    IS_CONTAINERIZED: "true",
    VELLUM_DISABLE_CES: "1",
    VELLUM_ENVIRONMENT: "production",
    VELLUM_WORKSPACE_DIR: "/workspace",
    WEB_DIST_DIR: "/app/web-dist",
    RUNTIME_HTTP_HOST: "127.0.0.1",
    RUNTIME_HTTP_PORT: "3001",
    RUNTIME_PROXY_REQUIRE_AUTH: "true",
    GATEWAY_PORT: "10000",
    GATEWAY_INTERNAL_URL: "http://127.0.0.1:10000",
    GATEWAY_SECURITY_DIR: "/workspace/gateway-security",
    ASSISTANT_HOST: "127.0.0.1",
    DEFAULT_ASSISTANT_ID: "cue-local",
    VELLUM_ASSISTANT_NAME: DEFAULT_ASSISTANT_NAME,
    // Bundled tool-API platform keys + brain selection (optional; only
    // included when set in HQ's env). providerEnv below can still override
    // per-instance.
    ...toolApiPassthroughEnv(),
    ...brainPassthroughEnv(),
    ...providerEnv,
  };
}

// ── JWT minting (daemon-compatible) ──────────────────────────────────────

function base64url(data: Buffer | string): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
  return buf.toString("base64url");
}

const JWT_HEADER = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));

export interface ActorTokenClaims {
  iss: string;
  aud: string;
  sub: string;
  scope_profile: string;
  exp: number;
  policy_epoch: number;
  iat: number;
  jti: string;
}

function keyFromHex(signingKeyHex: string): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(signingKeyHex)) {
    throw new Error(
      `Invalid signing key: expected 64 hex chars, got ${signingKeyHex.length}`,
    );
  }
  return Buffer.from(signingKeyHex, "hex");
}

/**
 * Mint an actor JWT the instance's gateway will accept.
 * Mirrors gateway mintAccessToken(): sub = actor:<assistantName>:<principal>.
 */
export function mintActorToken(params: {
  signingKeyHex: string;
  guardianPrincipalId: string;
  assistantName?: string;
  ttlSeconds?: number;
}): string {
  const key = keyFromHex(params.signingKeyHex);
  const now = Math.floor(Date.now() / 1000);
  const claims: ActorTokenClaims = {
    iss: TOKEN_ISSUER,
    aud: TOKEN_AUDIENCE,
    sub: `actor:${params.assistantName ?? DEFAULT_ASSISTANT_NAME}:${params.guardianPrincipalId}`,
    scope_profile: TOKEN_SCOPE_PROFILE,
    exp: now + (params.ttlSeconds ?? ACTOR_TOKEN_TTL_SECONDS),
    policy_epoch: CURRENT_POLICY_EPOCH,
    iat: now,
    jti: randomBytes(16).toString("hex"),
  };
  const payload = base64url(JSON.stringify(claims));
  const sigInput = `${JWT_HEADER}.${payload}`;
  const sig = createHmac("sha256", key).update(sigInput).digest();
  return `${sigInput}.${base64url(sig)}`;
}

/** Verify an HQ-minted token (test/diagnostic mirror of the gateway check). */
export function verifyActorToken(
  token: string,
  signingKeyHex: string,
): { ok: true; claims: ActorTokenClaims } | { ok: false; reason: string } {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed_token" };
  const [header, payload, sigPart] = parts;
  const expected = createHmac("sha256", keyFromHex(signingKeyHex))
    .update(`${header}.${payload}`)
    .digest();
  const actual = Buffer.from(sigPart, "base64url");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, reason: "invalid_signature" };
  }
  let claims: ActorTokenClaims;
  try {
    claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf-8"),
    ) as ActorTokenClaims;
  } catch {
    return { ok: false, reason: "malformed_claims" };
  }
  if (claims.aud !== TOKEN_AUDIENCE) return { ok: false, reason: "audience" };
  if (claims.exp <= Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: "token_expired" };
  }
  return { ok: true, claims };
}

// ── guardian bootstrap (one-time, against a freshly provisioned instance) ─

export interface GuardianInitResult {
  guardianPrincipalId: string;
  accessToken: string;
  accessTokenExpiresAt: number;
}

/**
 * Consume the instance's one-time bootstrap secret to create the guardian
 * binding and obtain the first actor token + the guardianPrincipalId
 * (which HQ persists so later magic links can be minted offline).
 */
export async function guardianInit(
  instanceUrl: string,
  bootstrapSecret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GuardianInitResult> {
  const res = await fetchImpl(
    `${instanceUrl.replace(/\/$/, "")}/v1/guardian/init`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bootstrap-secret": bootstrapSecret,
      },
      body: JSON.stringify({
        platform: "web",
        deviceId: `hq-${randomBytes(8).toString("hex")}`,
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`guardian/init → ${res.status}: ${text.slice(0, 300)}`);
  }
  const body = (await res.json()) as {
    guardianPrincipalId?: string;
    accessToken?: string;
    accessTokenExpiresAt?: number;
  };
  if (!body.guardianPrincipalId || !body.accessToken) {
    throw new Error("guardian/init returned an unexpected body");
  }
  return {
    guardianPrincipalId: body.guardianPrincipalId,
    accessToken: body.accessToken,
    accessTokenExpiresAt: body.accessTokenExpiresAt ?? 0,
  };
}

/**
 * Build the one-click connect URL for a live instance.
 *
 * The SPA's self-host bootstrap (apps/web/src/lib/self-hosted/cue-self-host.ts
 * → bootstrapCueSelfHost()) consumes a one-time `?cueToken=<actor JWT>` query
 * param on boot: it seeds localStorage (cue:selfHost=1 + the durable
 * cue:selfHost:actorToken) and strips the credential from the URL/history.
 * There is no `#selfHostToken=` fragment path — the query param IS the
 * supported magic-link mechanism.
 */
export function buildMagicLink(
  instanceUrl: string,
  actorToken: string,
): string {
  return `${instanceUrl.replace(/\/$/, "")}/assistant/?cueToken=${encodeURIComponent(actorToken)}`;
}
