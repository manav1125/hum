import type { z } from "zod";

import { QuestionPrompter } from "../../permissions/question-prompter.js";
import { RiskLevel } from "../../permissions/types.js";
import {
  type CredentialSolicitation,
  findCredentialSolicitations,
  formatCredentialSolicitationRefusal,
} from "../../security/credential-solicitation.js";
import {
  invalidToolInputResult,
  toToolInputSchema,
} from "../shared/zod-tool-schema.js";
import {
  askQuestionInputSchema,
  type SingleQuestionSchema,
} from "../tool-input-schemas.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../types.js";

// ── Input schema ────────────────────────────────────────────────────
// One Zod source (`askQuestionInputSchema` in `../tool-input-schemas.ts`,
// where the pre-execution gate also validates it) for both runtime
// validation and the LLM-facing `input_schema` derived below with
// `toToolInputSchema`.

export type SingleQuestion = z.infer<typeof SingleQuestionSchema>;
export type AskQuestionInput = z.infer<typeof askQuestionInputSchema>;

// ── Tool description ────────────────────────────────────────────────

const DESCRIPTION = [
  "Use this tool whenever a request is ambiguous and can be resolved",
  "by 2–4 plausible interpretations or discrete choices. Prefer it over",
  "plain-text clarification — structured options are faster to answer and",
  "remove guessing.",
  "",
  "When in doubt between (a) asking inline and (b) calling ask_question with",
  "structured options: call ask_question. The structured choices are better UX.",
  "",
  'Example: given a request like "schedule lunch with Alice next week" where there',
  "are two plausible Alice contacts, ask which Alice with options like",
  '`{id: "alice_work", label: "Alice (work)"}` and',
  '`{id: "alice_personal", label: "Alice (personal)"}`.',
  "",
  "Batch related clarifications into one call by passing multiple entries in",
  "`questions` (up to 5). Each question gets its own page with a Skip button.",
  "",
  "Never use this tool to collect a secret. Do not ask for — or offer to",
  "receive — a password, API key, access token, 2FA code, or any other",
  "credential, in a question, an option label, or the free-text slot. Such",
  "calls are rejected. The user signs in themselves in their own browser, or",
  'supplies a token via `credential_store` with `action: "prompt"`.',
  "",
  "When NOT to use this tool:",
  "- The answer is obvious from context or recent conversation.",
  "- The question is genuinely open-ended (more than ~4 plausible answers) —",
  "  fall back to plain text.",
  "- You're about to take a low-stakes reversible action and can adjust based",
  "  on feedback.",
  "",
  "If a question is skipped, proceed with reasonable defaults for that",
  "question; if every question in the batch is skipped, stop interrupting",
  "and use defaults across the board.",
  "",
  "Provide 2–4 options. A free-text fallback is always added by the UI — do not",
  "include a 'something else' option yourself.",
  "",
  "Each option needs a stable `id` (the value the response carries back) and a",
  "short human-readable `label`. Optional `description` adds one line of",
  "context shown beneath the label.",
].join("\n");

/**
 * Scan every model-authored string in a question batch — the question, its
 * description, each option label and description, and the free-text
 * placeholder — for an offer to receive a secret in chat.
 *
 * Exported for tests.
 */
export function scanQuestionsForCredentialSolicitation(
  questions: readonly SingleQuestion[],
): CredentialSolicitation[] {
  const fields: { field: string; text: string | undefined }[] = [];
  questions.forEach((q, qi) => {
    fields.push({ field: `questions[${qi}].question`, text: q.question });
    fields.push({ field: `questions[${qi}].description`, text: q.description });
    fields.push({
      field: `questions[${qi}].freeTextPlaceholder`,
      text: q.freeTextPlaceholder,
    });
    q.options.forEach((o, oi) => {
      fields.push({
        field: `questions[${qi}].options[${oi}].label`,
        text: o.label,
      });
      fields.push({
        field: `questions[${qi}].options[${oi}].description`,
        text: o.description,
      });
    });
  });
  return findCredentialSolicitations(fields);
}

// ── Tool ────────────────────────────────────────────────────────────

/**
 * `ask_question` tool definition. Tests stub the prompter by mocking
 * `../../permissions/question-prompter.js` via `bun:test`'s `mock.module`
 * before importing this file — see `ask-question-tool.test.ts` for the
 * pattern.
 */
export const askQuestionTool = {
  name: "ask_question",
  description: DESCRIPTION,
  category: "interaction",
  executionTarget: "sandbox",
  defaultRiskLevel: RiskLevel.Low,
  // Derived from the same Zod source the pre-execution gate validates
  // against (`TOOL_INPUT_SCHEMAS`). No top-level `required` — caller must
  // supply either `questions` or the legacy flat trio (`question` +
  // `options`), enforced by the schema's refine.
  input_schema: toToolInputSchema(askQuestionInputSchema),

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const parsed = askQuestionInputSchema.safeParse(input);
    if (!parsed.success) {
      return invalidToolInputResult("ask_question", parsed.error);
    }

    // Normalize legacy flat input into a one-element `questions` batch so
    // downstream code only has to deal with the batched shape. The refine
    // above guarantees `question` and `options` are present whenever
    // `questions` is absent.
    const questions: SingleQuestion[] = parsed.data.questions ?? [
      {
        question: parsed.data.question!,
        description: parsed.data.description,
        options: parsed.data.options!,
        freeTextPlaceholder: parsed.data.freeTextPlaceholder,
      },
    ];

    // A question card is model-authored text the user answers in chat, which
    // makes it the one surface where "how do you want to log in?" can quietly
    // become "paste your password here". Refuse before the card is ever
    // rendered — see `security/credential-solicitation.ts` for the incident
    // this backstops.
    const solicitations = scanQuestionsForCredentialSolicitation(questions);
    if (solicitations.length > 0) {
      return {
        content: formatCredentialSolicitationRefusal(solicitations),
        isError: true,
      };
    }

    const prompter = new QuestionPrompter();
    const result = await prompter.prompt({
      conversationId: context.conversationId,
      questions,
      toolUseId: context.toolUseId,
      signal: context.signal,
    });

    // Format the aggregated transcript. Each line is keyed by the original
    // question text (not the daemon-assigned id) — the LLM never sees those
    // ids, and human-readable labels read better in the result content.
    const lines = result.entries.map((entry, i) => {
      const q = questions[i]!;
      const prefix = `Question "${q.question}" →`;
      if (entry.decision === "option") {
        const chosen = q.options.find((o) => o.id === entry.optionId);
        const label = chosen?.label ?? "(unknown)";
        return `${prefix} Option: ${entry.optionId} (${label})`;
      }
      if (entry.decision === "free_text") {
        return `${prefix} Free text: ${entry.text ?? ""}`;
      }
      return `${prefix} Skipped`;
    });

    switch (result.overall) {
      case "completed":
        return { content: lines.join("\n"), isError: false };
      case "closed": {
        const summary =
          "User closed the question card without answering. All questions skipped.";
        return {
          content: [summary, ...lines].join("\n"),
          isError: false,
        };
      }
      case "timed_out":
        return {
          content: "User did not respond within timeout",
          isError: true,
        };
      case "aborted":
        return {
          content: "Question aborted",
          isError: true,
        };
    }
  },
} satisfies ToolDefinition;
