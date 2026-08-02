/**
 * Where the answer came from.
 *
 * Design's rule for the conversation surface: lead with the answer, then a
 * quiet expandable line — *"from your pricing model, Dana's last email, and the
 * Northwind deal."* Confidence lives in the willingness to be checked, not in
 * hedging language, so nothing here softens the answer; it only makes the
 * answer checkable.
 *
 * The hard constraint is the codebase's standing rule: **never assert
 * provenance you do not have.** So sources are not something the model tells us
 * about — they are DERIVED from the tool calls that actually ran and actually
 * finished in that turn. A turn that answered from the model's own knowledge
 * read nothing, produces an empty list, and must render no line at all.
 *
 * What counts:
 *   - the call completed without erroring (a failed read is not a source)
 *   - it READ something rather than wrote/sent/deleted (a send is not evidence)
 *   - it belongs to a family we can name honestly ("your email", "the web")
 *
 * Anything else — bash, file writes, UI plumbing, unrecognised tools — is
 * dropped rather than rendered as a vague "1 source".
 */

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import { isToolCallCompleted } from "@/domains/chat/utils/tool-call-status";
import { resolveAction } from "@/domains/chat/utils/action-summary";

/** The families we are willing to name. Order is display order. */
export type SourceFamily =
  | "mail"
  | "calendar"
  | "messages"
  | "documents"
  | "spreadsheets"
  | "crm"
  | "tasks"
  | "files"
  | "memory"
  | "cue"
  | "web";

export interface AnswerSource {
  /** Tool-call id — stable React key, and the thing a reader could go check. */
  id: string;
  family: SourceFamily;
  /** Plain-language name of the family: "your email", "the web". */
  label: string;
  /** The specific thing read, when the input names one. Never invented. */
  detail?: string;
  /** The tool that produced it, for the expanded list. */
  toolName: string;
}

/**
 * Verbs that mean "this call changed the world" rather than "this call read
 * it". A send is never evidence for the answer, and listing it as a source
 * would be both wrong and alarming.
 */
const WRITE_VERB_RE =
  /\b(send|post|create|update|delete|remove|archive|move|reply|forward|publish|deploy|charge|pay|transfer|order|checkout|buy|invite|schedule|write|edit|upload|import|assign|close)\b/;

/**
 * Tools that are the agent's own machinery. Their results are not the user's
 * data and naming them would be noise at best and misleading at worst.
 */
const INFRA_TOOL_RE =
  /^(bash|terminal|host_bash|ui_show|ui_update|app_open|todo|think|task|spawn|handoff|sleep|wait)/;

interface FamilyRule {
  family: SourceFamily;
  label: string;
  match: RegExp;
  /** Input keys, in preference order, whose value names the specific thing. */
  detailKeys: readonly string[];
}

/**
 * Slug → family. Matched against the RESOLVED action slug (so a Composio proxy
 * call carrying `GMAIL_FETCH_EMAILS` is recognised as mail, not as "Composio").
 * First match wins, so narrower families are listed before broader ones.
 */
const FAMILY_RULES: readonly FamilyRule[] = [
  {
    family: "mail",
    label: "your email",
    match: /gmail|outlook|mailbox|\bmail\b|thread|inbox/,
    detailKeys: ["subject", "query", "q", "thread_id", "from"],
  },
  {
    family: "calendar",
    label: "your calendar",
    match: /calendar|gcal|freebusy|\bevents?\b/,
    detailKeys: ["summary", "query", "calendar_id", "time_min"],
  },
  {
    family: "messages",
    label: "your messages",
    match: /slack|teams|discord|telegram|whatsapp|\bdm\b/,
    detailKeys: ["channel", "channel_name", "query", "user"],
  },
  {
    family: "spreadsheets",
    label: "your spreadsheets",
    match: /sheet|spreadsheet|excel|csv|airtable/,
    detailKeys: ["title", "spreadsheet_id", "range", "table"],
  },
  {
    family: "documents",
    label: "your documents",
    match:
      /drive|\bdocs?\b|document|notion|confluence|\bbox\b|dropbox|onedrive/,
    detailKeys: ["title", "name", "query", "document_id", "page_id"],
  },
  {
    family: "crm",
    label: "your CRM",
    match:
      /hubspot|salesforce|pipedrive|attio|\bcrm\b|\bdeal|\bcontacts?\b|company/,
    detailKeys: ["name", "query", "deal", "object_type"],
  },
  {
    family: "tasks",
    label: "your tasks",
    match: /linear|jira|asana|clickup|monday|issue|ticket/,
    detailKeys: ["title", "query", "issue_id", "project"],
  },
  {
    family: "memory",
    label: "what I remember",
    match: /memory|memories|recall|knowledge_base/,
    detailKeys: ["query", "key", "topic"],
  },
  {
    family: "files",
    label: "your files",
    match: /^(host_)?file_(read|search|list)$|attachment|^grep$|^glob$/,
    detailKeys: ["path", "file_path", "pattern", "filename"],
  },
  {
    family: "cue",
    label: "your work in Cue",
    match: /work_item|workitem|\bproject|\brule|schedule_list/,
    detailKeys: ["title", "query", "id"],
  },
  {
    family: "web",
    label: "the web",
    match: /^web_(search|fetch)$|^(search|fetch)_web$|serp|browse/,
    detailKeys: ["query", "url", "q"],
  },
];

/** Stable display order for the summary line. */
const FAMILY_ORDER: readonly SourceFamily[] = FAMILY_RULES.map((r) => r.family);

/** Longest detail we will show before eliding — a source line, not a quote. */
const MAX_DETAIL_CHARS = 48;

function firstString(
  args: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      const trimmed = value.trim().replace(/\s+/g, " ");
      return trimmed.length > MAX_DETAIL_CHARS
        ? `${trimmed.slice(0, MAX_DETAIL_CHARS - 1).trimEnd()}…`
        : trimmed;
    }
  }
  return undefined;
}

/**
 * Classify one finished tool call. Returns null for anything that isn't an
 * honest, nameable read of the user's data.
 */
export function classifyToolCall(
  toolCall: ChatMessageToolCall,
): AnswerSource | null {
  const rawName = toolCall.name ?? "";
  if (!rawName) return null;
  if (INFRA_TOOL_RE.test(rawName.toLowerCase())) return null;

  const input =
    toolCall.input && typeof toolCall.input === "object"
      ? (toolCall.input as Record<string, unknown>)
      : {};
  const { slug, args } = resolveAction(rawName, input);
  const bare = (slug.split(/__|\./).pop() ?? slug).toLowerCase();
  if (INFRA_TOOL_RE.test(bare)) return null;

  // A write is not evidence. Checked on the bare slug so `GMAIL_SEND_EMAIL`
  // is excluded while `GMAIL_FETCH_EMAILS` survives.
  const spaced = bare.replace(/[_-]+/g, " ");
  if (WRITE_VERB_RE.test(spaced)) return null;

  for (const rule of FAMILY_RULES) {
    if (!rule.match.test(bare)) continue;
    const detail = firstString(args, rule.detailKeys);
    return {
      id: toolCall.id,
      family: rule.family,
      label: rule.label,
      ...(detail ? { detail } : {}),
      toolName: rawName,
    };
  }
  return null;
}

/**
 * The turn's sources, deduplicated by family, in display order.
 *
 * Returns `[]` — not a placeholder — when the turn read nothing. Callers must
 * render nothing at all in that case; see `AnswerSources`.
 */
export function deriveAnswerSources(
  toolCalls: readonly ChatMessageToolCall[] | undefined,
): AnswerSource[] {
  if (!toolCalls || toolCalls.length === 0) return [];

  const byFamily = new Map<SourceFamily, AnswerSource>();
  for (const toolCall of toolCalls) {
    if (!isToolCallCompleted(toolCall)) continue;
    const source = classifyToolCall(toolCall);
    if (!source) continue;
    const existing = byFamily.get(source.family);
    // Keep the first read of a family, but prefer one that names something.
    if (!existing) byFamily.set(source.family, source);
    else if (!existing.detail && source.detail)
      byFamily.set(source.family, source);
  }

  return FAMILY_ORDER.flatMap((family) => {
    const found = byFamily.get(family);
    return found ? [found] : [];
  });
}

/**
 * "your email, your calendar and the web" — the collapsed line's tail.
 *
 * Serial comma omitted deliberately: this is a sentence Cue speaks, not a list
 * it renders. Empty input returns an empty string so a caller that forgets the
 * guard still renders no claim.
 */
export function summarizeSources(sources: readonly AnswerSource[]): string {
  const labels = sources.map((s) => s.label);
  if (labels.length === 0) return "";
  if (labels.length === 1) return labels[0]!;
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}
