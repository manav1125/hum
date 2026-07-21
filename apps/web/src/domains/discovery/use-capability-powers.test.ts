import { describe, expect, it } from "vitest";

import {
  buildCapabilityPowers,
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

  it("keeps the browser extension honest — no signal, so it only teaches", () => {
    // There is no installed/handshake endpoint for the extension anywhere in
    // the daemon, so no combination of signals may ever mark it on.
    for (const signals of [
      NOTHING_ON,
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
      expect(extension.cta).toBe("Learn");
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
