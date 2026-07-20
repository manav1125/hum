import { describe, expect, test } from "bun:test";

import { isVisionUnsupportedError } from "@/domains/chat/components/mobile-turn-error-card";

describe("isVisionUnsupportedError", () => {
  test("matches the daemon's vision-unsupported copy", () => {
    expect(
      isVisionUnsupportedError({
        message:
          "This model doesn't support image input. Remove the image or switch to a vision-capable model.",
      }),
    ).toBe(true);
  });

  test("matches copy variants", () => {
    expect(
      isVisionUnsupportedError({
        message: "The current model does not support image attachments",
      }),
    ).toBe(true);
    expect(
      isVisionUnsupportedError({
        message: "Switch to a vision-capable model to attach images.",
      }),
    ).toBe(true);
  });

  test("matches by code regardless of copy", () => {
    expect(
      isVisionUnsupportedError({
        message: "unrelated",
        code: "VISION_UNSUPPORTED",
      }),
    ).toBe(true);
  });

  test("does not match unrelated errors", () => {
    expect(
      isVisionUnsupportedError({ message: "Connection lost. Try again." }),
    ).toBe(false);
    expect(
      isVisionUnsupportedError({
        message: "The daemon returned an unexpected 502 while replying.",
      }),
    ).toBe(false);
  });
});
