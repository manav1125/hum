/**
 * Connector (MCP) risk classifier — risk follows the VERB, not the server.
 *
 * MCP and connector tools have no per-invocation selector (no command, no path,
 * no URL), so before this classifier the only signal available for them was the
 * risk level their *server* was configured with. That is a property of where a
 * tool came from, not of what it does: one number covered `GMAIL_FETCH_EMAILS`
 * and `GMAIL_SEND_EMAIL` alike, and every choice about it was wrong for one of
 * them. Set low, it auto-approved sending. Set high — the schema's fail-closed
 * default — it denied reading a calendar in any unattended or voice run.
 *
 * This classifier reads the operation out of the tool name and assigns risk by
 * what the operation *does*:
 *
 * - reads (`_LIST`, `_GET`, `_FETCH`, `_SEARCH`, `_READ`, `_FIND`, …)  → low
 * - create / draft (`_CREATE`, `_DRAFT`, `_ADD`, `_UPLOAD`, …)          → low
 * - modify existing (`_UPDATE`, `_MODIFY`, `_PATCH`, `_MOVE`, …)        → medium
 * - send / delete / publish / pay / share / execute                     → high
 *
 * ## The load-bearing property: an unrecognised verb is HIGH
 *
 * The four sets below are not exhaustive and never will be — a toolkit added
 * tomorrow can name its operations anything. So the fallthrough is `high`, not
 * `medium` and certainly not the server's default: a connector whose operations
 * we have no pattern for produces "ask", never "allow". Adding a connector can
 * therefore never silently widen what an unattended run may do; the widest
 * thing a new connector gets by default is a prompt.
 *
 * This is the July rogue-send class stated as an invariant. A background run
 * emailed a partner because a trust rank turned out to cover sending — the
 * grant was written against a category ("this server is fine") that quietly
 * contained an action nobody had considered. Deriving from the verb removes the
 * category; failing closed removes the "quietly".
 *
 * ## Ordering: the most consequential reading wins
 *
 * Tokens are matched anywhere in the operation name and the sets are probed
 * high → medium → create → read, so a name carrying both a benign and a
 * consequential verb takes the consequential one. `GMAIL_SEND_DRAFT` is a send,
 * not a draft. `CREATE_TEMPLATE_PREVIEW_SEND_JOB` sends mail, whatever it says
 * about previews.
 *
 * ## Matching is on SEGMENTS, never substrings
 *
 * `send`/`pay`/`order` as raw substrings misfire badly — the autonomy
 * classifier learned this when substring matching read `screen_recorder` as
 * "rec-ORDER-er" and `set_payload` as "PAY-load", feeding false hard-denies
 * into the work-item gate. Names are split on non-alphanumerics and camelCase
 * boundaries and compared whole (see {@link stemsOf} for which inflections are
 * folded), so a toolkit called `sendgrid` is one segment and is not a send.
 *
 * ## What this does NOT do
 *
 * It classifies the *named* operation. A router tool that takes the real
 * operation in its arguments — `COMPOSIO_EXECUTE_TOOL`,
 * `COMPOSIO_MULTI_EXECUTE_TOOL` — is classified as what it is: a tool that runs
 * an operation we cannot see from here. Those land in the `execute` family and
 * stay high. Deriving their risk from the payload would need the invocation's
 * arguments, which the classification IPC does not carry.
 */

import type { RiskAssessment } from "./risk-types.js";

// ---------------------------------------------------------------------------
// Tool-name shape
// ---------------------------------------------------------------------------

/** Namespace every MCP-backed tool is registered under (`mcp__<server>__<op>`). */
const CONNECTOR_TOOL_PREFIX = "mcp__";

/**
 * Whether this tool is an MCP/connector tool, and so classified by verb.
 *
 * Deliberately keyed on the namespace the MCP tool factory assigns, not on a
 * server name: the whole point is that risk stops depending on which server
 * provided the tool. Classifier-less tools OUTSIDE this namespace (browser,
 * computer-use) keep their registry risk — this classifier says nothing about
 * them.
 */
export function isConnectorTool(tool: string): boolean {
  return tool.startsWith(CONNECTOR_TOOL_PREFIX);
}

/**
 * A provider-safe tool name that had to be truncated ends in a 12-hex digest
 * (see `toProviderSafeToolName`). The operation name is then a fragment — or
 * gone entirely — so nothing read out of it can be trusted.
 */
const TRUNCATION_DIGEST = /__[0-9a-f]{12}$/;

/**
 * The operation part of `mcp__<server>__<OPERATION>`.
 *
 * Splitting after the LAST `__` inside the body keeps the server key out of the
 * token stream in both directions: a server named `composio_getty` cannot lend
 * a "get" to an operation, and one named `..._delete_...` cannot escalate every
 * read it serves.
 */
function operationName(tool: string): string {
  const body = tool.slice(CONNECTOR_TOOL_PREFIX.length);
  const sep = body.lastIndexOf("__");
  return sep >= 0 ? body.slice(sep + 2) : body;
}

/**
 * Split an operation name into lowercase word segments, on non-alphanumeric
 * separators and camelCase boundaries: `GOOGLECALENDAR_EVENTS_LIST` →
 * ["googlecalendar", "events", "list"], `createOrder` → ["create", "order"].
 */
function segments(operation: string): string[] {
  return operation
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * The forms of a segment worth probing against the verb sets.
 *
 * Connector names inflect: `SLACK_SENDS_A_MESSAGE`, `ADD_FILE_SHARING_
 * PREFERENCE`. Plurals and gerunds still name the act, so they are stemmed.
 *
 * Past participles deliberately are NOT: `-ed` in a connector name is almost
 * always an adjective describing a noun rather than the operation's verb, and
 * stemming it makes reads disappear. `GOOGLEDRIVE_LIST_SHARED_DRIVES` lists;
 * it does not share. `GMAIL_LIST_SENT_MESSAGES` lists; it does not send.
 */
function stemsOf(segment: string): string[] {
  const forms = [segment];
  if (segment.endsWith("es")) forms.push(segment.slice(0, -2));
  if (segment.endsWith("s")) forms.push(segment.slice(0, -1));
  if (segment.endsWith("ing")) {
    const stem = segment.slice(0, -3);
    forms.push(stem, stem + "e");
  }
  return forms;
}

/** Whether any segment, in any of its forms, is in `verbs`. */
function hasVerbFrom(parts: string[], verbs: ReadonlySet<string>): boolean {
  return parts.some((part) => stemsOf(part).some((form) => verbs.has(form)));
}

// ---------------------------------------------------------------------------
// The verb taxonomy
// ---------------------------------------------------------------------------

/**
 * HIGH — the line the owner drew: send and delete, plus the neighbours that
 * are the same act under another name (publish is a send to everyone; share
 * and grant hand someone else the keys; pay moves money; execute/run is
 * whatever the payload says it is, which is anything).
 *
 * `archive`, `unlabel` and `revoke` sit here to agree with the autonomy
 * classifier, which already calls them deletes.
 */
const HIGH_VERBS: ReadonlySet<string> = new Set([
  // send / outbound
  "send",
  "reply",
  "forward",
  "dispatch",
  "submit",
  "notify",
  "invite",
  "subscribe",
  "unsubscribe",
  // delete / destroy
  "delete",
  "remove",
  "trash",
  "destroy",
  "purge",
  "erase",
  "drop",
  "archive",
  "unlabel",
  "uninstall",
  "cancel",
  // publish
  "publish",
  "unpublish",
  "republish",
  "deploy",
  "broadcast",
  "release",
  // access handed to someone else
  "share",
  "unshare",
  "grant",
  "revoke",
  "authorize",
  // money moved
  "pay",
  "payout",
  "charge",
  "refund",
  "checkout",
  "transfer",
  "purchase",
  "withdraw",
  "deposit",
  // arbitrary execution — the operation is in the payload, not the name
  "execute",
  "exec",
  "run",
  "invoke",
  "eval",
  "shell",
  "bash",
  "terminal",
  "sandbox",
]);

/**
 * MEDIUM — changes something that already exists and that someone else may be
 * relying on. Not the owner's line; see the module note in the handler.
 *
 * `label` and `mark` are deliberately absent. Labelling and marking annotate
 * rather than change content, the destructive direction is already covered
 * (`remove`, `unlabel`), and putting them here would have made routine inbox
 * triage — `GMAIL_ADD_LABEL_TO_EMAIL`, which this instance calls — medium and
 * so denied unattended.
 */
const MEDIUM_VERBS: ReadonlySet<string> = new Set([
  "update",
  "modify",
  "patch",
  "move",
  "rename",
  "edit",
  "replace",
  "set",
  "upsert",
  // Merging two records is a modification that loses one of them. Medium is
  // the tier that asks a present owner and stops an unattended run.
  "merge",
  "assign",
  "toggle",
  "enable",
  "disable",
  "activate",
  "deactivate",
  "restore",
  "reorder",
  "resize",
  "import",
  "connect",
  "disconnect",
]);

/**
 * LOW (create / draft) — bringing something new into existence, including a
 * draft of a message. Explicitly the owner's ruling: drafting is thinking, not
 * sending, and a draft that is never sent has done nothing to anyone.
 */
const CREATE_VERBS: ReadonlySet<string> = new Set([
  "create",
  "draft",
  "add",
  "insert",
  "new",
  "compose",
  "generate",
  "clone",
  "duplicate",
  "copy",
  "upload",
  "append",
  "scaffold",
]);

/** LOW (read) — looks, does not touch. */
const READ_VERBS: ReadonlySet<string> = new Set([
  "list",
  "get",
  "fetch",
  "search",
  "read",
  "find",
  "retrieve",
  "describe",
  "view",
  "query",
  "lookup",
  "count",
  "check",
  "status",
  "info",
  "schema",
  "preview",
  "render",
  "export",
  "download",
  "discover",
  "explore",
  "resolve",
  "validate",
  "estimate",
  "analyze",
  "analyse",
  "summarize",
  "summarise",
  "summary",
  "report",
  "history",
  "metadata",
  "stats",
  "aggregate",
  "benchmark",
]);

/**
 * Placing a real-time call to a person. Mirrors the autonomy classifier's
 * contact rule: a channel word paired with an initiation word, so
 * `make_phone_call` and `create_call` are outreach while `get_call_logs` is a
 * read. Kept as a pair rule rather than dumped into HIGH_VERBS because "call"
 * alone appears in plenty of read operations.
 */
const CONTACT_CHANNELS: ReadonlySet<string> = new Set([
  "call",
  "phone",
  "dial",
]);
const CONTACT_INITIATIONS: ReadonlySet<string> = new Set([
  "start",
  "initiate",
  "place",
  "make",
  "begin",
  "outbound",
  "dial",
  "create",
]);

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Risk for one connector tool, derived from the verb in its operation name.
 *
 * Returns a full {@link RiskAssessment} so the handler can hand it back
 * unchanged. `matchType` is `"registry"`: the risk came from a rule this
 * service holds, not from a rule the user wrote (`"user_rule"`, checked before
 * this runs) and not from having no idea (`"unknown"`).
 */
export function classifyConnectorTool(tool: string): RiskAssessment {
  const base = {
    scopeOptions: [],
    matchType: "registry" as const,
  };

  // A truncated name is a fragment. Whatever verb it appears to carry may be
  // half of a different word, and the rest of the operation — which is where a
  // `_DELETE` or `_SEND` would have been — is simply not present.
  if (TRUNCATION_DIGEST.test(tool)) {
    return {
      ...base,
      riskLevel: "high",
      reason:
        "Connector tool with a truncated name — the operation cannot be read, so it is treated as consequential",
    };
  }

  const operation = operationName(tool);
  const parts = segments(operation);

  if (hasVerbFrom(parts, HIGH_VERBS)) {
    return {
      ...base,
      riskLevel: "high",
      reason: `Connector operation sends, deletes, publishes, pays, or executes (${operation})`,
    };
  }

  if (
    hasVerbFrom(parts, CONTACT_CHANNELS) &&
    hasVerbFrom(parts, CONTACT_INITIATIONS)
  ) {
    return {
      ...base,
      riskLevel: "high",
      reason: `Connector operation places a call to a person (${operation})`,
    };
  }

  if (hasVerbFrom(parts, MEDIUM_VERBS)) {
    return {
      ...base,
      riskLevel: "medium",
      reason: `Connector operation modifies something that already exists (${operation})`,
    };
  }

  if (hasVerbFrom(parts, CREATE_VERBS)) {
    return {
      ...base,
      riskLevel: "low",
      reason: `Connector operation creates or drafts (${operation})`,
    };
  }

  if (hasVerbFrom(parts, READ_VERBS)) {
    return {
      ...base,
      riskLevel: "low",
      reason: `Connector operation reads (${operation})`,
    };
  }

  // Fail closed. See the module note: this is the branch that keeps a newly
  // added connector from widening anything on its own.
  return {
    ...base,
    riskLevel: "high",
    reason: `Connector operation not recognised (${operation}) — treated as consequential until it is`,
  };
}
