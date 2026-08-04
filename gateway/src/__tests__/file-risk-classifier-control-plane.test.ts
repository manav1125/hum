/**
 * Control-plane write escalation in the file risk classifier.
 *
 * A write under `prompts/`, `users/`, `channels/`, `tools/`, or `routes/`, or
 * to a root prompt file (SOUL.md and friends), can rewrite the assistant's own
 * system prompt or drop daemon-loaded code — including silencing the prompt
 * sections that defend against credential custody and external-content
 * injection. These must classify high so the ordinary "workspace-scoped
 * low-risk operation" auto-approval can never claim them.
 */

import { describe, expect, test } from "bun:test";

import type { FileClassificationContext } from "../risk/file-risk-classifier.js";
import { FileRiskClassifier } from "../risk/file-risk-classifier.js";

const WORKSPACE = "/workspace";

function makeContext(
  overrides: Partial<FileClassificationContext> = {},
): FileClassificationContext {
  return {
    protectedDir: "/data/protected",
    deprecatedDir: "/data/deprecated",
    hooksDir: `${WORKSPACE}/hooks`,
    pluginsDir: `${WORKSPACE}/plugins`,
    skillSourceDirs: [`${WORKSPACE}/skills`],
    controlPlaneDirs: [
      `${WORKSPACE}/prompts`,
      `${WORKSPACE}/users`,
      `${WORKSPACE}/channels`,
      `${WORKSPACE}/tools`,
      `${WORKSPACE}/routes`,
    ],
    controlPlaneFiles: [
      `${WORKSPACE}/SOUL.md`,
      `${WORKSPACE}/IDENTITY.md`,
      `${WORKSPACE}/NOW.md`,
      `${WORKSPACE}/HEARTBEAT.md`,
    ],
    ...overrides,
  };
}

async function classifyWrite(
  filePath: string,
  context = makeContext(),
): Promise<{ riskLevel: string; reason: string }> {
  const classifier = new FileRiskClassifier();
  const assessment = await classifier.classify(
    { toolName: "file_write", filePath, workingDir: WORKSPACE },
    context,
  );
  return { riskLevel: assessment.riskLevel, reason: assessment.reason };
}

describe("FileRiskClassifier — control-plane surfaces", () => {
  test("system-prompt section override classifies high", async () => {
    const result = await classifyWrite(
      `${WORKSPACE}/prompts/system/06-credential-security.md`,
    );
    expect(result.riskLevel).toBe("high");
    expect(result.reason).toContain("control-plane");
  });

  test("relative path resolving into prompts/ classifies high", async () => {
    const result = await classifyWrite("prompts/system/07-external-content.md");
    expect(result.riskLevel).toBe("high");
  });

  test("root prompt files classify high", async () => {
    for (const file of ["SOUL.md", "IDENTITY.md", "NOW.md", "HEARTBEAT.md"]) {
      const result = await classifyWrite(`${WORKSPACE}/${file}`);
      expect(result.riskLevel).toBe("high");
    }
  });

  test("persona and executable-sink dirs classify high", async () => {
    for (const path of [
      "users/default.md",
      "channels/slack.md",
      "tools/custom-tool.ts",
      "routes/handler.ts",
    ]) {
      const result = await classifyWrite(`${WORKSPACE}/${path}`);
      expect(result.riskLevel).toBe("high");
    }
  });

  test("ordinary workspace writes stay low risk", async () => {
    for (const path of [
      `${WORKSPACE}/notes/todo.md`,
      `${WORKSPACE}/promptset.md`, // prefix of "prompts" must not match
      `${WORKSPACE}/data/routes.csv`,
    ]) {
      const result = await classifyWrite(path);
      expect(result.riskLevel).toBe("low");
    }
  });

  test("reads of control-plane files stay low risk", async () => {
    const classifier = new FileRiskClassifier();
    const assessment = await classifier.classify(
      {
        toolName: "file_read",
        filePath: `${WORKSPACE}/SOUL.md`,
        workingDir: WORKSPACE,
      },
      makeContext(),
    );
    expect(assessment.riskLevel).toBe("low");
  });

  test("absent context fields never escalate (older assistant compat)", async () => {
    const result = await classifyWrite(
      `${WORKSPACE}/prompts/system/06-credential-security.md`,
      makeContext({
        controlPlaneDirs: undefined,
        controlPlaneFiles: undefined,
      }),
    );
    expect(result.riskLevel).toBe("low");
  });
});
