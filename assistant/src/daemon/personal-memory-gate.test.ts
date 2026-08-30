/**
 * The personal-memory trust gate.
 *
 * The bug these pin: the gate's rule was shaped by *channel* — deny a
 * non-guardian arriving remotely, and treat `vellum` as internal. That is
 * true of the transport but not of the people on it. `vellum` is also the
 * first-party console, and a trusted contact can be sitting in it, so a
 * positively identified non-owner was shown the owner's private memory.
 *
 * Seventy lines away, message history is gated on guardian class alone. The
 * two predicates therefore disagreed about exactly one actor, and the more
 * permissive one decided what got injected into the prompt.
 *
 * The `unknown`-on-vellum case is asserted as ALLOWED on purpose. It is not
 * an oversight: `FALLBACK_TURN_TRUST` synthesises that exact value for turns
 * that never resolved an actor, so denying it would strip NOW.md, PKB context
 * and the memory blocks from ordinary internal paths. If a future change
 * teaches the fallback to stop claiming a class, this expectation is the one
 * to revisit — deliberately, not by accident.
 */

import { describe, expect, test } from "bun:test";

import {
  FALLBACK_TURN_TRUST,
  INTERNAL_GUARDIAN_TRUST_CONTEXT,
  isPersonalMemoryAllowed,
  type TrustContext,
} from "./trust-context.js";

const ctx = (over: Partial<TrustContext>): TrustContext => ({
  sourceChannel: "vellum",
  trustClass: "unknown",
  ...over,
});

describe("isPersonalMemoryAllowed", () => {
  test("denies a trusted contact on the first-party console", () => {
    // The reported hole. `vellum` is not a proxy for "the owner".
    expect(
      isPersonalMemoryAllowed(
        ctx({ sourceChannel: "vellum", trustClass: "trusted_contact" }),
      ),
    ).toBe(false);
  });

  test("denies a trusted contact on every other channel too", () => {
    // Already denied by the channel rule; pinned so the two paths cannot
    // drift apart and leave one of them permissive.
    for (const channel of ["telegram", "whatsapp", "slack"] as const) {
      expect(
        isPersonalMemoryAllowed(
          ctx({ sourceChannel: channel, trustClass: "trusted_contact" }),
        ),
      ).toBe(false);
    }
  });

  test("allows the guardian, on the console and remotely", () => {
    expect(isPersonalMemoryAllowed(INTERNAL_GUARDIAN_TRUST_CONTEXT)).toBe(true);
    expect(
      isPersonalMemoryAllowed(
        ctx({ sourceChannel: "telegram", trustClass: "guardian" }),
      ),
    ).toBe(true);
  });

  test("still denies an unknown actor arriving remotely", () => {
    // The original prompt-injection rule, unchanged.
    expect(
      isPersonalMemoryAllowed(
        ctx({ sourceChannel: "telegram", trustClass: "unknown" }),
      ),
    ).toBe(false);
  });

  test("still allows the unresolved-actor fallback", () => {
    // Not a stranger — a turn that never bound an actor. Denying this would
    // silently drop personal memory from internal paths. See the header.
    expect(isPersonalMemoryAllowed(FALLBACK_TURN_TRUST)).toBe(true);
    expect(isPersonalMemoryAllowed(undefined)).toBe(true);
  });
});
