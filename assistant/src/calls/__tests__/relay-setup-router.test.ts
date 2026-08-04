/**
 * Inbound ACL routing coverage for `routeSetup`.
 *
 * The focus is the ordering of the governance gates: a channel the guardian
 * set to `policy: 'deny'` must be denied for EVERY caller class — trust class
 * derives from channel status alone, so a denied channel still resolves to
 * `unknown` while its status is `unverified`/`pending`, and a per-class gate
 * would miss it. The deny also outranks an active voice invite. Unknown
 * callers (no deny ruling) keep reaching the guardian access-request flow via
 * name capture.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import type {
  ActorTrustContext,
  TrustClass,
} from "../../runtime/actor-trust-resolver.js";

let actorTrust: ActorTrustContext;
const actualTrustResolver =
  await import("../../runtime/actor-trust-resolver.js");
mock.module("../../runtime/actor-trust-resolver.js", () => ({
  ...actualTrustResolver,
  resolveActorTrust: () => actorTrust,
}));

let activeVoiceInvites: Array<{
  friendName: string | null;
  guardianName: string | null;
  expiresAt: number | null;
}> = [];
const actualInviteStore = await import("../../memory/invite-store.js");
mock.module("../../memory/invite-store.js", () => ({
  ...actualInviteStore,
  findActiveVoiceInvites: () => activeVoiceInvites,
}));

const actualVerificationService =
  await import("../../runtime/channel-verification-service.js");
mock.module("../../runtime/channel-verification-service.js", () => ({
  ...actualVerificationService,
  getPendingSession: () => null,
}));

const actualConfigLoader = await import("../../config/loader.js");
mock.module("../../config/loader.js", () => ({
  ...actualConfigLoader,
  getConfig: () => ({
    calls: { verification: { enabled: false, maxAttempts: 3, codeLength: 6 } },
  }),
}));

const { routeSetup } = await import("../relay-setup-router.js");

const FROM = "+12025550142";

function makeTrust(
  trustClass: TrustClass,
  member?: { status: string; policy: string; role?: string },
): ActorTrustContext {
  return {
    canonicalSenderId: FROM,
    guardianBindingMatch: null,
    guardianPrincipalId: undefined,
    memberRecord: member
      ? {
          contact: {
            displayName: "Alice Example",
            role: member.role ?? "member",
          } as never,
          channel: {
            id: "chan-1",
            status: member.status,
            policy: member.policy,
          } as never,
        }
      : null,
    trustClass,
    actorMetadata: {
      identifier: FROM,
      displayName: undefined,
      senderDisplayName: undefined,
      memberDisplayName: undefined,
      username: undefined,
      channel: "phone",
      trustStatus: trustClass,
    },
  };
}

function routeInbound() {
  return routeSetup({
    callSessionId: "cs-1",
    session: null,
    from: FROM,
    to: "+12025550100",
  });
}

beforeEach(() => {
  activeVoiceInvites = [];
  actorTrust = makeTrust("unknown");
});

describe("routeSetup — member policy deny outranks every inbound flow", () => {
  // Status and policy are independent governance signals: a channel the
  // guardian set to deny still resolves to `unknown` while its status is
  // `unverified`/`pending`.
  test("an unverified-status denied contact is denied, not sent to verification guidance", () => {
    actorTrust = makeTrust("unknown", {
      status: "unverified",
      policy: "deny",
    });

    const { outcome } = routeInbound();
    expect(outcome.action).toBe("deny");
    if (outcome.action === "deny") {
      expect(outcome.logReason).toBe("Inbound voice ACL: member policy deny");
    }
  });

  test("a pending-status denied contact is denied", () => {
    actorTrust = makeTrust("unknown", { status: "pending", policy: "deny" });

    expect(routeInbound().outcome.action).toBe("deny");
  });

  test("denied even with an active voice invite", () => {
    actorTrust = makeTrust("unknown", {
      status: "unverified",
      policy: "deny",
    });
    activeVoiceInvites = [
      { friendName: "Alice", guardianName: "Sam", expiresAt: null },
    ];

    expect(routeInbound().outcome.action).toBe("deny");
  });

  test("an active-status member with policy deny is denied", () => {
    actorTrust = makeTrust("trusted_contact", {
      status: "active",
      policy: "deny",
    });

    expect(routeInbound().outcome.action).toBe("deny");
  });
});

describe("routeSetup — unknown callers still reach the guardian approval flow", () => {
  test("an unrecognized number routes to name capture (access-request flow)", () => {
    const { outcome } = routeInbound();
    expect(outcome.action).toBe("name_capture");
    if (outcome.action === "name_capture") {
      expect(outcome.fromNumber).toBe(FROM);
    }
  });

  test("an active voice invite takes precedence for a caller with no deny ruling", () => {
    activeVoiceInvites = [
      { friendName: "Alice", guardianName: "Sam", expiresAt: null },
    ];

    expect(routeInbound().outcome.action).toBe("invite_redemption");
  });

  test("a blocked caller is still denied", () => {
    actorTrust = makeTrust("unknown", { status: "blocked", policy: "allow" });

    expect(routeInbound().outcome.action).toBe("deny");
  });

  test("a known-but-unverified caller with no deny ruling gets verification guidance", () => {
    actorTrust = makeTrust("unknown", {
      status: "unverified",
      policy: "allow",
    });

    expect(routeInbound().outcome.action).toBe("unverified_caller");
  });

  test("a trusted contact with an allow policy connects normally", () => {
    actorTrust = makeTrust("trusted_contact", {
      status: "active",
      policy: "allow",
    });

    const { outcome } = routeInbound();
    expect(outcome.action).toBe("normal_call");
  });
});
