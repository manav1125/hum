import { describe, expect, it } from "bun:test";

import { extractMailgunAuthResults } from "./mailgun-webhook.js";

describe("extractMailgunAuthResults", () => {
  it("returns undefined when message-headers is absent", () => {
    expect(extractMailgunAuthResults({})).toBeUndefined();
  });

  it("returns undefined when message-headers is not valid JSON", () => {
    expect(
      extractMailgunAuthResults({ "message-headers": "not json" }),
    ).toBeUndefined();
  });

  it("returns undefined when message-headers is not an array", () => {
    expect(
      extractMailgunAuthResults({ "message-headers": '{"a":1}' }),
    ).toBeUndefined();
  });

  it("extracts the Authentication-Results value (case-insensitive header name)", () => {
    const headers = JSON.stringify([
      ["Received", "from mx by example"],
      ["Authentication-Results", "mx.example.com; dmarc=pass"],
      ["Subject", "Hi"],
    ]);
    expect(extractMailgunAuthResults({ "message-headers": headers })).toBe(
      "mx.example.com; dmarc=pass",
    );
  });

  it("returns the FIRST Authentication-Results (receiver-stamped, not a forged duplicate lower in the message)", () => {
    const headers = JSON.stringify([
      ["authentication-results", "mx.example.com; dmarc=fail"],
      ["Authentication-Results", "forged; dmarc=pass"],
    ]);
    expect(extractMailgunAuthResults({ "message-headers": headers })).toBe(
      "mx.example.com; dmarc=fail",
    );
  });

  it("returns undefined when no Authentication-Results header is present", () => {
    const headers = JSON.stringify([["Received", "x"]]);
    expect(
      extractMailgunAuthResults({ "message-headers": headers }),
    ).toBeUndefined();
  });
});
