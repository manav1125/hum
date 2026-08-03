/**
 * `hasSomethingToSend` — the one answer to "is there anything to send?".
 *
 * The reason it exists is a divergence, not a refactor. `shouldSubmitOnEnter`
 * has always counted an attachment as content; the mobile composer's
 * tap-to-send gate was written separately as "the text box is non-empty", so on
 * a phone — where attaching a photo and tapping send with no caption is the
 * ordinary way to send a picture — the send button was disabled and the tap did
 * nothing. No send, no error, nothing. These pin the shared policy so the two
 * paths cannot drift apart again.
 */

import { describe, expect, test } from "bun:test";

import {
  attachDisabledReason,
  hasSomethingToSend,
  partitionAttachableFiles,
  shouldSubmitOnEnter,
} from "@/domains/chat/components/chat-composer/chat-composer-utils";

describe("hasSomethingToSend", () => {
  test("an uploaded attachment with no caption is a message", () => {
    expect(
      hasSomethingToSend({ input: "", canSendAttachments: true }),
    ).toBe(true);
  });

  test("whitespace around an attachment is still just the attachment", () => {
    expect(
      hasSomethingToSend({ input: "   \n ", canSendAttachments: true }),
    ).toBe(true);
  });

  test("text alone is a message", () => {
    expect(
      hasSomethingToSend({ input: "look at this", canSendAttachments: false }),
    ).toBe(true);
  });

  test("nothing typed and nothing attached is nothing to send", () => {
    expect(hasSomethingToSend({ input: "  ", canSendAttachments: false })).toBe(
      false,
    );
  });
});

describe("the Enter path answers the same question", () => {
  const ENTER = {
    key: "Enter",
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    isComposing: false,
    keyCode: 13,
  };

  test("an attachment with no text submits on Enter", () => {
    expect(
      shouldSubmitOnEnter(ENTER, false, {
        input: "",
        canSendAttachments: true,
        sendDisabled: false,
        attachmentsUploadingCount: 0,
        cmdEnterMode: false,
      }),
    ).toBe("submit");
  });
});

/**
 * "On home screen new chat I can't upload a file."
 *
 * The paperclip was disabled outright whenever the active model was known
 * text-only — which on the prod brain (DeepSeek V4) is always. Vision has
 * nothing to do with a PDF, and the daemon's own `agent/vision-tier.ts` reroutes
 * image-bearing rounds to a vision model anyway; the composer was refusing
 * files nobody's model ever objected to.
 */
const file = (name: string, type: string): File =>
  new File(["x"], name, { type });

describe("partitionAttachableFiles", () => {
  test("a text-only model still accepts documents — they are never images", () => {
    const { accepted, blockedImages } = partitionAttachableFiles(
      [
        file("contract.pdf", "application/pdf"),
        file("rows.csv", "text/csv"),
        file("notes.txt", "text/plain"),
      ],
      false,
    );
    expect(accepted.map((f) => f.name)).toEqual([
      "contract.pdf",
      "rows.csv",
      "notes.txt",
    ]);
    expect(blockedImages).toBe(0);
  });

  test("a text-only model takes the documents and counts the images it dropped", () => {
    const { accepted, blockedImages } = partitionAttachableFiles(
      [file("shot.png", "image/png"), file("contract.pdf", "application/pdf")],
      false,
    );
    expect(accepted.map((f) => f.name)).toEqual(["contract.pdf"]);
    expect(blockedImages).toBe(1);
  });

  test("images only, on a text-only model: nothing attaches and the caller is told why", () => {
    const { accepted, blockedImages } = partitionAttachableFiles(
      [file("a.png", "image/png"), file("b.jpg", "image/jpeg")],
      false,
    );
    expect(accepted).toEqual([]);
    // Non-zero is what makes the notice fire — a silent no-op is the bug.
    expect(blockedImages).toBe(2);
  });

  test("a vision model takes everything untouched", () => {
    const { accepted, blockedImages } = partitionAttachableFiles(
      [file("shot.png", "image/png"), file("contract.pdf", "application/pdf")],
      true,
    );
    expect(accepted.map((f) => f.name)).toEqual(["shot.png", "contract.pdf"]);
    expect(blockedImages).toBe(0);
  });
});

describe("attachDisabledReason", () => {
  test("a text-only model is NOT a reason to disable the paperclip", () => {
    // The regression itself: `supportsVision === false` used to land here.
    expect(
      attachDisabledReason({ typingDisabled: false, assistantId: "asst_1" }),
    ).toBeNull();
  });

  test("no assistant disables it, and says so", () => {
    expect(
      attachDisabledReason({ typingDisabled: false, assistantId: null }),
    ).toBe("No assistant is connected yet");
  });

  test("a composer that isn't taking input disables it, and says so", () => {
    expect(
      attachDisabledReason({ typingDisabled: true, assistantId: "asst_1" }),
    ).toBe("This conversation isn't accepting input right now");
  });
});
