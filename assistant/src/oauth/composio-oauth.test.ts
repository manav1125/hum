/**
 * Unit tests for the Composio proxy request encoding (`buildProxyArgs`).
 *
 * These guard the two bugs that were found against the live proxy:
 *  1. Query spaces must be "%20" (encodeURIComponent), not "+".
 *  2. Header params must use the field name `type` (not `in`), and the
 *     Authorization header must be stripped.
 */

import { describe, expect, it } from "bun:test";

import { buildProxyArgs } from "./composio-oauth.js";

describe("buildProxyArgs", () => {
  it("joins base + path with no query", () => {
    const { endpoint, params } = buildProxyArgs({
      method: "GET",
      baseUrl: "https://gmail.googleapis.com",
      path: "/gmail/v1/users/me/profile",
    });
    expect(endpoint).toBe(
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    );
    expect(params).toEqual([]);
  });

  it("strips a trailing slash from baseUrl", () => {
    const { endpoint } = buildProxyArgs({
      method: "GET",
      baseUrl: "https://gmail.googleapis.com/",
      path: "/x",
    });
    expect(endpoint).toBe("https://gmail.googleapis.com/x");
  });

  it("encodes query spaces as %20, not + (proxy mangles +)", () => {
    const { endpoint } = buildProxyArgs({
      method: "GET",
      baseUrl: "https://gmail.googleapis.com",
      path: "/gmail/v1/users/me/messages",
      query: { q: "is:unread in:inbox", maxResults: "15" },
    });
    expect(endpoint).toContain("q=is%3Aunread%20in%3Ainbox");
    expect(endpoint).toContain("maxResults=15");
    expect(endpoint).not.toContain("+");
  });

  it("expands array query values into repeated params", () => {
    const { endpoint } = buildProxyArgs({
      method: "GET",
      baseUrl: "https://gmail.googleapis.com",
      path: "/gmail/v1/users/me/messages/123",
      query: {
        format: "metadata",
        metadataHeaders: ["From", "Subject"],
      },
    });
    expect(endpoint).toContain("format=metadata");
    expect(endpoint).toContain("metadataHeaders=From");
    expect(endpoint).toContain("metadataHeaders=Subject");
  });

  it("maps headers to {name,value,type:'header'} and drops Authorization", () => {
    const { params } = buildProxyArgs({
      method: "POST",
      baseUrl: "https://gmail.googleapis.com",
      path: "/gmail/v1/users/me/labels",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer leaked-token",
      },
    });
    expect(params).toContainEqual({
      name: "Content-Type",
      value: "application/json",
      type: "header",
    });
    expect(params.some((p) => p.name.toLowerCase() === "authorization")).toBe(
      false,
    );
  });
});
