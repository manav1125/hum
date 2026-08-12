/**
 * Curated spoken-language catalog for the listening-language setting
 * (Settings → Voice).
 *
 * PARITY: the daemon owns the authoritative roster —
 * `DEEPGRAM_NOVA3_MONOLINGUAL_CODES` in
 * `assistant/src/providers/speech-to-text/deepgram.ts` (the verified
 * Deepgram nova-3 monolingual roster). This package must not import from
 * `assistant/`, so the codes are duplicated here and
 * `stt-language-catalog-parity.test.ts` (sibling file) pins the two
 * together by reading the daemon source at test time. Extending either side
 * alone fails that test; extending both requires verifying nova-3
 * monolingual support in Deepgram's docs first.
 *
 * Base codes only: `services.stt.language` accepts any non-empty string, so
 * regional variants ("en-US") stay expressible as custom values — the card
 * renders an unknown code verbatim rather than hiding it.
 */

/**
 * The code the daemon special-cases as Deepgram nova-3 code-switching
 * (follows a speaker moving between languages inside one utterance). Also
 * the daemon schema default for `services.stt.language`.
 */
export const STT_MULTI_CODE = "multi";

/** Explicit English — a deliberate pin, distinct from the multilingual default. */
export const STT_ENGLISH_CODE = "en";

/**
 * Mirror of the daemon's `DEEPGRAM_NOVA3_MONOLINGUAL_CODES` (see the parity
 * note above). Keep sorted by code; includes "en".
 */
export const STT_MONOLINGUAL_CODES = [
  "ar",
  "be",
  "bg",
  "bn",
  "bs",
  "ca",
  "cs",
  "da",
  "de",
  "el",
  "en",
  "es",
  "et",
  "fa",
  "fi",
  "fr",
  "gu",
  "he",
  "hi",
  "hr",
  "hu",
  "id",
  "it",
  "ja",
  "kn",
  "ko",
  "lt",
  "lv",
  "mk",
  "mr",
  "ms",
  "nl",
  "no",
  "pl",
  "pt",
  "ro",
  "ru",
  "sk",
  "sl",
  "sr",
  "sv",
  "ta",
  "te",
  "th",
  "tl",
  "tr",
  "uk",
  "ur",
  "vi",
  "zh",
] as const;

/**
 * English display names for every roster code, used when `Intl.DisplayNames`
 * is unavailable or returns nothing better than the code itself. Covering
 * the full roster keeps the catalog deterministic across runtimes.
 */
const FALLBACK_LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  ar: "Arabic",
  be: "Belarusian",
  bg: "Bulgarian",
  bn: "Bengali",
  bs: "Bosnian",
  ca: "Catalan",
  cs: "Czech",
  da: "Danish",
  de: "German",
  el: "Greek",
  en: "English",
  es: "Spanish",
  et: "Estonian",
  fa: "Persian",
  fi: "Finnish",
  fr: "French",
  gu: "Gujarati",
  he: "Hebrew",
  hi: "Hindi",
  hr: "Croatian",
  hu: "Hungarian",
  id: "Indonesian",
  it: "Italian",
  ja: "Japanese",
  kn: "Kannada",
  ko: "Korean",
  lt: "Lithuanian",
  lv: "Latvian",
  mk: "Macedonian",
  mr: "Marathi",
  ms: "Malay",
  nl: "Dutch",
  no: "Norwegian",
  pl: "Polish",
  pt: "Portuguese",
  ro: "Romanian",
  ru: "Russian",
  sk: "Slovak",
  sl: "Slovenian",
  sr: "Serbian",
  sv: "Swedish",
  ta: "Tamil",
  te: "Telugu",
  th: "Thai",
  tl: "Tagalog",
  tr: "Turkish",
  uk: "Ukrainian",
  ur: "Urdu",
  vi: "Vietnamese",
  zh: "Chinese",
};

function languageDisplayName(code: string): string {
  try {
    const name = new Intl.DisplayNames(["en"], { type: "language" }).of(code);
    if (name && name.toLowerCase() !== code.toLowerCase()) {
      return name;
    }
  } catch {
    // Malformed code or missing ICU data — fall through to the static map.
  }
  return FALLBACK_LANGUAGE_NAMES[code] ?? code;
}

export interface SttLanguageOption {
  /** The exact `services.stt.language` value this row writes. */
  code: string;
  label: string;
  description?: string;
}

export const STT_MULTILINGUAL_OPTION: SttLanguageOption = {
  code: STT_MULTI_CODE,
  label: "Multilingual",
  description: "Switches languages with you mid-conversation.",
};

/**
 * The full picker catalog: Multilingual and English as peer rows on top
 * (the two common intents — follow me anywhere vs. pin my daily driver),
 * then the rest of the roster A–Z by English label.
 */
export const STT_LANGUAGE_OPTIONS: readonly SttLanguageOption[] = [
  STT_MULTILINGUAL_OPTION,
  { code: STT_ENGLISH_CODE, label: languageDisplayName(STT_ENGLISH_CODE) },
  ...STT_MONOLINGUAL_CODES.filter((code) => code !== STT_ENGLISH_CODE)
    .map((code) => ({ code, label: languageDisplayName(code) }))
    .sort((a, b) => a.label.localeCompare(b.label, "en")),
];

/**
 * Display label for a persisted `services.stt.language` value, catalog
 * membership or not: a custom value (e.g. a regional variant typed through
 * the settings skill) renders verbatim rather than pretending to be
 * something it is not.
 */
export function sttLanguageLabelForCode(code: string): string {
  const option = STT_LANGUAGE_OPTIONS.find((entry) => entry.code === code);
  return option?.label ?? code;
}

/** Search predicate shared by the picker: matches label or raw code. */
export function sttLanguageMatches(
  option: SttLanguageOption,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return true;
  }
  return (
    option.label.toLowerCase().includes(needle) ||
    option.code.toLowerCase().startsWith(needle)
  );
}
