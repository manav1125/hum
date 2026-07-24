import { describe, expect, test } from "bun:test";

import { isOutboundExternalSendTool } from "../outbound-send.js";

/**
 * The predicate is the security boundary that stopped a background run from
 * emailing an external partner with no approval. It must catch every outbound
 * send path (native + connector) and must NOT catch drafting or internal
 * self-maintenance — otherwise it either lets a rogue send through or parks
 * harmless internal work.
 */
describe("isOutboundExternalSendTool", () => {
  const yes = (name: string, input: Record<string, unknown> = {}) =>
    expect(isOutboundExternalSendTool(name, input)).toBe(true);
  const no = (name: string, input: Record<string, unknown> = {}) =>
    expect(isOutboundExternalSendTool(name, input)).toBe(false);

  test("catches connector + native outbound sends", () => {
    // The exact tool that sent the rogue email.
    yes("gmail__GMAIL_SEND_EMAIL");
    yes("mcp__composio__GMAIL_SEND_EMAIL");
    yes("messaging_send"); // native egress (name-last verb)
    yes("outlook__SEND_MAIL");
    yes("slack__CHAT_POST_MESSAGE"); // post_ send verb
    yes("twilio__SEND_SMS");
  });

  test("catches real-time call initiation (contact)", () => {
    yes("call_start");
    yes("phone__DIAL_OUTBOUND");
  });

  test("does NOT catch drafting — background runs may prepare, not send", () => {
    no("gmail__GMAIL_CREATE_EMAIL_DRAFT");
    no("messaging_draft");
    no("create_draft");
  });

  test("does NOT catch reads / lookups on message objects", () => {
    no("gmail__GMAIL_FETCH_EMAILS");
    no("messaging_read");
    no("messaging_search");
    no("list_email_templates");
    no("get_message_metadata");
  });

  test("does NOT catch internal self-maintenance (safe under guardian trust)", () => {
    no("remember");
    no("file_write");
    no("file_edit");
    no("bash");
    no("host_bash");
    no("skill_load");
  });
});
