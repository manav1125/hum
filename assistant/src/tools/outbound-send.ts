/**
 * High-consequence actions — the hard-checkpoint class.
 *
 * Any tool that reaches outside or is irreversible — sending a message to a
 * third party (email / DM / post), placing a call, moving money, making a
 * purchase, publishing/deploying, or deleting — is a hard checkpoint: it
 * ALWAYS requires explicit human approval and can NEVER be cleared by internal
 * or background "guardian" trust. In an unattended run such a tool parks as a
 * needs-you item instead of executing; in an attended run it forces a fresh,
 * un-auto-approvable confirmation prompt.
 *
 * This exists because the guardian-approval gate is *trust*-scoped (it only
 * catches untrusted external actors), so a scheduled/background run holding
 * INTERNAL_GUARDIAN_TRUST_CONTEXT could reach an immediate-effect connector
 * tool (`gmail__GMAIL_SEND_EMAIL`, a Stripe charge, a CRM delete) and act with
 * no human in the loop. The concept the trust gate lacks is "this call reaches
 * the outside world / can't be undone" — that is what this supplies,
 * independent of trust class.
 *
 * We reuse the lexical autonomy classifier so a newly connected connector is
 * covered automatically:
 *   - "send" → gmail send, messaging_send, outlook send, *_SEND_MESSAGE, post_*
 *   - "contact" → real-time call initiation (call_start, dial_outbound)
 *   - "money" → transfer/charge/pay/trade
 *   - "publish" → publish/deploy/post-live
 *   - "delete" → delete/remove/archive of a record
 *   - "purchase" → buy/order/checkout
 * and crucially NOT "draft"/"research"/"other" — so preparing a message,
 * reading, and internal bookkeeping in the background stay allowed; only the
 * consequential act parks.
 */
import { classifyAutonomy } from "../permissions/autonomy-class.js";

/**
 * Internal plumbing tools that are governed by the host/file approval gate, not
 * by the high-consequence action park. Excluded for two reasons: (1) legitimate
 * background self-maintenance (memory, file staging, the workspace organizer)
 * runs these under guardian trust and must not park; (2) the lexical classifier
 * false-positives some of them — `host_file_transfer` classifies as "money" via
 * the "transfer" segment though it only moves files between host and sandbox.
 */
const INTERNAL_INFRA_TOOLS: ReadonlySet<string> = new Set([
  "bash",
  "terminal",
  "host_bash",
  "file_read",
  "file_write",
  "file_edit",
  "file_list",
  "file_delete",
  "file_search",
  "host_file_read",
  "host_file_write",
  "host_file_edit",
  "host_file_list",
  "host_file_transfer",
]);

/** Autonomy classes that reach outside or are irreversible. */
const HIGH_CONSEQUENCE_CLASSES: ReadonlySet<string> = new Set([
  "send",
  "contact",
  "money",
  "publish",
  "delete",
  "purchase",
]);

/**
 * Backstop for connector tools whose egress verb is NOT at the name prefix, so
 * the lexical classifier (which prefix-anchors its send verbs) under-buckets
 * them. The canonical miss is Slack's `chat.postMessage` →
 * `slack__CHAT_POST_MESSAGE` (verb "post" sits mid-name). Matched against the
 * lowercased full name. Kept narrow — only phrases that unambiguously mean "a
 * message leaves to someone".
 */
const OUTBOUND_SEND_NAME_PATTERNS: readonly RegExp[] = [
  /send[_.-]?(e?mail|message|msg|sms|text|dm|chat|reply|note)/,
  /(post|create)[_.-]?message/,
  /reply[_.-]?(all|email|message|thread)/,
  /\bdm[_.-]?send\b/,
];

/**
 * Input keys that carry an *embedded* connector action slug when a generic
 * proxy tool is used instead of the per-connector tool. Composio's meta tools
 * (`COMPOSIO_EXECUTE_TOOL`, `COMPOSIO_MULTI_EXECUTE_TOOL`) route the real action
 * — e.g. `GMAIL_SEND_EMAIL` — through the *input* (`tool_slug` / `tool_name`)
 * rather than the tool name, so a name-only check sails past a real send. This
 * is how the rogue-email path actually reached Gmail. We pull the slug out and
 * classify IT.
 */
const ACTION_SLUG_KEYS = [
  "tool_slug",
  "tool_name",
  "action",
  "action_name",
  "slug",
  "app_action",
] as const;

/**
 * Extract connector action slugs embedded in a proxy/execute tool's input, so
 * `COMPOSIO_EXECUTE_TOOL({ tool_slug: "GMAIL_SEND_EMAIL", … })` and the
 * multi-execute array form both surface their real underlying actions. Only
 * known action-identifier keys are read (never free-text like an email body),
 * so it can't false-positive on message content. Shallow by design: it looks at
 * the top level, the keys of a `tool_schemas` map, and one level into common
 * batch arrays (`arguments`/`tools`/`actions`/`executions`/`calls`).
 */
export function extractProxiedActionSlugs(
  input: Record<string, unknown>,
): string[] {
  const out: string[] = [];
  const pushFrom = (obj: unknown) => {
    if (!obj || typeof obj !== "object") return;
    const rec = obj as Record<string, unknown>;
    for (const k of ACTION_SLUG_KEYS) {
      const v = rec[k];
      if (typeof v === "string" && v.trim()) out.push(v.trim());
    }
  };
  pushFrom(input);
  // `tool_schemas` is a map keyed by action slug (the multi-execute schema call).
  const schemas = input.tool_schemas;
  if (schemas && typeof schemas === "object") {
    out.push(...Object.keys(schemas as Record<string, unknown>));
  }
  // Batch/array forms: one shallow level in.
  for (const key of ["arguments", "tools", "actions", "executions", "calls"]) {
    const arr = input[key];
    if (Array.isArray(arr)) for (const el of arr) pushFrom(el);
  }
  return out;
}

function classIsHighConsequence(name: string, input: Record<string, unknown>) {
  if (INTERNAL_INFRA_TOOLS.has(name)) return false;
  const cls = classifyAutonomy(name, input);
  if (HIGH_CONSEQUENCE_CLASSES.has(cls)) return true;
  return OUTBOUND_SEND_NAME_PATTERNS.some((re) => re.test(name.toLowerCase()));
}

/** Bare tool name (drop any `mcp__<server>__` / `connector.` namespace). */
function bareName(name: string): string {
  return name.split(/__|\./).pop() ?? name;
}

/**
 * A `schedule_create`/`schedule_update` that installs a **script-mode** job.
 * At fire time the scheduler runs the raw `script` through `sh -c` with no agent
 * loop and no approval gate — so planting one is the consequential act, and it
 * must face a human. (Without this, an autonomous run could persist
 * `curl …exfil…` as a cron and fully decouple the send from any approval.)
 */
function isScriptModeScheduleInstall(
  name: string,
  input: Record<string, unknown>,
): boolean {
  const bare = bareName(name);
  if (bare !== "schedule_create" && bare !== "schedule_update") return false;
  const script = input.script;
  return (
    input.mode === "script" &&
    typeof script === "string" &&
    script.trim().length > 0
  );
}

/**
 * Apify actors run arbitrary third-party code under the user's token — many
 * send email, post to social, or submit forms — and the action lives in a
 * free-form `actor_id`, invisible to name/slug classification. Fail closed:
 * treat `apify_run_actor` as high-consequence UNLESS the actor id clearly names
 * a read-only data-gathering actor (scrape/search/enrich/…), so lead-gen
 * scraping still runs unattended while a sender/poster parks.
 */
const APIFY_READONLY_ACTOR =
  /scrap|search|fetch|extract|crawl|read|scan|find|list|lookup|enrich|monitor|detail|harvest|collect/i;

function isOpaqueExternalRunner(
  name: string,
  input: Record<string, unknown>,
): boolean {
  if (bareName(name) !== "apify_run_actor") return false;
  const actor = String(input.actor_id ?? input.actor ?? "").trim();
  // Unknown/empty actor → fail closed (gate it).
  return actor === "" || !APIFY_READONLY_ACTOR.test(actor);
}

/**
 * True when the tool performs a high-consequence action (external send/call,
 * money, publish, delete, purchase) that must never run unattended without a
 * human and needs a fresh approval when run interactively. Checks the tool name
 * AND any connector action slug the tool carries in its input (proxy/execute
 * meta-tools), so a generic executor can't smuggle a send past the gate.
 */
export function requiresHumanApprovalForAction(
  name: string,
  input: Record<string, unknown>,
): boolean {
  if (!INTERNAL_INFRA_TOOLS.has(name) && classIsHighConsequence(name, input)) {
    return true;
  }
  // Payload-carried actions the name/slug classifier can't see:
  //   · script-mode schedules install a detached, un-gated shell command
  //   · apify actors run opaque third-party code that may send/post/submit
  if (isScriptModeScheduleInstall(name, input)) return true;
  if (isOpaqueExternalRunner(name, input)) return true;
  // Proxied action slugs (COMPOSIO_EXECUTE_TOOL et al.): classify each embedded
  // action by name. The empty-input classification is what matters here.
  for (const slug of extractProxiedActionSlugs(input)) {
    if (classIsHighConsequence(slug, {})) return true;
  }
  return false;
}

/**
 * The outbound-message subset — used where the phrasing is send-specific.
 * (A strict subset of {@link requiresHumanApprovalForAction}.)
 */
export function isOutboundExternalSendTool(
  name: string,
  input: Record<string, unknown>,
): boolean {
  const isSend = (n: string, i: Record<string, unknown>) => {
    if (INTERNAL_INFRA_TOOLS.has(n)) return false;
    const cls = classifyAutonomy(n, i);
    if (cls === "send" || cls === "contact") return true;
    return OUTBOUND_SEND_NAME_PATTERNS.some((re) => re.test(n.toLowerCase()));
  };
  if (isSend(name, input)) return true;
  return extractProxiedActionSlugs(input).some((slug) => isSend(slug, {}));
}
