/**
 * Client-side elicitation form for a Create-studio template.
 *
 * Rendered the moment a template with `elicit` fields is picked — BEFORE any
 * model turn. It reuses the exact batched question card the chat surface uses
 * (`QuestionPromptCard`), so the paginated click-through, defaults, and
 * free-text slot all come for free. On submit the answers compose into the
 * final prompt deterministically (`composeElicitedPrompt`) and the caller sends
 * THAT — the model just builds.
 *
 * Two exits to "generate now": click through the options (the card auto-submits
 * once every question has an answer), or hit "Use defaults & generate" to
 * accept every recommended default in one tap. The card's ✕ / Back cancels
 * without sending.
 *
 * Visuals ride the design-library tokens (`--content-*`, `--surface-*`), so the
 * same component renders correctly on the desktop Create surface and inside the
 * mobile create sheet, in light and dark.
 */

import { ChevronLeft } from "lucide-react";
import { useMemo } from "react";

import type { QuestionResponseEntry } from "@/domains/chat/api/event-types";
import { QuestionPromptCard } from "@/domains/chat/components/question-prompt-card";
import { Button, Typography } from "@vellumai/design-library";

import { composeElicitedPrompt, elicitFieldsToEntries } from "./create-elicit";
import type { CreateTemplate } from "./create-templates";

export interface TemplateElicitFormProps {
  /** The picked template — must carry `elicit` fields. */
  template: CreateTemplate;
  /** Fires with the composed prompt once answers are in. */
  onSubmit: (composedPrompt: string) => void;
  /** Fires when the user backs out without generating. */
  onCancel: () => void;
}

/**
 * The pre-send question form. Owns no run/intent logic — the caller decides how
 * the composed prompt becomes a thread (so desktop and mobile keep their own
 * intent/brand/reference wiring).
 */
export function TemplateElicitForm({
  template,
  onSubmit,
  onCancel,
}: TemplateElicitFormProps) {
  const entries = useMemo(
    () => elicitFieldsToEntries(template.elicit ?? []),
    [template],
  );

  const handleSubmitAll = (responses: QuestionResponseEntry[]) => {
    onSubmit(composeElicitedPrompt(template, responses));
  };

  const handleUseDefaults = () => {
    // Empty responses → every field resolves to its recommended default.
    onSubmit(composeElicitedPrompt(template, []));
  };

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4 py-1">
      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex w-fit items-center gap-1 text-[color:var(--content-tertiary)] transition-colors hover:text-[color:var(--content-secondary)]"
          aria-label="Back"
        >
          <ChevronLeft className="h-4 w-4" />
          <Typography variant="body-small-default" as="span">
            Back
          </Typography>
        </button>
        <Typography
          variant="title-small"
          as="h2"
          className="text-[color:var(--content-default)]"
        >
          {template.title}
        </Typography>
        <Typography
          variant="body-small-default"
          as="p"
          className="text-[color:var(--content-tertiary)]"
        >
          A couple of quick answers so this builds exactly right — or accept the
          defaults to generate now.
        </Typography>
      </div>

      <QuestionPromptCard
        requestId={`create-elicit-${template.id}`}
        entries={entries}
        isSubmitting={false}
        onSubmitAll={handleSubmitAll}
        onClose={onCancel}
      />

      <Button variant="primary" fullWidth onClick={handleUseDefaults}>
        Use defaults &amp; generate
      </Button>
    </div>
  );
}
