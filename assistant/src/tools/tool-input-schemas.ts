import { z } from "zod";

import { formatToolInputError } from "./shared/zod-tool-schema.js";

// ── Per-tool Zod input schemas ──────────────────────────────────────
//
// Each schema here is the single source for BOTH the runtime validation run
// by the pre-execution gate (via {@link parseToolInput}) AND the tool's
// advertised `input_schema` (the tool module imports its schema from here and
// derives the JSON Schema with `toToolInputSchema` from
// `shared/zod-tool-schema.ts`), so the model-facing contract and the runtime
// validation cannot drift.
//
// The schemas are defined in this module — not in the tool modules — because
// the tool modules self-register into the tool registry at import time and
// pull in their execution dependencies (prompters, PKB indexing, image
// readers). The approval handler must be able to import this registry without
// dragging that graph (and its registry side effects) into every consumer;
// keeping this module pure Zod keeps the gate import-light.
//
// Authoring rules, so validation never tightens behavior a tool already
// tolerates:
//
// - Top-level schemas are `z.looseObject` — unknown keys (including the
//   injected `activity` field, see `schema-transforms.ts`) pass through.
// - A field the tool silently ignores when malformed gets
//   `.optional().catch(undefined)` so a bad value degrades exactly as the
//   tool always degraded, instead of failing the call.
// - Fields the advertised schema requires only to guide the model (e.g.
//   `activity`, which is status-only and never read by the tool) stay
//   optional-with-`.catch(undefined)` here; the derivation marks them
//   required via `advertiseRequired`.

const activityField = z
  .string()
  .describe(
    "Brief non-technical explanation of what you are doing and why, shown as a status update.",
  )
  .optional()
  .catch(undefined);

/**
 * `file_read` input. `offset` and `limit` catch to `undefined` because the
 * tool has always ignored non-numeric values rather than failing the read.
 */
export const fileReadInputSchema = z.looseObject({
  path: z
    .string()
    .min(1)
    .describe(
      "The path to the file to read (absolute or relative to working directory)",
    ),
  offset: z
    .number()
    .describe("Line number to start reading from (1-indexed)")
    .optional()
    .catch(undefined),
  limit: z
    .number()
    .describe("Maximum number of lines to read")
    .optional()
    .catch(undefined),
  activity: activityField,
});

/**
 * `file_write` input. Loose so injected fields (e.g. `activity`, which the
 * model must send but the tool never reads) pass through untouched.
 */
export const fileWriteInputSchema = z.looseObject({
  path: z
    .string()
    .min(1)
    .describe(
      "The path to the file to write (absolute or relative to working directory)",
    ),
  content: z.string().describe("The content to write to the file"),
  activity: activityField,
});

/**
 * `file_edit` input. `replace_all` catches to `undefined` because the tool
 * has always treated anything but a literal `true` as "single match" — a
 * malformed value degrades the same way instead of failing the call.
 */
export const fileEditInputSchema = z.looseObject({
  path: z
    .string()
    .min(1)
    .describe(
      "The path to the file to edit (absolute or relative to working directory)",
    ),
  old_string: z
    .string()
    .min(1, { message: "old_string must not be empty" })
    .describe("The exact text to find in the file"),
  new_string: z.string().describe("The replacement text"),
  replace_all: z
    .boolean()
    .describe(
      "Replace all occurrences of old_string instead of requiring a unique match (default: false)",
    )
    .optional()
    .catch(undefined),
  activity: activityField,
});

/**
 * `file_list` input. `glob` catches to `undefined` because the tool has
 * always ignored non-string values rather than failing the listing.
 */
export const fileListInputSchema = z.looseObject({
  path: z.string().min(1).describe("The directory path to list"),
  glob: z
    .string()
    .describe("Filter entries by glob pattern, e.g. '*.md'")
    .optional()
    .catch(undefined),
  activity: activityField,
});

// ── ask_question ────────────────────────────────────────────────────

/** Option shape shared by the batched and legacy `ask_question` inputs. */
export const OptionSchema = z.object({
  id: z
    .string()
    .min(1)
    .describe(
      "Stable identifier for this option (returned verbatim in the response).",
    ),
  label: z.string().min(1).describe("Short human-readable label."),
  description: z
    .string()
    .describe("Optional one-line context shown beneath the label.")
    .optional(),
});

// One question in a (possibly single-element) batch. Intentionally has no
// `id` field — per-question ids are daemon-assigned (`q1`, `q2`, ...) inside
// the prompter, never supplied by the LLM. This keeps the LLM-facing schema
// smaller and removes a validation surface (no duplicate-id check, no
// length cap on ids).
export const SingleQuestionSchema = z.object({
  question: z.string().min(1).describe("The clarifying question to display."),
  description: z
    .string()
    .describe("Optional one-line context shown beneath the question.")
    .optional(),
  // 2–4 LLM-supplied options. The client renders a fixed 5th "Type
  // something else" slot for free-text, so the model must keep the
  // structured set to 4 or fewer.
  options: z
    .array(OptionSchema)
    .min(2)
    .max(4)
    .describe(
      "2–4 structured options. The UI always appends a free-text fallback slot, so do not include a 'something else' option here.",
    ),
  freeTextPlaceholder: z
    .string()
    .describe(
      "Optional placeholder text shown inside the free-text fallback input.",
    )
    .optional(),
});

// Cap at 5 questions per batch. Past that it starts to feel like a form,
// not a clarification — the model should be implementing, not asking. Any
// input with ≥6 entries is rejected with a clear Zod error.
export const MAX_QUESTIONS_PER_BATCH = 5;

/**
 * `ask_question` input. Both the batched shape (`questions[]`) and the legacy
 * flat shape are accepted; `execute()` normalizes legacy callers into a
 * one-element `questions` array before forwarding to the prompter. Loose so
 * injected fields (e.g. `activity`) never fail validation.
 */
export const askQuestionInputSchema = z
  .looseObject({
    questions: z
      .array(SingleQuestionSchema)
      .min(1)
      .max(MAX_QUESTIONS_PER_BATCH, {
        message: `At most ${MAX_QUESTIONS_PER_BATCH} questions per batch; split into multiple turns if you need more.`,
      })
      .describe(
        `Recommended shape. 1–${MAX_QUESTIONS_PER_BATCH} clarifying questions to ask in a single turn. Use a batch when several independent ambiguities block progress; ask one at a time when they're sequentially dependent. Past ${MAX_QUESTIONS_PER_BATCH} questions you should be implementing, not asking.`,
      )
      .optional(),
    // Legacy flat fields. Optional so batched callers can omit them; when
    // present and `questions` is absent, they are normalized into a
    // one-element batch in `execute()`.
    question: z
      .string()
      .min(1)
      .describe(
        "Legacy: the single clarifying question. Prefer `questions[]` for new code.",
      )
      .optional(),
    description: z
      .string()
      .describe(
        "Legacy: optional one-line context shown beneath the question. Prefer `questions[].description`.",
      )
      .optional(),
    options: z
      .array(OptionSchema)
      .min(2)
      .max(4)
      .describe(
        "Legacy: 2–4 structured options. Prefer `questions[].options`. The UI always appends a free-text fallback slot, so do not include a 'something else' option here.",
      )
      .optional(),
    freeTextPlaceholder: z
      .string()
      .describe(
        "Legacy: optional placeholder text for the free-text fallback input. Prefer `questions[].freeTextPlaceholder`.",
      )
      .optional(),
  })
  .refine(
    (v) =>
      v.questions !== undefined ||
      (v.question !== undefined && v.options !== undefined),
    {
      message:
        "Provide `questions` (preferred) or the legacy flat fields (`question` + `options`).",
    },
  );

/**
 * Per-tool Zod input schemas, keyed by tool name. Tool calls are a
 * discriminated payload — the tool name determines the shape of `input` —
 * but the model's JSON arrives untrusted, so the pre-execution gate
 * (`ToolApprovalHandler.checkPreExecutionGates`) parses it against this
 * registry (via {@link parseToolInput}) before any executor reads a field —
 * and, crucially, before any one-time grant is consumed or guardian
 * escalation starts, so a malformed call can never interrupt the guardian.
 *
 * Covers built-in (core-owned) tools only — skill / plugin / MCP / workspace
 * tools own their schemas elsewhere, and the gate skips this registry for
 * them (a workspace override of a built-in name must not be validated
 * against the built-in's schema). Core tools are the ones with no
 * `getToolOwner` entry.
 */
export const TOOL_INPUT_SCHEMAS: Readonly<Record<string, z.ZodType>> = {
  ask_question: askQuestionInputSchema,
  file_edit: fileEditInputSchema,
  file_list: fileListInputSchema,
  file_read: fileReadInputSchema,
  file_write: fileWriteInputSchema,
};

/**
 * Validate model-supplied tool input against the registered schema for
 * `name`, returning the parsed value (with `.catch()` recoveries applied) or
 * a descriptive, model-correctable error message. A tool with no registered
 * schema passes through unchanged.
 */
export function parseToolInput(
  name: string,
  input: Record<string, unknown>,
):
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; message: string } {
  const schema = TOOL_INPUT_SCHEMAS[name];
  if (!schema) {
    return { ok: true, data: input };
  }
  const result = schema.safeParse(input);
  if (!result.success) {
    return { ok: false, message: formatToolInputError(name, result.error) };
  }
  // Every registry schema is an object schema, so the parsed value is a
  // plain record; `z.ZodType`'s output is just too wide to say so statically.
  return { ok: true, data: result.data as Record<string, unknown> };
}
