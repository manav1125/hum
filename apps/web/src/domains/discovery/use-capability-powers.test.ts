import { describe, expect, it } from "vitest";

import {
  buildCapabilityPowers,
  readExtensionReach,
  type CapabilitySignals,
} from "@/domains/discovery/use-capability-powers";

const NOTHING_ON: CapabilitySignals = {
  macOnline: false,
  organizerRunning: false,
  enabledWatchers: 0,
  enabledPlaybooks: 0,
  installedPlugins: 0,
  phoneReady: false,
  cueLiveActive: false,
  cueLiveReachable: false,
  extensionReach: "absent",
};

/** A connected extension, exactly as `/v1/clients` reports one. */
const EXTENSION_CLIENT = {
  clientId: "c-1",
  interfaceId: "chrome-extension",
  capabilities: ["host_browser"],
  machineName: null,
  connectedAt: "2026-08-16T10:00:00.000Z",
  lastActiveAt: "2026-08-16T10:00:00.000Z",
};

const MAC_CLIENT = {
  clientId: "c-2",
  interfaceId: "macos",
  capabilities: ["host_bash", "host_file", "host_browser"],
  machineName: "manav-mbp",
  connectedAt: "2026-08-16T10:00:00.000Z",
  lastActiveAt: "2026-08-16T10:00:00.000Z",
};

function byId(signals: Partial<CapabilitySignals> = {}) {
  const powers = buildCapabilityPowers({ ...NOTHING_ON, ...signals });
  return Object.fromEntries(powers.map((p) => [p.id, p]));
}

describe("buildCapabilityPowers", () => {
  it("renders all seven powers", () => {
    const powers = buildCapabilityPowers(NOTHING_ON);
    expect(powers).toHaveLength(7);
    expect(powers.map((p) => p.id)).toEqual([
      "organizer",
      "watchers",
      "playbooks",
      "plugins",
      "extension",
      "phone",
      "cue-live",
    ]);
  });

  it("never claims a power is on when nothing is running", () => {
    const powers = buildCapabilityPowers(NOTHING_ON);
    expect(powers.filter((p) => p.state === "on")).toHaveLength(0);
    expect(powers.filter((p) => p.state === "running")).toHaveLength(0);
  });

  it("names the cost in amber for anything that needs a Mac or an install", () => {
    const powers = byId();
    expect(powers.organizer.caveat).toBe("Needs the Mac app.");
    expect(powers["cue-live"].caveat).toBe("Needs the Mac app.");
    expect(powers.phone.caveat).toBe("Needs setup.");
    expect(powers.extension.caveat).toMatch(/Needs the extension/);
  });

  it("drops the Mac caveat once a host Mac is connected", () => {
    const powers = byId({ macOnline: true, cueLiveReachable: true });
    expect(powers.organizer.caveat).toBeNull();
    expect(powers.organizer.state).toBe("on");
    expect(powers.organizer.cta).toBe("On ✓");
    expect(powers["cue-live"].caveat).toBeNull();
  });

  it("uses the blue running state only while something is actually running", () => {
    expect(
      byId({ macOnline: true, organizerRunning: true }).organizer,
    ).toMatchObject({ state: "running", cta: "Running" });
    expect(
      byId({ cueLiveReachable: true, cueLiveActive: true })["cue-live"],
    ).toMatchObject({ state: "running", cta: "Running" });
  });

  it("flips watchers / playbooks / plugins / phone to On ✓ on real counts", () => {
    const powers = byId({
      enabledWatchers: 3,
      enabledPlaybooks: 1,
      installedPlugins: 2,
      phoneReady: true,
    });
    expect(powers.watchers).toMatchObject({ state: "on", cta: "On ✓" });
    expect(powers.watchers.line).toContain("3 watching");
    expect(powers.playbooks).toMatchObject({ state: "on", cta: "On ✓" });
    expect(powers.plugins).toMatchObject({ state: "on", cta: "On ✓" });
    expect(powers.plugins.line).toContain("2 installed");
    expect(powers.phone).toMatchObject({ state: "on", cta: "On ✓" });
    expect(powers.phone.caveat).toBeNull();
  });

  it("marks the browser extension on when the daemon reports it connected", () => {
    const extension = byId({ extensionReach: "connected" }).extension;
    expect(extension.state).toBe("on");
    expect(extension.cta).toBe("On ✓");
    expect(extension.caveat).toBeNull();
  });

  it("says the extension is not connected only when the clients list said so", () => {
    const extension = byId({ extensionReach: "absent" }).extension;
    expect(extension.state).toBe("needs-you");
    expect(extension.cta).toBe("Learn");
    expect(extension.caveat).toBe(
      "Needs the extension — not connected right now.",
    );
  });

  it("says it cannot confirm the extension when the clients query failed", () => {
    // A failed read is not evidence of absence: the copy must not assert the
    // extension is missing, and the verb must not claim it is on.
    const extension = byId({ extensionReach: "unknown" }).extension;
    expect(extension.state).toBe("needs-you");
    expect(extension.cta).toBe("Learn");
    expect(extension.caveat).toBe(
      "Needs the extension — Cue can't confirm it right now.",
    );
  });

  it("never infers the extension from any other signal", () => {
    for (const signals of [
      { ...NOTHING_ON, macOnline: true, cueLiveReachable: true },
      {
        ...NOTHING_ON,
        enabledWatchers: 9,
        installedPlugins: 9,
        phoneReady: true,
      },
    ]) {
      const extension = buildCapabilityPowers(signals).find(
        (p) => p.id === "extension",
      )!;
      expect(extension.state).toBe("needs-you");
      expect(extension.to).toBeNull();
    }
  });

  it("only offers a destination for powers that have a surface", () => {
    for (const power of buildCapabilityPowers(NOTHING_ON)) {
      if (power.id === "extension") continue;
      expect(power.to).toMatch(/^\/assistant\//);
    }
  });
});

describe("readExtensionReach", () => {
  it("reads a connected chrome-extension client with host_browser", () => {
    expect(readExtensionReach([MAC_CLIENT, EXTENSION_CLIENT], false)).toBe(
      "connected",
    );
  });

  it("reports absent when the list came back without the extension", () => {
    expect(readExtensionReach([], false)).toBe("absent");
    expect(readExtensionReach([MAC_CLIENT], false)).toBe("absent");
  });

  it("does not count a chrome-extension client that lost host_browser", () => {
    expect(
      readExtensionReach([{ ...EXTENSION_CLIENT, capabilities: [] }], false),
    ).toBe("absent");
  });

  it("reports unknown — never absent — when the query failed or has no data", () => {
    expect(readExtensionReach(undefined, false)).toBe("unknown");
    expect(readExtensionReach([], true)).toBe("unknown");
  });

  it("does not claim connected from data held over a failed refetch", () => {
    expect(readExtensionReach([EXTENSION_CLIENT], true)).toBe("unknown");
  });
});
