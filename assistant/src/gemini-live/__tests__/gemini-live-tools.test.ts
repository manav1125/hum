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
  GEMINI_LIVE_CALENDAR_EVENTS_TOOL,
  GEMINI_LIVE_FUNCTION_DECLARATIONS,
  GEMINI_LIVE_REGISTRY_TOOL_ALLOWLIST,
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

describe("get_calendar (Google Calendar via Composio MCP)", () => {
  /**
   * A realistic slice of Composio's verbose envelope around Google's
   * events.list response: envelope + calendar metadata + per-event noise
   * (etags, links, conferenceData, attendee objects with emails).
   */
  const VERBOSE_CALENDAR_FIXTURE = JSON.stringify({
    successful: true,
    error: null,
    data: {
      kind: "calendar#events",
      etag: '"p33g67o1k5vugc0o"',
      summary: "owner@example.com",
      description: "",
      updated: "2026-08-10T02:11:00.000Z",
      timeZone: "Asia/Singapore",
      accessRole: "owner",
      defaultReminders: [{ method: "popup", minutes: 10 }],
      nextPageToken: undefined,
      items: [
        {
          kind: "calendar#event",
          etag: '"3465113772538000"',
          id: "abc123def456",
          status: "confirmed",
          htmlLink: "https://www.google.com/calendar/event?eid=YWJjMTIz",
          created: "2026-07-30T08:00:00.000Z",
          updated: "2026-08-09T02:11:00.000Z",
          summary: "Investor sync",
          description:
            "Q3 numbers walkthrough. Agenda:\n1. Pipeline\n2. Burn\n3. Hiring\n" +
            "Dial-in details below…",
          location: "Zoom",
          creator: { email: "owner@example.com", self: true },
          organizer: { email: "owner@example.com", self: true },
          start: {
            dateTime: "2026-08-10T09:00:00+08:00",
            timeZone: "Asia/Singapore",
          },
          end: {
            dateTime: "2026-08-10T09:45:00+08:00",
            timeZone: "Asia/Singapore",
          },
          iCalUID: "fixture-uid@example.com",
          sequence: 2,
          attendees: [
            {
              email: "owner@example.com",
              self: true,
              responseStatus: "accepted",
            },
            { email: "alice@example.com", responseStatus: "accepted" },
            { email: "bob@example.com", responseStatus: "needsAction" },
          ],
          hangoutLink: "https://meet.google.com/xyz-abcd-efg",
          conferenceData: {
            entryPoints: [
              {
                entryPointType: "video",
                uri: "https://meet.google.com/xyz-abcd-efg",
              },
            ],
            conferenceSolution: { name: "Google Meet" },
            conferenceId: "xyz-abcd-efg",
          },
          reminders: { useDefault: true },
          eventType: "default",
        },
        {
          kind: "calendar#event",
          id: "cancelled-1",
          status: "cancelled",
          summary: "Old standup",
          start: { dateTime: "2026-08-10T10:00:00+08:00" },
          end: { dateTime: "2026-08-10T10:15:00+08:00" },
        },
        {
          kind: "calendar#event",
          etag: '"3465113772538001"',
          id: "allday789",
          status: "confirmed",
          htmlLink: "https://www.google.com/calendar/event?eid=YWxsZGF5",
          summary: "Block: deep work",
          creator: { email: "owner@example.com", self: true },
          organizer: { email: "owner@example.com", self: true },
          start: { date: "2026-08-11" },
          end: { date: "2026-08-12" },
          transparency: "opaque",
          reminders: { useDefault: false },
          eventType: "focusTime",
        },
      ],
    },
  });

  test("the allowlist contains the calendar MCP tool (and only curated names)", () => {
    expect(
      GEMINI_LIVE_REGISTRY_TOOL_ALLOWLIST.has(GEMINI_LIVE_CALENDAR_EVENTS_TOOL),
    ).toBe(true);
    expect(GEMINI_LIVE_CALENDAR_EVENTS_TOOL).toBe(
      "mcp__composio_googlecalendar__GOOGLECALENDAR_EVENTS_LIST",
    );
    // Read-only: no calendar write tool is reachable from the voice surface.
    for (const name of GEMINI_LIVE_REGISTRY_TOOL_ALLOWLIST) {
      expect(name).not.toMatch(/CREATE_EVENT|QUICK_ADD|UPDATE|DELETE|PATCH/);
    }
  });

  test("dispatches the Composio tool with Google-standard args through the registry seam", async () => {
    const { ctx, registryCalls } = makeCtx({
      content: VERBOSE_CALENDAR_FIXTURE,
    });
    await executeGeminiLiveFunctionCall(
      {
        name: "get_calendar",
        args: {
          time_min: "2026-08-10T00:00:00+08:00",
          time_max: "2026-08-11T00:00:00+08:00",
        },
      },
      { ...ctx, isToolRegistered: () => true },
    );
    expect(registryCalls).toEqual([
      {
        name: GEMINI_LIVE_CALENDAR_EVENTS_TOOL,
        input: {
          calendarId: "primary",
          timeMin: "2026-08-10T00:00:00+08:00",
          timeMax: "2026-08-11T00:00:00+08:00",
          singleEvents: true,
          orderBy: "startTime",
          maxResults: 15,
        },
      },
    ]);
  });

  test("with no range it defaults to now → +7 days", async () => {
    const { ctx, registryCalls } = makeCtx({
      content: VERBOSE_CALENDAR_FIXTURE,
    });
    const before = Date.now();
    await executeGeminiLiveFunctionCall(
      { name: "get_calendar", args: {} },
      { ...ctx, isToolRegistered: () => true },
    );
    const input = registryCalls[0]!.input as {
      timeMin: string;
      timeMax: string;
    };
    const timeMin = Date.parse(input.timeMin);
    const timeMax = Date.parse(input.timeMax);
    expect(timeMin).toBeGreaterThanOrEqual(before - 1000);
    expect(timeMin).toBeLessThanOrEqual(Date.now() + 1000);
    expect(timeMax - timeMin).toBe(7 * 24 * 60 * 60 * 1000);
  });

  test("an unparsable range is refused without dispatching", async () => {
    const { ctx, registryCalls } = makeCtx();
    const out = await executeGeminiLiveFunctionCall(
      { name: "get_calendar", args: { time_min: "next tuesday-ish" } },
      { ...ctx, isToolRegistered: () => true },
    );
    expect(registryCalls).toHaveLength(0);
    const response = out.response as { ok: boolean; error: string };
    expect(response.ok).toBe(false);
    expect(response.error).toContain("ISO 8601");
  });

  test("shapes the verbose Composio envelope down to voice-sized events", async () => {
    const { ctx } = makeCtx({ content: VERBOSE_CALENDAR_FIXTURE });
    const out = await executeGeminiLiveFunctionCall(
      { name: "get_calendar", args: { time_min: "2026-08-10T00:00:00+08:00" } },
      { ...ctx, isToolRegistered: () => true },
    );
    const response = out.response as {
      ok: boolean;
      count: number;
      events: Array<Record<string, unknown>>;
    };
    expect(response.ok).toBe(true);
    // The cancelled event is dropped.
    expect(response.count).toBe(2);
    expect(response.events[0]).toEqual({
      title: "Investor sync",
      start: "2026-08-10T09:00:00+08:00",
      end: "2026-08-10T09:45:00+08:00",
      location: "Zoom",
      attendees: 3,
    });
    // All-day events keep their date form; no attendees key when there are none.
    expect(response.events[1]).toEqual({
      title: "Block: deep work",
      start: "2026-08-11",
      end: "2026-08-12",
    });
    // The verbose junk is gone entirely — nothing for the model to read aloud.
    const wire = JSON.stringify(response);
    for (const junk of [
      "conferenceData",
      "htmlLink",
      "iCalUID",
      "etag",
      "alice@example.com",
      "Dial-in",
    ]) {
      expect(wire).not.toContain(junk);
    }
    expect(wire.length).toBeLessThan(VERBOSE_CALENDAR_FIXTURE.length / 4);
  });

  test("absent from the registry → honest not-connected error, no dispatch", async () => {
    const { ctx, registryCalls } = makeCtx({
      content: VERBOSE_CALENDAR_FIXTURE,
    });
    const out = await executeGeminiLiveFunctionCall(
      { name: "get_calendar", args: {} },
      { ...ctx, isToolRegistered: () => false },
    );
    expect(registryCalls).toHaveLength(0);
    const response = out.response as { ok: boolean; error: string };
    expect(response.ok).toBe(false);
    expect(response.error).toContain("isn't connected");
    expect(response.error).toContain("Settings → Connectors");
    expect(response.error).toContain("Do not guess or invent events");
  });

  test("without a seam the real (empty in tests) registry yields the same honest answer", async () => {
    // No isToolRegistered override: the default consults the actual registry,
    // where the Composio tool is absent on an unconnected instance — exactly
    // the local degradation path.
    const { ctx, registryCalls } = makeCtx();
    const out = await executeGeminiLiveFunctionCall(
      { name: "get_calendar", args: {} },
      ctx,
    );
    expect(registryCalls).toHaveLength(0);
    const response = out.response as { ok: boolean; error: string };
    expect(response.ok).toBe(false);
    expect(response.error).toContain("isn't connected");
  });

  test("a connection-shaped execution error degrades to not-connected", async () => {
    const { ctx } = makeCtx({
      content:
        "MCP tool execution failed: no connected account found for toolkit googlecalendar (status: EXPIRED)",
      isError: true,
    });
    const out = await executeGeminiLiveFunctionCall(
      { name: "get_calendar", args: {} },
      { ...ctx, isToolRegistered: () => true },
    );
    const response = out.response as { ok: boolean; error: string };
    expect(response.ok).toBe(false);
    expect(response.error).toContain("isn't connected");
    expect(response.error).toContain("Settings → Connectors");
  });

  test("a Composio in-envelope auth failure (isError false) also degrades honestly", async () => {
    const { ctx } = makeCtx({
      content: JSON.stringify({
        successful: false,
        error: "Connected account is expired, please re-authenticate",
        data: {},
      }),
    });
    const out = await executeGeminiLiveFunctionCall(
      { name: "get_calendar", args: {} },
      { ...ctx, isToolRegistered: () => true },
    );
    const response = out.response as { ok: boolean; error: string };
    expect(response.ok).toBe(false);
    expect(response.error).toContain("isn't connected");
  });

  test("a permission denial stays a permission denial, not a fake disconnect", async () => {
    const { ctx } = makeCtx({
      content:
        'Permission denied: tool "mcp__composio_googlecalendar__GOOGLECALENDAR_EVENTS_LIST" requires user approval but no interactive client is connected.',
      isError: true,
    });
    const out = await executeGeminiLiveFunctionCall(
      { name: "get_calendar", args: {} },
      { ...ctx, isToolRegistered: () => true },
    );
    const response = out.response as { ok: boolean; error: string };
    expect(response.ok).toBe(false);
    expect(response.error).toContain("Permission denied");
    expect(response.error).not.toContain("Settings → Connectors");
  });

  test("an empty range reports zero events, never an error", async () => {
    const { ctx } = makeCtx({
      content: JSON.stringify({
        successful: true,
        error: null,
        data: { kind: "calendar#events", items: [] },
      }),
    });
    const out = await executeGeminiLiveFunctionCall(
      { name: "get_calendar", args: {} },
      { ...ctx, isToolRegistered: () => true },
    );
    expect(out.response).toEqual({
      ok: true,
      count: 0,
      events: [],
      message: "No calendar events in that range.",
    });
  });

  test("an unrecognized successful shape falls back to the clipped raw result", async () => {
    const { ctx } = makeCtx({ content: "Fetched 2 events: standup, review" });
    const out = await executeGeminiLiveFunctionCall(
      { name: "get_calendar", args: {} },
      { ...ctx, isToolRegistered: () => true },
    );
    expect(out.response).toEqual({
      ok: true,
      result: "Fetched 2 events: standup, review",
    });
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
