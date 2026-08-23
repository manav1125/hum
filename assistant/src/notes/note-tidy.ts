/**
 * Tidying a note — only when asked, and always with the original recoverable.
 *
 * This is where the design diverges hardest from Mem, and the reason is
 * worth keeping in front of whoever changes it next: **an assistant that
 * silently rewrites what you typed makes the note untrustworthy as a record
 * of what you actually thought**, which is the only reason to keep notes at
 * all. A tidied note that quietly replaced the original is no longer
 * evidence of anything.
 *
 * Three rules, and all three are structural rather than editorial:
 *
 *  1. **Never unasked.** Nothing calls this on a timer, on save, or on close.
 *     There is deliberately no `✧` button in the editor inviting a rewrite —
 *     the tidy lives in `⋯`, where you go looking for it.
 *  2. **Always a diff.** The route returns both texts. The client shows them
 *     side by side and offers three answers: use the tidied one, keep mine,
 *     keep both.
 *  3. **The original is always recoverable, even after accepting.** The tidy
 *     is a version, not a replacement — {@link applyTidy} preserves the
 *     original in the note so "Keep mine" works tomorrow, not just now.
 *
 * What a tidy may do: punctuation, capitalisation, expanding the owner's own
 * shorthand, breaking a wall of text into sentences. What it may not do: add
 * a fact, drop a fact, soften a judgement, or make it sound like someone
 * else. The prompt says so, and {@link looksLikeRewrite} refuses results that
 * changed the length so much that something was plainly added or lost.
 */

import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import { getConfig } from "../config/loader.js";
import { getConfiguredProvider } from "../providers/provider-send-message.js";
import { runBtwSidechain } from "../runtime/btw-sidechain.js";
import { getLogger } from "../util/logger.js";
import { getNote, type Note, updateNote } from "./note-store.js";

const log = getLogger("note-tidy");

const TIDY_TIMEOUT_MS = 15_000;
const MAX_TIDY_CHARS = 8_000;

/**
 * How far the length may move before the result is treated as a rewrite
 * rather than a tidy.
 *
 * Expanding shorthand legitimately grows text ("thu+fri" → "Thursday and
 * Friday"), so the ceiling is generous; anything past it has almost
 * certainly added or dropped something, and the honest response is to keep
 * the owner's words rather than to show them a "tidy" that is not one.
 */
const MAX_GROWTH = 1.6;
const MIN_SHRINK = 0.6;

export function looksLikeRewrite(original: string, tidied: string): boolean {
  const from = original.trim().length;
  const to = tidied.trim().length;
  if (from === 0) return true;
  const ratio = to / from;
  return ratio > MAX_GROWTH || ratio < MIN_SHRINK;
}

export type TidyResult =
  | { status: "tidied"; original: string; tidied: string }
  /** The model gave back something that was not a tidy. Keep their words. */
  | { status: "refused" }
  /** The request failed. Distinct from "refused", and from "no change". */
  | { status: "failed" }
  | { status: "not_found" };

function buildTidyPrompt(body: string): string {
  return [
    "Below is a note somebody wrote for themselves, in their own shorthand. Tidy it.",
    "",
    "You MAY: fix punctuation and capitalisation, expand their own abbreviations, and break a wall of text into sentences.",
    "You MUST NOT: add any fact, drop any fact, soften or strengthen a judgement, or change the voice into something more formal than they wrote.",
    "Keep it recognisably theirs. If it is already tidy, return it unchanged.",
    "",
    "Reply with ONLY the tidied text — no preamble, no quotes, no explanation.",
    "",
    '"""',
    body.slice(0, MAX_TIDY_CHARS),
    '"""',
  ].join("\n");
}

type TidyFn = (body: string) => Promise<string | null>;

let tidyOverride: TidyFn | null = null;

export function _setNoteTidyOverridesForTests(overrides: {
  tidy?: TidyFn;
}): void {
  tidyOverride = overrides.tidy ?? null;
}

async function tidyWithLlm(body: string): Promise<string | null> {
  try {
    const provider = await getConfiguredProvider("conversationTitle");
    if (!provider) return null;
    const config = getConfig();
    const resolved = resolveCallSiteConfig("conversationTitle", config.llm);
    const result = await runBtwSidechain({
      content: buildTidyPrompt(body),
      provider,
      systemPrompt:
        "You tidy a person's own notes without changing what they said. You never add or remove facts, and you never make it sound like someone else wrote it. Reply with only the tidied text.",
      messages: [],
      tools: [],
      callSite: "conversationTitle",
      maxTokens: resolved.maxTokens,
      timeoutMs: TIDY_TIMEOUT_MS,
    });
    return result.text.trim() || null;
  } catch (err) {
    log.debug({ err: String(err) }, "tidy failed");
    return null;
  }
}

/**
 * Propose a tidied version. **Writes nothing** — the note is untouched until
 * the owner accepts, which is the whole point of returning a diff.
 */
export async function proposeTidy(noteId: string): Promise<TidyResult> {
  const note = getNote(noteId);
  if (!note) return { status: "not_found" };

  const original = note.body;
  if (!original.trim()) return { status: "refused" };

  const tidied = await (tidyOverride ?? tidyWithLlm)(original);
  if (tidied === null) return { status: "failed" };

  // A "tidy" that changed the length this much added or lost something.
  // Keeping their words is the safe way to be wrong here.
  if (looksLikeRewrite(original, tidied)) {
    log.debug({ noteId }, "tidy looked like a rewrite; keeping the original");
    return { status: "refused" };
  }

  return { status: "tidied", original, tidied };
}

export type TidyChoice = "use_tidied" | "keep_mine" | "keep_both";

/**
 * Record what the owner chose.
 *
 * `use_tidied` swaps the body **and keeps the original in `transcript`**, so
 * "Keep mine" still works tomorrow. That field is where a note's verbatim
 * record already lives (a voice note's actual words), and the meaning is the
 * same here: what was really said, kept apart from Cue's prose.
 *
 * `bodyIsSummary` is set so every surface that renders the note labels it as
 * Cue's words rather than the owner's — the same rule that stops a voice
 * summary being read as a transcript.
 */
export function applyTidy(
  noteId: string,
  choice: TidyChoice,
  tidied: string,
): Note | null {
  const note = getNote(noteId);
  if (!note) return null;

  if (choice === "keep_mine") return note;

  if (choice === "keep_both") {
    // Both versions, in one note, with the owner's first. Nothing is lost and
    // nothing needs a second row to find later.
    return updateNote(noteId, {
      body: `${note.body.trimEnd()}\n\n---\nTidied by Cue:\n${tidied.trim()}`,
    });
  }

  return updateNote(noteId, {
    body: tidied.trim(),
    // The original, recoverable forever — the tidy is a version, not a
    // replacement, and that promise has to survive the session it was made in.
    transcript: note.transcript ?? note.body,
    bodyIsSummary: true,
  });
}
