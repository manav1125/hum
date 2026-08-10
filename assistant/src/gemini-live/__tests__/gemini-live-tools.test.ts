/**
 * The curated voice toolset bridge (H-1): declarations stay under the schema
 * budget, every declared function dispatches (no dead declarations), registry-
 * backed calls reach the real executor path with the mapped inputs, permission
 * denials surface as spoken-safe errors, `ui_show` produces a normalized card,
 * and an unknown function degrades gracefully.
 *
 * Registry execution is driven through the `runRegistryTool` seam — the
 * production default (the shared ToolExecutor) needs a running daemon registry;
 * the seam lets these tests assert the DISPATCH contract (tool name + input
 * mapping + result shaping) hermetically.
 */

import { describe, expect, mock, test } from "bun:test";

const loggerActual = await import("../../util/logger.js");
mock.module("../../util/logger.js", () => ({
  ...loggerActual,
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

const {
  executeGeminiLiveFunctionCall,
  GEMINI_LIVE_FUNCTION_DECLARATIONS,
  GEMINI_LIVE_TOOL_SCHEMA_BUDGET_BYTES,
  GEMINI_LIVE_VOICE_SKILLS,
  geminiLiveDeclarationsJsonBytes,
} = await import("../gemini-live-tools.js");

type RegistryCall = { name: string; input: Record<string, unknown> };
type GeminiLiveCard = import("../gemini-live-tools.js").GeminiLiveCard;

/** Context with a recording fake registry runner. */
function makeCtx(
  result: { content: string; isError?: boolean } = { content: "ok!" },
) {
  const registryCalls: RegistryCall[] = [];
  const cards: GeminiLiveCard[] = [];
  const ctx = {
    conversationId: "conv-1",
    showCard: (card: GeminiLiveCard) => {
      cards.push(card);
    },
    runRegistryTool: async (name: string, input: Record<string, unknown>) => {
      registryCalls.push({ name, input });
      return { content: result.content, isError: result.isError ?? false };
    },
  };
  return { ctx, registryCalls, cards };
}

describe("gemini-live tool declarations", () => {
  test("serialized declarations stay under the schema budget", () => {
    expect(geminiLiveDeclarationsJsonBytes()).toBeLessThanOrEqual(
      GEMINI_LIVE_TOOL_SCHEMA_BUDGET_BYTES,
    );
  });

  test("declaration names are unique and every one has a description", () => {
    const names = GEMINI_LIVE_FUNCTION_DECLARATIONS.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
    for (const d of GEMINI_LIVE_FUNCTION_DECLARATIONS) {
      expect(d.description.length).toBeGreaterThan(0);
    }
  });

  test("every declared function actually dispatches (no dead declarations)", async () => {
    // Empty args: validation-first tools reject before touching stores, and
    // registry-backed reads hit the fake runner. The one outcome that must
    // never appear for a DECLARED name is the unknown-function fallback.
    for (const d of GEMINI_LIVE_FUNCTION_DECLARATIONS) {
      const { ctx } = makeCtx();
      const out = await executeGeminiLiveFunctionCall(
        { name: d.name, args: {} },
        ctx,
      );
      const response = out.response as { ok?: boolean; error?: string };
      expect(response.error ?? "").not.toContain("unknown function");
    }
  });

  test("the voice skill list covers the registry-backed skill tools", () => {
    expect([...GEMINI_LIVE_VOICE_SKILLS].sort()).toEqual([
      "contacts",
      "followups",
      "messaging",
      "schedule",
    ]);
  });
});

describe("registry-backed dispatch", () => {
  test("web_search reaches the real executor path with the mapped input", async () => {
    const { ctx, registryCalls } = makeCtx({ content: "top results" });
    const out = await executeGeminiLiveFunctionCall(
      { id: "c1", name: "web_search", args: { query: "surf report canggu" } },
      ctx,
    );
    expect(registryCalls).toEqual([
      { name: "web_search", input: { query: "surf report canggu", count: 5 } },
    ]);
    expect(out.response).toEqual({ ok: true, result: "top results" });
    expect(out.id).toBe("c1");
  });

  test("recall_memory maps to the registered `recall` tool at fast depth", async () => {
    const { ctx, registryCalls } = makeCtx();
    await executeGeminiLiveFunctionCall(
      { name: "recall_memory", args: { query: "sister birthday" } },
      ctx,
    );
    expect(registryCalls).toEqual([
      { name: "recall", input: { query: "sister birthday", depth: "fast" } },
    ]);
  });

  test("a permission denial comes back as a spoken-safe error, not success", async () => {
    const { ctx } = makeCtx({
      content:
        'Permission denied: tool "schedule_create" requires user approval but no interactive client is connected.',
      isError: true,
    });
    const out = await executeGeminiLiveFunctionCall(
      {
        name: "set_reminder",
        args: { message: "stretch", when: "2027-01-01T10:00:00" },
      },
      ctx,
    );
    const response = out.response as { ok: boolean; error: string };
    expect(response.ok).toBe(false);
    expect(response.error).toContain("Permission denied");
  });

  test("a throwing registry runner degrades to { ok: false } instead of throwing", async () => {
    const out = await executeGeminiLiveFunctionCall(
      { name: "web_search", args: { query: "x" } },
      {
        conversationId: "conv-1",
        runRegistryTool: async () => {
          throw new Error("registry exploded");
        },
      },
    );
    expect(out.response).toEqual({ ok: false, error: "registry exploded" });
  });

  test("oversized results are clipped before going back to the model", async () => {
    const { ctx } = makeCtx({ content: "x".repeat(10_000) });
    const out = await executeGeminiLiveFunctionCall(
      { name: "web_search", args: { query: "q" } },
      ctx,
    );
    const response = out.response as { ok: boolean; result: string };
    expect(response.result.length).toBeLessThan(4000);
    expect(response.result.endsWith("… (truncated)")).toBe(true);
  });

  test("set_reminder maps one-time reminders to a notify-mode schedule_create", async () => {
    const { ctx, registryCalls } = makeCtx();
    await executeGeminiLiveFunctionCall(
      {
        name: "set_reminder",
        args: {
          message: "take the focaccia out of the oven",
          when: "2027-03-01T17:00:00",
          timezone: "Asia/Makassar",
        },
      },
      ctx,
    );
    expect(registryCalls).toHaveLength(1);
    const { name, input } = registryCalls[0]!;
    expect(name).toBe("schedule_create");
    expect(input.mode).toBe("notify");
    expect(input.fire_at).toBe("2027-03-01T17:00:00");
    expect(input.timezone).toBe("Asia/Makassar");
    expect(input.message).toBe("take the focaccia out of the oven");
    expect(typeof input.name).toBe("string");
    expect(typeof input.description).toBe("string");
    // Voice never creates script-mode schedules.
    expect(input.script).toBeUndefined();
  });

  test("set_reminder with a cron maps to expression; with no time it refuses", async () => {
    const { ctx, registryCalls } = makeCtx();
    await executeGeminiLiveFunctionCall(
      {
        name: "set_reminder",
        args: { message: "weekly review", repeat: "0 9 * * 1" },
      },
      ctx,
    );
    expect(registryCalls[0]!.input.expression).toBe("0 9 * * 1");
    expect(registryCalls[0]!.input.fire_at).toBeUndefined();

    const { ctx: ctx2, registryCalls: calls2 } = makeCtx();
    const out = await executeGeminiLiveFunctionCall(
      { name: "set_reminder", args: { message: "no time given" } },
      ctx2,
    );
    expect(calls2).toHaveLength(0);
    expect((out.response as { ok: boolean }).ok).toBe(false);
  });

  test("find_contact requires a name or address and maps both", async () => {
    const { ctx, registryCalls } = makeCtx();
    await executeGeminiLiveFunctionCall(
      { name: "find_contact", args: { name: "Simon" } },
      ctx,
    );
    expect(registryCalls).toEqual([
      { name: "contact_search", input: { query: "Simon", limit: 5 } },
    ]);

    const { ctx: ctx2, registryCalls: calls2 } = makeCtx();
    const out = await executeGeminiLiveFunctionCall(
      { name: "find_contact", args: {} },
      ctx2,
    );
    expect(calls2).toHaveLength(0);
    expect((out.response as { ok: boolean }).ok).toBe(false);
  });

  test("check_inbox clamps the limit; read_messages requires a conversation id", async () => {
    const { ctx, registryCalls } = makeCtx();
    await executeGeminiLiveFunctionCall(
      { name: "check_inbox", args: { limit: 500 } },
      ctx,
    );
    expect(registryCalls).toEqual([
      { name: "messaging_list_conversations", input: { limit: 25 } },
    ]);

    const { ctx: ctx2, registryCalls: calls2 } = makeCtx();
    const out = await executeGeminiLiveFunctionCall(
      { name: "read_messages", args: {} },
      ctx2,
    );
    expect(calls2).toHaveLength(0);
    expect((out.response as { ok: boolean }).ok).toBe(false);
  });
});

describe("ui_show (voice tile subset)", () => {
  test("a list card is normalized (item ids, selectionMode) and emitted", async () => {
    const { ctx, cards } = makeCtx();
    const out = await executeGeminiLiveFunctionCall(
      {
        name: "ui_show",
        args: {
          surface_type: "list",
          title: "Late-night spots",
          data: { items: [{ title: "Luigi's" }, { title: "Warung Local" }] },
        },
      },
      ctx,
    );
    expect((out.response as { ok: boolean }).ok).toBe(true);
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(card.surfaceType).toBe("list");
    expect(card.title).toBe("Late-night spots");
    expect(typeof card.surfaceId).toBe("string");
    const data = card.data as {
      items: Array<{ id: string; title: string }>;
      selectionMode: string;
    };
    expect(data.selectionMode).toBe("none");
    expect(data.items.map((i) => i.id)).toEqual(["item-1", "item-2"]);
  });

  test("an unsupported surface type is refused and shows nothing", async () => {
    const { ctx, cards } = makeCtx();
    const out = await executeGeminiLiveFunctionCall(
      {
        name: "ui_show",
        args: { surface_type: "dynamic_page", data: { html: "<p>hi</p>" } },
      },
      ctx,
    );
    expect((out.response as { ok: boolean }).ok).toBe(false);
    expect(cards).toHaveLength(0);
  });

  test("an empty list is refused and shows nothing", async () => {
    const { ctx, cards } = makeCtx();
    const out = await executeGeminiLiveFunctionCall(
      { name: "ui_show", args: { surface_type: "list", data: { items: [] } } },
      ctx,
    );
    expect((out.response as { ok: boolean }).ok).toBe(false);
    expect(cards).toHaveLength(0);
  });

  test("without a card sink the tool reports no screen (never fake success)", async () => {
    const out = await executeGeminiLiveFunctionCall(
      {
        name: "ui_show",
        args: { surface_type: "card", data: { title: "T", body: "B" } },
      },
      { conversationId: "conv-1" },
    );
    const response = out.response as { ok: boolean; error: string };
    expect(response.ok).toBe(false);
    expect(response.error).toContain("no screen");
  });
});

describe("unknown functions", () => {
  test("an unknown function is a graceful spoken-safe error", async () => {
    const { ctx, registryCalls } = makeCtx();
    const out = await executeGeminiLiveFunctionCall(
      { name: "launch_missiles", args: {} },
      ctx,
    );
    const response = out.response as { ok: boolean; error: string };
    expect(response.ok).toBe(false);
    expect(response.error).toContain("isn't available in this call");
    expect(registryCalls).toHaveLength(0);
  });
});
