import { describe, expect, test } from "bun:test";

import {
  buildReachSnapshot,
  type ClientRegistryReader,
  renderReachLines,
} from "./reach-snapshot.js";

type Client = { actorPrincipalId?: string };

/**
 * A stand-in client registry. Injected rather than module-mocked: replacing
 * `assistant-event-hub.js` wholesale drops its other exports and poisons every
 * test file that runs after this one in the same bun process.
 */
function registryOf(entries: {
  extension?: Client[];
  hostBrowser?: Client[];
  hostBash?: Client[];
  throws?: boolean;
}): ClientRegistryReader {
  return {
    listClientsByCapability(capability) {
      if (entries.throws) throw new Error("registry unavailable");
      return capability === "host_browser"
        ? (entries.hostBrowser ?? [])
        : (entries.hostBash ?? []);
    },
    listClientsByInterface() {
      if (entries.throws) throw new Error("registry unavailable");
      return entries.extension ?? [];
    },
  };
}

describe("buildReachSnapshot", () => {
  test("no connected clients — the user's browser is not reachable", () => {
    const snapshot = buildReachSnapshot({ registry: registryOf({}) });
    expect(snapshot.userBrowser.reachable).toBe(false);
    expect(snapshot.userBrowser.route).toBeNull();
    expect(snapshot.userMac.reachable).toBe(false);
    expect(snapshot.unknown).toBe(false);
  });

  test("a connected Chrome extension makes the user's browser reachable", () => {
    const snapshot = buildReachSnapshot({
      registry: registryOf({ extension: [{}], hostBrowser: [{}] }),
    });
    expect(snapshot.userBrowser.reachable).toBe(true);
    expect(snapshot.userBrowser.route).toBe("extension");
  });

  test("the desktop bridge alone is a host-bridge route", () => {
    const snapshot = buildReachSnapshot({
      registry: registryOf({ hostBrowser: [{}] }),
    });
    expect(snapshot.userBrowser.reachable).toBe(true);
    expect(snapshot.userBrowser.route).toBe("host-bridge");
  });

  test("host_bash clients decide Mac reach", () => {
    expect(
      buildReachSnapshot({ registry: registryOf({ hostBash: [{}] }) }).userMac
        .reachable,
    ).toBe(true);
  });

  test("actor scoping: another actor's client does not count", () => {
    const snapshot = buildReachSnapshot({
      sourceActorPrincipalId: "mine",
      registry: registryOf({
        extension: [{ actorPrincipalId: "other" }],
        hostBrowser: [{ actorPrincipalId: "other" }],
        hostBash: [{ actorPrincipalId: "other" }],
      }),
    });
    expect(snapshot.userBrowser.reachable).toBe(false);
    expect(snapshot.userMac.reachable).toBe(false);
  });

  test("an unreadable registry degrades to unknown, never to a claim", () => {
    const snapshot = buildReachSnapshot({
      registry: registryOf({ throws: true }),
    });
    expect(snapshot.unknown).toBe(true);
    expect(renderReachLines(snapshot).join("\n")).toContain("unknown");
  });
});

describe("renderReachLines", () => {
  test("no route: says the browser is the container's and to stop", () => {
    const text = renderReachLines(
      buildReachSnapshot({ registry: registryOf({}) }),
    ).join("\n");
    expect(text).toContain("NOT reachable");
    expect(text).toContain("throwaway browser inside Cue's own container");
    expect(text).toContain("proves nothing about their account");
    expect(text).toContain("no desktop client is connected");
  });

  test("extension route: says browser tools drive their real browser", () => {
    const text = renderReachLines(
      buildReachSnapshot({ registry: registryOf({ extension: [{}] }) }),
    ).join("\n");
    expect(text).toContain("REACHABLE via the connected Chrome extension");
    expect(text).not.toContain("throwaway browser");
    // When the browser is reachable, the model must be told to use the
    // browser_* tools for web work and NOT computer_use screen-control.
    expect(text).toContain("`browser_*` tools");
    expect(text).toContain("Do NOT use `computer_use_*`");
    expect(text).toContain("native desktop apps only");
  });

  test("host-bridge route: also steers web work to browser_* over computer_use", () => {
    const text = renderReachLines(
      buildReachSnapshot({ registry: registryOf({ hostBrowser: [{}] }) }),
    ).join("\n");
    expect(text).toContain("REACHABLE via the desktop bridge");
    expect(text).toContain("`browser_*` tools");
    expect(text).toContain("Do NOT use `computer_use_*`");
  });
});
