/**
 * The Library's share, judged on the only thing that matters about it: does
 * the surface's claim match what the code can actually do?
 *
 * The gallery shipped saying "Tap opens it here." because a share button that
 * did nothing would have been worse than no share button. That trade is still
 * the rule — so these tests are written against the trade, not the feature:
 *
 *  · A reach that cannot carry bytes must not produce a footer that says it
 *    can, and must not produce a ⇪ on a file-only output.
 *  · A share that rejects must come back as `failed`. The mutation this is
 *    guarding against is the easy one — wrap the `await` in `catch {}` and
 *    return `shared` — and it is exactly what `runtime/native-file.ts` does
 *    today, which is why the Library needed its own runner.
 *  · A dismissal must NOT come back as failed, or the failure surface becomes
 *    noise and gets ignored the one time it is real.
 */

import { describe, expect, test } from "bun:test";

import type { LibraryEntry } from "./library-model";
import {
  anyShareable,
  detectShareReach,
  entryShareMode,
  isShareDismissal,
  reachCarriesFiles,
  shareFooterLine,
  shareLibraryEntry,
  type ShareIo,
  type ShareProbe,
} from "./library-share";

const NOW = Date.now();

function entry(over: Partial<LibraryEntry> = {}): LibraryEntry {
  return {
    id: "o1",
    workItemId: "w1",
    missionId: null,
    projectId: null,
    attachmentId: null,
    externalUrl: null,
    kind: "document",
    title: "Acme one-pager",
    why: null,
    agent: null,
    reviewState: "approved",
    createdAt: NOW,
    attachment: null,
    ...over,
  } as LibraryEntry;
}

const FILE_BACKED = entry({
  id: "f",
  attachmentId: "att-1",
  attachment: {
    id: "att-1",
    filename: "acme-one-pager.pdf",
    mimeType: "application/pdf",
    sizeBytes: 1234,
    hasThumbnail: false,
  },
});

const LINK_BACKED = entry({
  id: "l",
  title: "Acme microsite",
  externalUrl: "https://acme.example/microsite",
});

/** Filed, but nothing to send: no bytes, no URL. */
const BARE = entry({ id: "b", projectId: "acme" });

function probe(over: Partial<ShareProbe> = {}): ShareProbe {
  return {
    isNative: false,
    platform: "web",
    hasWebShare: false,
    canShareFiles: () => false,
    ...over,
  };
}

/* -------------------------------------------------------------------------- */

describe("reach — what this shell can actually do", () => {
  test("the Capacitor iOS shell is the full sheet", () => {
    expect(detectShareReach(probe({ isNative: true, platform: "ios" }))).toBe(
      "ios-sheet",
    );
  });

  test("a Capacitor Android shell shares files, but is not iOS", () => {
    const reach = detectShareReach(
      probe({ isNative: true, platform: "android" }),
    );
    expect(reach).toBe("native-sheet");
    expect(reachCarriesFiles(reach)).toBe(true);
  });

  test("plain web with no Web Share API reaches nothing", () => {
    expect(detectShareReach(probe())).toBe("none");
  });

  test("web that refuses files is link-only, not file-capable", () => {
    const reach = detectShareReach(
      probe({ hasWebShare: true, canShareFiles: () => false }),
    );
    expect(reach).toBe("web-link");
    expect(reachCarriesFiles(reach)).toBe(false);
  });

  test("web that accepts files carries them", () => {
    expect(
      detectShareReach(probe({ hasWebShare: true, canShareFiles: () => true })),
    ).toBe("web-files");
  });

  test("a canShare that throws is a no, never an assumed yes", () => {
    const reach = detectShareReach(
      probe({
        hasWebShare: true,
        canShareFiles: () => {
          throw new Error("nope");
        },
      }),
    );
    expect(reach).toBe("web-link");
  });
});

describe("what a card may offer", () => {
  test("bytes on a file-capable shell", () => {
    expect(entryShareMode(FILE_BACKED, "ios-sheet")).toBe("file");
  });

  test("a file-backed output on a link-only shell offers NOTHING — not a ⇪ that opens an empty sheet", () => {
    expect(entryShareMode(FILE_BACKED, "web-link")).toBeNull();
  });

  test("a link-backed output rides any reach", () => {
    expect(entryShareMode(LINK_BACKED, "web-link")).toBe("link");
    expect(entryShareMode(LINK_BACKED, "ios-sheet")).toBe("link");
  });

  test("bytes beat a URL when both exist and the shell can carry bytes", () => {
    const both = entry({ ...LINK_BACKED, attachment: FILE_BACKED.attachment });
    expect(entryShareMode(both, "ios-sheet")).toBe("file");
    expect(entryShareMode(both, "web-link")).toBe("link");
  });

  test("an output with neither is never shareable, on any shell", () => {
    for (const reach of [
      "ios-sheet",
      "native-sheet",
      "web-files",
      "web-link",
      "none",
    ] as const) {
      expect(entryShareMode(BARE, reach)).toBeNull();
    }
  });

  test("a shell with no reach offers nothing at all", () => {
    expect(anyShareable([FILE_BACKED, LINK_BACKED, BARE], "none")).toBe(false);
    expect(anyShareable([FILE_BACKED], "ios-sheet")).toBe(true);
  });
});

describe("the footer says what the code can do — and no more", () => {
  test("design's line ships only where UIActivityViewController is what opens", () => {
    expect(shareFooterLine("ios-sheet", [FILE_BACKED])).toBe(
      "Tap opens it here. ⇪ shares to Files, Mail, AirDrop.",
    );
  });

  test("Android gets a share sheet, so it is promised a share sheet — not Files, Mail, AirDrop", () => {
    const line = shareFooterLine("native-sheet", [FILE_BACKED]);
    expect(line).toBe(
      "Tap opens it here. ⇪ opens your share sheet with the real file.",
    );
    expect(line).not.toContain("AirDrop");
  });

  test("a link-only shell promises a link, and never a file", () => {
    const line = shareFooterLine("web-link", [FILE_BACKED, LINK_BACKED]);
    expect(line).toBe(
      "Tap opens it here. ⇪ shares a link to the published ones.",
    );
    expect(line).not.toContain("file");
  });

  test("a shell with no reach claims nothing beyond the tap", () => {
    expect(shareFooterLine("none", [FILE_BACKED, LINK_BACKED])).toBe(
      "Tap opens it here.",
    );
  });

  test("a full-reach shell showing nothing shareable still claims nothing", () => {
    // The wall, not just the shell, has to hold something up.
    expect(shareFooterLine("ios-sheet", [BARE])).toBe("Tap opens it here.");
    expect(shareFooterLine("ios-sheet", [])).toBe("Tap opens it here.");
  });

  test("the file line only appears when a file-shareable card is on screen", () => {
    expect(shareFooterLine("ios-sheet", [LINK_BACKED, BARE])).toBe(
      "Tap opens it here. ⇪ shares a link to the published ones.",
    );
  });
});

describe("dismissal is not failure", () => {
  test("the iOS plugin's own cancel string is read as a dismissal", () => {
    // SharePlugin.swift: `call.reject("Share canceled")` on !completed.
    expect(isShareDismissal(new Error("Share canceled"))).toBe(true);
  });

  test("the plugin's REAL failure is not mistaken for one", () => {
    // SharePlugin.swift: `call.reject("Error sharing item", ...)`.
    expect(isShareDismissal(new Error("Error sharing item"))).toBe(false);
  });

  test("the web sheet's AbortError is a dismissal", () => {
    expect(isShareDismissal(new DOMException("x", "AbortError"))).toBe(true);
    expect(isShareDismissal(new DOMException("x", "NotAllowedError"))).toBe(
      false,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The runner                                                                 */
/* -------------------------------------------------------------------------- */

function io(over: Partial<ShareIo> = {}): Partial<ShareIo> {
  return {
    fetchBlob: async () => new Blob(["bytes"], { type: "application/pdf" }),
    shareFile: async () => {},
    shareLink: async () => {},
    ...over,
  };
}

describe("sharing a file", () => {
  test("the artefact's own bytes and filename reach the sheet", async () => {
    const seen: Array<{ filename: string; title: string; size: number }> = [];
    const result = await shareLibraryEntry(FILE_BACKED, {
      assistantId: "asst-1",
      reach: "ios-sheet",
      io: io({
        shareFile: async ({ blob, filename, title }) => {
          seen.push({ filename, title, size: blob.size });
        },
      }),
    });
    expect(result).toEqual({ status: "shared" });
    expect(seen).toEqual([
      { filename: "acme-one-pager.pdf", title: "Acme one-pager", size: 5 },
    ]);
  });

  test("the bytes are fetched with the entry's OWN attachment id", async () => {
    const asked: Array<[string, string]> = [];
    await shareLibraryEntry(FILE_BACKED, {
      assistantId: "asst-1",
      reach: "ios-sheet",
      io: io({
        fetchBlob: async (assistantId, attachmentId) => {
          asked.push([assistantId, attachmentId]);
          return new Blob(["x"]);
        },
      }),
    });
    expect(asked).toEqual([["asst-1", "att-1"]]);
  });

  test("bytes that never arrive are a FAILURE — no sheet is opened over nothing", async () => {
    let sheetOpened = false;
    const result = await shareLibraryEntry(FILE_BACKED, {
      assistantId: "asst-1",
      reach: "ios-sheet",
      io: io({
        fetchBlob: async () => {
          throw new Error("500");
        },
        shareFile: async () => {
          sheetOpened = true;
        },
      }),
    });
    expect(result.status).toBe("failed");
    expect(sheetOpened).toBe(false);
  });

  /**
   * THE mutation guard. Delete the `catch` in `shareLibraryEntry`'s file
   * branch, or replace it with `catch {}` + `return { status: "shared" }` —
   * the shape `runtime/native-file.ts` uses — and this is the test that goes
   * red. Without it, a share sheet that failed to open reports done.
   */
  test("a rejected share is reported as failed, never as done", async () => {
    const result = await shareLibraryEntry(FILE_BACKED, {
      assistantId: "asst-1",
      reach: "ios-sheet",
      io: io({
        shareFile: async () => {
          throw new Error("Error sharing item");
        },
      }),
    });
    expect(result.status).toBe("failed");
    expect(result).not.toEqual({ status: "shared" });
    if (result.status === "failed") {
      expect(result.message.length).toBeGreaterThan(0);
    }
  });

  test("backing out of the sheet is a dismissal, not a failure", async () => {
    const result = await shareLibraryEntry(FILE_BACKED, {
      assistantId: "asst-1",
      reach: "ios-sheet",
      io: io({
        shareFile: async () => {
          throw new Error("Share canceled");
        },
      }),
    });
    expect(result).toEqual({ status: "dismissed" });
  });
});

describe("sharing a link", () => {
  test("the published URL goes to the sheet", async () => {
    const seen: string[] = [];
    const result = await shareLibraryEntry(LINK_BACKED, {
      assistantId: "asst-1",
      reach: "web-link",
      io: io({
        shareLink: async ({ url }) => {
          seen.push(url);
        },
      }),
    });
    expect(result).toEqual({ status: "shared" });
    expect(seen).toEqual(["https://acme.example/microsite"]);
  });

  test("a rejected link share fails loudly too", async () => {
    const result = await shareLibraryEntry(LINK_BACKED, {
      assistantId: "asst-1",
      reach: "web-link",
      io: io({
        shareLink: async () => {
          throw new Error("Error sharing item");
        },
      }),
    });
    expect(result.status).toBe("failed");
  });

  test("a file-backed output on a link-only shell is refused, not silently downgraded", async () => {
    let anything = false;
    const result = await shareLibraryEntry(FILE_BACKED, {
      assistantId: "asst-1",
      reach: "web-link",
      io: io({
        shareFile: async () => {
          anything = true;
        },
        shareLink: async () => {
          anything = true;
        },
      }),
    });
    expect(result.status).toBe("failed");
    expect(anything).toBe(false);
  });
});

describe("nothing behind it", () => {
  test("a bare output resolves to a named refusal, never a resolved nothing", async () => {
    const result = await shareLibraryEntry(BARE, {
      assistantId: "asst-1",
      reach: "ios-sheet",
      io: io(),
    });
    expect(result.status).toBe("failed");
  });
});
