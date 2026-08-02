/**
 * Renders the `QuestionPromptCard` above the composer when an agent question
 * is pending, reading state from interaction-store directly.
 *
 * Capped at one question per turn (`capClarifyingQuestions`): one clarifying
 * question is partnership, three is a form. Anything past the first is answered
 * as an explicit skip in the same submission, so the run resumes with Cue
 * making its own call rather than with the user filling in a questionnaire.
 */

import { useCallback } from "react";

import { useInteractionStore } from "@/domains/chat/interaction-store";
import {
  handleQuestionResponse,
  handleDismissPendingQuestion,
} from "@/domains/chat/question-actions";
import { QuestionPromptCard } from "@/domains/chat/components/question-prompt-card";
import {
  capClarifyingQuestions,
  withDroppedSkips,
} from "@/domains/chat/partner/clarifying";
import type { QuestionResponseEntry } from "@/domains/chat/api/event-types";

export function QuestionPromptSlot() {
  const pendingQuestion = useInteractionStore.use.pendingQuestion();
  const isSubmitting = useInteractionStore.use.isSubmittingQuestion();

  const entries = pendingQuestion?.entries;
  const onSubmitAll = useCallback(
    (responses: QuestionResponseEntry[]) => {
      void handleQuestionResponse(withDroppedSkips(entries ?? [], responses));
    },
    [entries],
  );

  if (!pendingQuestion) return null;

  return (
    <div className="mb-2">
      <QuestionPromptCard
        key={pendingQuestion.requestId}
        requestId={pendingQuestion.requestId}
        entries={capClarifyingQuestions(pendingQuestion.entries)}
        isSubmitting={isSubmitting}
        onSubmitAll={onSubmitAll}
        onClose={handleDismissPendingQuestion}
      />
    </div>
  );
}
