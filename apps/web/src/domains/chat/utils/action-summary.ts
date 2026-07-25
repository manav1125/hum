/**
 * Derive a legible, human-readable headline for a tool-confirmation card.
 *
 * Connector sends often arrive through a generic proxy — Composio's
 * `COMPOSIO_EXECUTE_TOOL` / `COMPOSIO_MULTI_EXECUTE_TOOL` — that carries the
 * real action (`GMAIL_SEND_EMAIL`) and its arguments in the INPUT, not the tool
 * name. Without this, the approval card reads "Confirmation required · Unknown
 * tool: mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL", which tells the user
 * nothing about what they're approving. This turns that into "Send email to
 * cindy@… — 'Partnership follow-up'".
 *
 * Pure and defensive: only reads known action/argument keys (never renders
 * free-form body text as the headline), and returns undefined when it can't
 * confidently summarize — the card then falls back to its generic label.
 */

type Dict = Record<string, unknown>;

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function asDict(v: unknown): Dict | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Dict) : undefined;
}

const ACTION_KEYS = [
  "tool_slug",
  "tool_name",
  "action",
  "action_name",
  "slug",
  "app_action",
] as const;

/** Pull the connector action slug + its argument object out of a proxy input. */
function resolveAction(
  toolName: string,
  input: Dict,
): { slug: string; args: Dict } {
  // COMPOSIO_MULTI_EXECUTE_TOOL: arguments is an array of { tool_slug, arguments }.
  const batchKeys = ["arguments", "tools", "actions", "executions", "calls"];
  for (const k of batchKeys) {
    const arr = input[k];
    if (Array.isArray(arr) && arr.length) {
      const first = asDict(arr[0]);
      if (first) {
        for (const ak of ACTION_KEYS) {
          const slug = asString(first[ak]);
          if (slug) return { slug, args: asDict(first.arguments) ?? first };
        }
      }
    }
  }
  // tool_schemas: { <SLUG>: {...} }
  const schemas = asDict(input.tool_schemas);
  if (schemas) {
    const key = Object.keys(schemas)[0];
    if (key) return { slug: key, args: asDict(input.arguments) ?? input };
  }
  // COMPOSIO_EXECUTE_TOOL: { tool_slug, arguments: {...} }
  for (const ak of ACTION_KEYS) {
    const slug = asString(input[ak]);
    if (slug) return { slug, args: asDict(input.arguments) ?? input };
  }
  // Not a proxy — the tool name itself is the action.
  return { slug: toolName, args: input };
}

/** "GMAIL_SEND_EMAIL" → { toolkit: "Gmail", verb phrase via specials }. */
function humanizeSlug(slug: string): string {
  const bare = slug.split(/__|\./).pop() ?? slug;
  const parts = bare.split("_").filter(Boolean);
  const toolkit = parts.length > 1 ? titleCase(parts[0]!) : undefined;
  const rest = (parts.length > 1 ? parts.slice(1) : parts).join(" ").toLowerCase();
  const via = toolkit ? ` via ${toolkit}` : "";
  if (/send.*mail|mail.*send/.test(rest)) return `Send an email${via}`;
  if (/send.*message|post.*message|message.*send/.test(rest))
    return `Send a message${via}`;
  if (/send.*sms|sms/.test(rest)) return `Send a text${via}`;
  if (/charge|payment|pay|transfer|payout/.test(rest))
    return `Move money${via}`;
  if (/order|checkout|purchase|buy/.test(rest)) return `Make a purchase${via}`;
  if (/publish|deploy/.test(rest)) return `Publish${via}`;
  if (/^delete|^remove/.test(rest)) return `Delete ${rest.replace(/^\w+\s?/, "")}${via}`.trim();
  if (/call|dial/.test(rest)) return `Place a call${via}`;
  return `${titleCase(rest)}${via}`.trim();
}

function titleCase(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1).toLowerCase() : s;
}

/** Insert a recipient clause before a trailing " via <Toolkit>", if present. */
function withRecipient(base: string, recipient: string): string {
  const m = base.match(/^(.*?)( via .+)$/);
  return m ? `${m[1]} to ${recipient}${m[2]}` : `${base} to ${recipient}`;
}

/**
 * The main entry: a one-line summary of what a confirmation will do, or
 * undefined when nothing legible can be derived.
 */
export function deriveActionSummary(
  toolName: string | undefined,
  input: Record<string, unknown> | undefined,
): string | undefined {
  if (!toolName || !input) return undefined;
  try {
    const { slug, args } = resolveAction(toolName, input);
    const base = humanizeSlug(slug);
    // Enrich sends with a recipient + subject when present.
    const recipient =
      asString(args.recipient_email) ??
      asString(args.to) ??
      asString(args.recipient) ??
      asString(args.email) ??
      asString(args.phone) ??
      asString(args.channel);
    const subject = asString(args.subject) ?? asString(args.title);
    if (/^send an email/i.test(base) && recipient) {
      const withTo = withRecipient(base, recipient);
      return subject ? `${withTo} — “${subject}”` : withTo;
    }
    if (/^send (a message|a text)/i.test(base) && recipient) {
      return withRecipient(base, recipient);
    }
    return base || undefined;
  } catch {
    return undefined;
  }
}
