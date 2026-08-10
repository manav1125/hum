/**
 * Per-client subscriber bounding: live sibling connections (windows/tabs of
 * one install share a clientId) must coexist; only the oldest beyond the cap
 * are evicted. The dispose-all-on-reconnect behavior this replaces made
 * sibling connections evict each other in an endless ping-pong.
 */
import { describe, expect, test } from "bun:test";

import { AssistantEventHub } from "../assistant-event-hub.js";

function clientSub(
  hub: AssistantEventHub,
  clientId: string,
  onEvict?: () => void,
) {
  return hub.subscribe({
    type: "client",
    clientId,
    interfaceId: "macos",
    capabilities: [],
    callback: () => {},
    onEvict,
  });
}

describe("per-client subscriber bounding", () => {
  test("sibling connections under the cap coexist — no mutual eviction", () => {
    const hub = new AssistantEventHub();
    let evictions = 0;
    const subs = [1, 2, 3].map(() =>
      clientSub(hub, "install-1", () => evictions++),
    );
    expect(evictions).toBe(0);
    for (const s of subs) expect(s.active).toBe(true);
  });

  test("beyond the cap, only the OLDEST are evicted", () => {
    const hub = new AssistantEventHub();
    const evicted: number[] = [];
    const subs = Array.from({ length: 7 }, (_, i) =>
      clientSub(hub, "install-1", () => evicted.push(i)),
    );
    // Cap is 6: the 7th registration evicts exactly the oldest (index 0).
    expect(evicted).toEqual([0]);
    expect(subs[0]!.active).toBe(false);
    for (const s of subs.slice(1)) expect(s.active).toBe(true);
  });

  test("other clients are untouched by a busy client's churn", () => {
    const hub = new AssistantEventHub();
    let otherEvicted = 0;
    const other = clientSub(hub, "install-2", () => otherEvicted++);
    for (let i = 0; i < 10; i++) clientSub(hub, "install-1");
    expect(otherEvicted).toBe(0);
    expect(other.active).toBe(true);
  });

  test("a reconnect storm stays bounded at the cap", () => {
    const hub = new AssistantEventHub();
    let live = 0;
    for (let i = 0; i < 50; i++) {
      live++;
      clientSub(hub, "install-1", () => live--);
    }
    expect(live).toBe(6);
  });
});
