/**
 * Where the encrypted credential store lands.
 *
 * The bug this pins cost a tester four days. On a containerized install the
 * workspace volume is mounted at "/workspace", so `vellumRoot()` sees a parent
 * of "/", refuses it, and falls back to ~/.vellum — the ephemeral container
 * layer. Credential METADATA lives on the volume and survives a deploy, so the
 * vault kept listing every secret with `hasSecret: false` behind it, and he
 * re-entered Slack, GitHub, Airtable and Hunter keys after each deploy without
 * ever being told they had been thrown away.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { getProtectedDir } from "../util/platform.js";

const ENV = ["CREDENTIAL_SECURITY_DIR", "VELLUM_WORKSPACE_DIR"] as const;
const saved = new Map(ENV.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of ENV) {
    const v = saved.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("getProtectedDir", () => {
  test("an explicit security directory wins over the derived root", () => {
    process.env.VELLUM_WORKSPACE_DIR = "/workspace";
    process.env.CREDENTIAL_SECURITY_DIR = "/workspace/credential-security";
    expect(getProtectedDir()).toBe("/workspace/credential-security");
  });

  test("a workspace at the filesystem root does not silently take the store with it", () => {
    // Without an explicit directory this is the case that lands on ephemeral
    // disk. Asserting the shape keeps the trap visible: any install with
    // VELLUM_WORKSPACE_DIR=/workspace MUST also set CREDENTIAL_SECURITY_DIR.
    process.env.VELLUM_WORKSPACE_DIR = "/workspace";
    delete process.env.CREDENTIAL_SECURITY_DIR;
    expect(getProtectedDir()).not.toStartWith("/workspace/");
  });

  test("a relative security directory is ignored rather than half-applied", () => {
    process.env.VELLUM_WORKSPACE_DIR = "/workspace";
    process.env.CREDENTIAL_SECURITY_DIR = "relative/path";
    expect(getProtectedDir()).not.toContain("relative/path");
  });
});
