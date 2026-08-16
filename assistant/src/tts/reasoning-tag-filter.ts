/**
 * Stateful streaming filter that removes `<think>` / `<thinking>` spans from
 * text on its way to a TTS feed.
 *
 * Reasoning models on OpenAI-compatible endpoints are supposed to keep their
 * chain-of-thought in the out-of-band `reasoning` / `reasoning_content` fields,
 * which the chat-completions provider turns into `thinking_delta` events and
 * never forwards to speech. That separation is not reliable: on some
 * OpenRouter-served models the split leaks, and the literal tag characters
 * arrive on the ordinary content channel — which is the one that feeds TTS.
 * Without a filter the assistant reads its own inner monologue aloud, with the
 * onset delay that implies.
 *
 * Two properties make this safe to run unconditionally:
 *
 * 1. **It only touches speech.** Callers keep accumulating the raw deltas for
 *    persistence, the transcript and the on-screen text. Nothing this filter
 *    withholds is lost to the user — it is merely not spoken. That is what
 *    makes the unclosed-span behaviour below acceptable.
 * 2. **A stream with no tags passes through byte-for-byte.** The only text ever
 *    held back is a suffix that is still a viable prefix of a tag, and
 *    {@link ReasoningTagFilter.flush} releases it once the turn ends and it is
 *    proven not to be one.
 *
 * Partial tags are held across delta boundaries, so a stream that splits
 * `<think` / `ing>` across two chunks still opens a span, and one that splits
 * `<b` / `old>` still emits `<bold>` intact.
 *
 * **Unclosed spans stay suppressed for the rest of the turn.** An opening tag
 * with no matching close mutes the remainder of the speech feed. This is the
 * deliberate choice: the text is still on screen (property 1), and the failure
 * being fixed is speaking reasoning that should never have been audible.
 * Suppression is per-turn — construct one filter per turn, or call
 * {@link ReasoningTagFilter.reset}, so a stuck span cannot outlive it.
 */

/** Tags that open a reasoning span. Matched case-insensitively. */
const OPEN_TAGS = ["<think>", "<thinking>"] as const;

/** Tags that close a reasoning span. Matched case-insensitively. */
const CLOSE_TAGS = ["</think>", "</thinking>"] as const;

const ALL_TAGS: readonly string[] = [...OPEN_TAGS, ...CLOSE_TAGS];

/** Longest tag length — the most text we ever need to hold as a partial. */
const MAX_TAG_LENGTH = Math.max(...ALL_TAGS.map((t) => t.length));

/**
 * Longest tag from `candidates` that `haystack` starts with at `index`, or
 * `undefined` when none matches. `haystack` must already be lowercased.
 * Longest-first matters because `<think>` is a prefix-sibling of `<thinking>`
 * only up to the sixth character — but `</think>` and `</thinking>` genuinely
 * share a prefix, so a shortest-match scan would close a span one tag early.
 */
function matchTagAt(
  haystack: string,
  index: number,
  candidates: readonly string[],
): string | undefined {
  let best: string | undefined;
  for (const tag of candidates) {
    if (!haystack.startsWith(tag, index)) continue;
    if (!best || tag.length > best.length) best = tag;
  }
  return best;
}

/**
 * True when `haystack.slice(index)` is a proper prefix of some tag — i.e. more
 * characters could still turn it into one, so it must be held rather than
 * emitted. `haystack` must already be lowercased.
 */
function couldStillBecomeTag(
  haystack: string,
  index: number,
  candidates: readonly string[],
): boolean {
  const rest = haystack.slice(index);
  return candidates.some((tag) => tag.startsWith(rest));
}

export class ReasoningTagFilter {
  /** Inside an opened, not-yet-closed reasoning span. */
  private inSpan = false;

  /** Text withheld because it is still a viable prefix of a tag. */
  private held = "";

  /**
   * Feed the next raw delta. Returns the text that is safe to speak now, which
   * may be empty — either because everything in it was reasoning, or because
   * the tail is an unresolved partial tag being held for the next delta.
   */
  push(text: string): string {
    if (text.length === 0) return "";

    const buffer = this.held + text;
    const lower = buffer.toLowerCase();
    this.held = "";

    let out = "";
    let i = 0;

    while (i < buffer.length) {
      if (this.inSpan) {
        const nextClose = this.findNextTagStart(lower, i, CLOSE_TAGS);
        if (nextClose === undefined) {
          // Nothing closes in what we have. Everything here is reasoning and
          // is dropped, but a trailing partial close tag must survive into the
          // next delta or a split `</thi` + `nk>` would never close the span.
          this.held = this.trailingPartial(buffer, lower, CLOSE_TAGS);
          return out;
        }
        this.inSpan = false;
        i = nextClose.end;
        continue;
      }

      const next = this.findNextTagStart(lower, i, ALL_TAGS);
      if (next === undefined) {
        // No tag, and no partial tag, in the remainder — but the tail may
        // still be the beginning of one.
        const partial = this.trailingPartial(buffer, lower, ALL_TAGS);
        out += buffer.slice(i, buffer.length - partial.length);
        this.held = partial;
        return out;
      }

      out += buffer.slice(i, next.start);
      i = next.end;
      // A stray close tag (span opened on the reasoning channel, only the tail
      // leaked onto the content channel) is dropped without changing state:
      // there is nothing to close, and speaking "</think>" is never right.
      if (matchTagAt(lower, next.start, OPEN_TAGS)) this.inSpan = true;
    }

    return out;
  }

  /**
   * End of turn. Releases any held partial tag — by definition it never became
   * one — and clears state so the instance can serve the next turn.
   */
  flush(): string {
    // A partial held while inside a span is reasoning, not speech: it was only
    // retained in case it completed a close tag.
    const tail = this.inSpan ? "" : this.held;
    this.reset();
    return tail;
  }

  /** Drop all state. Held text is discarded, not emitted. */
  reset(): void {
    this.inSpan = false;
    this.held = "";
  }

  /**
   * First complete tag at or after `from`, as `{ start, end }` offsets. A `<`
   * that only *could* become a tag (because the buffer ends mid-tag) is not a
   * match — {@link trailingPartial} handles that case.
   */
  private findNextTagStart(
    lower: string,
    from: number,
    candidates: readonly string[],
  ): { start: number; end: number } | undefined {
    for (
      let i = lower.indexOf("<", from);
      i !== -1;
      i = lower.indexOf("<", i + 1)
    ) {
      const tag = matchTagAt(lower, i, candidates);
      if (tag) return { start: i, end: i + tag.length };
    }
    return undefined;
  }

  /**
   * The suffix of `buffer` that must be held because it is a proper prefix of
   * some tag. Only the last `MAX_TAG_LENGTH - 1` characters can qualify, so
   * this is bounded work regardless of how long the buffer grew.
   */
  private trailingPartial(
    buffer: string,
    lower: string,
    candidates: readonly string[],
  ): string {
    const earliest = Math.max(0, buffer.length - (MAX_TAG_LENGTH - 1));
    for (
      let i = lower.indexOf("<", earliest);
      i !== -1;
      i = lower.indexOf("<", i + 1)
    ) {
      if (couldStillBecomeTag(lower, i, candidates)) return buffer.slice(i);
    }
    return "";
  }
}
