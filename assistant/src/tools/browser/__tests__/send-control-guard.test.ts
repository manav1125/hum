import { describe, expect, test } from "bun:test";

import type { ToolContext } from "../../types.js";
import {
  classifyKeySend,
  describeControl,
  gateResolvedSendControl,
  isSendControl,
  parseKeyChord,
  type ResolvedControl,
} from "../send-control-guard.js";

function control(overrides: Partial<ResolvedControl> = {}): ResolvedControl {
  return {
    tag: "button",
    labels: [],
    text: "",
    isControl: true,
    isTextEntry: false,
    isMultiline: false,
    isSearch: false,
    isDisabled: false,
    ...overrides,
  };
}

function textEntry(overrides: Partial<ResolvedControl> = {}): ResolvedControl {
  return control({
    tag: "textarea",
    isControl: false,
    isTextEntry: true,
    isMultiline: true,
    ...overrides,
  });
}

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    conversationId: "conv-1",
    workingDir: "/tmp",
    trustClass: "guardian",
    isInteractive: true,
    ...overrides,
  } as ToolContext;
}

describe("isSendControl", () => {
  test("fires on the accessible name of a real send control", () => {
    expect(isSendControl(control({ labels: ["Send"] }))).toBe(true);
    expect(isSendControl(control({ text: "Send" }))).toBe(true);
    expect(isSendControl(control({ labels: ["Send ‪(Ctrl-Enter)‬"] }))).toBe(
      true,
    );
    expect(isSendControl(control({ labels: ["Send now"] }))).toBe(true);
    expect(isSendControl(control({ text: "Reply all" }))).toBe(true);
    expect(isSendControl(control({ text: "Place order" }))).toBe(true);
    expect(isSendControl(control({ labels: ["Pay $42.00"] }))).toBe(true);
    expect(isSendControl(control({ text: "Publish" }))).toBe(true);
  });

  test("does not fire on ordinary browsing targets", () => {
    for (const name of [
      "Search",
      "Back",
      "Next page",
      "Compose",
      "Save draft",
      "Attach file",
      "Sign in",
      "Add to cart",
      "Refresh",
      "Inbox",
    ]) {
      expect(isSendControl(control({ text: name }))).toBe(false);
    }
  });

  test("non-controls never gate, however they are labelled", () => {
    // A link or a div reading "Send feedback" is not a send control.
    expect(
      isSendControl(control({ isControl: false, text: "Send feedback" })),
    ).toBe(false);
    expect(isSendControl(textEntry({ labels: ["Send a message"] }))).toBe(
      false,
    );
  });

  test("disabled controls cannot act, so they never gate", () => {
    expect(isSendControl(control({ text: "Send", isDisabled: true }))).toBe(
      false,
    );
  });

  test("prose is never keyword-matched", () => {
    // Long text is a paragraph / row / message body, not a button label.
    const body =
      "Thanks for the update — I will send the signed contract over to " +
      "the partner as soon as legal confirms the numbers, probably Friday.";
    expect(isSendControl(control({ text: body }))).toBe(false);
  });

  test("an unresolved target never gates", () => {
    expect(isSendControl(null)).toBe(false);
  });
});

describe("parseKeyChord", () => {
  test("recognises the enter family and its modifiers", () => {
    expect(parseKeyChord("Enter")).toMatchObject({ enter: true, meta: false });
    expect(parseKeyChord("Return")).toMatchObject({ enter: true });
    expect(parseKeyChord("cmd+enter")).toMatchObject({
      enter: true,
      meta: true,
    });
    expect(parseKeyChord("Control+Enter")).toMatchObject({
      enter: true,
      ctrl: true,
    });
    expect(parseKeyChord("Shift+Enter")).toMatchObject({
      enter: true,
      shift: true,
    });
    expect(parseKeyChord("Tab")).toMatchObject({ enter: false });
    expect(parseKeyChord("")).toMatchObject({ enter: false });
  });
});

describe("classifyKeySend", () => {
  test("⌘/Ctrl+Enter in a text entry is a send", () => {
    expect(classifyKeySend("cmd+enter", textEntry(), "mail.google.com")).toBe(
      "send",
    );
    expect(
      classifyKeySend("Control+Enter", textEntry(), "outlook.office.com"),
    ).toBe("send");
  });

  test("⌘+Enter outside a text entry does nothing consequential", () => {
    expect(classifyKeySend("cmd+enter", control({ text: "Cancel" }))).toBe(
      "free",
    );
    expect(classifyKeySend("cmd+enter", null)).toBe("free");
  });

  test("Shift+Enter is a newline everywhere", () => {
    expect(classifyKeySend("shift+enter", textEntry(), "app.slack.com")).toBe(
      "free",
    );
    expect(
      classifyKeySend("cmd+shift+enter", textEntry(), "mail.google.com"),
    ).toBe("free");
  });

  test("bare Enter on a focused send button activates it", () => {
    expect(classifyKeySend("Enter", control({ text: "Send" }))).toBe("send");
  });

  test("bare Enter in a composer sends only on Enter-sends hosts", () => {
    expect(classifyKeySend("Enter", textEntry(), "app.slack.com")).toBe("send");
    expect(classifyKeySend("Enter", textEntry(), "discord.com")).toBe("send");
    expect(classifyKeySend("Enter", textEntry(), "web.whatsapp.com")).toBe(
      "send",
    );
    // Gmail / X insert a newline on bare Enter — gating it would break typing.
    expect(classifyKeySend("Enter", textEntry(), "mail.google.com")).toBe(
      "free",
    );
    expect(classifyKeySend("Enter", textEntry(), "x.com")).toBe("free");
    expect(classifyKeySend("Enter", textEntry(), undefined)).toBe("free");
  });

  test("bare Enter in ordinary fields stays free", () => {
    // Search box on an Enter-sends host.
    expect(
      classifyKeySend(
        "Enter",
        textEntry({ isSearch: true, isMultiline: true }),
        "app.slack.com",
      ),
    ).toBe("free");
    // Single-line input (login form, URL field, filter).
    expect(
      classifyKeySend(
        "Enter",
        textEntry({ isMultiline: false }),
        "app.slack.com",
      ),
    ).toBe("free");
    // Anywhere else.
    expect(classifyKeySend("Enter", textEntry(), "example.com")).toBe("free");
  });

  test("non-enter keys are never sends", () => {
    expect(classifyKeySend("Tab", control({ text: "Send" }))).toBe("free");
    expect(classifyKeySend("Escape", textEntry(), "app.slack.com")).toBe(
      "free",
    );
  });
});

describe("gateResolvedSendControl", () => {
  const base = {
    toolName: "browser_click",
    controlLabel: "Send",
    targetDescription: 'element_id "e14"',
  } as const;

  test("an unattended run never dispatches and says it parked", () => {
    const decision = gateResolvedSendControl({
      ...base,
      input: { element_id: "e14" },
      context: ctx({ isInteractive: false }),
    });
    expect(decision.blocked).toBe(true);
    expect(decision.result?.isError).toBe(true);
    expect(decision.result?.content).toContain("Parked");
    expect(decision.result?.content).toContain("needs-you");
  });

  test("an attended run is blocked and told how to reach the approval gate", () => {
    const decision = gateResolvedSendControl({
      ...base,
      input: { element_id: "e14" },
      context: ctx(),
    });
    expect(decision.blocked).toBe(true);
    // The instruction must name the field the pre-execution gate reads, so the
    // retry is visible to it.
    expect(decision.result?.content).toContain('label: "Send"');
    expect(decision.result?.content).toContain("Nothing was dispatched");
  });

  test("a call the pre-execution gate already approved is allowed through", () => {
    // `label: "Send"` makes requiresHumanApprovalForAction true, so this
    // invocation already faced the forced, un-auto-approvable prompt.
    const decision = gateResolvedSendControl({
      ...base,
      input: { element_id: "e14", label: "Send" },
      context: ctx(),
    });
    expect(decision.blocked).toBe(false);
  });

  test("a labelled call still cannot run unattended", () => {
    const decision = gateResolvedSendControl({
      ...base,
      input: { element_id: "e14", label: "Send" },
      context: ctx({ isInteractive: false }),
    });
    expect(decision.blocked).toBe(true);
  });

  test("keyboard sends are described as a keypress", () => {
    const decision = gateResolvedSendControl({
      toolName: "browser_press_key",
      input: { key: "cmd+enter" },
      context: ctx(),
      controlLabel: "cmd+enter",
      targetDescription: "the focused element",
      kind: "key",
    });
    expect(decision.result?.content).toContain('Sending "cmd+enter"');
  });

  test("the label it tells you to retry with is one the gate actually sees", () => {
    // A key chord is not a send keyword, so instructing `label: "cmd+enter"`
    // would produce a retry the pre-execution gate ignores — and this guard
    // would then block it again forever. The label must be gate-visible.
    const decision = gateResolvedSendControl({
      toolName: "browser_press_key",
      input: { key: "cmd+enter" },
      context: ctx(),
      controlLabel: "cmd+enter",
      targetDescription: "the focused element",
      kind: "key",
    });
    const suggested = /label: "([^"]+)"/.exec(decision.result!.content)![1]!;
    const retry = gateResolvedSendControl({
      toolName: "browser_press_key",
      input: { key: "cmd+enter", label: suggested },
      context: ctx(),
      controlLabel: "cmd+enter",
      targetDescription: "the focused element",
      kind: "key",
    });
    expect(retry.blocked).toBe(false);
  });

  test("the retry loop terminates for clicks too", () => {
    const decision = gateResolvedSendControl({
      ...base,
      input: { element_id: "e14" },
      context: ctx(),
    });
    const suggested = /label: "([^"]+)"/.exec(decision.result!.content)![1]!;
    expect(
      gateResolvedSendControl({
        ...base,
        input: { element_id: "e14", label: suggested },
        context: ctx(),
      }).blocked,
    ).toBe(false);
  });
});

describe("describeControl", () => {
  test("prefers the first short name", () => {
    expect(describeControl(control({ labels: ["Send now"] }))).toBe("Send now");
    expect(describeControl(control({ labels: [], text: "Submit" }))).toBe(
      "Submit",
    );
    expect(describeControl(null)).toBe("the target element");
  });
});
