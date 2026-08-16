/**
 * The normalization removes ONLY the value the provisioner wrote itself.
 *
 * The mutation checks guard the three ways this could quietly do damage:
 * overwriting a level the owner chose deliberately, reaching into a server the
 * owner added themselves, or pinning `"high"` explicitly instead of letting the
 * schema default apply — which would leave normalized instances in a different
 * shape from freshly provisioned ones.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { McpServerConfigSchema } from "../../../config/schemas/mcp.js";
import { normalizeAutoProvisionedComposioRiskLevelMigration as migration } from "../106-normalize-auto-provisioned-composio-risk-level.js";

function workspaceWith(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "cue-mig106-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify(config, null, 2));
  return dir;
}

function serversOf(dir: string): Record<string, any> {
  const raw = JSON.parse(readFileSync(join(dir, "config.json"), "utf-8"));
  return raw.mcp?.servers ?? {};
}

function composioServer(url: string, extra?: Record<string, unknown>) {
  return {
    transport: { type: "streamable-http", url },
    enabled: true,
    maxTools: 20,
    ...extra,
  };
}

/** The shape the provisioner actually wrote before the fix. */
const SEEDED = {
  mcp: {
    servers: {
      composio: composioServer("https://backend.composio.dev/v3/mcp/router", {
        defaultRiskLevel: "low",
      }),
      composio_gmail: composioServer("https://backend.composio.dev/v3/mcp/g", {
        defaultRiskLevel: "low",
      }),
      composio_slack: composioServer("https://backend.composio.dev/v3/mcp/s", {
        defaultRiskLevel: "low",
      }),
    },
  },
};

describe("106-normalize-auto-provisioned-composio-risk-level", () => {
  test("clears the auto-written 'low' so the fail-closed default applies", () => {
    const dir = workspaceWith(SEEDED);

    migration.run(dir);

    const servers = serversOf(dir);
    const schemaDefault = McpServerConfigSchema.parse({
      transport: { type: "streamable-http", url: "https://example.invalid" },
    }).defaultRiskLevel;

    for (const key of ["composio", "composio_gmail", "composio_slack"]) {
      // The field is gone, not rewritten — a normalized workspace ends up in
      // exactly the shape a freshly provisioned one has.
      expect(`${key}:${"defaultRiskLevel" in servers[key]}`).toBe(
        `${key}:false`,
      );
      expect(
        `${key}:${McpServerConfigSchema.parse(servers[key]).defaultRiskLevel}`,
      ).toBe(`${key}:${schemaDefault}`);
    }
  });

  test("leaves the rest of each server entry untouched", () => {
    const dir = workspaceWith(SEEDED);

    migration.run(dir);

    const gmail = serversOf(dir).composio_gmail;
    expect(gmail.enabled).toBe(true);
    expect(gmail.maxTools).toBe(20);
    expect(gmail.transport.url).toBe("https://backend.composio.dev/v3/mcp/g");
  });

  test("does not overwrite a level the owner raised deliberately", () => {
    // "medium" and "high" were never written by the provisioner, so their
    // presence is a choice someone made.
    const dir = workspaceWith({
      mcp: {
        servers: {
          composio_gmail: composioServer("https://x.invalid", {
            defaultRiskLevel: "medium",
          }),
          composio_slack: composioServer("https://y.invalid", {
            defaultRiskLevel: "high",
          }),
        },
      },
    });

    migration.run(dir);

    const servers = serversOf(dir);
    expect(servers.composio_gmail.defaultRiskLevel).toBe("medium");
    expect(servers.composio_slack.defaultRiskLevel).toBe("high");
  });

  test("does not touch servers the owner added themselves", () => {
    // Exact key match, not a bare startsWith("composio") — otherwise a
    // hand-added server whose name merely begins with the same letters gets
    // swept up.
    const dir = workspaceWith({
      mcp: {
        servers: {
          "composio-mine": composioServer("https://mine.invalid", {
            defaultRiskLevel: "low",
          }),
          linear: composioServer("https://linear.invalid", {
            defaultRiskLevel: "low",
          }),
        },
      },
    });

    migration.run(dir);

    const servers = serversOf(dir);
    expect(servers["composio-mine"].defaultRiskLevel).toBe("low");
    expect(servers.linear.defaultRiskLevel).toBe("low");
  });

  test("is idempotent — a second run rewrites nothing", () => {
    const dir = workspaceWith(SEEDED);

    migration.run(dir);
    const afterFirst = readFileSync(join(dir, "config.json"), "utf-8");
    migration.run(dir);

    expect(readFileSync(join(dir, "config.json"), "utf-8")).toBe(afterFirst);
  });

  test("survives a workspace with no config, no mcp block, and unparseable JSON", () => {
    const empty = mkdtempSync(join(tmpdir(), "cue-mig106-none-"));
    expect(() => migration.run(empty)).not.toThrow();

    const noMcp = workspaceWith({ llm: { profiles: {} } });
    expect(() => migration.run(noMcp)).not.toThrow();

    const broken = mkdtempSync(join(tmpdir(), "cue-mig106-broken-"));
    writeFileSync(join(broken, "config.json"), "{ not json");
    expect(() => migration.run(broken)).not.toThrow();
    // A workspace we cannot parse is one we must not rewrite.
    expect(readFileSync(join(broken, "config.json"), "utf-8")).toBe(
      "{ not json",
    );
  });
});
