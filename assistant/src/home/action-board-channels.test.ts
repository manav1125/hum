/**
 * Unit tests for the multi-source channel gather (Part B).
 *
 * Exercises the per-channel BOUNDED fetch and the connected-channel gating
 * using mock MessagingProviders — no network, no real OAuth. Verifies:
 *   - the fetch caps conversations + messages and respects the lookback window
 *   - unread / recently-active conversations are preferred
 *   - a provider that throws degrades to an empty list (failure isolation)
 *   - channel→category mapping
 */

import { describe, expect, it } from "bun:test";

import type { MessagingProvider } from "../messaging/provider.js";
import type { Conversation, Message } from "../messaging/provider-types.js";
import {
  channelToCategory,
  fetchChannelConversations,
} from "./action-board.js";

const NOW = new Date("2026-06-20T12:00:00Z");

function convo(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "C1",
    name: "#eng",
    type: "channel",
    platform: "slack",
    unreadCount: 0,
    lastActivityAt: NOW.getTime(),
    ...overrides,
  };
}

function msg(overrides: Partial<Message> = {}): Message {
  return {
    id: "m1",
    conversationId: "C1",
    sender: { id: "U1", name: "Jane" },
    text: "Can you review the budget?",
    timestamp: NOW.getTime(),
    platform: "slack",
    ...overrides,
  };
}

/** A mock provider whose credentials are self-managed (isConnected → true). */
function mockProvider(opts: {
  conversations: Conversation[] | (() => Promise<Conversation[]>);
  history?: (id: string) => Promise<Message[]>;
}): MessagingProvider {
  return {
    id: "slack",
    displayName: "Slack",
    credentialService: "slack",
    capabilities: new Set<string>(),
    isConnected: async () => true,
    testConnection: async () => ({
      connected: true,
      user: "me",
      platform: "slack",
    }),
    listConversations: async () =>
      typeof opts.conversations === "function"
        ? opts.conversations()
        : opts.conversations,
    getHistory: async (_conn, id) =>
      opts.history ? opts.history(id) : [msg({ conversationId: id })],
    search: async () => ({ total: 0, messages: [], hasMore: false }),
    sendMessage: async () => ({ id: "x", timestamp: 0, conversationId: "C1" }),
  };
}

describe("channelToCategory", () => {
  it("maps provider ids to feed categories", () => {
    expect(channelToCategory("slack")).toBe("slack");
    expect(channelToCategory("telegram-bot")).toBe("telegram");
    expect(channelToCategory("whatsapp")).toBe("whatsapp");
    expect(channelToCategory("discord")).toBe("chat");
  });
});

describe("fetchChannelConversations (bounded fetch)", () => {
  it("gathers recent messages tagged with channel + conversation", async () => {
    const provider = mockProvider({
      conversations: [convo({ id: "C1", unreadCount: 2 })],
    });
    const result = await fetchChannelConversations(provider, NOW);
    expect(result).toHaveLength(1);
    expect(result[0].channel).toBe("slack");
    expect(result[0].conversationId).toBe("C1");
    expect(result[0].messages.length).toBeGreaterThan(0);
    expect(result[0].messages[0].text).toContain("budget");
  });

  it("caps conversations to the per-channel limit (15)", async () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      convo({ id: `C${i}`, unreadCount: 1 }),
    );
    const provider = mockProvider({ conversations: many });
    const result = await fetchChannelConversations(provider, NOW);
    expect(result.length).toBeLessThanOrEqual(15);
  });

  it("skips stale read conversations outside the lookback window", async () => {
    const stale = convo({
      id: "C-stale",
      unreadCount: 0,
      lastActivityAt: NOW.getTime() - 7 * 24 * 60 * 60 * 1000,
    });
    const provider = mockProvider({ conversations: [stale] });
    const result = await fetchChannelConversations(provider, NOW);
    expect(result).toHaveLength(0);
  });

  it("drops messages older than the lookback window", async () => {
    const provider = mockProvider({
      conversations: [convo({ id: "C1", unreadCount: 1 })],
      history: async (id) => [
        msg({ id: "old", conversationId: id, timestamp: NOW.getTime() - 1e10 }),
        msg({ id: "new", conversationId: id, timestamp: NOW.getTime() }),
      ],
    });
    const result = await fetchChannelConversations(provider, NOW);
    expect(result).toHaveLength(1);
    expect(result[0].messages).toHaveLength(1);
  });

  it("isolates failures — a throwing provider yields an empty list", async () => {
    const provider = mockProvider({
      conversations: () => {
        throw new Error("slack api down");
      },
    });
    const result = await fetchChannelConversations(provider, NOW);
    expect(result).toEqual([]);
  });
});
