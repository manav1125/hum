import { describe, it, expect } from "bun:test";
import {
  evaluateSenderAuthentication,
  normalizeEmailWebhook,
} from "./normalize.js";

describe("normalizeEmailWebhook", () => {
  function makePayload(overrides?: Record<string, unknown>) {
    return {
      from: "alice@example.com",
      to: "bot@vellum.me",
      messageId: "<msg-1@example.com>",
      conversationId: "conv-1",
      subject: "Test Subject",
      strippedText: "Hello, world!",
      bodyText: "On Mon, someone wrote:\n> old\n\nHello, world!",
      timestamp: "2026-04-03T01:00:00.000Z",
      ...(overrides ?? {}),
    };
  }

  it("normalizes a valid email payload", () => {
    const result = normalizeEmailWebhook(makePayload());
    expect(result).not.toBeNull();
    expect(result!.eventId).toBe("<msg-1@example.com>");
    expect(result!.recipientAddress).toBe("bot@vellum.me");
    expect(result!.event.sourceChannel).toBe("email");
    expect(result!.event.message.content).toBe("Hello, world!");
    expect(result!.event.message.conversationExternalId).toBe("conv-1");
    expect(result!.event.message.externalMessageId).toBe("<msg-1@example.com>");
    expect(result!.event.actor.actorExternalId).toBe("alice@example.com");
    expect(result!.event.actor.displayName).toBe("alice@example.com");
  });

  it("returns null when required fields are missing", () => {
    // Missing 'from'
    expect(
      normalizeEmailWebhook({
        to: "bot@vellum.me",
        messageId: "m",
        conversationId: "c",
      }),
    ).toBeNull();
    // Missing 'to'
    expect(
      normalizeEmailWebhook({
        from: "a@b.com",
        messageId: "m",
        conversationId: "c",
      }),
    ).toBeNull();
    // Missing 'messageId'
    expect(
      normalizeEmailWebhook({
        from: "a@b.com",
        to: "bot@vellum.me",
        conversationId: "c",
      }),
    ).toBeNull();
    // Missing 'conversationId'
    expect(
      normalizeEmailWebhook({
        from: "a@b.com",
        to: "bot@vellum.me",
        messageId: "m",
      }),
    ).toBeNull();
  });

  it("returns null for empty object", () => {
    expect(normalizeEmailWebhook({})).toBeNull();
  });

  it("uses fromName as displayName when provided", () => {
    const result = normalizeEmailWebhook(
      makePayload({ fromName: "Alice Smith" }),
    );
    expect(result).not.toBeNull();
    expect(result!.event.actor.actorExternalId).toBe("alice@example.com");
    expect(result!.event.actor.displayName).toBe("Alice Smith");
  });

  it("falls back to email as displayName when fromName is absent", () => {
    const result = normalizeEmailWebhook(makePayload());
    expect(result!.event.actor.displayName).toBe("alice@example.com");
  });

  it("prefers strippedText over bodyText", () => {
    const result = normalizeEmailWebhook(
      makePayload({
        strippedText: "Just the new reply",
        bodyText: "Full email with quoted content",
      }),
    );
    expect(result!.event.message.content).toBe("Just the new reply");
  });

  it("falls back to bodyText when strippedText is missing", () => {
    const payload = makePayload();
    delete (payload as Record<string, unknown>).strippedText;
    const result = normalizeEmailWebhook(payload);
    expect(result!.event.message.content).toBe(
      "On Mon, someone wrote:\n> old\n\nHello, world!",
    );
  });

  it("uses empty string when both strippedText and bodyText are missing", () => {
    const payload = makePayload();
    delete (payload as Record<string, unknown>).strippedText;
    delete (payload as Record<string, unknown>).bodyText;
    const result = normalizeEmailWebhook(payload);
    expect(result!.event.message.content).toBe("");
  });

  it("uses messageId as eventId", () => {
    const result = normalizeEmailWebhook(
      makePayload({ messageId: "<unique@example.com>" }),
    );
    expect(result!.eventId).toBe("<unique@example.com>");
  });

  it("sets username to sender email", () => {
    const result = normalizeEmailWebhook(makePayload());
    expect(result!.event.actor.username).toBe("alice@example.com");
  });

  it("preserves raw payload in event.raw", () => {
    const payload = makePayload();
    const result = normalizeEmailWebhook(payload);
    expect(result!.event.raw).toEqual(payload);
  });

  it("carries senderAuthenticated=true onto the actor", () => {
    const result = normalizeEmailWebhook(
      makePayload({ senderAuthenticated: true }),
    );
    expect(result!.event.actor.senderAuthenticated).toBe(true);
  });

  it("carries senderAuthenticated=false onto the actor", () => {
    const result = normalizeEmailWebhook(
      makePayload({ senderAuthenticated: false }),
    );
    expect(result!.event.actor.senderAuthenticated).toBe(false);
  });

  it("omits senderAuthenticated when the payload has no verdict", () => {
    const result = normalizeEmailWebhook(makePayload());
    expect("senderAuthenticated" in result!.event.actor).toBe(false);
  });

  it("ignores a non-boolean senderAuthenticated (treated as no signal)", () => {
    const result = normalizeEmailWebhook(
      makePayload({ senderAuthenticated: "true" }),
    );
    expect("senderAuthenticated" in result!.event.actor).toBe(false);
  });

  it("omits attachments when the payload carries none", () => {
    const result = normalizeEmailWebhook(makePayload());
    expect(result!.attachments).toBeUndefined();
  });

  it("parses well-formed attachments", () => {
    const result = normalizeEmailWebhook(
      makePayload({
        attachments: [
          {
            filename: "receipt.pdf",
            contentType: "application/pdf",
            size: 12345,
            content: "YmFzZTY0",
            contentId: "img001@example.com",
          },
        ],
      }),
    );
    expect(result!.attachments).toEqual([
      {
        filename: "receipt.pdf",
        contentType: "application/pdf",
        size: 12345,
        content: "YmFzZTY0",
        contentId: "img001@example.com",
      },
    ]);
  });

  it("drops attachments missing required fields but keeps valid ones", () => {
    const result = normalizeEmailWebhook(
      makePayload({
        attachments: [
          { filename: "no-content.pdf", contentType: "application/pdf" },
          { contentType: "application/pdf", content: "YmFzZTY0" },
          {
            filename: "ok.pdf",
            contentType: "application/pdf",
            content: "YmE=",
          },
          "not-an-object",
        ],
      }),
    );
    expect(result!.attachments).toEqual([
      { filename: "ok.pdf", contentType: "application/pdf", content: "YmE=" },
    ]);
  });

  it("omits attachments when the field is not an array", () => {
    const result = normalizeEmailWebhook(makePayload({ attachments: "nope" }));
    expect(result!.attachments).toBeUndefined();
  });
});

describe("evaluateSenderAuthentication", () => {
  const fromEmail = "alice@example.com";

  it("returns undefined when no Authentication-Results header is present", () => {
    expect(
      evaluateSenderAuthentication({ authResults: undefined, fromEmail }),
    ).toBeUndefined();
    expect(
      evaluateSenderAuthentication({ authResults: null, fromEmail }),
    ).toBeUndefined();
    expect(
      evaluateSenderAuthentication({ authResults: "", fromEmail }),
    ).toBeUndefined();
  });

  it("returns true when DMARC passes", () => {
    expect(
      evaluateSenderAuthentication({
        authResults: "mx.example.com; spf=pass; dkim=pass; dmarc=pass",
        fromEmail,
      }),
    ).toBe(true);
  });

  it("returns false on a present non-pass DMARC verdict even with an aligned DKIM pass", () => {
    // The DMARC verdict is authoritative — an aligned DKIM pass must NOT
    // override a receiver-reported dmarc=fail.
    for (const verdict of ["fail", "temperror", "permerror"]) {
      expect(
        evaluateSenderAuthentication({
          authResults: `mx.example.com; dkim=pass header.d=example.com; dmarc=${verdict}`,
          fromEmail,
        }),
      ).toBe(false);
    }
  });

  it("falls back to aligned DKIM when DMARC is none", () => {
    expect(
      evaluateSenderAuthentication({
        authResults:
          "mx.example.com; dkim=pass header.d=example.com; dmarc=none",
        fromEmail,
      }),
    ).toBe(true);
  });

  it("falls back to aligned DKIM when there is no DMARC verdict", () => {
    expect(
      evaluateSenderAuthentication({
        authResults: "mx.example.com; spf=pass; dkim=pass header.d=example.com",
        fromEmail,
      }),
    ).toBe(true);
  });

  it("accepts an organizational-domain (subdomain) aligned DKIM pass", () => {
    expect(
      evaluateSenderAuthentication({
        authResults: "mx; dkim=pass header.d=mail.example.com; dmarc=none",
        fromEmail,
      }),
    ).toBe(true);
  });

  it("returns false when the only DKIM pass is for an unaligned domain", () => {
    expect(
      evaluateSenderAuthentication({
        authResults: "mx; dkim=pass header.d=evil.com; dmarc=none",
        fromEmail,
      }),
    ).toBe(false);
  });

  it("does not let a DKIM pass in one method chunk authenticate an unaligned domain in another", () => {
    // dkim=pass belongs to evil.com's chunk; the aligned example.com token
    // sits in a separate (non-pass) chunk and must not be borrowed.
    expect(
      evaluateSenderAuthentication({
        authResults:
          "mx; dkim=fail header.d=example.com; dkim=pass header.d=evil.com; dmarc=none",
        fromEmail,
      }),
    ).toBe(false);
  });

  it("returns false when DKIM fails and there is no DMARC verdict", () => {
    expect(
      evaluateSenderAuthentication({
        authResults: "mx; spf=pass; dkim=fail header.d=example.com",
        fromEmail,
      }),
    ).toBe(false);
  });

  it("is case-insensitive on the verdict tokens", () => {
    expect(
      evaluateSenderAuthentication({
        authResults: "MX; DMARC=PASS",
        fromEmail,
      }),
    ).toBe(true);
  });
});
