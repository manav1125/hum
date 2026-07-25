import { describe, expect, test } from "bun:test";

import {
  isOutboundExternalSendTool,
  requiresHumanApprovalForAction,
} from "../outbound-send.js";

/**
 * These predicates are the security boundary that stopped a background run from
 * emailing an external partner with no approval. They must catch every
 * outward-reaching / irreversible action (native + connector) and must NOT
 * catch drafting, reading, or internal self-maintenance — otherwise they either
 * let a rogue action through or park harmless internal work.
 */
describe("requiresHumanApprovalForAction (high-consequence gate)", () => {
  const yes = (name: string, input: Record<string, unknown> = {}) =>
    expect(requiresHumanApprovalForAction(name, input)).toBe(true);
  const no = (name: string, input: Record<string, unknown> = {}) =>
    expect(requiresHumanApprovalForAction(name, input)).toBe(false);

  test("catches outbound sends + calls", () => {
    yes("gmail__GMAIL_SEND_EMAIL"); // the exact rogue tool
    yes("mcp__composio__GMAIL_SEND_EMAIL");
    yes("messaging_send");
    yes("slack__CHAT_POST_MESSAGE");
    yes("call_start");
  });

  test("catches money / purchase / publish / delete (mostly connectors)", () => {
    yes("stripe__CREATE_CHARGE"); // money
    yes("coinbase__SEND_MONEY"); // money+send
    yes("amazon__PLACE_ORDER"); // purchase
    yes("shopify__CHECKOUT_CREATE"); // purchase
    yes("wordpress__PUBLISH_POST"); // publish
    yes("hubspot__DELETE_CONTACT"); // delete
    yes("delete_managed_skill"); // native delete
  });

  test("does NOT catch drafting / reading — background may prepare", () => {
    no("gmail__GMAIL_CREATE_EMAIL_DRAFT");
    no("messaging_draft");
    no("gmail__GMAIL_FETCH_EMAILS");
    no("messaging_read");
    no("hubspot__GET_CONTACT");
    no("list_email_templates");
  });

  test("catches actions smuggled through a Composio proxy/execute meta-tool", () => {
    // The EXACT path the rogue email actually took: a generic executor with the
    // real action as a `tool_slug` input, not the tool name.
    yes("COMPOSIO_EXECUTE_TOOL", { tool_slug: "GMAIL_SEND_EMAIL" });
    yes("mcp__composio__COMPOSIO_EXECUTE_TOOL", { tool_name: "GMAIL_SEND_EMAIL" });
    yes("COMPOSIO_MULTI_EXECUTE_TOOL", {
      arguments: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: {} }],
    });
    yes("COMPOSIO_MULTI_EXECUTE_TOOL", {
      tool_schemas: { STRIPE_CREATE_CHARGE: {} },
    });
    // A proxy pointed at a draft/read action must NOT park.
    no("COMPOSIO_EXECUTE_TOOL", { tool_slug: "GMAIL_CREATE_EMAIL_DRAFT" });
    no("COMPOSIO_EXECUTE_TOOL", { tool_slug: "GMAIL_FETCH_EMAILS" });
    // Bare proxy with no action yet (schema lookup) does not park.
    no("COMPOSIO_EXECUTE_TOOL", {});
  });

  test("does NOT catch internal infra plumbing (self-maintenance safe)", () => {
    no("bash");
    no("host_bash");
    no("file_write");
    no("file_edit");
    no("file_delete");
    // Classifier false-positive: host_file_transfer → "money" via "transfer";
    // it only moves files host↔sandbox and must never park.
    no("host_file_transfer");
    no("remember");
    no("skill_load");
    no("web_search");
  });
});

describe("isOutboundExternalSendTool (send subset)", () => {
  test("send/call only — not money/publish/delete", () => {
    expect(isOutboundExternalSendTool("gmail__GMAIL_SEND_EMAIL", {})).toBe(true);
    expect(isOutboundExternalSendTool("call_start", {})).toBe(true);
    expect(isOutboundExternalSendTool("stripe__CREATE_CHARGE", {})).toBe(false);
    expect(isOutboundExternalSendTool("gmail__GMAIL_CREATE_EMAIL_DRAFT", {})).toBe(
      false,
    );
    expect(isOutboundExternalSendTool("host_file_transfer", {})).toBe(false);
  });
});
