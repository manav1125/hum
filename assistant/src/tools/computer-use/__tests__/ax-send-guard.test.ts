import { beforeEach, describe, expect, test } from "bun:test";

import type { ToolContext } from "../../types.js";
import {
  axElementToControl,
  clearAxSnapshot,
  evaluateComputerUseSendGate,
  parseAxSnapshot,
  recordAxSnapshot,
  resolveCuFocus,
  resolveCuTarget,
  runGuardedComputerUseTool,
} from "../ax-send-guard.js";

/** A response shaped exactly like `HostCuProxy.formatObservation` produces. */
const MAIL_SNAPSHOT = `Action executed

<ax-tree>
CURRENT SCREEN STATE:
Window: "New Message" (Mail)
Interactive elements:
  [1] button "Close" at (20, 40)
  [7] text field "To:" at (300, 90) value: "partner@example.com"
  [9] text area at (300, 300) FOCUSED value: "Hi there,"
  [12] button "Send" at (431, 56)
  [15] button "Attach" at (470, 56) disabled
  [18] text field "Search" at (900, 20) placeholder: "Search mailbox"

Visible text:
  Draft saved
</ax-tree>`;

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    conversationId: "conv-cu",
    workingDir: "/tmp",
    trustClass: "guardian",
    isInteractive: true,
    ...overrides,
  } as ToolContext;
}

beforeEach(() => {
  clearAxSnapshot();
});

describe("parseAxSnapshot", () => {
  test("reads id, role, title, centre, focus and disabled state", () => {
    const els = parseAxSnapshot(MAIL_SNAPSHOT);
    expect(els).toHaveLength(6);

    const send = els.find((e) => e.id === 12)!;
    expect(send).toMatchObject({
      role: "button",
      title: "Send",
      x: 431,
      y: 56,
    });

    const body = els.find((e) => e.id === 9)!;
    expect(body).toMatchObject({ role: "text area", focused: true });
    expect(body.value).toBe("Hi there,");

    expect(els.find((e) => e.id === 15)!.disabled).toBe(true);
    expect(els.find((e) => e.id === 18)!.placeholder).toBe("Search mailbox");
  });

  test("ignores content outside the ax-tree block and unparsable lines", () => {
    expect(parseAxSnapshot("no tree here")).toEqual([]);
    expect(parseAxSnapshot("<ax-tree>\ngarbage\n</ax-tree>")).toEqual([]);
    expect(parseAxSnapshot("")).toEqual([]);
  });
});

describe("axElementToControl", () => {
  test("buttons are controls, text fields are text entries", () => {
    const els = parseAxSnapshot(MAIL_SNAPSHOT);
    const send = axElementToControl(els.find((e) => e.id === 12)!);
    expect(send.isControl).toBe(true);
    expect(send.labels).toContain("Send");

    const body = axElementToControl(els.find((e) => e.id === 9)!);
    expect(body.isTextEntry).toBe(true);
    expect(body.isMultiline).toBe(true);
    expect(body.isControl).toBe(false);

    const search = axElementToControl(els.find((e) => e.id === 18)!);
    expect(search.isSearch).toBe(true);
  });

  test("a text field's typed value is never treated as a label", () => {
    // "partner@example.com" is user content, not a control name — and neither
    // is a body that happens to contain the word "send".
    const to = axElementToControl(
      parseAxSnapshot(MAIL_SNAPSHOT).find((e) => e.id === 7)!,
    );
    expect(to.labels).not.toContain("partner@example.com");
  });
});

describe("resolveCuTarget", () => {
  beforeEach(() => recordAxSnapshot("conv-cu", MAIL_SNAPSHOT));

  test("matches an element_id exactly, as number or numeric string", () => {
    expect(resolveCuTarget("conv-cu", { element_id: 12 })?.title).toBe("Send");
    expect(resolveCuTarget("conv-cu", { element_id: "12" })?.title).toBe(
      "Send",
    );
    expect(resolveCuTarget("conv-cu", { element_id: 999 })).toBeNull();
  });

  test("matches a coordinate click at (or very near) the reported centre", () => {
    expect(resolveCuTarget("conv-cu", { x: 431, y: 56 })?.title).toBe("Send");
    expect(resolveCuTarget("conv-cu", { x: 436, y: 60 })?.title).toBe("Send");
  });

  test("a coordinate far from every control resolves to nothing", () => {
    expect(resolveCuTarget("conv-cu", { x: 431, y: 400 })).toBeNull();
    expect(resolveCuTarget("conv-cu", {})).toBeNull();
  });

  test("an unknown conversation has no snapshot", () => {
    expect(resolveCuTarget("other-conv", { element_id: 12 })).toBeNull();
  });

  test("focus is read from the snapshot", () => {
    expect(resolveCuFocus("conv-cu")?.id).toBe(9);
  });
});

describe("evaluateComputerUseSendGate", () => {
  beforeEach(() => recordAxSnapshot("conv-cu", MAIL_SNAPSHOT));

  test("blocks an opaque element_id click that resolves to Send", () => {
    const blocked = evaluateComputerUseSendGate(
      "computer_use_click",
      { element_id: 12, reasoning: "finish up" },
      ctx(),
    );
    expect(blocked?.isError).toBe(true);
    expect(blocked?.content).toContain('label: "Send"');
  });

  test("blocks a coordinate-only click that lands on Send", () => {
    const blocked = evaluateComputerUseSendGate(
      "computer_use_click",
      { x: 431, y: 56, reasoning: "finish up" },
      ctx(),
    );
    expect(blocked?.content).toContain("Send");
  });

  test("parks instead of blocking when the run is unattended", () => {
    const blocked = evaluateComputerUseSendGate(
      "computer_use_click",
      { x: 431, y: 56, reasoning: "finish up" },
      ctx({ isInteractive: false }),
    );
    expect(blocked?.content).toContain("Parked");
  });

  test("leaves ordinary clicks alone", () => {
    for (const input of [
      { element_id: 1 }, // Close
      { element_id: 7 }, // To: field
      { element_id: 18 }, // Search
      { x: 900, y: 20 }, // Search, by coordinate
      { x: 640, y: 480 }, // nothing there
    ]) {
      expect(
        evaluateComputerUseSendGate("computer_use_click", input, ctx()),
      ).toBeNull();
    }
  });

  test("a right-click opens a context menu, so it is never a send", () => {
    expect(
      evaluateComputerUseSendGate(
        "computer_use_right_click",
        { element_id: 12 },
        ctx(),
      ),
    ).toBeNull();
    expect(
      evaluateComputerUseSendGate(
        "computer_use_click",
        { element_id: 12, click_type: "right" },
        ctx(),
      ),
    ).toBeNull();
  });

  test("⌘+Enter with a compose field focused is a send", () => {
    const blocked = evaluateComputerUseSendGate(
      "computer_use_key",
      { key: "cmd+enter", reasoning: "send it" },
      ctx(),
    );
    expect(blocked?.isError).toBe(true);
  });

  test("other keys — including a bare Enter — stay free", () => {
    for (const key of ["enter", "tab", "escape", "cmd+c", "shift+enter"]) {
      expect(
        evaluateComputerUseSendGate("computer_use_key", { key }, ctx()),
      ).toBeNull();
    }
  });

  test("a labelled retry the pre-execution gate approved is allowed", () => {
    expect(
      evaluateComputerUseSendGate(
        "computer_use_click",
        { element_id: 12, label: "Send" },
        ctx(),
      ),
    ).toBeNull();
  });

  test("with no snapshot at all, nothing is gated", () => {
    clearAxSnapshot();
    expect(
      evaluateComputerUseSendGate(
        "computer_use_click",
        { element_id: 12 },
        ctx(),
      ),
    ).toBeNull();
  });
});

describe("runGuardedComputerUseTool", () => {
  test("caches the snapshot from a response so the next action is covered", async () => {
    let calls = 0;
    const invoke = async () => {
      calls++;
      return { content: MAIL_SNAPSHOT, isError: false };
    };

    // First call: no snapshot yet, so it forwards and learns the screen.
    const first = await runGuardedComputerUseTool(
      "computer_use_observe",
      {},
      ctx(),
      invoke,
    );
    expect(calls).toBe(1);
    expect(first.content).toBe(MAIL_SNAPSHOT);

    // Second call now resolves against what the first returned.
    const second = await runGuardedComputerUseTool(
      "computer_use_click",
      { element_id: 12 },
      ctx(),
      invoke,
    );
    expect(calls).toBe(1); // never forwarded
    expect(second.isError).toBe(true);
    expect(second.content).toContain("Send");
  });

  test("a non-send action still forwards", async () => {
    let calls = 0;
    await runGuardedComputerUseTool(
      "computer_use_observe",
      {},
      ctx(),
      async () => {
        calls++;
        return { content: MAIL_SNAPSHOT, isError: false };
      },
    );
    await runGuardedComputerUseTool(
      "computer_use_click",
      { element_id: 7 },
      ctx(),
      async () => {
        calls++;
        return { content: "ok", isError: false };
      },
    );
    expect(calls).toBe(2);
  });
});
