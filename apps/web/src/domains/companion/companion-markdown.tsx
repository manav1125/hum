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

/** The card's link colour. Matches the composer's send button. */
const ACCENT_TEXT = "#6E9BFF";

export function renderCompanionInline(
  text: string,
  keyPrefix = "i",
  onOpenLink?: (href: string) => void,
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
      // An empty label would render as nothing at all, so the address stands
      // in for it rather than the link vanishing.
      const shown = label || href;
      out.push(
        onOpenLink ? (
          <button
            key={key}
            type="button"
            title={href}
            onClick={() => onOpenLink(href)}
            style={{
              background: "none",
              border: 0,
              padding: 0,
              font: "inherit",
              color: ACCENT_TEXT,
              textDecoration: "underline",
              textUnderlineOffset: 2,
              cursor: "pointer",
            }}
          >
            {shown}
          </button>
        ) : (
          <span
            key={key}
            title={href}
            style={{ textDecoration: "underline", textUnderlineOffset: 2 }}
          >
            {shown}
          </span>
        ),
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
 * A turn's body: headings, bullet and numbered lists, and paragraphs.
 *
 * Answers routinely come back as lists, and a list drawn as run-on prose with
 * stray hyphens is harder to read than the paragraph it was trying not to be.
 * Everything beyond this — tables, block quotes, fenced code — stays the app's
 * job, and "Open in Cue ›" is how you get there.
 */
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const NUMBERED = /^\s{0,3}(\d{1,2})[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}(#{1,4})\s+(.*)$/;

type Block =
  | { kind: "p"; lines: string[] }
  | { kind: "h"; level: number; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[]; start: number };

/** Group the lines into blocks. Exported for its test. */
export function toCompanionBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const heading = HEADING.exec(line);
    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);
    const last = blocks[blocks.length - 1];

    if (!line.trim()) {
      // A blank line ends whatever was open, which is what separates two
      // paragraphs from one paragraph with a line break in it.
      if (last && last.kind === "p") blocks.push({ kind: "p", lines: [] });
      continue;
    }
    if (heading) {
      blocks.push({ kind: "h", level: heading[1]!.length, text: heading[2]! });
      continue;
    }
    if (bullet) {
      if (last?.kind === "ul") last.items.push(bullet[1]!);
      else blocks.push({ kind: "ul", items: [bullet[1]!] });
      continue;
    }
    if (numbered) {
      if (last?.kind === "ol") last.items.push(numbered[2]!);
      else
        blocks.push({
          kind: "ol",
          items: [numbered[2]!],
          start: Number(numbered[1]),
        });
      continue;
    }
    if (last?.kind === "p" && last.lines.length > 0) last.lines.push(line);
    else blocks.push({ kind: "p", lines: [line] });
  }
  return blocks.filter(
    (b) =>
      b.kind !== "p" || b.lines.some((l) => l.trim().length > 0),
  );
}

export function renderCompanionMarkdown(
  text: string,
  onOpenLink?: (href: string) => void,
): ReactNode[] {
  const inline = (line: string, key: string) =>
    renderCompanionInline(line, key, onOpenLink);

  return toCompanionBlocks(text).map((block, b) => {
    const spacing = { display: "block", marginTop: b > 0 ? 6 : 0 } as const;
    if (block.kind === "h") {
      return (
        <span
          key={`h${b}`}
          style={{
            ...spacing,
            fontWeight: 600,
            // The card is 360px wide; a heading that grew would shout. One
            // step up from the body, and no more.
            fontSize: block.level <= 2 ? "1.04em" : "1em",
          }}
        >
          {inline(block.text, `h${b}`)}
        </span>
      );
    }
    if (block.kind === "ul" || block.kind === "ol") {
      return (
        <span key={`l${b}`} style={spacing}>
          {block.items.map((item, i) => (
            <span
              key={`li${i}`}
              style={{ display: "flex", gap: 7, alignItems: "baseline" }}
            >
              <span aria-hidden style={{ flex: "0 0 auto", opacity: 0.7 }}>
                {block.kind === "ul" ? "•" : `${block.start + i}.`}
              </span>
              <span style={{ minWidth: 0 }}>{inline(item, `li${b}-${i}`)}</span>
            </span>
          ))}
        </span>
      );
    }
    return (
      <span key={`p${b}`} style={spacing}>
        {block.lines.map((line, l) => (
          <span key={`pl${l}`} style={{ display: "block" }}>
            {inline(line, `p${b}l${l}`)}
          </span>
        ))}
      </span>
    );
  });
}
