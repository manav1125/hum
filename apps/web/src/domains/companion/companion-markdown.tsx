/**
 * The small amount of Markdown a glance needs.
 *
 * The card was drawing the model's raw output, so a real answer arrived as
 * `**Hong Kong — Sunday**` and `[Hong Kong Observatory](https://…)`: asterisks
 * and a URL longer than the sentence around it, in a panel that floats over
 * whatever you were doing.
 *
 * **Deliberately not `react-markdown`.** The companion route is a standalone
 * window that loads before anything else and is meant to be instant; pulling a
 * parser and its plugin chain into that chunk costs the panel its start-up for
 * a surface that shows two paragraphs. This covers what answers actually use
 * inline — emphasis, code, links — and leaves everything structural to
 * "Open in Cue ›", which is what that handoff is for.
 *
 * Links render as their label. The companion window is `navigation: "deny-all"`
 * and there is no external-open bridge, so a clickable link here would be a
 * link that does nothing — the failure this surface has been caught by twice.
 * The address goes in the `title` so it is still available, and the app is
 * where a link can actually be followed.
 */

import type { ReactNode } from "react";

/**
 * One pass, ordered so the greedier forms cannot eat the others: code first,
 * because backticks may legitimately contain asterisks; then links, whose
 * label may contain emphasis; then bold before italic, because `**` starts
 * with `*`.
 */
const INLINE =
  /(`[^`\n]+`)|(\[[^\]\n]*\]\([^)\s]+\))|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)/;

export function renderCompanionInline(
  text: string,
  keyPrefix = "i",
): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let n = 0;

  while (rest.length > 0) {
    const match = INLINE.exec(rest);
    if (!match || match.index === undefined) {
      out.push(rest);
      break;
    }
    if (match.index > 0) out.push(rest.slice(0, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${n++}`;

    if (token.startsWith("`")) {
      out.push(
        <code
          key={key}
          style={{
            fontFamily: "'DM Mono', ui-monospace, monospace",
            fontSize: "0.92em",
            background: "rgba(255,255,255,.07)",
            borderRadius: 4,
            padding: "1px 4px",
          }}
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("[")) {
      const split = token.indexOf("](");
      const label = token.slice(1, split);
      const href = token.slice(split + 2, -1);
      out.push(
        <span
          key={key}
          title={href}
          style={{ textDecoration: "underline", textUnderlineOffset: 2 }}
        >
          {/* An empty label would render as nothing at all, so the address
              stands in for it rather than the link vanishing. */}
          {label || href}
        </span>,
      );
    } else if (token.startsWith("**") || token.startsWith("__")) {
      out.push(
        <strong key={key} style={{ fontWeight: 600 }}>
          {token.slice(2, -2)}
        </strong>,
      );
    } else {
      out.push(<em key={key}>{token.slice(1, -1)}</em>);
    }

    rest = rest.slice(match.index + token.length);
  }

  return out;
}

/**
 * A turn's body: blank-line-separated paragraphs, with single newlines kept as
 * line breaks. Anything more structural is the app's job.
 */
export function renderCompanionMarkdown(text: string): ReactNode[] {
  return text
    .split(/\n{2,}/)
    .filter((block) => block.trim().length > 0)
    .map((block, b) => (
      <span key={`b${b}`} style={{ display: "block", marginTop: b > 0 ? 6 : 0 }}>
        {block.split("\n").map((line, l) => (
          <span key={`l${l}`} style={{ display: "block" }}>
            {renderCompanionInline(line, `b${b}l${l}`)}
          </span>
        ))}
      </span>
    ));
}
