import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  truncateForLog: (value: string) => value,
}));

import { upsertContact } from "../../contacts/contact-store.js";
import { getDb, getSqliteFrom } from "../../memory/db-connection.js";
import { initializeDb } from "../../memory/db-init.js";
import {
  generatePeerToken,
  getPeerTokenForSender,
  parseBearer,
  storePeerToken,
  verifyPeerToken,
} from "../peer-auth.js";

initializeDb();

/** Create a trusted a2a contact and store a peer token for it. */
function seedPeer(address: string, token: string): void {
  const contact = upsertContact({
    displayName: `Peer ${address}`,
    contactType: "assistant",
    role: "contact",
    channels: [
      {
        type: "a2a",
        address: address.toLowerCase(),
        externalUserId: address,
        status: "active",
        policy: "allow",
      },
    ],
  });
  storePeerToken({
    contactId: contact.id,
    assistantId: address,
    gatewayUrl: "https://peer.example.com",
    peerToken: token,
  });
}

describe("a2a peer-auth", () => {
  beforeEach(() => {
    const raw = getSqliteFrom(getDb());
    raw.run("DELETE FROM assistant_contact_metadata");
    raw.run("DELETE FROM contact_channels");
    raw.run("DELETE FROM contacts");
  });

  test("generatePeerToken produces high-entropy unique tokens", () => {
    const a = generatePeerToken();
    const b = generatePeerToken();
    expect(a).not.toBe(b);
    // 32 bytes base64url ≈ 43 chars
    expect(a.length).toBeGreaterThanOrEqual(43);
  });

  test("verifyPeerToken accepts a matching token", () => {
    const token = generatePeerToken();
    seedPeer("assistant-a", token);

    const result = verifyPeerToken({
      senderAssistantId: "assistant-a",
      presentedToken: token,
    });
    expect(result.ok).toBe(true);
  });

  test("verifyPeerToken rejects a mismatched token", () => {
    seedPeer("assistant-a", generatePeerToken());

    const result = verifyPeerToken({
      senderAssistantId: "assistant-a",
      presentedToken: "wrong-token",
    });
    expect(result).toEqual({ ok: false, reason: "token_mismatch" });
  });

  test("verifyPeerToken rejects when no token is presented", () => {
    seedPeer("assistant-a", generatePeerToken());

    expect(
      verifyPeerToken({
        senderAssistantId: "assistant-a",
        presentedToken: null,
      }),
    ).toEqual({ ok: false, reason: "missing_token" });
    expect(
      verifyPeerToken({
        senderAssistantId: "assistant-a",
        presentedToken: "  ",
      }),
    ).toEqual({ ok: false, reason: "missing_token" });
  });

  test("verifyPeerToken rejects an unknown / untokened sender", () => {
    // Contact exists but has no stored token → unknown_sender.
    upsertContact({
      displayName: "No Token",
      contactType: "assistant",
      role: "contact",
      channels: [
        {
          type: "a2a",
          address: "assistant-b",
          externalUserId: "assistant-b",
          status: "active",
          policy: "allow",
        },
      ],
    });

    expect(
      verifyPeerToken({
        senderAssistantId: "assistant-b",
        presentedToken: "anything",
      }),
    ).toEqual({ ok: false, reason: "unknown_sender" });

    // Sender with no contact at all → unknown_sender too.
    expect(
      verifyPeerToken({
        senderAssistantId: "ghost",
        presentedToken: "anything",
      }),
    ).toEqual({ ok: false, reason: "unknown_sender" });
  });

  test("getPeerTokenForSender round-trips the stored token", () => {
    const token = generatePeerToken();
    seedPeer("assistant-c", token);
    expect(getPeerTokenForSender("assistant-c")).toBe(token);
    expect(getPeerTokenForSender("nope")).toBeNull();
  });

  test("parseBearer extracts the token from an Authorization header", () => {
    expect(parseBearer("Bearer abc123")).toBe("abc123");
    expect(parseBearer("bearer abc123")).toBe("abc123");
    expect(parseBearer("Basic xyz")).toBeNull();
    expect(parseBearer(null)).toBeNull();
  });
});
