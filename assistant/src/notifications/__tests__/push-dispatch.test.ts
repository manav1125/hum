/**
 * Tests for the mobile push dispatch mirror: which hub events page devices,
 * the payload contract the iOS shell parses (CueNotificationRouter reads
 * custom keys off the payload root), category/quiet-hours preference
 * gating (checked BEFORE throttle state is recorded), per-item throttles,
 * and invalid-token pruning. The APNs HTTP/2 client is mocked — no real
 * pushes leave this file.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// ── APNs sender mock (capture alerts, controllable per-send result) ────
import type { ApnsAlert, ApnsSendResult } from "../apns-sender.js";

interface SentPush {
  token: string;
  alert: ApnsAlert;
}
const sentPushes: SentPush[] = [];
let apnsConfigured = true;
let nextSendResult: ApnsSendResult = { ok: true };
mock.module("../apns-sender.js", () => ({
  isApnsConfigured: () => apnsConfigured,
  sendApnsAlert: async (
    token: string,
    alert: ApnsAlert,
  ): Promise<ApnsSendResult> => {
    sentPushes.push({ token, alert });
    return nextSendResult;
  },
}));

// ── Device registry mock ───────────────────────────────────────────────
let devices: Array<{ id: string; token: string }> = [];
const removedTokens: string[] = [];
mock.module("../push-device-store.js", () => ({
  listPushDevices: () =>
    devices.map((d) => ({
      ...d,
      platform: "ios",
      deviceName: null,
      createdAt: 0,
      updatedAt: 0,
      lastSeenAt: 0,
    })),
  removePushDevice: (token: string) => {
    removedTokens.push(token);
    return true;
  },
}));

// ── Config mock (drives the real push-prefs gate) ──────────────────────
import {
  type PushConfig,
  PushConfigSchema,
} from "../../config/schemas/notifications.js";

let pushConfig: PushConfig = PushConfigSchema.parse({});
mock.module("../../config/loader.js", () => ({
  getConfig: () => ({ notifications: { push: pushConfig } }),
}));

// ── Work-item store mock (lazy-imported by the dispatcher) ─────────────
mock.module("../../work-items/work-item-store.js", () => ({
  getWorkItem: (id: string) => ({ id, title: `Task ${id}` }),
}));

import type { ServerMessage } from "../../daemon/message-protocol.js";
import { dispatchPushForServerMessage } from "../push-dispatch.js";

let seq = 0;
function uniqueId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

function workItemCompleted(
  workItemId: string,
  status: "done" | "awaiting_review" | "failed" = "awaiting_review",
): ServerMessage {
  return {
    type: "work_item_completed",
    workItemId,
    status,
    result: { summary: "done", highlights: [], conversationId: "conv-1" },
    completedAt: new Date().toISOString(),
  } as ServerMessage;
}

function confirmationRequest(requestId: string): ServerMessage {
  return {
    type: "confirmation_request",
    requestId,
    toolName: "send_email",
    conversationId: uniqueId("conv"),
  } as unknown as ServerMessage;
}

/** A quiet-hours window guaranteed to contain "now" (daemon-local clock). */
function quietHoursAroundNow(): { start: string; end: string } {
  const pad = (n: number) => String(n).padStart(2, "0");
  const now = new Date();
  const at = (offsetHours: number) => {
    const h = (now.getHours() + offsetHours + 24) % 24;
    return `${pad(h)}:${pad(now.getMinutes())}`;
  };
  return { start: at(-2), end: at(2) };
}

beforeEach(() => {
  sentPushes.length = 0;
  removedTokens.length = 0;
  apnsConfigured = true;
  nextSendResult = { ok: true };
  devices = [{ id: "dev-1", token: "tok-1" }];
  pushConfig = PushConfigSchema.parse({});
});

describe("work_item_completed dispatch", () => {
  test("awaiting_review fans out to every device with the iOS payload contract", async () => {
    devices = [
      { id: "dev-1", token: "tok-1" },
      { id: "dev-2", token: "tok-2" },
    ];
    const id = uniqueId("wi");
    await dispatchPushForServerMessage(workItemCompleted(id));

    expect(sentPushes.map((p) => p.token).sort()).toEqual(["tok-1", "tok-2"]);
    const alert = sentPushes[0]!.alert;
    expect(alert.title).toBe("Cue finished a task");
    expect(alert.body).toContain(`Task ${id}`);
    expect(alert.collapseId).toBe(`wi-${id}`);
    expect(alert.threadId).toBe("cue-work-items");
    // Custom keys CueNotificationRouter receives in userInfo.
    expect(alert.data).toEqual({
      kind: "work_item_completed",
      workItemId: id,
      conversationId: "conv-1",
    });
  });

  test("done and failed completions do not page the phone", async () => {
    await dispatchPushForServerMessage(
      workItemCompleted(uniqueId("wi"), "done"),
    );
    await dispatchPushForServerMessage(
      workItemCompleted(uniqueId("wi"), "failed"),
    );
    expect(sentPushes).toHaveLength(0);
  });

  test("per-item throttle: a repeat completion within the window is dropped", async () => {
    const id = uniqueId("wi");
    await dispatchPushForServerMessage(workItemCompleted(id));
    await dispatchPushForServerMessage(workItemCompleted(id));
    expect(sentPushes).toHaveLength(1);
  });

  test("reviewReady category off suppresses the push without consuming the throttle", async () => {
    const id = uniqueId("wi");
    pushConfig = {
      ...pushConfig,
      categories: { ...pushConfig.categories, reviewReady: false },
    };
    await dispatchPushForServerMessage(workItemCompleted(id));
    expect(sentPushes).toHaveLength(0);

    // Re-enabled: the same item can still page (the gate ran before any
    // throttle state was recorded).
    pushConfig = PushConfigSchema.parse({});
    await dispatchPushForServerMessage(workItemCompleted(id));
    expect(sentPushes).toHaveLength(1);
  });

  test("unconfigured APNs is a silent no-op", async () => {
    apnsConfigured = false;
    await dispatchPushForServerMessage(workItemCompleted(uniqueId("wi")));
    expect(sentPushes).toHaveLength(0);
  });
});

describe("confirmation_request dispatch", () => {
  test("an approval request pages once with the needsYou payload", async () => {
    const id = uniqueId("req");
    const msg = confirmationRequest(id);
    await dispatchPushForServerMessage(msg);
    await dispatchPushForServerMessage(msg);

    expect(sentPushes).toHaveLength(1);
    const alert = sentPushes[0]!.alert;
    expect(alert.title).toBe("Cue needs your approval");
    expect(alert.body).toContain("send_email");
    expect(alert.collapseId).toBe(`conf-${id}`);
    expect(alert.threadId).toBe("cue-approvals");
    expect(alert.data).toMatchObject({
      kind: "confirmation_request",
      requestId: id,
      toolName: "send_email",
    });
  });

  test("quiet hours drop the push without consuming the one-shot", async () => {
    const id = uniqueId("req");
    pushConfig = {
      ...pushConfig,
      quietHours: { ...quietHoursAroundNow(), timezone: null },
    };
    await dispatchPushForServerMessage(confirmationRequest(id));
    expect(sentPushes).toHaveLength(0);

    // Quiet hours over: the same request may still page.
    pushConfig = PushConfigSchema.parse({});
    await dispatchPushForServerMessage(confirmationRequest(id));
    expect(sentPushes).toHaveLength(1);
  });

  test("needsYou category off suppresses approval pushes", async () => {
    pushConfig = {
      ...pushConfig,
      categories: { ...pushConfig.categories, needsYou: false },
    };
    await dispatchPushForServerMessage(confirmationRequest(uniqueId("req")));
    expect(sentPushes).toHaveLength(0);
  });
});

describe("token pruning", () => {
  test("tokens APNs reports invalid are removed from the registry", async () => {
    nextSendResult = {
      ok: false,
      reason: "Unregistered",
      status: 410,
      tokenInvalid: true,
    };
    await dispatchPushForServerMessage(workItemCompleted(uniqueId("wi")));
    expect(removedTokens).toEqual(["tok-1"]);
  });

  test("transient failures do not prune", async () => {
    nextSendResult = { ok: false, reason: "timeout" };
    await dispatchPushForServerMessage(workItemCompleted(uniqueId("wi")));
    expect(removedTokens).toHaveLength(0);
  });
});
