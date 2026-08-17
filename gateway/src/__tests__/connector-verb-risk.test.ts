/**
 * Connector risk follows the verb, not the server.
 *
 * Every tool name exercised here is one Manav's production instance has
 * actually called, read out of `tool_invocations` on `cue-manav-prod`. The
 * point of using real names rather than invented ones is that the taxonomy has
 * to survive Composio's actual convention — `<TOOLKIT>_<VERB>_<NOUN>`, verb
 * anywhere in the middle or at the end — not a tidy `verb_noun` shape.
 *
 * These tests drive the real `classify_risk` handler with a real trust-rule
 * store behind it. The decision that risk then produces (allow / deny in an
 * unattended session) is pinned next door in
 * `assistant/src/tools/__tests__/unattended-connector-verbs.test.ts`, which
 * runs this same classifier through the real permission checker.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { initGatewayDb, resetGatewayDb } from "../db/connection.js";
import { TrustRuleStore } from "../db/trust-rule-store.js";
import { riskClassificationRoutes } from "../ipc/risk-classification-handlers.js";
import { GLOBAL_DEFAULTS } from "../ipc/threshold-handlers.js";
import {
  initTrustRuleCache,
  resetTrustRuleCache,
  WHOLE_TOOL_PATTERN,
} from "../risk/trust-rule-cache.js";
import "./test-preload.js";

const classifyRiskHandler = riskClassificationRoutes.find(
  (r) => r.method === "classify_risk",
)!.handler;

/**
 * Ask the way the assistant asks. `registryDefaultRisk` is the tool's MCP
 * server's `defaultRiskLevel`, and it is `"high"` for every auto-provisioned
 * Composio server since migration 106 — passing it on every call is what makes
 * these assertions meaningful: a low result means the verb beat the server.
 */
async function classify(tool: string): Promise<Record<string, unknown>> {
  return (await classifyRiskHandler({
    tool,
    registryDefaultRisk: "high",
  })) as Record<string, unknown>;
}

async function riskOf(tool: string): Promise<unknown> {
  return (await classify(tool)).risk;
}

let store: TrustRuleStore;

beforeEach(async () => {
  resetGatewayDb();
  await initGatewayDb();
  store = new TrustRuleStore();
  // The database file outlives resetGatewayDb(), so a rule written by an
  // earlier test would otherwise leak into the next one.
  for (const rule of store.list({
    includeDeleted: true,
    origin: "user_defined",
  })) {
    store.remove(rule.id);
  }
  initTrustRuleCache(store);
});

afterEach(() => {
  resetTrustRuleCache();
  resetGatewayDb();
});

// ── Reads ────────────────────────────────────────────────────────────────────

describe("reads are low", () => {
  const READS = [
    "mcp__composio_googlecalendar__GOOGLECALENDAR_EVENTS_LIST",
    "mcp__composio_gmail__GMAIL_FETCH_EMAILS",
    "mcp__composio_gmail__GMAIL_LIST_THREADS",
    "mcp__composio_googledrive__GOOGLEDRIVE_FIND_FILE",
    "mcp__composio_googledrive__GOOGLEDRIVE_FIND_FOLDER",
    "mcp__composio_googlesheets__GOOGLESHEETS_BATCH_GET",
    "mcp__composio_googlesheets__GOOGLESHEETS_GET_SHEET_NAMES",
    "mcp__composio_slack__SLACK_FIND_CHANNELS",
    "mcp__composio_slack__SLACK_FIND_USERS",
    "mcp__composio_slack__SLACK_FETCH_CONVERSATION_HISTORY",
    "mcp__composio_notion__NOTION_SEARCH_NOTION_PAGE",
    // The tool-router's own read operations. These are how a connector
    // becomes reachable at all: the model finds a toolkit's tools before it
    // can call one, so denying these denies every connector downstream.
    "mcp__composio__COMPOSIO_SEARCH_TOOLS",
    "mcp__composio__COMPOSIO_GET_TOOL_SCHEMAS",
  ];

  for (const tool of READS) {
    test(tool, async () => {
      expect(await riskOf(tool)).toBe("low");
    });
  }

  test("the risk comes from the verb, not from the server's default", async () => {
    // Same call, server default "high" — the read still resolves low, and
    // says so.
    const result = await classify(
      "mcp__composio_googlecalendar__GOOGLECALENDAR_EVENTS_LIST",
    );
    expect(result.risk).toBe("low");
    expect(result.matchType).toBe("registry");
    expect(String(result.reason)).toContain("reads");
  });
});

// ── Create / draft ───────────────────────────────────────────────────────────

describe("creating and drafting is low", () => {
  const CREATES = [
    "mcp__composio_googlecalendar__GOOGLECALENDAR_CREATE_EVENT",
    "mcp__composio_googlesheets__GOOGLESHEETS_CREATE_GOOGLE_SHEET1",
    "mcp__composio_googlesheets__GOOGLESHEETS_ADD_SHEET",
    "mcp__composio_googledrive__GOOGLEDRIVE_CREATE_FILE_FROM_TEXT",
    "mcp__composio_gmail__GMAIL_ADD_LABEL_TO_EMAIL",
    "mcp__composio_slack__SLACK_CREATE_A_REMINDER",
  ];

  for (const tool of CREATES) {
    test(tool, async () => {
      expect(await riskOf(tool)).toBe("low");
    });
  }

  test("a mail DRAFT is low — a draft has not been sent to anyone", async () => {
    expect(await riskOf("mcp__composio_gmail__GMAIL_CREATE_EMAIL_DRAFT")).toBe(
      "low",
    );
  });

  test("but SENDING a draft is high — the consequential verb wins", async () => {
    expect(await riskOf("mcp__composio_gmail__GMAIL_SEND_DRAFT")).toBe("high");
  });
});

// ── Modify existing ──────────────────────────────────────────────────────────

describe("modifying something that already exists is medium", () => {
  const MODIFIES = [
    "mcp__composio_googlecalendar__GOOGLECALENDAR_UPDATE_EVENT",
    "mcp__composio_googlecalendar__GOOGLECALENDAR_PATCH_CALENDAR",
    "mcp__composio_googledrive__GOOGLEDRIVE_MOVE_FILE",
    "mcp__composio_notion__NOTION_UPDATE_PAGE",
    // Merging loses one of the two records. Medium asks a present owner and
    // stops an unattended run, which is the whole point of the tier.
    "mcp__composio_hubspot__HUBSPOT_MERGE_AND_SUPPRESS_CONTACT_RECORDS",
  ];

  for (const tool of MODIFIES) {
    test(tool, async () => {
      expect(await riskOf(tool)).toBe("medium");
    });
  }
});

// ── Inflected names ──────────────────────────────────────────────────────────

describe("inflection does not let a verb hide", () => {
  test("a gerund still names the act", async () => {
    // "…FILE_SHARING_PREFERENCE" hands access to someone else.
    expect(
      await riskOf(
        "mcp__composio_googledrive__GOOGLEDRIVE_ADD_FILE_SHARING_PREFERENCE",
      ),
    ).toBe("high");
  });

  test("but a past participle is an adjective, not the act", async () => {
    // These list. They do not share, and they do not send.
    expect(
      await riskOf("mcp__composio_googledrive__GOOGLEDRIVE_LIST_SHARED_DRIVES"),
    ).toBe("low");
    expect(await riskOf("mcp__composio_gmail__GMAIL_LIST_SENT_MESSAGES")).toBe(
      "low",
    );
  });
});

// ── Send / delete / publish / pay ────────────────────────────────────────────

describe("send, delete, publish and pay are high", () => {
  const HIGH = [
    "mcp__composio_gmail__GMAIL_SEND_EMAIL",
    "mcp__composio_gmail__GMAIL_REPLY_TO_THREAD",
    "mcp__composio_slack__SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL",
    "mcp__composio_googlecalendar__GOOGLECALENDAR_DELETE_EVENT",
    "mcp__composio_googledrive__GOOGLEDRIVE_DELETE_FILE",
    "mcp__composio_gmail__GMAIL_MOVE_TO_TRASH",
    "mcp__composio_stripe__STRIPE_CREATE_REFUND",
    "mcp__composio_shopify__SHOPIFY_PUBLISH_PRODUCT",
    // The router's execute path: the operation it will run is in the
    // arguments, not in this name. It could be any of the above.
    "mcp__composio__COMPOSIO_EXECUTE_TOOL",
    "mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL",
    "mcp__composio__COMPOSIO_REMOTE_BASH_TOOL",
  ];

  for (const tool of HIGH) {
    test(tool, async () => {
      expect(await riskOf(tool)).toBe("high");
    });
  }

  test("a send is high even when the name also reads", async () => {
    // Composes a preview and mails it. The preview is not the point.
    expect(
      await riskOf("mcp__composio_klaviyo__CREATE_TEMPLATE_PREVIEW_SEND_JOB"),
    ).toBe("high");
  });

  test("placing a call to a person is high", async () => {
    expect(await riskOf("mcp__composio_twilio__TWILIO_MAKE_PHONE_CALL")).toBe(
      "high",
    );
  });

  test("but reading call records is not", async () => {
    expect(await riskOf("mcp__composio_twilio__TWILIO_LIST_CALL_LOGS")).toBe(
      "low",
    );
  });
});

// ── THE fail-closed property ─────────────────────────────────────────────────

describe("an unrecognised verb fails closed to high", () => {
  // This is the property the whole design rests on. A toolkit we have never
  // seen must produce "ask", never "allow" — adding a connector cannot widen
  // what an unattended run may do. July's rogue send happened because a grant
  // written against a category turned out to contain sending.
  const UNRECOGNISED = [
    // Plausible operations from toolkits nobody has classified.
    "mcp__composio_docusign__DOCUSIGN_ENVELOPE_RECIPIENTS_CORRECT",
    "mcp__composio_jira__JIRA_TRANSITION_ISSUE",
    "mcp__composio_zoom__ZOOM_INSTANT_MEETING",
    // Real, and in production today: the router's catch-all surfaces.
    "mcp__composio__COMPOSIO_REMOTE_WORKBENCH",
    "mcp__composio__COMPOSIO_MANAGE_CONNECTIONS",
    // A server that is not Composio at all, with its own naming.
    "mcp__acme_crm__acmeQuietlyDoesSomething",
  ];

  for (const tool of UNRECOGNISED) {
    test(tool, async () => {
      const result = await classify(tool);
      expect(result.risk).toBe("high");
      expect(String(result.reason)).toContain("not recognised");
    });
  }

  test("a name truncated to a digest is high, and says why", async () => {
    // `toProviderSafeToolName` hashes any name over 64 chars, so the operation
    // survives only as a fragment. This exact tool is in production.
    const result = await classify(
      "mcp__composio_googlecalendar__GOOGLECALENDAR_CALEN__148bd91106ae",
    );
    expect(result.risk).toBe("high");
    expect(String(result.reason)).toContain("truncated");
  });

  test("the fallthrough is high even when the server default is low", async () => {
    // Belt to the migration's braces: a server that still carries the old
    // auto-written "low" cannot lend it to an operation we cannot read.
    const result = (await classifyRiskHandler({
      tool: "mcp__composio_unknown__UNKNOWN_TOOLKIT_OPERATION",
      registryDefaultRisk: "low",
    })) as Record<string, unknown>;
    expect(result.risk).toBe("high");
  });
});

// ── A user-authored rule still wins ──────────────────────────────────────────

describe("a whole-tool trust rule the user wrote overrides the verb", () => {
  const READ = "mcp__composio_googlecalendar__GOOGLECALENDAR_EVENTS_LIST";
  const UNRECOGNISED = "mcp__composio_zoom__ZOOM_INSTANT_MEETING";

  test("it can raise a read the taxonomy called low", async () => {
    store.create({
      tool: READ,
      pattern: WHOLE_TOOL_PATTERN,
      risk: "high",
      description: "my calendar is not for background runs",
    });
    initTrustRuleCache(store);

    const result = await classify(READ);
    expect(result.risk).toBe("high");
    expect(result.matchType).toBe("user_rule");
    expect(result.reason).toBe("my calendar is not for background runs");
  });

  test("it can release one operation the taxonomy fails closed on", async () => {
    store.create({
      tool: UNRECOGNISED,
      pattern: WHOLE_TOOL_PATTERN,
      risk: "low",
      description: "starting a meeting is fine",
    });
    initTrustRuleCache(store);

    expect((await classify(UNRECOGNISED)).risk).toBe("low");
    // …and only that one. Its neighbour is untouched.
    expect(await riskOf("mcp__composio_zoom__ZOOM_SCHEDULED_MEETING")).toBe(
      "high",
    );
  });

  test("a seeded default cannot widen a connector tool", async () => {
    store.upsertDefault({
      id: "default:composio-send:all",
      tool: "mcp__composio_gmail__GMAIL_SEND_EMAIL",
      pattern: WHOLE_TOOL_PATTERN,
      risk: "low",
      description: "seeded",
    });
    initTrustRuleCache(store);

    expect(await riskOf("mcp__composio_gmail__GMAIL_SEND_EMAIL")).toBe("high");
  });
});

// ── Blast radius ─────────────────────────────────────────────────────────────

describe("nothing outside the MCP namespace moved", () => {
  // Classifier-less tools that are not MCP-backed keep their registry risk.
  // `browser_click` staying medium (rather than becoming high on an
  // unrecognised verb) is what keeps the whole-tool-rule suite next door true.
  const NON_CONNECTOR = ["browser_click", "browser_type", "computer_use"];

  for (const tool of NON_CONNECTOR) {
    test(`${tool} keeps its registry risk`, async () => {
      const result = (await classifyRiskHandler({
        tool,
        registryDefaultRisk: "medium",
      })) as Record<string, unknown>;
      expect(result.risk).toBe("medium");
      expect(result.matchType).toBe("unknown");
    });
  }

  test("tools that HAVE a classifier are untouched", async () => {
    const result = (await classifyRiskHandler({
      tool: "web_search",
      url: "https://example.com",
    })) as Record<string, unknown>;
    expect(result.risk).toBe("low");
  });
});

// ── What these levels mean against the live thresholds ───────────────────────

describe("against the thresholds an unconfigured instance actually has", () => {
  // Read from the gateway's own defaults rather than restated, because
  // restating them from memory is the mistake that caused this regression:
  // an empty `auto_approve_thresholds` table was read as Strict when it is
  // nothing of the kind.
  const ORDINAL: Record<string, number> = {
    none: -1,
    low: 0,
    medium: 1,
    high: 2,
  };
  const withinBackground = (risk: string) =>
    ORDINAL[risk]! <= ORDINAL[GLOBAL_DEFAULTS.autonomous]!;

  test("the background threshold is low, not none", () => {
    expect(GLOBAL_DEFAULTS.autonomous).toBe("low");
    expect(GLOBAL_DEFAULTS.interactive).toBe("medium");
  });

  test("a calendar read clears it", async () => {
    expect(
      withinBackground(
        String(
          await riskOf(
            "mcp__composio_googlecalendar__GOOGLECALENDAR_EVENTS_LIST",
          ),
        ),
      ),
    ).toBe(true);
  });

  test("a mail send does not", async () => {
    expect(
      withinBackground(
        String(await riskOf("mcp__composio_gmail__GMAIL_SEND_EMAIL")),
      ),
    ).toBe(false);
  });

  test("neither does an unrecognised operation", async () => {
    expect(
      withinBackground(
        String(await riskOf("mcp__composio_zoom__ZOOM_INSTANT_MEETING")),
      ),
    ).toBe(false);
  });

  test("a modification does not clear it either — it asks", async () => {
    expect(
      withinBackground(
        String(
          await riskOf(
            "mcp__composio_googlecalendar__GOOGLECALENDAR_UPDATE_EVENT",
          ),
        ),
      ),
    ).toBe(false);
  });
});
