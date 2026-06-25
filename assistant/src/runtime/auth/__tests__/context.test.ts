import { describe, expect, test } from "bun:test";

import { DAEMON_INTERNAL_ASSISTANT_ID } from "../../assistant-scope.js";
import { buildAuthContext } from "../context.js";
import type { TokenClaims } from "../types.js";

function validClaims(overrides?: Partial<TokenClaims>): TokenClaims {
  return {
    iss: "vellum-auth",
    aud: "vellum-daemon",
    sub: "actor:self:principal-abc",
    scope_profile: "actor_client_v1",
    exp: Math.floor(Date.now() / 1000) + 300,
    policy_epoch: 1,
    iat: Math.floor(Date.now() / 1000),
    jti: "test-jti",
    ...overrides,
  };
}

describe("buildAuthContext", () => {
  test("builds context from valid actor claims", () => {
    const result = buildAuthContext(validClaims());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.subject).toBe("actor:self:principal-abc");
      expect(result.context.principalType).toBe("actor");
      expect(result.context.assistantId).toBe("self");
      expect(result.context.actorPrincipalId).toBe("principal-abc");
      expect(result.context.conversationId).toBeUndefined();
      expect(result.context.scopeProfile).toBe("actor_client_v1");
      expect(result.context.policyEpoch).toBe(1);
      expect(result.context.scopes.has("chat.read")).toBe(true);
      expect(result.context.scopes.has("chat.write")).toBe(true);
    }
  });

  test("builds context from valid svc:gateway claims", () => {
    const result = buildAuthContext(
      validClaims({
        sub: "svc:gateway:self",
        scope_profile: "gateway_ingress_v1",
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.principalType).toBe("svc_gateway");
      expect(result.context.assistantId).toBe("self");
      expect(result.context.scopes.has("ingress.write")).toBe(true);
    }
  });

  test("builds context from valid local claims", () => {
    const result = buildAuthContext(
      validClaims({
        sub: "local:self:session-123",
        scope_profile: "local_v1",
      }),
      // Inject a stub owner resolver so the test does not depend on a live
      // contacts DB (the production default reads the vellum guardian binding).
      { resolveOwnerPrincipalId: () => undefined },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.principalType).toBe("local");
      expect(result.context.assistantId).toBe("self");
      expect(result.context.conversationId).toBe("session-123");
      expect(result.context.scopes.has("local.all")).toBe(true);
    }
  });

  test("local principal resolves actorPrincipalId to the owner guardian principal", () => {
    // ROOT FIX: a `local` sub carries no actorPrincipalId, so the builder
    // resolves it to the vellum-bound guardian's principalId — making the
    // self-host owner a fully-recognized principal that downstream gates
    // (require-bound-guardian, trust-context resolution) accept.
    const result = buildAuthContext(
      validClaims({
        sub: "local:self:session-123",
        scope_profile: "local_v1",
      }),
      { resolveOwnerPrincipalId: () => "vellum-principal-owner-xyz" },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.principalType).toBe("local");
      expect(result.context.actorPrincipalId).toBe(
        "vellum-principal-owner-xyz",
      );
    }
  });

  test("local principal carries no actorPrincipalId before guardian bootstrap", () => {
    // Pre-bootstrap (no guardian binding) the resolver returns undefined.
    // This preserves the pre-fix behavior for fresh installs; downstream
    // gates already tolerate a missing principal in that window.
    const result = buildAuthContext(
      validClaims({
        sub: "local:self:session-123",
        scope_profile: "local_v1",
      }),
      { resolveOwnerPrincipalId: () => undefined },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.principalType).toBe("local");
      expect(result.context.actorPrincipalId).toBeUndefined();
    }
  });

  test("non-local principal ignores the owner resolver (unaffected by fix)", () => {
    // A remote/actor principal must NOT pick up the owner principal id — its
    // actorPrincipalId comes solely from its own sub. The owner resolver is
    // a poisoned stub here to prove it is never consulted for `actor`.
    const result = buildAuthContext(
      validClaims({ sub: "actor:self:remote-principal-abc" }),
      {
        resolveOwnerPrincipalId: () => {
          throw new Error("owner resolver must not run for actor principals");
        },
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.principalType).toBe("actor");
      expect(result.context.actorPrincipalId).toBe("remote-principal-abc");
    }
  });

  test("daemon-audience token forces assistantId to DAEMON_INTERNAL_ASSISTANT_ID", () => {
    // Token sub contains an external assistant ID, but audience is daemon
    const result = buildAuthContext(
      validClaims({
        aud: "vellum-daemon",
        sub: "actor:external-assistant-xyz:principal-abc",
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.assistantId).toBe(DAEMON_INTERNAL_ASSISTANT_ID);
      expect(result.context.assistantId).toBe("self");
      // Other fields should still reflect the parsed sub
      expect(result.context.principalType).toBe("actor");
      expect(result.context.actorPrincipalId).toBe("principal-abc");
    }
  });

  test("gateway-audience token preserves assistantId from sub", () => {
    const result = buildAuthContext(
      validClaims({
        aud: "vellum-gateway",
        sub: "actor:external-assistant-xyz:principal-abc",
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.assistantId).toBe("external-assistant-xyz");
      expect(result.context.principalType).toBe("actor");
      expect(result.context.actorPrincipalId).toBe("principal-abc");
    }
  });

  test("daemon-audience svc:gateway sub also forces assistantId to self", () => {
    const result = buildAuthContext(
      validClaims({
        aud: "vellum-daemon",
        sub: "svc:gateway:external-id",
        scope_profile: "gateway_ingress_v1",
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.assistantId).toBe(DAEMON_INTERNAL_ASSISTANT_ID);
      expect(result.context.principalType).toBe("svc_gateway");
    }
  });

  test("fails with invalid sub pattern", () => {
    const result = buildAuthContext(validClaims({ sub: "bad:format" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("unrecognized");
    }
  });

  test("fails with empty sub", () => {
    const result = buildAuthContext(validClaims({ sub: "" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("empty");
    }
  });

  test("preserves policy epoch from claims", () => {
    const result = buildAuthContext(validClaims({ policy_epoch: 42 }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.policyEpoch).toBe(42);
    }
  });
});
