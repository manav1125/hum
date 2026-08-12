/**
 * Tests for the Slack watcher provider.
 *
 * What these pin, in order of importance:
 *  1. No firehose — an empty channel list makes zero API calls and produces
 *     nothing, and `describeScope` says the watcher cannot produce.
 *  2. Membership filter — configured channels the bot is not a member of are
 *     skipped, and `not_in_channel` from the history call is a skip, not a
 *     poll failure.
 *  3. Watermark — per-channel cursors advance to the newest ts seen
 *     (including messages we do not surface), first poll starts from the
 *     floor, and cursors for dropped channels are pruned.
 *  4. Untrusted marking — the provider declares `untrustedContentSource:
 *     "slack"`, which is what makes the engine fence its payloads, and
 *     message text is capped at the source.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { WATCHER_PAYLOAD_TEXT_MAX_CHARS } from "../constants.js";
import type { WatcherItem } from "../provider-types.js";

// ── Fake Slack Web API behind the connection layer ────────────────────

/** Every request the provider sent: [path, query]. */
let requests: Array<{ path: string; query: Record<string, string> }> = [];
/** Channel IDs `users.conversations` reports the bot as a member of. */
let memberChannels: string[] | null = [];
/** Per-channel `conversations.history` responses. */
let historyByChannel: Record<string, unknown> = {};
/** Which credential services `resolveOAuthConnection` was asked for. */
let resolvedServices: string[] = [];
/** Services whose resolution should throw (simulate "not connected"). */
let failingServices: Set<string> = new Set();

const fakeConnection = {
  id: "conn-slack",
  provider: "slack",
  accountInfo: null,
  withToken: async () => {
    throw new Error("not used");
  },
  request: async (req: {
    path: string;
    query?: Record<string, string>;
    baseUrl?: string;
  }) => {
    requests.push({ path: req.path, query: req.query ?? {} });
    // The provider must always name the Slack host explicitly — the Composio
    // proxy path has no fallback base URL for the Slack toolkit.
    expect(req.baseUrl).toBe("https://slack.com/api");
    if (req.path === "/users.conversations") {
      if (memberChannels === null) {
        return { status: 200, headers: {}, body: { ok: false, error: "boom" } };
      }
      return {
        status: 200,
        headers: {},
        body: { ok: true, channels: memberChannels.map((id) => ({ id })) },
      };
    }
    if (req.path === "/conversations.history") {
      const channel = req.query?.channel ?? "";
      const body = historyByChannel[channel] ?? {
        ok: false,
        error: "channel_not_found",
      };
      return { status: 200, headers: {}, body };
    }
    throw new Error(`Unexpected Slack call: ${req.path}`);
  },
};

// Spread the real module — mock.module is process-global, and a hand-written
// export list would delete every other export for later test files.
const realResolver = await import("../../oauth/connection-resolver.js");
mock.module("../../oauth/connection-resolver.js", () => ({
  ...realResolver,
  resolveOAuthConnection: async (service: string) => {
    resolvedServices.push(service);
    if (failingServices.has(service)) {
      throw new Error(`No active OAuth connection found for "${service}"`);
    }
    return fakeConnection;
  },
}));

const { slackProvider } = await import("../providers/slack.js");

afterEach(() => {
  requests = [];
  memberChannels = [];
  historyByChannel = {};
  resolvedServices = [];
  failingServices = new Set();
});

// ── Helpers ───────────────────────────────────────────────────────────

function msg(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "message",
    user: "U111",
    text: "hello there",
    ts: "1723459300.000100",
    ...overrides,
  };
}

function watermark(
  floor: string,
  channels: Record<string, string> = {},
): string {
  return JSON.stringify({ floor, channels });
}

// ── Untrusted marking ─────────────────────────────────────────────────

describe("slackProvider untrusted-content declaration", () => {
  test("declares its payloads as slack-source external content", () => {
    // This single field is what routes every Slack message body into the
    // engine's <external_content source="slack"> fence — third-party text
    // must never enter a prompt unfenced.
    expect(slackProvider.untrustedContentSource).toBe("slack");
  });
});

// ── describeScope ─────────────────────────────────────────────────────

describe("slackProvider.describeScope", () => {
  test("no channel list means the watcher CANNOT produce", () => {
    const scope = slackProvider.describeScope!({});
    expect(scope.watching).toBe(false);
    expect(scope.fix).toBeTruthy();
  });

  test("a channel list is named in the summary", () => {
    const scope = slackProvider.describeScope!({ channels: ["C1", "C2"] });
    expect(scope.watching).toBe(true);
    expect(scope.summary).toContain("C1");
    expect(scope.summary).toContain("2 Slack channels");
  });
});

// ── No firehose ───────────────────────────────────────────────────────

describe("slackProvider.fetchNew — no firehose", () => {
  test("empty channel config polls nothing and calls nothing", async () => {
    const result = await slackProvider.fetchNew(
      "slack",
      watermark("100.000000"),
      {},
      "w1",
    );
    expect(result.items).toEqual([]);
    expect(requests).toEqual([]);
    expect(resolvedServices).toEqual([]);
  });
});

// ── Membership filter ─────────────────────────────────────────────────

describe("slackProvider.fetchNew — membership filter", () => {
  test("skips configured channels the bot is not a member of", async () => {
    memberChannels = ["C_IN"];
    historyByChannel = {
      C_IN: { ok: true, messages: [msg({ ts: "200.000100" })] },
      C_OUT: { ok: true, messages: [msg({ ts: "999.000100" })] },
    };

    const result = await slackProvider.fetchNew(
      "slack",
      watermark("100.000000"),
      { channels: ["C_IN", "C_OUT"] },
      "w1",
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.payload.channel).toBe("C_IN");
    // C_OUT's history was never even requested.
    const histories = requests.filter(
      (r) => r.path === "/conversations.history",
    );
    expect(histories.map((r) => r.query.channel)).toEqual(["C_IN"]);
  });

  test("when membership cannot be read, not_in_channel is a skip — not a poll failure", async () => {
    memberChannels = null; // users.conversations fails
    historyByChannel = {
      C_A: { ok: false, error: "not_in_channel" },
      C_B: { ok: true, messages: [msg({ ts: "300.000100" })] },
    };

    const result = await slackProvider.fetchNew(
      "slack",
      watermark("100.000000"),
      { channels: ["C_A", "C_B"] },
      "w1",
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.payload.channel).toBe("C_B");
  });

  test("a real API error still fails the poll", async () => {
    memberChannels = ["C_A"];
    historyByChannel = { C_A: { ok: false, error: "invalid_auth" } };

    await expect(
      slackProvider.fetchNew(
        "slack",
        watermark("100.000000"),
        { channels: ["C_A"] },
        "w1",
      ),
    ).rejects.toThrow(/invalid_auth/);
  });
});

// ── Watermark behaviour ───────────────────────────────────────────────

describe("slackProvider.fetchNew — watermark", () => {
  test("first poll of a channel starts from the floor, not from zero", async () => {
    memberChannels = ["C_A"];
    historyByChannel = { C_A: { ok: true, messages: [] } };

    await slackProvider.fetchNew(
      "slack",
      watermark("1723459200.000000"),
      { channels: ["C_A"] },
      "w1",
    );

    const history = requests.find((r) => r.path === "/conversations.history")!;
    expect(history.query.oldest).toBe("1723459200.000000");
    expect(history.query.inclusive).toBe("false");
  });

  test("cursor advances to the newest ts seen, including unsurfaced messages", async () => {
    memberChannels = ["C_A"];
    historyByChannel = {
      C_A: {
        ok: true,
        messages: [
          // Newest first, as Slack returns them. The bot message is not
          // surfaced but must still advance the cursor, or the same window
          // re-fetches forever.
          msg({ ts: "500.000300", bot_id: "B1", user: undefined }),
          msg({ ts: "400.000200" }),
        ],
      },
    };

    const result = await slackProvider.fetchNew(
      "slack",
      watermark("100.000000", { C_A: "300.000100" }),
      { channels: ["C_A"] },
      "w1",
    );

    expect(result.items).toHaveLength(1); // only the human message
    const next = JSON.parse(result.watermark) as {
      channels: Record<string, string>;
    };
    expect(next.channels.C_A).toBe("500.000300");
  });

  test("cursors for channels no longer configured are pruned", async () => {
    memberChannels = ["C_A"];
    historyByChannel = { C_A: { ok: true, messages: [] } };

    const result = await slackProvider.fetchNew(
      "slack",
      watermark("100.000000", { C_A: "200.000100", C_GONE: "900.000900" }),
      { channels: ["C_A"] },
      "w1",
    );

    const next = JSON.parse(result.watermark) as {
      channels: Record<string, string>;
    };
    expect(Object.keys(next.channels)).toEqual(["C_A"]);
  });

  test("getInitialWatermark needs no API call and carries a floor", async () => {
    const raw = await slackProvider.getInitialWatermark("slack");
    const parsed = JSON.parse(raw) as { floor: string; channels: unknown };
    expect(parsed.floor).toMatch(/^\d+\.\d+$/);
    expect(parsed.channels).toEqual({});
    expect(requests).toEqual([]);
  });
});

// ── Message filtering & payload shape ─────────────────────────────────

describe("slackProvider.fetchNew — message filtering", () => {
  test("drops joins, bot posts and threads-metadata noise; keeps human messages", async () => {
    memberChannels = ["C_A"];
    historyByChannel = {
      C_A: {
        ok: true,
        messages: [
          msg({ ts: "600.000500", subtype: "channel_join" }),
          msg({ ts: "600.000400", bot_id: "B7", user: undefined }),
          msg({ ts: "600.000300", text: "real message", thread_ts: "500.1" }),
        ],
      },
    };

    const result = await slackProvider.fetchNew(
      "slack",
      watermark("100.000000"),
      { channels: ["C_A"] },
      "w1",
    );

    expect(result.items).toHaveLength(1);
    const item = result.items[0]! as WatcherItem;
    expect(item.externalId).toBe("C_A:600.000300");
    expect(item.eventType).toBe("new_message");
    expect(item.payload).toMatchObject({
      channel: "C_A",
      user: "U111",
      text: "real message",
      threadTs: "500.1",
    });
    expect(item.timestamp).toBe(600_000);
  });

  test("caps message text at the source", async () => {
    memberChannels = ["C_A"];
    historyByChannel = {
      C_A: {
        ok: true,
        messages: [
          msg({ ts: "700.000100", text: "x".repeat(40_000) }),
        ],
      },
    };

    const result = await slackProvider.fetchNew(
      "slack",
      watermark("100.000000"),
      { channels: ["C_A"] },
      "w1",
    );

    const text = result.items[0]!.payload.text as string;
    expect(text.length).toBeLessThanOrEqual(WATCHER_PAYLOAD_TEXT_MAX_CHARS);
  });
});

// ── Credential layering ───────────────────────────────────────────────

describe("slackProvider.fetchNew — credential resolution", () => {
  test("falls back to the slack_channel bot token when the primary service is unavailable", async () => {
    failingServices = new Set(["slack"]);
    memberChannels = ["C_A"];
    historyByChannel = { C_A: { ok: true, messages: [] } };

    await slackProvider.fetchNew(
      "slack",
      watermark("100.000000"),
      { channels: ["C_A"] },
      "w1",
    );

    expect(resolvedServices).toEqual(["slack", "slack_channel"]);
  });
});
