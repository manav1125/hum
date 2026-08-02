/**
 * The quiet line under an answer: *"from your email and the Northwind deal."*
 *
 * Collapsed by default — one click away, always present when there are sources,
 * and **completely absent when there are none.** That absence is the whole
 * point: a turn that answered from the model's own knowledge must not imply it
 * read the user's data. See `deriveAnswerSources` for how the list is built.
 *
 * Nothing here hedges the answer above it. No "I think", no "it appears that" —
 * the answer stands, and this is the receipt.
 */

import { ChevronRight } from "lucide-react";
import { useId, useState } from "react";

import type { AnswerSource } from "@/domains/chat/partner/answer-sources";
import { summarizeSources } from "@/domains/chat/partner/answer-sources";

export interface AnswerSourcesProps {
  sources: readonly AnswerSource[];
}

export function AnswerSources({ sources }: AnswerSourcesProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  // No sources, no line. Never a placeholder, never an empty disclosure —
  // rendering chrome here would assert provenance we do not have.
  if (sources.length === 0) return null;

  return (
    <div className="w-full" data-testid="answer-sources">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="flex min-w-0 items-center gap-1 rounded text-left text-[12.5px] text-[var(--content-tertiary)] transition-colors hover:text-[var(--content-secondary)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--border-element)]"
      >
        <ChevronRight
          aria-hidden
          className={`size-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="min-w-0 truncate">
          from {summarizeSources(sources)}
        </span>
      </button>
      {open ? (
        <ul
          id={panelId}
          data-testid="answer-sources-detail"
          className="m-0 mt-1 list-none space-y-1 border-l border-[var(--border-base)] pl-3"
        >
          {sources.map((source) => (
            <li
              key={source.id}
              className="min-w-0 text-[12.5px] text-[var(--content-tertiary)]"
            >
              <span className="text-[var(--content-secondary)]">
                {source.label}
              </span>
              {source.detail ? <span> · {source.detail}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
