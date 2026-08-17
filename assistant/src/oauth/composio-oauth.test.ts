/**
 * Unit tests for the Composio proxy request encoding (`buildProxyArgs`).
 *
 * These guard the two bugs that were found against the live proxy:
 *  1. Query spaces must be "%20" (encodeURIComponent), not "+".
 *  2. Header params must use the field name `type` (not `in`), and the
 *     Authorization header must be stripped.
 */

import { describe, expect, it } from "bun:test";

import {
  buildProxyArgs,
  isComposioInfrastructureFault,
} from "./composio-oauth.js";

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

describe("buildProxyArgs — base URL fallback", () => {
  it("a caller that omits baseUrl gets the toolkit's host, not a bare path", () => {
    // The Gmail client asks for "/profile" and nothing else, because a native
    // connection supplies the host from its provider seed. Without the
    // fallback this produced the endpoint "/profile", which Composio resolved
    // against Google's web root — the live failure was an HTML 404 page.
    const { endpoint } = buildProxyArgs(
      { method: "GET", path: "/profile" },
      "https://gmail.googleapis.com/gmail/v1/users/me",
    );
    expect(endpoint).toBe(
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    );
  });

  it("an explicit baseUrl still wins over the fallback", () => {
    const { endpoint } = buildProxyArgs(
      {
        method: "GET",
        path: "/calendars/primary/events",
        baseUrl: "https://www.googleapis.com/calendar/v3",
      },
      "https://gmail.googleapis.com/gmail/v1/users/me",
    );
    expect(endpoint).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events",
    );
  });

  it("query encoding is unchanged by the fallback", () => {
    const { endpoint } = buildProxyArgs(
      { method: "GET", path: "/messages", query: { q: "is:unread in:inbox" } },
      "https://gmail.googleapis.com/gmail/v1/users/me",
    );
    // Spaces must be %20, never "+" — the proxy re-encodes "+" to "%2B".
    expect(endpoint).toContain("q=is%3Aunread%20in%3Ainbox");
  });

  it("no baseUrl and no fallback still degrades to the old behaviour", () => {
    const { endpoint } = buildProxyArgs({ method: "GET", path: "/x" });
    expect(endpoint).toBe("/x");
  });
});

describe("isComposioInfrastructureFault", () => {
  // The real message from Levi's instance. Recording this against the
  // connector put "Needs attention" on Gmail/Calendar/Airtable whose
  // Composio connections were all ACTIVE, and sent him round a reconnect
  // loop that could never have worked — reconnecting a Google account does
  // not grant Cue's API key a scope it was minted without.
  it("recognises the proxy-execute capability rejection", () => {
    expect(
      isComposioInfrastructureFault(
        'Composio proxy GET https://gmail.googleapis.com/gmail/v1/users/me/profile -> 403 {"error":{"message":"Proxy execute is not enabled for this API key. Create a new scoped API key with proxy execute functionality","code":403}}',
      ),
    ).toBe(true);
  });

  it("recognises other capability/plan rejections aimed at our key", () => {
    expect(
      isComposioInfrastructureFault(
        "This feature is not enabled for your organization",
      ),
    ).toBe(true);
    expect(
      isComposioInfrastructureFault(
        "The API key lacks the required capability",
      ),
    ).toBe(true);
  });

  // The other half matters just as much: a genuinely broken connection must
  // still mark the connector, or a user who really does need to reconnect
  // is never told.
  it("leaves real connection failures classified as the connection's", () => {
    for (const message of [
      "Composio proxy GET /x -> 401 invalid credentials",
      "No active connection found for gmail",
      "invalid_grant: Token has been expired or revoked",
      "Provider rejected the connection (HTTP 403) — reconnect to fix",
      "connection is expired",
    ]) {
      expect(isComposioInfrastructureFault(message)).toBe(false);
    }
  });
});
