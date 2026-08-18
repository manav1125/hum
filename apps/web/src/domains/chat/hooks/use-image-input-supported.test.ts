import { describe, expect, test } from "bun:test";

import { selectImageInputSupported } from "./use-image-input-supported";

/**
 * The composer asks the daemon whether an image can be read here. This covers
 * the client's only remaining job: picking the answer that applies, and never
 * inventing a refusal when there is no answer to pick.
 */
type Llm = Parameters<typeof selectImageInputSupported>[0];

const llm = (value: Record<string, unknown>) => value as unknown as Llm;

describe("selectImageInputSupported", () => {
  test("uses the conversation's own inference profile first", () => {
    const config = llm({
      activeProfile: "cloud",
      imageInputSupported: true,
      profiles: {
        cloud: { imageInputSupported: true },
        local: { imageInputSupported: false },
      },
    });
    expect(selectImageInputSupported(config, "local")).toBe(false);
    expect(selectImageInputSupported(config, null)).toBe(true);
  });

  test("falls back to the workspace's active profile", () => {
    const config = llm({
      activeProfile: "local",
      imageInputSupported: true,
      profiles: { local: { imageInputSupported: false } },
    });
    expect(selectImageInputSupported(config, undefined)).toBe(false);
  });

  test("falls back to the workspace answer when no profile is active", () => {
    expect(
      selectImageInputSupported(llm({ imageInputSupported: false }), null),
    ).toBe(false);
    expect(
      selectImageInputSupported(llm({ imageInputSupported: true }), null),
    ).toBe(true);
  });

  test("a profile the response doesn't carry falls through, it doesn't refuse", () => {
    const config = llm({
      activeProfile: "gone",
      imageInputSupported: true,
      profiles: {},
    });
    expect(selectImageInputSupported(config, "also-gone")).toBe(true);
  });

  test("no config, or a daemon too old to answer, attaches anyway", () => {
    // Fail-open: not knowing is not the same as knowing the answer is no, and
    // a paperclip that silently eats files is the worse of the two failures.
    expect(selectImageInputSupported(undefined, null)).toBe(true);
    expect(selectImageInputSupported(llm({}), null)).toBe(true);
    expect(
      selectImageInputSupported(
        llm({ activeProfile: "brain", profiles: { brain: {} } }),
        null,
      ),
    ).toBe(true);
  });
});
