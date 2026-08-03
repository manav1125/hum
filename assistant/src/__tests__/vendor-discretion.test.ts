/**
 * Vendor discretion on managed instances — the daemon half.
 *
 * A managed (HQ-provisioned) customer never chose, pays for, or administers
 * the inference vendor, and the product must not name it. The system prompt
 * enforces that for anything the MODEL says. This suite covers the three
 * surfaces the model never sees, because the daemon composes them itself and
 * posts them straight to the client:
 *
 *   1. `/model`, `/models`, `/status`, `/commands` — slash commands rendered
 *      verbatim as chat messages (`daemon/conversation-slash.ts`).
 *   2. chat error banners that splice raw upstream text into `userMessage`
 *      (`daemon/conversation-error.ts`).
 *   3. routes that return the provider's own request/response envelope
 *      (`runtime/auth/route-policy.ts` + the `vendorDisclosing` routes).
 *
 * Every assertion is written twice — once managed, once self-host — because
 * the point is not "hide it" but "hide it on exactly one of the two
 * deployments". A self-hoster who supplies their own key is entitled to see
 * what they are paying for, and a guard that hid it from them would be a
 * regression, not extra safety.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  type ClassifiedConversationError,
  classifyConversationError,
} from "../daemon/conversation-error.js";
import {
  resolveSlash,
  type SlashContext,
} from "../daemon/conversation-slash.js";
import { enforcePolicy } from "../runtime/auth/route-policy.js";
import type { AuthContext, PrincipalType } from "../runtime/auth/types.js";
import { ROUTES as CONVERSATION_QUERY_ROUTES } from "../runtime/routes/conversation-query-routes.js";
import { ProviderError } from "../util/errors.js";

// The exact strings a leak would look like: the provider slug the prod brain
// actually runs on, its vendor, and the aggregator in front of it.
const VENDOR_TOKENS = [
  "deepseek",
  "openrouter",
  "anthropic",
  "claude",
  "gemini",
  "openai",
  "qwen",
  "fireworks",
  "minimax",
];

function expectNamesNoVendor(text: string): void {
  const lower = text.toLowerCase();
  const found = VENDOR_TOKENS.filter((token) => lower.includes(token));
  // Assert on the list, not per-token, so a failure prints which vendor
  // leaked and the string it leaked in.
  expect({ found, text }).toEqual({ found: [], text });
}

const originalManaged = process.env.CUE_MANAGED;
const originalAuthDisabled = process.env.DISABLE_HTTP_AUTH;

function setManaged(managed: boolean): void {
  if (managed) process.env.CUE_MANAGED = "1";
  else delete process.env.CUE_MANAGED;
}

beforeEach(() => {
  delete process.env.CUE_MANAGED;
});

afterEach(() => {
  if (originalManaged === undefined) delete process.env.CUE_MANAGED;
  else process.env.CUE_MANAGED = originalManaged;
  if (originalAuthDisabled === undefined) {
    delete process.env.DISABLE_HTTP_AUTH;
  } else {
    process.env.DISABLE_HTTP_AUTH = originalAuthDisabled;
  }
});

// ---------------------------------------------------------------------------
// 1 · Slash commands
// ---------------------------------------------------------------------------

function slashContext(overrides: Partial<SlashContext> = {}): SlashContext {
  return {
    messageCount: 4,
    inputTokens: 1024,
    outputTokens: 256,
    maxInputTokens: 200000,
    model: "deepseek/deepseek-v4-pro",
    provider: "openrouter",
    estimatedCost: 0.03,
    ...overrides,
  };
}

async function slashMessage(
  content: string,
  context?: SlashContext,
): Promise<string> {
  const result = await resolveSlash(content, context);
  if (result.kind !== "unknown") {
    throw new Error(`expected ${content} to resolve to kind=unknown`);
  }
  return result.message;
}

describe("slash commands on a managed instance", () => {
  test("/status keeps the conversation facts and drops the model line", async () => {
    setManaged(true);
    const message = await slashMessage("/status", slashContext());

    expectNamesNoVendor(message);
    expect(message).not.toContain("Model:");
    // Still useful: the numbers the command exists for survive.
    expect(message).toContain("Context:");
    expect(message).toContain("Messages: 4");
    expect(message).toContain("Cost:");
  });

  test("/status on self-host still names the model and provider", async () => {
    setManaged(false);
    const message = await slashMessage("/status", slashContext());

    expect(message).toContain(
      "Model:    deepseek/deepseek-v4-pro (openrouter)",
    );
  });

  test("/context is the same command and gets the same treatment", async () => {
    setManaged(true);
    expectNamesNoVendor(await slashMessage("/context", slashContext()));
  });

  test("/models refuses instead of dumping the provider catalog", async () => {
    setManaged(true);
    const message = await slashMessage("/models");

    expectNamesNoVendor(message);
    expect(message).toContain("managed");
  });

  test("/model and /model <name> refuse too", async () => {
    setManaged(true);
    expectNamesNoVendor(await slashMessage("/model"));
    // The switch form must not silently succeed either — a managed customer
    // has no model picker anywhere else in the product.
    expectNamesNoVendor(await slashMessage("/model quality-optimized"));
  });

  test("a deprecated provider shortcut does not name the provider back", async () => {
    setManaged(true);
    // Self-host answers "/opus has been removed, use Settings → Models &
    // Services" — on managed that page does not exist and the word is a
    // vendor's model name being echoed to the user.
    expectNamesNoVendor(await slashMessage("/opus"));
  });

  test("/commands stops advertising the model commands", async () => {
    setManaged(true);
    const lines = (await slashMessage("/commands", slashContext())).split("\n");

    expect(lines.some((l) => l.startsWith("/model —"))).toBe(false);
    expect(lines.some((l) => l.startsWith("/models —"))).toBe(false);
    // The rest of the menu is untouched.
    expect(lines.some((l) => l.startsWith("/status —"))).toBe(true);
    expect(lines.some((l) => l.startsWith("/compact —"))).toBe(true);
  });

  test("/commands on self-host still advertises them", async () => {
    setManaged(false);
    const lines = (await slashMessage("/commands", slashContext())).split("\n");

    expect(lines.some((l) => l.startsWith("/model —"))).toBe(true);
    expect(lines.some((l) => l.startsWith("/models —"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2 · Chat error banners
// ---------------------------------------------------------------------------

function classify(error: unknown): ClassifiedConversationError {
  return classifyConversationError(error, { phase: "handler", aborted: false });
}

describe("chat error banners on a managed instance", () => {
  // The shape OpenRouter actually returns for an unknown/ineligible model.
  const upstream400 = () =>
    new ProviderError(
      'API error (400): {"error":{"message":"deepseek/deepseek-v4-pro is not a valid model ID","code":400}}',
      "openrouter",
      400,
    );

  test("a 4xx keeps the status code and drops the vendor's prose", () => {
    setManaged(true);
    const classified = classify(upstream400());

    expectNamesNoVendor(classified.userMessage);
    // Actionable meaning survives: the user learns the turn failed, and the
    // retry affordance is unchanged.
    expect(classified.userMessage).toContain("HTTP 400");
    expect(classified.retryable).toBe(true);
    expect(classified.errorCategory).toBe("provider_api_error");
  });

  test("the same 4xx on self-host still carries the provider detail", () => {
    setManaged(false);
    const classified = classify(upstream400());

    expect(classified.userMessage).toContain("is not a valid model ID");
  });

  test("an unclassified error does not leak its first line", () => {
    setManaged(true);
    const classified = classify(
      new Error("anthropic/claude-opus-4-6 refused the request"),
    );

    expectNamesNoVendor(classified.userMessage);
    expect(classified.retryable).toBe(true);
    expect(classified.errorCategory).toBe("processing_failed");
  });

  test("an unclassified error on self-host keeps its first line", () => {
    setManaged(false);
    const classified = classify(
      new Error("anthropic/claude-opus-4-6 refused the request"),
    );

    expect(classified.userMessage).toContain("claude-opus-4-6");
  });

  test("classified errors were already vendor-neutral and stay useful", () => {
    setManaged(true);
    const rateLimited = classify(
      new ProviderError("API error (429): rate limit", "openrouter", 429),
    );

    expectNamesNoVendor(rateLimited.userMessage);
    expect(rateLimited.retryable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3 · Vendor-disclosing routes
// ---------------------------------------------------------------------------

/**
 * Routes whose response body carries the provider's own envelope. Adding a
 * route that serves raw LLM request/response payloads without marking it
 * `vendorDisclosing` should fail here.
 */
const VENDOR_DISCLOSING_OPERATIONS = [
  // Whole response is the active model + provider + catalog of alternatives.
  "model_get",
  "conversations_llm_context_get",
  "messages_llm_context_get",
  "llm_request_logs_payload_get",
  "llm_request_logs_context_get",
];

/**
 * Both principals carry the same scopes on purpose: `principalType` is the
 * only variable under test, so a denial here can only come from the vendor
 * check and never from the scope check.
 *
 * That the scopes are a tester's is the whole point of item 8 — every scope
 * a developer tool could require (`chat.read`, `settings.read`,
 * `feature_flags.write`) already ships in the `actor_client_v1` profile that
 * every signed-in customer holds, so no scope raise could have fixed this.
 */
function authContext(principalType: PrincipalType): AuthContext {
  return {
    subject: principalType === "local" ? "local:cli" : "actor:tester",
    principalType,
    assistantId: "asst_1",
    scopeProfile: "actor_client_v1",
    scopes: new Set(["chat.read", "chat.write", "settings.read"] as const),
    policyEpoch: 1,
  };
}

describe("vendor-disclosing routes", () => {
  test("every route that returns a raw LLM envelope declares the flag", () => {
    const flagged = CONVERSATION_QUERY_ROUTES.filter(
      (r) => r.policy?.vendorDisclosing === true,
    ).map((r) => r.operationId);

    expect(flagged.sort()).toEqual([...VENDOR_DISCLOSING_OPERATIONS].sort());
  });

  test("a tester's own session token is refused on a managed instance", () => {
    setManaged(true);
    for (const operationId of VENDOR_DISCLOSING_OPERATIONS) {
      const route = CONVERSATION_QUERY_ROUTES.find(
        (r) => r.operationId === operationId,
      );
      const denied = enforcePolicy(
        route!.endpoint,
        route!.policy,
        authContext("actor"),
      );
      expect(denied?.status).toBe(403);
    }
  });

  test("the same token is allowed on a self-host instance", () => {
    setManaged(false);
    for (const operationId of VENDOR_DISCLOSING_OPERATIONS) {
      const route = CONVERSATION_QUERY_ROUTES.find(
        (r) => r.operationId === operationId,
      );
      expect(
        enforcePolicy(route!.endpoint, route!.policy, authContext("actor")),
      ).toBeNull();
    }
  });

  test("a local CLI principal still gets through on managed — this is the staff path", () => {
    setManaged(true);
    for (const operationId of VENDOR_DISCLOSING_OPERATIONS) {
      const route = CONVERSATION_QUERY_ROUTES.find(
        (r) => r.operationId === operationId,
      );
      expect(
        enforcePolicy(route!.endpoint, route!.policy, authContext("local")),
      ).toBeNull();
    }
  });

  test("disabling auth in dev does not reopen the route on a managed instance", () => {
    setManaged(true);
    process.env.DISABLE_HTTP_AUTH = "true";
    const route = CONVERSATION_QUERY_ROUTES.find(
      (r) => r.operationId === "llm_request_logs_payload_get",
    );
    const denied = enforcePolicy(
      route!.endpoint,
      route!.policy,
      authContext("actor"),
    );
    expect(denied?.status).toBe(403);
  });

  test("unflagged routes are unaffected by managed mode", () => {
    setManaged(true);
    const route = CONVERSATION_QUERY_ROUTES.find(
      (r) => r.operationId === "conversations_search",
    );
    expect(route?.policy?.vendorDisclosing).toBeUndefined();
    expect(
      enforcePolicy(route!.endpoint, route!.policy, authContext("actor")),
    ).toBeNull();
  });
});
