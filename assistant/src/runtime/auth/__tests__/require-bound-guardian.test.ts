import { describe, expect, mock, test } from "bun:test";

import { resolveScopeProfile } from "../scopes.js";
import type { AuthContext } from "../types.js";

// Default mocks: auth enabled (no dev bypass), guardian bound to "guardian-1".
// Specifiers are resolved relative to this test file, so mirror the path the
// system-under-test imports (`../../config/env.js`, `../../contacts/...`) from
// its own location one directory up.
mock.module("../../../config/env.js", () => ({
  isHttpAuthDisabled: () => false,
}));
mock.module("../../../contacts/contact-store.js", () => ({
  findGuardianForChannel: () => ({
    contact: { principalId: "guardian-1" },
    channel: { externalUserId: "guardian-1" },
  }),
}));

const { requireBoundGuardian } = await import("../require-bound-guardian.js");

function ctx(overrides: Partial<AuthContext>): AuthContext {
  return {
    subject: "actor:self:guardian-1",
    principalType: "actor",
    assistantId: "self",
    scopeProfile: "actor_client_v1",
    scopes: resolveScopeProfile("actor_client_v1"),
    policyEpoch: 1,
    ...overrides,
  };
}

describe("requireBoundGuardian", () => {
  test("allows the local principal even without actorPrincipalId", () => {
    // A `local:<assistantId>:<conversationId>` JWT (self-host owner over the
    // local session) carries no actorPrincipalId. The single-guardian
    // invariant means the local owner IS the bound guardian, so the gate must
    // allow it — not 403 it like the bug that made in-thread Approve fail.
    const result = requireBoundGuardian(
      ctx({
        subject: "local:self:conv-1",
        principalType: "local",
        actorPrincipalId: undefined,
        conversationId: "conv-1",
      }),
    );
    expect(result).toBeNull();
  });

  test("allows a local principal that now carries the owner guardian principal", () => {
    // ROOT FIX: buildAuthContext resolves the local owner's actorPrincipalId
    // to the vellum guardian principal. With that populated, the gate's
    // principal-equality path (not just the `local` short-circuit) also
    // recognizes the owner — belt-and-suspenders with the existing patch.
    const result = requireBoundGuardian(
      ctx({
        subject: "local:self:conv-1",
        principalType: "local",
        actorPrincipalId: "guardian-1",
        conversationId: "conv-1",
      }),
    );
    expect(result).toBeNull();
  });

  test("allows an actor whose principal matches the bound guardian", () => {
    const result = requireBoundGuardian(
      ctx({ principalType: "actor", actorPrincipalId: "guardian-1" }),
    );
    expect(result).toBeNull();
  });

  test("403s a non-local actor with no actorPrincipalId", () => {
    const result = requireBoundGuardian(
      ctx({ principalType: "actor", actorPrincipalId: undefined }),
    );
    expect(result).not.toBeNull();
    expect(result?.status).toBe(403);
  });

  test("403s an actor whose principal does not match the bound guardian", () => {
    const result = requireBoundGuardian(
      ctx({ principalType: "actor", actorPrincipalId: "someone-else" }),
    );
    expect(result).not.toBeNull();
    expect(result?.status).toBe(403);
  });
});
