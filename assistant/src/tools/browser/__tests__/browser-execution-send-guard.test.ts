/**
 * Wiring test for the execution-layer send guard in browser-execution.ts.
 *
 * The predicates are unit-tested in send-control-guard.test.ts; this file
 * proves the CDP round-trip is actually made and its answer honoured — that a
 * click on an opaque `element_id` which resolves to a Send button never reaches
 * `Input.dispatchMouseEvent`, and that an ordinary button still does.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { createMockLoggerModule } from "../../../__tests__/helpers/mock-logger.js";
import type { ToolContext } from "../../types.js";

// ── Fake CDP client ───────────────────────────────────────────────────

interface FakeNode {
  /** Value returned by the page-side describe function. */
  describe: Record<string, unknown> | null;
}

/** backendNodeId -> node. */
const nodes = new Map<number, FakeNode>();
let pageUrl = "https://mail.example.com/mail/u/0/";
let sentMethods: string[] = [];

const fakeCdp = {
  kind: "local" as const,
  send: async (method: string, params?: Record<string, unknown>) => {
    sentMethods.push(method);
    switch (method) {
      case "DOM.resolveNode":
        return {
          object: { objectId: `obj-${params?.backendNodeId as number}` },
        };
      case "Runtime.callFunctionOn": {
        const id = Number(String(params?.objectId).replace("obj-", ""));
        return { result: { value: nodes.get(id)?.describe ?? null } };
      }
      case "DOM.getBoxModel":
        return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } };
      case "Runtime.evaluate": {
        const expr = String(params?.expression ?? "");
        if (expr.includes("document.location.href")) {
          return { result: { value: pageUrl } };
        }
        // describeFocusedControl
        return { result: { value: nodes.get(-1)?.describe ?? null } };
      }
      default:
        return {};
    }
  },
  dispose: () => {},
};

mock.module("../cdp-client/factory.js", () => ({
  getCdpClient: () => fakeCdp,
  buildCandidateList: mock(() => []),
  isDesktopAutoCooldownActive: () => false,
}));

mock.module("../../../util/logger.js", () => createMockLoggerModule());

// The real browser manager is used (mocking it globally would leak into every
// other test file in the run); only its snapshot map is seeded below.
const { browserManager } = await import("../browser-manager.js");
const { executeBrowserClick, executeBrowserPressKey } =
  await import("../browser-execution.js");

const CONVERSATION_ID = "conv-send-guard";

// ── Helpers ───────────────────────────────────────────────────────────

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    conversationId: CONVERSATION_ID,
    workingDir: "/tmp",
    trustClass: "guardian",
    isInteractive: true,
    ...overrides,
  } as unknown as ToolContext;
}

/** Register a fake element under `eN` and describe it as `describe`. */
function seedElement(
  eid: string,
  backendNodeId: number,
  describe: Record<string, unknown> | null,
) {
  nodes.set(backendNodeId, { describe });
  browserManager.storeSnapshotBackendNodeMap(
    CONVERSATION_ID,
    new Map([[eid, backendNodeId]]),
  );
}

const SEND_BUTTON = {
  tag: "div",
  labels: ["Send ‪(Ctrl-Enter)‬"],
  text: "Send",
  isControl: true,
  isTextEntry: false,
  isMultiline: false,
  isSearch: false,
  isDisabled: false,
};

const ARCHIVE_BUTTON = {
  tag: "button",
  labels: ["Archive"],
  text: "Archive",
  isControl: true,
  isTextEntry: false,
  isMultiline: false,
  isSearch: false,
  isDisabled: false,
};

const COMPOSE_BODY = {
  tag: "div",
  labels: ["Message Body"],
  text: "",
  isControl: false,
  isTextEntry: true,
  isMultiline: true,
  isSearch: false,
  isDisabled: false,
};

beforeEach(() => {
  nodes.clear();
  browserManager.clearSnapshotBackendNodeMap(CONVERSATION_ID);
  sentMethods = [];
  pageUrl = "https://mail.example.com/mail/u/0/";
});

function clicked() {
  return sentMethods.includes("Input.dispatchMouseEvent");
}
function keyed() {
  return sentMethods.includes("Input.dispatchKeyEvent");
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("executeBrowserClick send guard", () => {
  test("an opaque element_id that resolves to Send is never dispatched", async () => {
    seedElement("e14", 14, SEND_BUTTON);

    const result = await executeBrowserClick({ element_id: "e14" }, ctx());

    expect(clicked()).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Send");
    expect(result.content).toContain("label:");
  });

  test("the same click goes through once the approval gate has seen it", async () => {
    seedElement("e14", 14, SEND_BUTTON);

    const result = await executeBrowserClick(
      { element_id: "e14", label: "Send" },
      ctx(),
    );

    expect(clicked()).toBe(true);
    expect(result.isError).toBe(false);
  });

  test("an ordinary button is clicked with no interference", async () => {
    seedElement("e3", 3, ARCHIVE_BUTTON);

    const result = await executeBrowserClick({ element_id: "e3" }, ctx());

    expect(clicked()).toBe(true);
    expect(result.isError).toBe(false);
  });

  test("an undescribable element fails open rather than blocking", async () => {
    seedElement("e9", 9, null);

    const result = await executeBrowserClick({ element_id: "e9" }, ctx());

    expect(clicked()).toBe(true);
    expect(result.isError).toBe(false);
  });

  test("an unattended run parks instead of clicking Send", async () => {
    seedElement("e14", 14, SEND_BUTTON);

    const result = await executeBrowserClick(
      { element_id: "e14" },
      ctx({ isInteractive: false }),
    );

    expect(clicked()).toBe(false);
    expect(result.content).toContain("Parked");
  });
});

describe("executeBrowserPressKey send guard", () => {
  test("⌘+Enter in a compose body is not dispatched", async () => {
    nodes.set(-1, { describe: COMPOSE_BODY });

    const result = await executeBrowserPressKey({ key: "cmd+enter" }, ctx());

    expect(keyed()).toBe(false);
    expect(result.isError).toBe(true);
  });

  test("bare Enter in a compose body on a newline host is dispatched", async () => {
    nodes.set(-1, { describe: COMPOSE_BODY });

    const result = await executeBrowserPressKey({ key: "Enter" }, ctx());

    expect(keyed()).toBe(true);
    expect(result.isError).toBe(false);
  });

  test("bare Enter in a composer on an Enter-sends host is blocked", async () => {
    pageUrl = "https://app.slack.com/client/T1/C1";
    nodes.set(-1, { describe: COMPOSE_BODY });

    const result = await executeBrowserPressKey({ key: "Enter" }, ctx());

    expect(keyed()).toBe(false);
    expect(result.content).toContain("label:");
  });

  test("non-enter keys never cost a describe round-trip", async () => {
    nodes.set(-1, { describe: COMPOSE_BODY });

    await executeBrowserPressKey({ key: "Escape" }, ctx());

    expect(keyed()).toBe(true);
    expect(sentMethods).not.toContain("Runtime.evaluate");
  });
});
