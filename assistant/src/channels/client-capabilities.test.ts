/**
 * What a connecting client is allowed to claim it can do.
 *
 * This resolver is a privilege boundary: it turns a request header into the
 * set of host-proxy channels the daemon will route to that client. The
 * mutation checks guard the two failures that matter — a client talking its
 * way into a channel that ACTS on the guardian's machine, and a capability
 * being claimed on behalf of builds that cannot service it.
 */

import { describe, expect, test } from "bun:test";

import {
  CLIENT_DECLARABLE_CAPABILITIES,
  resolveClientCapabilities,
} from "./types.js";

describe("the five original capabilities still come from the interface", () => {
  test("a Mac gets them without declaring anything", () => {
    const caps = resolveClientCapabilities("macos");
    for (const cap of [
      "host_bash",
      "host_file",
      "host_cu",
      "host_browser",
      "host_app_control",
    ] as const) {
      expect(caps).toContain(cap);
    }
  });

  test("the chrome extension still gets only host_browser", () => {
    expect(resolveClientCapabilities("chrome-extension")).toEqual([
      "host_browser",
    ]);
  });

  test("a web client gets no host proxy at all", () => {
    expect(resolveClientCapabilities("web")).toEqual([]);
  });
});

describe("a self-declared capability cannot be a channel that acts", () => {
  test("MUTATION CHECK: declaring host_bash does not grant it", () => {
    // The declaration is an unverified header. If this ever passes through,
    // any client that can open an event stream can ask for shell execution on
    // the guardian's machine.
    const caps = resolveClientCapabilities(
      "web",
      "host_bash,host_file,host_cu,host_app_control",
    );
    expect(caps).toEqual([]);
  });

  test("MUTATION CHECK: the declarable allowlist holds nothing that acts", () => {
    // Guards the list itself, not just the filter that reads it.
    for (const cap of CLIENT_DECLARABLE_CAPABILITIES) {
      expect([
        "host_bash",
        "host_file",
        "host_cu",
        "host_app_control",
      ]).not.toContain(cap);
    }
  });

  test("a declaration cannot take a capability away either", () => {
    // Declaring a narrow set must not shrink what the interface establishes;
    // the two sources are unioned, not intersected.
    const caps = resolveClientCapabilities("macos", "host_observe");
    expect(caps).toContain("host_bash");
  });
});

describe("host_observe is granted only by declaring it", () => {
  test("MUTATION CHECK: a Mac that says nothing is NOT claimed to observe", () => {
    // Every desktop build in the field before this shipped shows up exactly
    // like this. Claiming it here would arm a capture session against a
    // client with no handler, and the owner would be told Cue was watching
    // their screen while nothing was captured.
    expect(resolveClientCapabilities("macos")).not.toContain("host_observe");
  });

  test("a Mac that declares it gets it", () => {
    expect(resolveClientCapabilities("macos", "host_observe")).toContain(
      "host_observe",
    );
  });

  test("whitespace and ordering in the header do not matter", () => {
    expect(
      resolveClientCapabilities("macos", " host_observe , host_bash "),
    ).toContain("host_observe");
  });
});

describe("a newer client talking to an older daemon is normal", () => {
  test("an unknown capability is dropped, not rejected", () => {
    const caps = resolveClientCapabilities("macos", "host_teleport");
    expect(caps).not.toContain("host_teleport");
    expect(caps).toContain("host_bash");
  });

  test("an empty or malformed header is harmless", () => {
    expect(resolveClientCapabilities("macos", "")).not.toContain(
      "host_observe",
    );
    expect(resolveClientCapabilities("macos", ",,, ,")).not.toContain(
      "host_observe",
    );
  });
});
