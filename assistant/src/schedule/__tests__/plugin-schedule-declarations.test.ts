import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  parsePluginScheduleDeclarations,
  pluginScheduleSourceKey,
} from "../plugin-schedule-declarations.js";

let pluginDir: string;

function writeDeclaration(name: string, files: Record<string, string>): string {
  const dir = join(pluginDir, "schedules", name);
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

const VALID_CONFIG = JSON.stringify({
  expression: "0 9 * * *",
  description: "Daily digest",
});

beforeEach(() => {
  pluginDir = mkdtempSync(join(tmpdir(), "plugin-sched-decl-"));
});

afterEach(() => {
  rmSync(pluginDir, { recursive: true, force: true });
});

describe("parsePluginScheduleDeclarations", () => {
  test("missing schedules/ directory yields no declarations and no errors", () => {
    const parsed = parsePluginScheduleDeclarations(pluginDir, "p");
    expect(parsed.declarations).toEqual([]);
    expect(parsed.errors).toEqual([]);
  });

  test("valid execute declaration parses with sourceKey, trimmed prompt, and config defaults", () => {
    writeDeclaration("digest", {
      "config.json": VALID_CONFIG,
      "index.md": "\nSummarize my day.\n\n",
    });
    const parsed = parsePluginScheduleDeclarations(pluginDir, "myplug");
    expect(parsed.errors).toEqual([]);
    expect(parsed.declarations).toHaveLength(1);
    const decl = parsed.declarations[0]!;
    expect(decl.sourceKey).toBe(pluginScheduleSourceKey("myplug", "digest"));
    expect(decl.name).toBe("digest");
    expect(decl.mode).toBe("execute");
    expect(decl.message).toBe("Summarize my day.");
    expect(decl.scriptInvocation).toBeNull();
    expect(decl.config.expression).toBe("0 9 * * *");
    expect(decl.config.syntax).toBe("cron");
    expect(decl.config.description).toBe("Daily digest");
    expect(decl.config.enabled).toBe(true);
    expect(decl.definitionHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("script declaration builds a shebang-aware invocation", () => {
    const dir = writeDeclaration("backup", {
      "config.json": VALID_CONFIG,
      "index.sh": "#!/usr/bin/env bash\necho hi\n",
    });
    const parsed = parsePluginScheduleDeclarations(pluginDir, "p");
    expect(parsed.errors).toEqual([]);
    const decl = parsed.declarations[0]!;
    expect(decl.mode).toBe("script");
    expect(decl.message).toBeNull();
    expect(decl.scriptInvocation).toBe(
      `'/usr/bin/env' 'bash' '${join(dir, "index.sh")}'`,
    );
  });

  test("script without shebang falls back to sh", () => {
    const dir = writeDeclaration("plain", {
      "config.json": VALID_CONFIG,
      "index.sh": "echo hi\n",
    });
    const parsed = parsePluginScheduleDeclarations(pluginDir, "p");
    expect(parsed.declarations[0]!.scriptInvocation).toBe(
      `sh '${join(dir, "index.sh")}'`,
    );
  });

  test("a file directly under schedules/ is an error, not silently ignored", () => {
    mkdirSync(join(pluginDir, "schedules"), { recursive: true });
    writeFileSync(join(pluginDir, "schedules", "stray.md"), "hello");
    const parsed = parsePluginScheduleDeclarations(pluginDir, "p");
    expect(parsed.declarations).toEqual([]);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]!.kind).toBe("invalid");
    expect(parsed.errors[0]!.reason).toContain("must be directories");
  });

  test("missing config.json is an error", () => {
    writeDeclaration("noconf", { "index.md": "Do things." });
    const parsed = parsePluginScheduleDeclarations(pluginDir, "p");
    expect(parsed.errors[0]!.reason).toBe("missing config.json");
  });

  test("malformed JSON config is an error", () => {
    writeDeclaration("badjson", {
      "config.json": "{ not json",
      "index.md": "Do things.",
    });
    const parsed = parsePluginScheduleDeclarations(pluginDir, "p");
    expect(parsed.errors[0]!.reason).toContain("not valid JSON");
  });

  test("unknown config fields are rejected (strict schema)", () => {
    writeDeclaration("extras", {
      "config.json": JSON.stringify({ expression: "0 9 * * *", cron: "x" }),
      "index.md": "Do things.",
    });
    const parsed = parsePluginScheduleDeclarations(pluginDir, "p");
    expect(parsed.errors[0]!.reason).toContain("invalid config");
  });

  test("invalid cron expression is an error", () => {
    writeDeclaration("badcron", {
      "config.json": JSON.stringify({
        expression: "99 99 * * *",
        expression_syntax: "cron",
      }),
      "index.md": "Do things.",
    });
    const parsed = parsePluginScheduleDeclarations(pluginDir, "p");
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]!.kind).toBe("invalid");
  });

  test("single-fire RRULE (COUNT=1) is rejected — declared schedules are recurring only", () => {
    writeDeclaration("oneshot", {
      "config.json": JSON.stringify({
        // Our recurrence engine requires DTSTART for deterministic scheduling.
        expression: "DTSTART:20190101T000000Z\nRRULE:FREQ=DAILY;COUNT=1",
        expression_syntax: "rrule",
      }),
      "index.md": "Do things.",
    });
    const parsed = parsePluginScheduleDeclarations(pluginDir, "p");
    expect(parsed.errors[0]!.reason).toContain(
      "declared schedules must be recurring",
    );
  });

  test("an already-ended recurrence fails closed with kind 'ended'", () => {
    writeDeclaration("ended", {
      "config.json": JSON.stringify({
        expression:
          "DTSTART:20190101T000000Z\nRRULE:FREQ=DAILY;UNTIL=20200101T000000Z",
        expression_syntax: "rrule",
      }),
      "index.md": "Do things.",
    });
    const parsed = parsePluginScheduleDeclarations(pluginDir, "p");
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]!.kind).toBe("ended");
  });

  test("frontmatter in index.md is rejected", () => {
    writeDeclaration("fm", {
      "config.json": VALID_CONFIG,
      "index.md": "---\ntitle: x\n---\nDo things.",
    });
    const parsed = parsePluginScheduleDeclarations(pluginDir, "p");
    expect(parsed.errors[0]!.reason).toContain("frontmatter");
  });

  test("empty prompt body is rejected", () => {
    writeDeclaration("empty", {
      "config.json": VALID_CONFIG,
      "index.md": "   \n  ",
    });
    const parsed = parsePluginScheduleDeclarations(pluginDir, "p");
    expect(parsed.errors[0]!.reason).toBe("prompt body is empty");
  });

  test("zero entrypoints fails closed", () => {
    writeDeclaration("none", { "config.json": VALID_CONFIG });
    const parsed = parsePluginScheduleDeclarations(pluginDir, "p");
    expect(parsed.errors[0]!.reason).toContain("no entrypoint");
  });

  test("multiple entrypoints fail closed rather than resolving by precedence", () => {
    writeDeclaration("both", {
      "config.json": VALID_CONFIG,
      "index.md": "Do things.",
      "index.sh": "echo hi",
    });
    const parsed = parsePluginScheduleDeclarations(pluginDir, "p");
    expect(parsed.errors[0]!.reason).toContain("multiple entrypoints");
  });

  test("unsupported entrypoint fails closed", () => {
    writeDeclaration("txt", {
      "config.json": VALID_CONFIG,
      "index.txt": "Do things.",
    });
    const parsed = parsePluginScheduleDeclarations(pluginDir, "p");
    expect(parsed.errors[0]!.reason).toContain(
      'unsupported entrypoint "index.txt"',
    );
  });

  test("one bad declaration never blocks siblings", () => {
    writeDeclaration("good", {
      "config.json": VALID_CONFIG,
      "index.md": "Do things.",
    });
    writeDeclaration("bad", { "index.md": "Missing config." });
    const parsed = parsePluginScheduleDeclarations(pluginDir, "p");
    expect(parsed.declarations).toHaveLength(1);
    expect(parsed.declarations[0]!.name).toBe("good");
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]!.scheduleName).toBe("bad");
  });

  test("definitionHash is stable across parses and changes when a file changes", () => {
    writeDeclaration("hashme", {
      "config.json": VALID_CONFIG,
      "index.md": "v1",
    });
    const first = parsePluginScheduleDeclarations(pluginDir, "p")
      .declarations[0]!.definitionHash;
    const second = parsePluginScheduleDeclarations(pluginDir, "p")
      .declarations[0]!.definitionHash;
    expect(second).toBe(first);
    writeFileSync(join(pluginDir, "schedules", "hashme", "index.md"), "v2");
    const third = parsePluginScheduleDeclarations(pluginDir, "p")
      .declarations[0]!.definitionHash;
    expect(third).not.toBe(first);
  });

  test("declared enabled:false is carried through", () => {
    writeDeclaration("off", {
      "config.json": JSON.stringify({
        expression: "0 9 * * *",
        enabled: false,
      }),
      "index.md": "Do things.",
    });
    const parsed = parsePluginScheduleDeclarations(pluginDir, "p");
    expect(parsed.declarations[0]!.config.enabled).toBe(false);
  });

  test("timeout_ms outside the script bounds is rejected", () => {
    writeDeclaration("timeout", {
      "config.json": JSON.stringify({
        expression: "0 9 * * *",
        timeout_ms: 1,
      }),
      "index.sh": "echo hi",
    });
    const parsed = parsePluginScheduleDeclarations(pluginDir, "p");
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]!.kind).toBe("invalid");
  });
});
