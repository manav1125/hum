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
  hasSomethingToSend,
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
