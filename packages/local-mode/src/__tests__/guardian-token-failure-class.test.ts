/**
 * A failed token subcommand has to say which kind of failure it was.
 *
 * Every non-zero exit used to map to 401, and `requiresGuardianReprovision()`
 * treats 401 as terminal — only re-provisioning recovers. So a local gateway
 * that was merely stopped (quit the app, reopen it) sent the owner to replace
 * credentials that were perfectly good. The CLI now exits 69 when the gateway
 * is not answering, and that has to survive the trip back as 503.
 */

import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CliInvocation } from "../util";

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = mock(() => true);
}

let lastChild: FakeChild;
const spawnMock = mock(() => {
  lastChild = new FakeChild();
  return lastChild;
});

mock.module("node:child_process", () => ({ spawn: spawnMock }));

let getGuardianAccessToken: typeof import("../guardian-token").getGuardianAccessToken;

beforeAll(async () => {
  ({ getGuardianAccessToken } = await import("../guardian-token"));
});

afterEach(() => {
  spawnMock.mockClear();
});

const invocation: CliInvocation = { command: "vellum", baseArgs: [] };

/**
 * A workspace whose access AND refresh tokens are both expired, so
 * `getGuardianAccessToken` runs exactly one subcommand (`relink`) and the test
 * observes a single child rather than a refresh-then-relink pair.
 */
function workspaceWithExpiredTokens(): { configDir: string; id: string } {
  const configDir = mkdtempSync(join(tmpdir(), "cue-guardian-"));
  const id = "assistant-1";
  mkdirSync(join(configDir, "assistants", id), { recursive: true });
  const past = new Date(Date.now() - 60 * 60_000).toISOString();
  writeFileSync(
    join(configDir, "assistants", id, "guardian-token.json"),
    JSON.stringify({
      accessToken: "stale",
      accessTokenExpiresAt: past,
      refreshToken: "stale-refresh",
      refreshTokenExpiresAt: past,
    }),
  );
  return { configDir, id };
}

async function resultForExit(
  code: number,
  stderr?: string,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const { configDir, id } = workspaceWithExpiredTokens();
  const pending = getGuardianAccessToken(id, configDir, invocation, true);
  // Let the spawn happen before driving the fake child.
  await Promise.resolve();
  if (stderr) lastChild.stderr.emit("data", Buffer.from(stderr));
  lastChild.emit("close", code);
  return (await pending) as { ok: boolean; status?: number; error?: string };
}

describe("guardian token failure classification", () => {
  test("an unreachable gateway is 503, not a rejected credential", async () => {
    const result = await resultForExit(69);

    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
  });

  test("any other failure stays 401", async () => {
    const result = await resultForExit(1);

    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  // stderr was piped and never read, so the only description of the failure
  // was discarded — and a child writing more than the pipe buffer would block.
  test("the CLI's own message survives instead of a generic one", async () => {
    const result = await resultForExit(69, "Gateway not reachable at http://x");

    expect(result.error).toBe("Gateway not reachable at http://x");
  });

  test("a successful token is still returned", async () => {
    const { configDir, id } = workspaceWithExpiredTokens();
    const pending = getGuardianAccessToken(id, configDir, invocation, true);
    await Promise.resolve();
    lastChild.stdout.emit("data", Buffer.from("fresh-token\n"));
    lastChild.emit("close", 0);

    expect(await pending).toEqual({ ok: true, accessToken: "fresh-token" });
  });
});
