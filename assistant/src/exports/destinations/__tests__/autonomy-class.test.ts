/**
 * The safety test for export destinations.
 *
 * Sending a document to Slack, Drive, HubSpot or Notion is outbound egress —
 * the class that put a partner email in front of a real recipient with no
 * approval in July. The guarantee that it cannot happen again rests entirely
 * on `classifyAutonomy` reading the tool name as `send`, because that is what
 * routes the call through the human checkpoint, parks it in unattended runs,
 * and excludes it from timed approval grants.
 *
 * That guarantee is name-shaped and therefore fragile: a rename to
 * `document_deliver` or `document_push` would classify as `other` and lose it
 * with no other symptom. This test is the thing that notices.
 */

import { describe, expect, it } from "bun:test";

import { classifyAutonomy } from "../../../permissions/autonomy-class.js";
import { requiresHumanApprovalForAction } from "../../../tools/outbound-send.js";
import { listDestinations } from "../registry.js";

/** The tool name that ships. Changing it here must be a deliberate act. */
const TOOL_NAME = "document_send";

describe("export destination autonomy classification", () => {
  it("classifies the destination send tool as `send`", () => {
    expect(classifyAutonomy(TOOL_NAME)).toBe("send");
  });

  it("routes the destination send tool through human approval", () => {
    expect(
      requiresHumanApprovalForAction(TOOL_NAME, {
        destination: "slack",
        surface_id: "doc_1",
      }),
    ).toBe(true);
  });

  it("stays `send` for every destination, regardless of input", () => {
    for (const destination of listDestinations()) {
      expect(classifyAutonomy(TOOL_NAME, { destination: destination.id })).toBe(
        "send",
      );
    }
  });

  it("would NOT be gated under a name without a send verb", () => {
    // Documents the failure mode this test exists to prevent: these are the
    // names a well-meaning rename reaches for, and each one silently drops
    // the approval guarantee.
    for (const unsafe of [
      "document_deliver",
      "document_push",
      "document_to_destination",
    ]) {
      expect(classifyAutonomy(unsafe)).not.toBe("send");
      expect(requiresHumanApprovalForAction(unsafe, {})).toBe(false);
    }
  });

  it("gates the underlying Composio actions by slug too", () => {
    // Defence in depth: even if the tool were invoked through the generic
    // Composio execute path, the action slugs the destinations use carry the
    // outbound classification themselves.
    expect(
      requiresHumanApprovalForAction("COMPOSIO_EXECUTE_TOOL", {
        tool_slug: "SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL",
      }),
    ).toBe(true);
  });
});
