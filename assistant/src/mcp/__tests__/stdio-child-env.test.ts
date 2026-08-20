/**
 * What a spawned stdio MCP server can see.
 *
 * The declared env used to be merged over `process.env`, so declaring a
 * single variable handed that child the daemon's entire environment — every
 * provider key and platform token in it. The bash tool has never worked that
 * way; `buildSanitizedEnv` is the allowlist it uses, and an MCP child has no
 * claim to more than a shell command gets.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { SAFE_ENV_VARS } from "../../tools/terminal/safe-env.js";
import { mcpCredentialConsumer, stdioChildEnv } from "../client.js";

const LEAKY = "SOME_PROVIDER_API_KEY";

describe("stdioChildEnv", () => {
  beforeEach(() => {
    process.env[LEAKY] = "sk-should-never-reach-a-child";
  });
  afterEach(() => {
    delete process.env[LEAKY];
  });

  test("does not hand the child an unrelated secret from the daemon env", () => {
    const env = stdioChildEnv({ ATLAS_BASE_URL: "https://atlas.example.com" });
    expect(env[LEAKY]).toBeUndefined();
  });

  test("still provides the allowlisted basics a child needs to run", () => {
    process.env.PATH ??= "/usr/bin";
    const env = stdioChildEnv(undefined);
    expect(SAFE_ENV_VARS).toContain("PATH");
    expect(env.PATH).toBeDefined();
  });

  test("declared values are laid on top", () => {
    const env = stdioChildEnv({ ATLAS_BASE_URL: "https://atlas.example.com" });
    expect(env.ATLAS_BASE_URL).toBe("https://atlas.example.com");
  });

  test("a declared value wins over the sanitized base", () => {
    const env = stdioChildEnv({ PATH: "/custom/bin" });
    expect(env.PATH).toBe("/custom/bin");
  });

  test("no declared env still yields a usable environment, not process.env", () => {
    const env = stdioChildEnv(undefined);
    expect(env[LEAKY]).toBeUndefined();
    expect(Object.keys(env).length).toBeGreaterThan(0);
  });
});

describe("mcpCredentialConsumer", () => {
  test("is scoped per server, so one server's grant is not another's", () => {
    expect(mcpCredentialConsumer("atlas")).toBe("mcp:atlas");
    expect(mcpCredentialConsumer("atlas")).not.toBe(
      mcpCredentialConsumer("composio_slack"),
    );
  });
});
