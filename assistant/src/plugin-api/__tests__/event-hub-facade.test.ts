/**
 * Security regressions for the plugin event-hub facade.
 *
 * The facade is what a workspace plugin receives when it imports
 * `assistantEventHub` from `@vellumai/plugin-api`. It must never let a plugin
 * publish a daemon-to-client `host_*` control event (which would drive
 * privileged shell/file/browser execution on the desktop client, bypassing the
 * host proxies' approval gate), and must not be bypassable by prototype
 * patching, boxed values, getters, or by impersonating a device client.
 */

import { afterEach, describe, expect, test } from "bun:test";

import type { AssistantEvent } from "../../runtime/assistant-event.js";
import { assistantEventHub } from "../../runtime/assistant-event-hub.js";
import { pluginAssistantEventHub } from "../event-hub-facade.js";

function evt(type: string, conversationId = "c1"): AssistantEvent {
  return { message: { type }, conversationId } as unknown as AssistantEvent;
}

describe("pluginAssistantEventHub.publish", () => {
  test("rejects host_* control events", async () => {
    await expect(
      pluginAssistantEventHub.publish(evt("host_bash_request")),
    ).rejects.toThrow(/host-proxy control events/);
    await expect(
      pluginAssistantEventHub.publish(evt("host_browser_request")),
    ).rejects.toThrow(/host-proxy control events/);
  });

  test("forwards a benign non-host event to the real hub", async () => {
    const received: string[] = [];
    const sub = assistantEventHub.subscribe({
      type: "process",
      callback: (e) => {
        const t = (e.message as { type?: string } | undefined)?.type;
        if (t) received.push(t);
      },
    });
    try {
      await pluginAssistantEventHub.publish(evt("assistant_message"));
      expect(received).toContain("assistant_message");
    } finally {
      sub.dispose();
    }
  });

  test("a boxed String host type is still rejected (canonicalization)", async () => {
    const sneaky = {
      message: { type: new String("host_bash_request") },
      conversationId: "c1",
    } as unknown as AssistantEvent;
    await expect(pluginAssistantEventHub.publish(sneaky)).rejects.toThrow(
      /host-proxy control events/,
    );
  });

  test("a patched String.prototype.startsWith does not bypass the guard", async () => {
    const original = String.prototype.startsWith;
    // eslint-disable-next-line no-extend-native
    String.prototype.startsWith = () => false;
    try {
      await expect(
        pluginAssistantEventHub.publish(evt("host_bash_request")),
      ).rejects.toThrow(/host-proxy control events/);
    } finally {
      // eslint-disable-next-line no-extend-native
      String.prototype.startsWith = original;
    }
  });

  test("a getter-based host type is rejected (inert snapshot)", async () => {
    const sneaky = {
      message: {
        get type() {
          return "host_bash_request";
        },
      },
      conversationId: "c1",
    } as unknown as AssistantEvent;
    await expect(pluginAssistantEventHub.publish(sneaky)).rejects.toThrow(
      /host-proxy control events/,
    );
  });
});

describe("pluginAssistantEventHub.subscribe", () => {
  const subs: Array<{ dispose: () => void }> = [];
  afterEach(() => {
    for (const s of subs.splice(0)) s.dispose();
  });

  test("delivers a frozen snapshot the plugin cannot mutate", async () => {
    let seen: AssistantEvent | null = null;
    subs.push(
      pluginAssistantEventHub.subscribe({
        type: "process",
        callback: (e) => {
          seen = e;
        },
      }),
    );
    await assistantEventHub.publish(evt("assistant_message", "c1"));
    expect(seen).not.toBeNull();
    // The delivered event is deep-frozen; mutating it throws in strict mode or
    // is silently ignored — either way the object is not writable.
    expect(Object.isFrozen(seen)).toBe(true);
  });
});
