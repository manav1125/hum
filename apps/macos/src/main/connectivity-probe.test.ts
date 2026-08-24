import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * Which backend the probe checks, and the rule that it may not assert an
 * outage it cannot demonstrate.
 *
 * Both bugs here were live on Manav's machine on 2026-08-24: the banner read
 * "Trying to reach Cue…" while his instance answered `/healthz` in under half
 * a second, and it never cleared — the log showed 12 drops against 4
 * recoveries.
 */

let selfHost: URL | null = null;
let lockfile: unknown = { ok: false };
const reachable: boolean[] = [];

mock.module("./app-config", () => ({ resolveSelfHostUrl: () => selfHost }));
mock.module("./status", () => ({
  setBackendReachable: (v: boolean) => reachable.push(v),
}));
mock.module("@vellumai/local-mode", () => ({
  getLockfileData: () => lockfile,
}));
mock.module("electron", () => ({
  app: { on: () => undefined },
  BrowserWindow: { getAllWindows: () => [] },
  powerMonitor: { on: () => undefined },
  net: { fetch: async () => ({ ok: true }) },
}));

const { resolveProbeTarget } = await import("./connectivity-probe");

beforeEach(() => {
  selfHost = null;
  lockfile = { ok: false };
  reachable.length = 0;
});

afterEach(() => {
  reachable.length = 0;
});

describe("which backend it probes", () => {
  test("REGRESSION: a self-hosted install probes the INSTANCE, not localhost", () => {
    selfHost = new URL("https://manav.justcue.app/assistant/?cueToken=abc");
    expect(resolveProbeTarget([])).toBe("https://manav.justcue.app/healthz");
  });

  test("with no instance and no lockfile there is no target", () => {
    expect(resolveProbeTarget([])).toBeNull();
  });
});
