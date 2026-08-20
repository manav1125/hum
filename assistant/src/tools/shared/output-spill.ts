/**
 * Oversized tool output is SPILLED, never discarded.
 *
 * A bounded preview goes to the model together with a locator and a sentence
 * telling it how to fetch the rest. The alternative — slicing and appending
 * "… (truncated)" — throws away the part nobody has read yet and tells the
 * model a story it cannot check: the interesting line is as likely to be at
 * byte 30,000 as at byte 300.
 *
 * `formatShellOutput` has done this for bash since it was written. This module
 * is that mechanism extracted so any tool can use it, because bash was not the
 * path that needed it most: an MCP tool result reached the model **unbounded**,
 * so one server returning a large payload spent the whole context window with
 * nothing able to stop it.
 *
 * ## Why the file is written the way it is
 *
 * Spilled text is arbitrary output from commands and third-party servers, and
 * it lands on a multi-user machine. So:
 *
 * - a **private directory** (0700) rather than the shared temp root, created
 *   once per process;
 * - a **random** name, so nothing is guessable;
 * - an **exclusive** create (`wx`) at 0600, so a pre-planted symlink at the
 *   path cannot redirect the write into a file the attacker chooses.
 *
 * Writing straight into `os.tmpdir()` with a predictable name is the symlink
 * race this avoids.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getLogger } from "../../util/logger.js";
import { safeStringSlice } from "../../util/unicode.js";

const log = getLogger("output-spill");

/** Files this process spilled, removed on shutdown. */
const spilled = new Set<string>();

/** Lazily created 0700 directory that holds every spill from this process. */
let spillDir: string | undefined;

function ensureSpillDir(): string {
  if (spillDir) return spillDir;
  // mkdtemp gives a random suffix; mode narrows it to the owner. Both matter:
  // the randomness stops guessing, the mode stops reading.
  spillDir = mkdtempSync(join(tmpdir(), "cue-spill-"));
  mkdirSync(spillDir, { recursive: true, mode: 0o700 });
  return spillDir;
}

/** A spilled artifact: where it went, how big it was, and how to read it. */
export interface SpillRef {
  /**
   * Opaque handle. It is a filesystem path today; consumers must render it
   * with {@link retrievalHint} rather than assuming a path is always what a
   * locator is — a remote execution world would hand back a URI or a key.
   */
  locator: string;
  /** Exact byte length of the text that was spilled. */
  bytes: number;
  /** One sentence telling the reader how to get the full text. */
  retrievalHint: string;
}

/**
 * Persist `text` and return its locator, or `undefined` when the write fails.
 *
 * Failing to spill is not an error the caller should propagate: the preview is
 * still useful and the tool still succeeded. It IS logged, because silently
 * losing the overflow is the behaviour this module exists to replace.
 */
export function spillText(text: string, label: string): SpillRef | undefined {
  try {
    const name = `${label}-${randomBytes(12).toString("hex")}.txt`;
    const locator = join(ensureSpillDir(), name);
    // `wx` fails if the path exists — including as a symlink someone planted.
    writeFileSync(locator, text, { encoding: "utf-8", mode: 0o600, flag: "wx" });
    spilled.add(locator);
    return {
      locator,
      bytes: Buffer.byteLength(text, "utf-8"),
      retrievalHint: `Read ${locator} for the full output.`,
    };
  } catch (err) {
    log.warn({ err, label }, "could not spill oversized output to a file");
    return undefined;
  }
}

/** Remove every file this process spilled. Safe to call more than once. */
export function cleanupSpilledFiles(): void {
  for (const path of spilled) {
    try {
      unlinkSync(path);
    } catch {
      // Already gone, or never ours to remove.
    }
  }
  spilled.clear();
}

export interface BoundedOutput {
  /** What the model sees: the preview plus, when spilled, how to get the rest. */
  content: string;
  /** Present only when the text exceeded `limit` AND the spill succeeded. */
  spill?: SpillRef;
  /** True when the text exceeded `limit`, whether or not the spill worked. */
  wasBounded: boolean;
}

/**
 * Bound `text` to `limit` characters, spilling the whole of it first.
 *
 * The marker states the real size and where the rest is, so the model can
 * decide whether the remainder is worth a read. When the spill fails the
 * marker says the rest is unavailable rather than implying a file exists —
 * a locator that does not resolve is worse than no locator.
 */
export function boundOutput(
  text: string,
  limit: number,
  label: string,
): BoundedOutput {
  if (text.length <= limit) return { content: text, wasBounded: false };

  const spill = spillText(text, label);
  const shown = safeStringSlice(text, 0, limit);
  const marker = spill
    ? `<output_bounded shown="${limit}" bytes="${spill.bytes}" file="${spill.locator}" />\n${spill.retrievalHint}`
    : `<output_bounded shown="${limit}" bytes="${Buffer.byteLength(text, "utf-8")}" unavailable="true" />\nThe rest of this output could not be saved and is not retrievable.`;

  return { content: `${shown}\n${marker}`, spill, wasBounded: true };
}
