import { describe, expect, it } from "vitest";

import { deriveActionSummary } from "./action-summary";

describe("deriveActionSummary", () => {
  it("summarizes a Composio COMPOSIO_EXECUTE_TOOL Gmail send", () => {
    expect(
      deriveActionSummary("mcp__composio__COMPOSIO_EXECUTE_TOOL", {
        tool_slug: "GMAIL_SEND_EMAIL",
        arguments: {
          recipient_email: "cindy@partner.com",
          subject: "Partnership follow-up",
        },
      }),
    ).toBe(
      "Send an email to cindy@partner.com via Gmail — “Partnership follow-up”",
    );
  });

  it("summarizes the MULTI_EXECUTE array form", () => {
    expect(
      deriveActionSummary("mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL", {
        arguments: [
          {
            tool_slug: "GMAIL_SEND_EMAIL",
            arguments: { recipient_email: "a@b.com" },
          },
        ],
      }),
    ).toBe("Send an email to a@b.com via Gmail");
  });

  it("summarizes a direct connector send tool by name", () => {
    expect(
      deriveActionSummary("gmail__GMAIL_SEND_EMAIL", {
        recipient_email: "x@y.com",
        subject: "Hi",
      }),
    ).toBe("Send an email to x@y.com via Gmail — “Hi”");
  });

  it("humanizes money / publish / delete / message actions", () => {
    expect(
      deriveActionSummary("mcp__composio__COMPOSIO_EXECUTE_TOOL", {
        tool_slug: "STRIPE_CREATE_CHARGE",
      }),
    ).toBe("Move money via Stripe");
    expect(
      deriveActionSummary("mcp__composio__COMPOSIO_EXECUTE_TOOL", {
        tool_slug: "WORDPRESS_PUBLISH_POST",
      }),
    ).toBe("Publish via Wordpress");
    expect(
      deriveActionSummary("mcp__composio__COMPOSIO_EXECUTE_TOOL", {
        tool_slug: "SLACK_CHAT_POST_MESSAGE",
        arguments: { channel: "#general" },
      }),
    ).toBe("Send a message to #general via Slack");
  });

  it("returns undefined when there is nothing to summarize", () => {
    expect(deriveActionSummary(undefined, undefined)).toBeUndefined();
  });
});
