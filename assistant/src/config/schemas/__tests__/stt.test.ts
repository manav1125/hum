import { describe, expect, test } from "bun:test";

import {
  SttProvidersSchema,
  SttServiceSchema,
  VALID_STT_PROVIDERS,
} from "../stt.js";

describe("SttProvidersSchema", () => {
  test("accepts a Deepgram entry with arbitrary fields (generic record)", () => {
    const parsed = SttProvidersSchema.parse({
      deepgram: { diarize: true },
    });
    expect(parsed).toEqual({ deepgram: { diarize: true } });
  });

  test("forward-compatible: unknown provider keys still pass validation", () => {
    const parsed = SttProvidersSchema.parse({
      "future-provider": { someField: 42 },
    });
    expect(parsed).toEqual({ "future-provider": { someField: 42 } });
  });

  test("empty providers map parses to {}", () => {
    const parsed = SttProvidersSchema.parse({});
    expect(parsed).toEqual({});
  });
});

describe("SttServiceSchema", () => {
  test("stt.provider=deepgram with providers.deepgram round-trips", () => {
    const parsed = SttServiceSchema.parse({
      provider: "deepgram",
      providers: { deepgram: { diarize: true } },
    });
    expect(parsed.provider).toBe("deepgram");
    expect(parsed.providers.deepgram).toEqual({ diarize: true });
  });

  test("VALID_STT_PROVIDERS includes deepgram", () => {
    expect(VALID_STT_PROVIDERS).toContain("deepgram");
  });

  test("language defaults to 'multi' when absent", () => {
    const parsed = SttServiceSchema.parse({ provider: "deepgram" });
    expect(parsed.language).toBe("multi");
  });

  test("an explicit language is preserved, trimmed", () => {
    const parsed = SttServiceSchema.parse({
      provider: "deepgram",
      language: "  hi-IN ",
    });
    expect(parsed.language).toBe("hi-IN");
  });

  test("an empty language is rejected", () => {
    expect(() =>
      SttServiceSchema.parse({ provider: "deepgram", language: "   " }),
    ).toThrow();
  });
});

describe("services-level stt default", () => {
  test("a services block with no stt still materializes language 'multi'", async () => {
    // Regression: the services-level stt default must be parsed THROUGH
    // SttServiceSchema. A literal object default bypasses the schema, so
    // any field the literal omits (language) would be undefined at runtime
    // despite the inferred type saying otherwise.
    const { ServicesSchema } = await import("../services.js");
    const parsed = ServicesSchema.parse({});
    expect(parsed.stt.language).toBe("multi");
    expect(parsed.stt.provider).toBe("deepgram");
  });
});
