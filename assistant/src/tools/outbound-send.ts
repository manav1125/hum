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
 * True when the tool performs a high-consequence action (external send/call,
 * money, publish, delete, purchase) that must never run unattended without a
 * human and needs a fresh approval when run interactively.
 */
export function requiresHumanApprovalForAction(
  name: string,
  input: Record<string, unknown>,
): boolean {
  if (INTERNAL_INFRA_TOOLS.has(name)) return false;
  const cls = classifyAutonomy(name, input);
  if (HIGH_CONSEQUENCE_CLASSES.has(cls)) return true;
  const lower = name.toLowerCase();
  return OUTBOUND_SEND_NAME_PATTERNS.some((re) => re.test(lower));
}

/**
 * The outbound-message subset — used where the phrasing is send-specific.
 * (A strict subset of {@link requiresHumanApprovalForAction}.)
 */
export function isOutboundExternalSendTool(
  name: string,
  input: Record<string, unknown>,
): boolean {
  if (INTERNAL_INFRA_TOOLS.has(name)) return false;
  const cls = classifyAutonomy(name, input);
  if (cls === "send" || cls === "contact") return true;
  const lower = name.toLowerCase();
  return OUTBOUND_SEND_NAME_PATTERNS.some((re) => re.test(lower));
}
