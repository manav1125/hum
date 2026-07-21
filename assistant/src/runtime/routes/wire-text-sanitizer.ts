/**
 * Wire-text sanitizer for unparsed DeepSeek/DSML tool-call markup.
 *
 * Old DeepSeek-era conversations persisted assistant turns in which the
 * model emitted its native tool-call grammar as plain text (the parser
 * missed it), so the raw markup renders as assistant prose in clients.
 * This module strips those blocks at serialization time on the
 * conversation-messages read path — stored history is never mutated.
 *
 * Two marker grammars exist in real rows (sampled from prod):
 *
 * 1. DeepSeek native special tokens, using U+FF5C FULLWIDTH VERTICAL BAR
 *    and U+2581 LOWER ONE EIGHTH BLOCK:
 *
 *      <｜tool▁calls▁begin｜><｜tool▁call▁begin｜>skill_load<｜tool▁sep｜>
 *      {"skill": "app-builder"}<｜tool▁call▁end｜><｜tool▁calls▁end｜>
 *
 *    with partial/unterminated variants seen in the wild:
 *
 *      <｜tool▁call▁begin｜>function<｜tool▁sep｜>app_open\n```json\n{...}\n```<prose resumes>
 *      function<｜tool▁sep｜>skill_load\n```json\n{...}\n```
 *
 * 2. DSML XML-style markup:
 *
 *      <｜DSML｜tool_calls>
 *      <｜DSML｜invoke name="...">
 *      <｜DSML｜parameter name="..." string="true">...</｜DSML｜parameter>
 *      ...
 *
 *    often truncated/malformed (no closing tag, broken nesting like
 *    `</<｜DSML｜tool_calls>`).
 *
 * Each stripped block is replaced with a quiet "[tool call]" placeholder;
 * adjacent placeholders collapse to one.
 */

// U+FF5C FULLWIDTH VERTICAL BAR — present in every known marker variant, so
// it doubles as the cheap fast-path probe.
const FULLWIDTH_BAR = "｜";

const CALLS_BEGIN = "<｜tool▁calls▁begin｜>";
const CALLS_END = "<｜tool▁calls▁end｜>";
const CALL_BEGIN = "<｜tool▁call▁begin｜>";
const CALL_END = "<｜tool▁call▁end｜>";
const SEP = "<｜tool▁sep｜>";
const DSML_CALLS_OPEN = "<｜DSML｜tool_calls>";
const DSML_CALLS_CLOSE = "</｜DSML｜tool_calls>";
const DSML_INVOKE_OPEN = "<｜DSML｜invoke";
const DSML_INVOKE_CLOSE = "</｜DSML｜invoke>";

const PLACEHOLDER = "[tool call]";

/** True when the text contains any known DSML/DeepSeek tool-call marker. */
export function containsDsmlMarkup(text: string): boolean {
  if (!text.includes(FULLWIDTH_BAR)) return false;
  return (
    text.includes("｜DSML｜") || text.includes("｜tool▁") || text.includes(SEP)
  );
}

/**
 * Replace every span delimited by `open`..`close` (inclusive) with the
 * placeholder. An unterminated span (open marker with no matching close)
 * is stripped to the end of the string — runaway generations never emit
 * the closing token.
 */
function stripDelimitedSpans(
  text: string,
  open: string,
  close: string,
): string {
  let out = text;
  let from = 0;
  for (;;) {
    const start = out.indexOf(open, from);
    if (start === -1) break;
    const closeIdx = out.indexOf(close, start + open.length);
    const end = closeIdx === -1 ? out.length : closeIdx + close.length;
    out = out.slice(0, start) + PLACEHOLDER + out.slice(end);
    from = start + PLACEHOLDER.length;
  }
  return out;
}

/**
 * Find the end of the argument payload that follows a `<｜tool▁sep｜>`
 * marker when no explicit end token exists: the close of the fenced code
 * block carrying the JSON args. Returns the index just past the closing
 * fence, or `text.length` when no complete fence follows (truncated row).
 */
function endOfSepPayload(text: string, sepEnd: number): number {
  const fenceOpen = text.indexOf("```", sepEnd);
  if (fenceOpen === -1) return text.length;
  // Skip past the opening fence line (e.g. ```json).
  const fenceClose = text.indexOf("```", fenceOpen + 3);
  if (fenceClose === -1) return text.length;
  return fenceClose + 3;
}

/**
 * Strip `<｜tool▁call▁begin｜> ... <｜tool▁call▁end｜>` spans, including the
 * unterminated variant where prose resumes right after the args' closing
 * ``` fence.
 */
function stripCallSpans(text: string): string {
  let out = text;
  let from = 0;
  for (;;) {
    const start = out.indexOf(CALL_BEGIN, from);
    if (start === -1) break;
    const closeIdx = out.indexOf(CALL_END, start + CALL_BEGIN.length);
    let end: number;
    if (closeIdx !== -1) {
      end = closeIdx + CALL_END.length;
    } else {
      const sepIdx = out.indexOf(SEP, start + CALL_BEGIN.length);
      end =
        sepIdx === -1 ? out.length : endOfSepPayload(out, sepIdx + SEP.length);
    }
    out = out.slice(0, start) + PLACEHOLDER + out.slice(end);
    from = start + PLACEHOLDER.length;
  }
  return out;
}

/**
 * Strip bare `function<｜tool▁sep｜>name\n```json\n{...}\n``` ` blocks that
 * carry no begin marker at all. The block starts at the beginning of the
 * line holding the separator and ends at the args' closing fence (or the
 * end of the string when truncated).
 */
function stripBareSepBlocks(text: string): string {
  let out = text;
  for (;;) {
    const sepIdx = out.indexOf(SEP);
    if (sepIdx === -1) break;
    const lineStart = out.lastIndexOf("\n", sepIdx) + 1;
    const end = endOfSepPayload(out, sepIdx + SEP.length);
    out = out.slice(0, lineStart) + PLACEHOLDER + out.slice(end);
  }
  return out;
}

/** Collapse placeholder runs and surplus blank lines, then trim. */
function tidy(text: string): string {
  return text
    .replace(/\[tool call\](?:[ \t]*\n{0,2}[ \t]*\[tool call\])+/g, PLACEHOLDER)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Strip unparsed DeepSeek/DSML tool-call markup from assistant wire text,
 * leaving a quiet "[tool call]" placeholder where each block was removed.
 *
 * Read-path only: callers must never write the sanitized text back to
 * storage. Text without markers is returned unchanged (fast path).
 */
export function sanitizeAssistantWireText(text: string): string {
  if (!text || !containsDsmlMarkup(text)) return text;

  let out = text;

  // DeepSeek native grammar — outermost wrapper first so inner markers are
  // consumed as part of the span, then loose call spans, then bare
  // separator blocks.
  out = stripDelimitedSpans(out, CALLS_BEGIN, CALLS_END);
  out = stripCallSpans(out);
  out = stripBareSepBlocks(out);

  // DSML XML-style grammar. Real rows are frequently truncated or have
  // broken nesting, so unterminated opens strip to the end of the string.
  out = stripDelimitedSpans(out, DSML_CALLS_OPEN, DSML_CALLS_CLOSE);
  out = stripDelimitedSpans(out, DSML_INVOKE_OPEN, DSML_INVOKE_CLOSE);

  // Residual fragments: stray parameter/close tags or mangled markers that
  // survived span stripping (e.g. `</<｜DSML｜tool_calls>`).
  out = out.replace(/<[^<>\n]*｜DSML｜[^<>\n]*>/g, PLACEHOLDER);
  out = out.replace(/<｜tool▁[a-z▁]*｜>/g, PLACEHOLDER);

  return tidy(out);
}
