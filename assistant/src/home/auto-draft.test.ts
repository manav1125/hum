/**
 * Unit tests for the pure auto-draft helpers: address parsing, base64url
 * encoding, RFC-2047 header encoding, and reply MIME construction
 * (threading + subject normalization).
 */

import { describe, expect, it } from "bun:test";

import {
  bareAddress,
  base64UrlEncode,
  buildReplyMime,
  encodeHeader,
  extractPlainTextBody,
  type GmailPayload,
  type MessageHeaders,
} from "./auto-draft.js";

const b64url = (s: string): string =>
  Buffer.from(s, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

describe("bareAddress", () => {
  it("extracts the address from a display-name header", () => {
    expect(bareAddress("Jane Doe <jane@example.com>")).toBe("jane@example.com");
  });
  it("passes a bare address through, trimmed", () => {
    expect(bareAddress("  jane@example.com ")).toBe("jane@example.com");
  });
});

describe("base64UrlEncode", () => {
  it("produces URL-safe base64 with no padding", () => {
    const out = base64UrlEncode("subjects??>>"); // forces +/ in std base64
    expect(out).not.toContain("+");
    expect(out).not.toContain("/");
    expect(out).not.toContain("=");
  });
  it("round-trips back to the original string", () => {
    const original = "Hello, 🌷 world — reply body\r\nLine 2";
    const decoded = Buffer.from(
      base64UrlEncode(original).replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf-8");
    expect(decoded).toBe(original);
  });
});

describe("encodeHeader", () => {
  it("passes ASCII through unchanged", () => {
    expect(encodeHeader("Re: Hello there")).toBe("Re: Hello there");
  });
  it("RFC-2047 encodes non-ASCII", () => {
    const out = encodeHeader("Re: 🌷 bulbs");
    expect(out.startsWith("=?UTF-8?B?")).toBe(true);
    expect(out.endsWith("?=")).toBe(true);
  });
});

describe("buildReplyMime", () => {
  const headers: MessageHeaders = {
    from: "Jane Doe <jane@example.com>",
    to: "me@example.com",
    subject: "Project update",
    messageId: "<abc@mail.example.com>",
    references: "<root@mail.example.com>",
  };

  it("addresses the reply to the original sender", () => {
    const { to } = buildReplyMime(headers, "Thanks!");
    expect(to).toBe("jane@example.com");
  });

  it("prefixes the subject with a single Re:", () => {
    expect(buildReplyMime(headers, "x").subject).toBe("Re: Project update");
    expect(
      buildReplyMime({ ...headers, subject: "Re: Project update" }, "x")
        .subject,
    ).toBe("Re: Project update");
    expect(
      buildReplyMime({ ...headers, subject: "RE: re: Deep thread" }, "x")
        .subject,
    ).toBe("Re: Deep thread");
  });

  it("threads with In-Reply-To and accumulated References", () => {
    const { mime } = buildReplyMime(headers, "body");
    expect(mime).toContain("In-Reply-To: <abc@mail.example.com>");
    expect(mime).toContain(
      "References: <root@mail.example.com> <abc@mail.example.com>",
    );
  });

  it("uses CRLF line endings and a blank line before the body", () => {
    const { mime } = buildReplyMime(headers, "the body");
    expect(mime).toContain("\r\n\r\nthe body");
    expect(mime).toContain('Content-Type: text/plain; charset="UTF-8"');
  });

  it("omits threading headers when the original had none", () => {
    const { mime } = buildReplyMime(
      { ...headers, messageId: "", references: "" },
      "body",
    );
    expect(mime).not.toContain("In-Reply-To:");
    expect(mime).not.toContain("References:");
  });
});

describe("extractPlainTextBody", () => {
  it("returns '' for an undefined payload", () => {
    expect(extractPlainTextBody(undefined)).toBe("");
  });

  it("decodes a non-multipart text/plain body", () => {
    const payload: GmailPayload = {
      mimeType: "text/plain",
      body: { data: b64url("Hello there.\nRegards") },
    };
    expect(extractPlainTextBody(payload)).toBe("Hello there.\nRegards");
  });

  it("prefers text/plain over text/html in a multipart message", () => {
    const payload: GmailPayload = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: b64url("plain wins") } },
        { mimeType: "text/html", body: { data: b64url("<p>html</p>") } },
      ],
    };
    expect(extractPlainTextBody(payload)).toBe("plain wins");
  });

  it("falls back to stripped text/html when no text/plain exists", () => {
    const payload: GmailPayload = {
      mimeType: "multipart/alternative",
      parts: [
        {
          mimeType: "text/html",
          body: {
            data: b64url(
              "<style>x{}</style><p>Hi&nbsp;<b>Jane</b></p><script>1</script>",
            ),
          },
        },
      ],
    };
    expect(extractPlainTextBody(payload)).toBe("Hi Jane");
  });

  it("recurses into nested multipart parts", () => {
    const payload: GmailPayload = {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/plain", body: { data: b64url("nested body") } },
          ],
        },
        { mimeType: "application/pdf", body: { data: b64url("PDFDATA") } },
      ],
    };
    expect(extractPlainTextBody(payload)).toBe("nested body");
  });
});
