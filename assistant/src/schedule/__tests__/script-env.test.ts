/**
 * A scheduled script's declared environment.
 *
 * The point of the channel is that a secret can reach an unattended child
 * without appearing in the command string (visible in `ps`, stored verbatim
 * on the schedule) and without an approval prompt nobody is present to
 * answer. These tests pin the failure behaviour: an unresolvable reference
 * stops the run instead of silently unsetting the variable.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const SECRET = "xoxb-not-a-real-token";

interface FakeCredential {
  service: string;
  field: string;
  allowedTools: string[];
}

let credentials: Record<string, FakeCredential> = {};
let secrets: Record<string, string> = {};

const actualResolve = await import("../../tools/credentials/resolve.js");
mock.module("../../tools/credentials/resolve.js", () => ({
  ...actualResolve,
  resolveCredentialRef: (ref: string) => {
    const c = credentials[ref];
    if (!c) return undefined;
    return {
      credentialId: `id-${ref}`,
      service: c.service,
      field: c.field,
      storageKey: `${c.service}:${c.field}`,
      injectionTemplates: [],
      metadata: {
        credentialId: `id-${ref}`,
        service: c.service,
        field: c.field,
        allowedTools: c.allowedTools,
        allowedDomains: [],
        createdAt: 0,
        updatedAt: 0,
      },
    };
  },
}));

const actualSecureKeys = await import("../../security/secure-keys.js");
mock.module("../../security/secure-keys.js", () => ({
  ...actualSecureKeys,
  getSecureKeyAsync: async (key: string) => secrets[key] ?? null,
}));

const actualCredentialKey = await import("../../security/credential-key.js");
mock.module("../../security/credential-key.js", () => ({
  ...actualCredentialKey,
  credentialKey: (service: string, field: string) => `${service}:${field}`,
}));

const {
  resolveScheduleScriptEnv,
  ScheduleEnvError,
  scheduleCredentialConsumer,
} = await import("../script-env.js");

const JOB = "job-signals-dispatch";

beforeEach(() => {
  credentials = {
    "slack_channel/bot_token": {
      service: "slack_channel",
      field: "bot_token",
      allowedTools: [scheduleCredentialConsumer(JOB)],
    },
  };
  secrets = { "slack_channel:bot_token": SECRET };
});

afterEach(() => {
  credentials = {};
  secrets = {};
});

describe("no declared environment", () => {
  test("null, undefined and blank all mean 'nothing declared'", async () => {
    expect(await resolveScheduleScriptEnv(JOB, null)).toBeUndefined();
    expect(await resolveScheduleScriptEnv(JOB, undefined)).toBeUndefined();
    expect(await resolveScheduleScriptEnv(JOB, "   ")).toBeUndefined();
  });
});

describe("resolution", () => {
  test("substitutes a credential reference at fire time", async () => {
    const env = await resolveScheduleScriptEnv(
      JOB,
      JSON.stringify({
        SLACK_BOT_TOKEN: "${credential:slack_channel/bot_token}",
      }),
    );
    expect(env).toEqual({ SLACK_BOT_TOKEN: SECRET });
  });

  test("passes plain values through", async () => {
    const env = await resolveScheduleScriptEnv(
      JOB,
      JSON.stringify({ ATLAS_BASE_URL: "https://atlas.example.com" }),
    );
    expect(env).toEqual({ ATLAS_BASE_URL: "https://atlas.example.com" });
  });
});

describe("the run fails rather than running under-provisioned", () => {
  test("a credential the schedule is not allowed to use", async () => {
    credentials["slack_channel/bot_token"]!.allowedTools = ["bash"];
    await expect(
      resolveScheduleScriptEnv(
        JOB,
        JSON.stringify({ T: "${credential:slack_channel/bot_token}" }),
      ),
    ).rejects.toBeInstanceOf(ScheduleEnvError);
  });

  test("a credential with no stored value", async () => {
    secrets = {};
    await expect(
      resolveScheduleScriptEnv(
        JOB,
        JSON.stringify({ T: "${credential:slack_channel/bot_token}" }),
      ),
    ).rejects.toThrow(/no stored value/);
  });

  test("malformed JSON", async () => {
    await expect(resolveScheduleScriptEnv(JOB, "{not json")).rejects.toThrow(
      /not valid JSON/,
    );
  });

  test("a JSON array is not an environment", async () => {
    await expect(resolveScheduleScriptEnv(JOB, "[]")).rejects.toThrow(
      /must be a JSON object/,
    );
  });

  test("a non-string value is rejected", async () => {
    await expect(
      resolveScheduleScriptEnv(JOB, JSON.stringify({ N: 42 })),
    ).rejects.toThrow(/must be a string/);
  });
});

describe("the secret does not leak into the error", () => {
  test("a denied reference names the credential, not the value", async () => {
    credentials["slack_channel/bot_token"]!.allowedTools = ["bash"];
    let err: unknown;
    try {
      await resolveScheduleScriptEnv(
        JOB,
        JSON.stringify({ T: "${credential:slack_channel/bot_token}" }),
      );
    } catch (e) {
      err = e;
    }
    const serialized = `${(err as Error).message} ${(err as Error).stack ?? ""}`;
    expect(serialized).not.toContain(SECRET);
    expect(serialized).toContain("slack_channel/bot_token");
  });
});

describe("consumer identity", () => {
  test("is scoped per schedule, so one job's grant is not another's", () => {
    expect(scheduleCredentialConsumer("a")).toBe("schedule:a");
    expect(scheduleCredentialConsumer("b")).not.toBe(
      scheduleCredentialConsumer("a"),
    );
  });
});
