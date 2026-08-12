import { z } from "zod";

/**
 * Valid STT provider identifiers. New providers append here and register
 * an adapter.
 */
export const VALID_STT_PROVIDERS = [
  "deepgram",
  "google-gemini",
  "openai-whisper",
  "xai",
] as const;

/**
 * Sparse provider config map under `services.stt.providers`.
 *
 * This is a forward-compatible record that accepts any provider ID as key
 * with an object value. All provider entries — known (`openai-whisper`,
 * `deepgram`, `google-gemini`) and unknown — are accepted with generic object
 * validation. Adding a new provider ID does not require a migration to seed
 * `services.stt.providers.<id>`.
 *
 * The map only holds entries the user has explicitly configured — it is
 * NOT required to enumerate every known provider.
 */
export const SttProvidersSchema = z.record(
  z.string(),
  z.record(z.string(), z.unknown()).default({}),
);
export type SttProviders = z.infer<typeof SttProvidersSchema>;

/**
 * Canonical STT service configuration.
 *
 * `mode` is locked to `"your-own"` -- managed STT is not supported.
 * Attempting to set `mode: "managed"` will fail schema validation.
 */
export const SttServiceSchema = z
  .object({
    mode: z
      .literal("your-own", {
        error:
          'services.stt.mode must be "your-own" -- managed STT is not supported',
      })
      .default("your-own" as const)
      .describe(
        'STT service mode -- only "your-own" is supported (managed STT is not available)',
      ),
    provider: z
      .enum(VALID_STT_PROVIDERS, {
        error: `services.stt.provider must be one of: ${VALID_STT_PROVIDERS.join(", ")}`,
      })
      .describe("Active STT provider used for speech-to-text transcription"),
    /**
     * Spoken-language selection, forwarded to providers whose adapters accept
     * a language (Deepgram; see `effectiveSttLanguage` in
     * `providers/speech-to-text/resolve.ts`).
     *
     * `"multi"` selects Deepgram's nova-3 code-switching mode, which follows
     * a speaker moving between languages inside a single utterance (e.g.
     * Hinglish). Any other value pins a base language code (or a regional
     * variant like "en-US") for the session. Providers that auto-detect
     * natively and take no language option (Gemini, Whisper) ignore this
     * field.
     *
     * Defaults to `"multi"` rather than staying unset so there is no state
     * where "what language is this assistant listening for" has to be
     * inferred. No workspace migration seeds this field: this fork never
     * shipped a `language` key, so every existing config simply has it
     * absent and the schema default materializes `"multi"` on the next
     * parse — identical behavior to what `effectiveSttLanguage` resolves
     * for an unset value.
     */
    language: z
      .string({ error: "services.stt.language must be a string" })
      .trim()
      .min(1, { error: "services.stt.language must not be empty" })
      .default("multi")
      .describe(
        "BCP-47 language code (e.g. 'en-US', 'hi') or 'multi' for code-switching across languages. Defaults to 'multi'; providers that detect natively ignore it",
      ),
    providers: SttProvidersSchema.default({}),
  })
  .describe(
    "Speech-to-text service configuration -- provider selection, spoken language, and per-provider settings",
  );

export type SttService = z.infer<typeof SttServiceSchema>;
