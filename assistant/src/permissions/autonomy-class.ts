/**
 * Per-task-type autonomy classifier (deterministic, pure).
 *
 * Maps a tool invocation to an *action category* used by the per-category
 * autonomy policy. The category — not the tool's risk level — decides whether
 * the user has opted the action into auto-run, ask, or never. Classification
 * is purely lexical (tool name + a light peek at input for destructive bash):
 * NO LLM, NO I/O, fully unit-testable.
 *
 * The category is intentionally coarse and biased toward the *more dangerous*
 * reading on ambiguity, so that the policy's safe defaults (send/money/delete/
 * publish/contact → ask) apply to anything that smells consequential. "other"
 * is the catch-all and itself defaults to ask.
 */

export type AutonomyClass =
  | "research"
  | "draft"
  | "send"
  | "money"
  | "delete"
  | "publish"
  | "contact"
  | "other";

// ── Core tool names (exact match) ──────────────────────────────────────────────
// These are first-party tools whose category is fixed regardless of input
// (except bash/terminal, which inspect their command for destructive verbs).

const CORE_RESEARCH = new Set<string>([
  "read",
  "list",
  "glob",
  "grep",
  "web_search",
  "web_fetch",
]);

const CORE_DRAFT = new Set<string>(["write", "edit", "create_draft"]);

const CORE_BASH = new Set<string>(["bash", "terminal"]);

// ── Destructive bash detection ─────────────────────────────────────────────────
// A bash/terminal invocation is a "delete" when its command contains a
// destructive verb. Matched on word-ish boundaries to avoid false positives on
// substrings of unrelated identifiers (e.g. "dropdown", "formatting").

const DESTRUCTIVE_BASH_PATTERNS: ReadonlyArray<RegExp> = [
  /\brm\b/, // rm (covers "rm -rf …" as well)
  /\bgit\s+push\b/, // git push
  /\bdrop\b/, // SQL DROP, drop database/table
  /\brmdir\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\btruncate\b/,
];

function extractBashCommand(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  // Different bash/terminal tools name the field differently; check the common
  // ones. Anything non-string is ignored.
  const candidate =
    record.command ?? record.cmd ?? record.script ?? record.input;
  return typeof candidate === "string" ? candidate : "";
}

function isDestructiveBash(input: unknown): boolean {
  const command = extractBashCommand(input);
  if (!command) return false;
  return DESTRUCTIVE_BASH_PATTERNS.some((re) => re.test(command));
}

// ── MCP / connector verb rules ─────────────────────────────────────────────────
// Connector tools follow a verb-prefixed (or substring) naming convention. We
// classify by the verb expressed in the tool-name suffix. Order matters: money
// segments are checked first (most consequential), then delete, send, draft,
// research — first match wins.

// Money is matched against whole name SEGMENTS (split on non-alphanumerics
// and camelCase boundaries) anywhere in the name: payment verbs are
// consequential enough that we never want a near-miss to fall through to a
// laxer bucket. Segment matching — not raw substring matching — is load-
// bearing: substring matching classified `screen_recorder` as money
// ("rec-ORDER-er") and `set_payload` as money ("PAY-load"), which fed false
// hard-denies into the work-item auto-run gate. Trailing plural "s" is
// normalized so `list_transactions` / `list_orders` still match.
const MONEY_SEGMENTS: ReadonlySet<string> = new Set([
  "pay",
  "payment",
  "payout",
  "charge",
  "transfer",
  "order",
  "refund",
  "checkout",
  "balance",
  "transaction",
]);

/**
 * Split a tool name into lowercase word segments on non-alphanumeric
 * separators (`_`, `-`, `.`, `__`, …) and camelCase boundaries, so
 * `createOrder` → ["create", "order"] and `screen_recorder` → ["screen",
 * "recorder"] (one segment — NOT "order").
 */
function toolNameSegments(toolName: string): string[] {
  return toolName
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Whether any name segment is a money term (plural-insensitive). */
function hasMoneySegment(toolName: string): boolean {
  return hasSegmentFrom(toolName, MONEY_SEGMENTS);
}

/** Whether any name segment is in `terms` (plural-insensitive). */
function hasSegmentFrom(toolName: string, terms: ReadonlySet<string>): boolean {
  return toolNameSegments(toolName).some(
    (segment) =>
      terms.has(segment) ||
      (segment.endsWith("s") && terms.has(segment.slice(0, -1))),
  );
}

// ── Publish detection ──────────────────────────────────────────────────────────
// A tool is a "publish" action when its name carries a publish/deploy segment
// anywhere (like money, segment-matched so `publish_website`, `deploy_game`,
// `app_publish`, `unpublish_page` all match). Public egress is consequential
// enough that read-ish names carrying these segments (e.g. a hypothetical
// `get_deploy_status`) deliberately land here too — over-asking is the safe
// direction, matching the money precedent (`list_transactions` → money).
const PUBLISH_SEGMENTS: ReadonlySet<string> = new Set([
  "publish",
  "unpublish",
  "republish",
  "deploy",
  "broadcast",
]);

// ── Contact (outbound outreach) detection ──────────────────────────────────────
// A tool is a "contact" action when it initiates real-time outreach to a
// person: its name pairs a call/phone segment with an initiation segment
// (`call_start`, `make_phone_call`, `create_call`, `dial_number`, …).
// Message/email sends are NOT in this class — they classify as "send" first
// (see SEND_VERBS), and the guardrail contact checkpoint matches both classes
// coarsely (see guardrails/checkpoint-enforcement).
const CONTACT_CHANNEL_SEGMENTS: ReadonlySet<string> = new Set([
  "call",
  "phone",
  "dial",
]);
const CONTACT_INITIATION_SEGMENTS: ReadonlySet<string> = new Set([
  "start",
  "initiate",
  "place",
  "make",
  "begin",
  "create",
  "dial",
  "outbound",
]);

/** Whether the tool name pairs a call/phone segment with an initiation verb. */
function isContactInitiation(toolName: string): boolean {
  return (
    hasSegmentFrom(toolName, CONTACT_CHANNEL_SEGMENTS) &&
    hasSegmentFrom(toolName, CONTACT_INITIATION_SEGMENTS)
  );
}

// Verb prefixes matched against the tool-name *suffix* (the part after the last
// connector namespace separator). Each entry maps a set of verb prefixes to a
// category.
const DELETE_VERBS: ReadonlyArray<string> = [
  "delete_",
  "remove_",
  "unlabel_",
  "archive_",
];
// Send verbs are matched as a PREFIX of the tool-name suffix only. "email" and
// "message" are deliberately prefix-anchored (not substring-matched) so that a
// tool like `list_email_templates` or `get_message_metadata` — which merely
// operates on email/message *objects* — is classified by its leading verb
// (research) rather than mis-bucketed as a send action.
const SEND_VERBS: ReadonlyArray<string> = [
  "send_",
  "post_",
  "email",
  "message",
  "subscribe_",
  "unsubscribe_",
];
// A "send" SEGMENT anywhere in the name also classifies as send: messaging
// egress tools name the channel first and the verb last (`messaging_send`),
// which no prefix rule can catch. Segment-matched so "sender"/"resend" style
// words don't false-positive.
const SEND_SEGMENTS: ReadonlySet<string> = new Set(["send"]);
const DRAFT_VERBS: ReadonlyArray<string> = ["create_", "update_", "draft_"];
const RESEARCH_VERBS: ReadonlyArray<string> = [
  "get_",
  "list_",
  "search_",
  "read_",
  "query_",
];

/**
 * Reduce a (possibly namespaced) tool name to the verb-bearing suffix.
 *
 * MCP tools arrive as `mcp__<server>__<verb_noun>` and connector tools may be
 * `connector.verb_noun` or similar. We take the segment after the last `__`,
 * `.`, `/`, or `:` so the verb prefix is at the start of what we test.
 */
function toolNameSuffix(toolName: string): string {
  const lastSep = Math.max(
    toolName.lastIndexOf("__"),
    toolName.lastIndexOf("."),
    toolName.lastIndexOf("/"),
    toolName.lastIndexOf(":"),
  );
  if (lastSep < 0) return toolName;
  // For the "__" separator advance two chars; for single-char separators one.
  const skip = toolName.startsWith("__", lastSep) ? 2 : 1;
  return toolName.slice(lastSep + skip);
}

/**
 * Classify a tool invocation into an autonomy action category.
 *
 * Deterministic and pure. `input` is consulted only for bash/terminal, to
 * distinguish destructive commands (delete) from benign ones (other).
 */
export function classifyAutonomy(
  toolName: string,
  input?: unknown,
): AutonomyClass {
  const name = toolName.toLowerCase();

  // ── 1. Core tools by exact name ──────────────────────────────────────────
  if (CORE_RESEARCH.has(name)) return "research";
  if (CORE_DRAFT.has(name)) return "draft";
  if (CORE_BASH.has(name)) {
    return isDestructiveBash(input) ? "delete" : "other";
  }

  // ── 2. MCP / connector tools by verb ─────────────────────────────────────
  const suffix = toolNameSuffix(name);

  // Money first — segment match anywhere in the full name, most consequential.
  if (hasMoneySegment(toolName)) return "money";

  // Delete before send/draft/research so e.g. "unsubscribe_" doesn't shadow a
  // genuine delete verb (none overlap today, but order encodes the priority).
  if (DELETE_VERBS.some((v) => suffix.startsWith(v))) return "delete";
  // Send before publish/contact so existing send-classified tools (post_*,
  // message*, …) keep their class — send checkpoints keep covering them, and
  // the contact checkpoint matches the send class coarsely on top.
  if (SEND_VERBS.some((v) => suffix.startsWith(v))) return "send";
  if (hasSegmentFrom(toolName, SEND_SEGMENTS)) return "send";
  // Publish/contact before draft/research: `publish_website` / `deploy_game`
  // and `call_start` / `create_call` are consequential even when a draft-ish
  // or read-ish verb also appears in the name.
  if (hasSegmentFrom(toolName, PUBLISH_SEGMENTS)) return "publish";
  if (isContactInitiation(toolName)) return "contact";
  if (DRAFT_VERBS.some((v) => suffix.startsWith(v))) return "draft";
  if (RESEARCH_VERBS.some((v) => suffix.startsWith(v))) return "research";

  // ── 3. Fallthrough ───────────────────────────────────────────────────────
  return "other";
}
