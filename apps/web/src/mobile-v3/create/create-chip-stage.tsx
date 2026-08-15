/**
 * Mobile v3 Create — N3, chip stage two.
 *
 * Two or three chip rows and nothing else. It is deliberately not a form: every
 * question has a small, closed set of answers, which is the whole reason it can
 * sit in front of a render without feeling like an obstacle.
 *
 * What this screen may not do:
 *
 *   NEVER pre-select a chip. A default that looks chosen is an answer the user
 *         did not give, on the type where a wrong assumption costs a full
 *         render — the same class of claim as a prefilled figure.
 *   NEVER block. Skip is always available and always builds; unanswered
 *         questions are simply absent from the run.
 *
 * The reason line is not decoration either. A stage that appears between the
 * user and the thing they asked for has to say why it is there, and design's
 * answer is the honest one: *"Nine templates, no questions today — so a wrong
 * guess burns a full render."*
 */

import { useState } from "react";

import { haptic } from "@/utils/haptics";

import {
  chipStageCta,
  chipStageReason,
  type ChipQuestion,
} from "./create-chip-sets";

import "./mv3-create.css";

export interface CreateChipStageProps {
  typeId: string;
  /** The singular thing being made, for the CTA ("Build the video →"). */
  noun: string;
  questions: ChipQuestion[];
  /** Build with the chips answered so far. */
  onBuild: (answers: Record<string, string>) => void;
}

export function CreateChipStage({
  typeId,
  noun,
  questions,
  onBuild,
}: CreateChipStageProps) {
  const [answers, setAnswers] = useState<Record<string, string>>({});

  return (
    <>
      <div className="mv3c-flow">
        <div className="mv3c-said">{chipStageReason(typeId)}</div>

        <div className="mv3c-ask">
          {questions.map((question) => (
            <div key={question.key}>
              <div className="mv3c-asklabel">{question.label}</div>
              <div
                className="mv3c-askfield"
                role="group"
                aria-label={question.label}
              >
                {question.options.map((option) => (
                  <button
                    key={option}
                    type="button"
                    className="mv3c-optchip"
                    aria-pressed={answers[question.key] === option}
                    onClick={() => {
                      haptic.light();
                      setAnswers((prev) =>
                        // Tapping the chosen chip again clears it — the user can
                        // get back to "I didn't say", which a radio group would
                        // not allow.
                        prev[question.key] === option
                          ? { ...prev, [question.key]: "" }
                          : { ...prev, [question.key]: option },
                      );
                    }}
                  >
                    {option}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div style={{ height: 4 }} />
      </div>

      <div className="mv3c-footer">
        <button
          type="button"
          className="mv3c-primary"
          onClick={() => {
            haptic.medium();
            onBuild(answers);
          }}
        >
          {chipStageCta(noun)}
        </button>
        <div className="mv3c-footnote">Lands in this thread when it's done.</div>
      </div>
    </>
  );
}
