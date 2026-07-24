/**
 * Outbound external-communication tools — the hard-checkpoint class.
 *
 * Any tool that egresses a message to a third party (email / DM / post /
 * subscribe) or initiates real-time outreach (a phone call) is a hard
 * checkpoint: sending to an outside party ALWAYS requires explicit human
 * approval before the message leaves, and can NEVER be cleared by internal or
 * background "guardian" trust. In an unattended run such a tool parks as a
 * needs-you item instead of executing; in an attended run it forces a fresh,
 * un-auto-approvable confirmation prompt.
 *
 * This exists because the guardian-approval gate is *trust*-scoped (it only
 * catches untrusted external actors), so a scheduled/background run holding
 * INTERNAL_GUARDIAN_TRUST_CONTEXT could reach an immediate-send connector tool
 * (`gmail__GMAIL_SEND_EMAIL`) and send with no human in the loop. The concept
 * the trust gate lacks is "this call talks to the outside world" — that is
 * what this predicate supplies, independent of trust class.
 *
 * We reuse the lexical autonomy classifier rather than a hand-maintained tool
 * list so a newly connected connector is covered automatically:
 *   - `classifyAutonomy` returns "send" for `gmail__GMAIL_SEND_EMAIL`,
 *     `messaging_send`, outlook `sendDraft`, `*_SEND_MESSAGE`, `post_*`,
 *     `subscribe_*` — anything whose name carries a send verb/segment.
 *   - it returns "contact" for real-time call initiation (`call_start`,
 *     `dial_outbound`, …).
 *   - crucially it returns "draft" (NOT "send") for `GMAIL_CREATE_EMAIL_DRAFT`,
 *     `messaging_draft`, `create_*` — so preparing a message in the background
 *     stays allowed and only the actual send parks. This is the intended
 *     "draft freely, human sends" flow.
 */
import { classifyAutonomy } from "../permissions/autonomy-class.js";

/**
 * Backstop for connector tools whose egress verb is NOT at the name prefix, so
 * the lexical classifier (which prefix-anchors its send verbs) under-buckets
 * them. The canonical miss is Slack's `chat.postMessage` →
 * `slack__CHAT_POST_MESSAGE` (verb "post" sits mid-name). Matched against the
 * lowercased full name so the namespace doesn't matter. Kept deliberately
 * narrow — only phrases that unambiguously mean "a message leaves to someone".
 */
const OUTBOUND_SEND_NAME_PATTERNS: readonly RegExp[] = [
  /send[_.-]?(e?mail|message|msg|sms|text|dm|chat|reply|note)/,
  /(post|create)[_.-]?message/, // slack chat.postMessage, *_create_message
  /reply[_.-]?(all|email|message|thread)/,
  /\bdm[_.-]?send\b/,
];

export function isOutboundExternalSendTool(
  name: string,
  input: Record<string, unknown>,
): boolean {
  const cls = classifyAutonomy(name, input);
  if (cls === "send" || cls === "contact") return true;
  const lower = name.toLowerCase();
  return OUTBOUND_SEND_NAME_PATTERNS.some((re) => re.test(lower));
}
