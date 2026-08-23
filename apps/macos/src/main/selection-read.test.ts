/**
 * Reading the selection — and, more importantly, putting the clipboard back.
 *
 * Two properties carry all the risk here:
 *
 *   1. **The clipboard is restored on every path**, including failure. This
 *      module borrows the pasteboard to get the selection; someone who copied
 *      a password a moment ago must not find it replaced by a paragraph of
 *      email because a script errored.
 *   2. **"Nothing selected" is detected, not guessed.** Without clearing
 *      first, a copy that does nothing leaves the PREVIOUS clipboard in place
 *      and the panel would confidently quote text the owner never selected —
 *      far worse than offering nothing at all.
 */

import { describe, expect, test } from "bun:test";

import {
  countWords,
  readSelection,
  type ClipboardSnapshot,
  type SelectionReadDeps,
} from "./selection-read";

interface Harness {
  deps: SelectionReadDeps;
  restored: ClipboardSnapshot[];
  /** A getter, not a snapshot — the counter is incremented inside the deps. */
  clearedCount: () => number;
  scripts: string[];
  clipboardNow: () => string;
}

/**
 * A fake pasteboard plus a fake `osascript`.
 *
 * `copyYields` is what the synthesised ⌘C puts on the clipboard — `null`
 * models an app where nothing was selected, so the copy is a no-op.
 */
function harness(
  options: {
    initial?: string;
    copyYields?: string | null;
    failCopyScript?: boolean;
    frontApp?: string;
  } = {},
): Harness {
  let clipboard = options.initial ?? "";
  const restored: ClipboardSnapshot[] = [];
  const scripts: string[] = [];
  let cleared = 0;
  let clock = 0;

  const deps: SelectionReadDeps = {
    readClipboardText: () => clipboard,
    snapshotClipboard: () =>
      clipboard
        ? { kind: "structured", data: { text: clipboard } }
        : { kind: "empty" },
    restoreClipboard: (snapshot) => {
      restored.push(snapshot);
      clipboard =
        snapshot.kind === "structured" ? (snapshot.data.text ?? "") : "";
    },
    clearClipboard: () => {
      cleared += 1;
      clipboard = "";
    },
    runScript: async (script) => {
      scripts.push(script);
      if (script.includes('keystroke "c"')) {
        if (options.failCopyScript) throw new Error("not authorised");
        if (options.copyYields != null) clipboard = options.copyYields;
        return "";
      }
      return options.frontApp ?? "Mail";
    },
    // A fake clock, advanced by `sleep`, so the poll loop reaches its
    // deadline instantly instead of burning real milliseconds.
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };

  return {
    deps,
    restored,
    clearedCount: () => cleared,
    scripts,
    clipboardNow: () => clipboard,
  };
}

describe("countWords", () => {
  test("counts what the panel prints beside the quote", () => {
    expect(countWords("  procurement will sign off at $47  ")).toBe(6);
    expect(countWords("   ")).toBe(0);
  });
});

describe("readSelection", () => {
  test("returns the selection, its word count and where it came from", async () => {
    const h = harness({
      copyYields: "procurement will sign off at $47",
      frontApp: "Mail",
    });

    const selection = await readSelection(h.deps);

    expect(selection).toEqual({
      text: "procurement will sign off at $47",
      wordCount: 6,
      appName: "Mail",
    });
  });

  test("clears the clipboard first, so 'nothing selected' is detectable", async () => {
    const h = harness({ initial: "a password", copyYields: null });

    const selection = await readSelection(h.deps);

    expect(h.clearedCount()).toBe(1);
    // The copy was a no-op, and nothing arrived. Quoting "a password" back at
    // the owner is exactly what clearing prevents.
    expect(selection).toBeNull();
  });

  test("restores the clipboard after a successful read", async () => {
    const h = harness({ initial: "a password", copyYields: "some email text" });

    await readSelection(h.deps);

    expect(h.clipboardNow()).toBe("a password");
  });

  test("restores the clipboard even when the copy script fails", async () => {
    // Automation permission refused is the realistic case, and it must not
    // cost the owner whatever they had copied.
    const h = harness({ initial: "a password", failCopyScript: true });

    const selection = await readSelection(h.deps);

    expect(selection).toBeNull();
    expect(h.clipboardNow()).toBe("a password");
    expect(h.restored).toHaveLength(1);
  });

  test("an empty clipboard is restored as empty, not left holding the selection", async () => {
    const h = harness({ initial: "", copyYields: "some email text" });

    await readSelection(h.deps);

    expect(h.clipboardNow()).toBe("");
  });

  test("whitespace-only is not a selection", async () => {
    const h = harness({ copyYields: "   \n  " });
    expect(await readSelection(h.deps)).toBeNull();
  });

  test("a missing front-app name costs the selection nothing", async () => {
    const h = harness({ copyYields: "text", frontApp: "" });
    const selection = await readSelection(h.deps);
    expect(selection?.text).toBe("text");
    expect(selection?.appName).toBeNull();
  });
});
