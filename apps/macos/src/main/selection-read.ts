import { clipboard, type Data } from "electron";

import { runAppleScript } from "./appleScriptExecutor";
import log from "./logger";

/**
 * Reading what the owner selected — the corner's primary input.
 *
 * Selection beats screen-reading as the way into the corner, on three counts.
 * It is **precise**: you chose the 41 words, so the suggestions are about the
 * right thing rather than a guess at the window. It is **narrow**: "only the
 * text you highlighted, nothing else on this screen was read" is a sentence
 * nobody has to think about. And it is **already muscle memory** —
 * select-then-shortcut is how people use every other Mac tool.
 *
 * ## How the text is actually obtained, and the trade that makes
 *
 * The selection is fetched by snapshotting the clipboard, synthesising ⌘C
 * into the frontmost app, reading what landed, and putting the original
 * clipboard back. The alternative is `kAXSelectedText` from the accessibility
 * API, which is cleaner — it never touches the pasteboard — and it is the
 * path this module should eventually take.
 *
 * The reasons it does not today are worth stating rather than discovering:
 *
 *   · It needs a **native helper build**, which this shape does not.
 *   · `kAXSelectedText` is unimplemented in a surprising number of apps
 *     (Electron apps and most web views among them), where a synthesised ⌘C
 *     works fine. In practice the copy path has broader reach.
 *
 * What it costs: the pasteboard is briefly borrowed. Restoring it is
 * therefore not politeness, it is correctness, and it happens on every path
 * including failure — someone who copied a password a moment ago must not
 * find it replaced by a paragraph of email.
 *
 * ## Consent
 *
 * This reads **only the current selection** — never the window, never the
 * screen, never another app. What the panel then prints is the text it
 * received, verbatim, so a wrong selection is obvious before anything acts on
 * it. Screen-reading is a separate, later, explicitly-asked-for upgrade.
 */

/** Synthesised copy, aimed at whatever is frontmost. */
const COPY_SHORTCUT_SCRIPT =
  'tell application "System Events" to keystroke "c" using command down';

/** The frontmost app's name, so the panel can say where the words came from. */
const FRONT_APP_SCRIPT =
  'tell application "System Events" to get name of first application process whose frontmost is true';

/**
 * How long to wait for the copy to land on the pasteboard.
 *
 * A synthesised keystroke is asynchronous — the app has to receive it, decide
 * it is a copy, and write. Polling a short window beats a single fixed sleep:
 * a fast app answers in a few milliseconds, and a slow one still gets its
 * chance without every read paying for it.
 */
const COPY_POLL_INTERVAL_MS = 20;
const COPY_TIMEOUT_MS = 320;

/** Longer than this and it is a document, not a selection worth quoting. */
const MAX_SELECTION_CHARS = 8_000;

export interface Selection {
  /** Exactly what was highlighted, verbatim. The panel quotes this. */
  text: string;
  /** Shown as "YOU SELECTED · 41 WORDS", so a wrong grab is obvious. */
  wordCount: number;
  /** Where it came from, e.g. "Mail". Null when it could not be determined. */
  appName: string | null;
}

export interface SelectionReadDeps {
  readClipboardText: () => string;
  snapshotClipboard: () => ClipboardSnapshot;
  restoreClipboard: (snapshot: ClipboardSnapshot) => void;
  clearClipboard: () => void;
  runScript: (script: string) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  /** Injected so the poll loop can be driven without burning real time. */
  now: () => number;
}

export type ClipboardSnapshot =
  { kind: "structured"; data: Data } | { kind: "empty" };

const snapshotClipboard = (): ClipboardSnapshot => {
  const data: Data = {};
  const text = clipboard.readText();
  const html = clipboard.readHTML();
  const rtf = clipboard.readRTF();
  const image = clipboard.readImage();
  if (text) data.text = text;
  if (html) data.html = html;
  if (rtf) data.rtf = rtf;
  if (!image.isEmpty()) data.image = image;
  return Object.keys(data).length > 0
    ? { kind: "structured", data }
    : { kind: "empty" };
};

const restoreClipboard = (snapshot: ClipboardSnapshot): void => {
  if (snapshot.kind === "structured") clipboard.write(snapshot.data);
  else clipboard.clear();
};

const defaultDeps: SelectionReadDeps = {
  readClipboardText: () => clipboard.readText(),
  snapshotClipboard,
  restoreClipboard,
  clearClipboard: () => clipboard.clear(),
  runScript: runAppleScript,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Read the current selection, or `null` when there isn't one.
 *
 * `null` is a first-class answer, not an error: pressing the summon with
 * nothing highlighted is completely normal, and the panel opens on its plain
 * "what do you need?" state rather than showing a failure.
 *
 * **Must be called before the corner window is shown.** The panel is
 * non-activating, but the copy is aimed at whatever is frontmost, so reading
 * first is what guarantees the words come from the app the owner was actually
 * looking at.
 */
export async function readSelection(
  deps: SelectionReadDeps = defaultDeps,
): Promise<Selection | null> {
  const snapshot = deps.snapshotClipboard();
  try {
    // Clearing first is what makes "nothing was selected" detectable: without
    // it, a copy that does nothing leaves the PREVIOUS clipboard in place and
    // the panel would confidently quote something the owner never selected —
    // which is far worse than offering nothing.
    deps.clearClipboard();

    await deps.runScript(COPY_SHORTCUT_SCRIPT);

    let text = "";
    const deadline = deps.now() + COPY_TIMEOUT_MS;
    while (deps.now() < deadline) {
      await deps.sleep(COPY_POLL_INTERVAL_MS);
      text = deps.readClipboardText();
      if (text) break;
    }
    if (!text.trim()) return null;

    return {
      text: text.slice(0, MAX_SELECTION_CHARS),
      wordCount: countWords(text),
      appName: await frontAppName(deps),
    };
  } catch (err) {
    // Automation permission refused, no frontmost app, a script that failed.
    // The corner still opens; it simply has nothing quoted at the top.
    log.warn("[selection-read] could not read the selection:", err);
    return null;
  } finally {
    // On every path, including the failures above. Someone who copied a
    // password a moment ago must not find it replaced by a paragraph of mail.
    deps.restoreClipboard(snapshot);
  }
}

async function frontAppName(deps: SelectionReadDeps): Promise<string | null> {
  try {
    const name = (await deps.runScript(FRONT_APP_SCRIPT)).trim();
    return name || null;
  } catch {
    // Nice-to-have provenance. Its absence must never cost the selection.
    return null;
  }
}
