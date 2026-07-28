import { FileText, MessageSquare } from "lucide-react";
import { Link } from "react-router";

import { LibraryCardPlaceholder } from "@/domains/library/components/library-card-placeholder";
import type { DocumentSummary } from "@/types/document-types";
import { cn } from "@/utils/misc";
import { formatFriendlyDate } from "@/utils/format-date";
import { routes } from "@/utils/routes";

function formatWordCount(count: number): string {
  return count === 1 ? "1 word" : `${count} words`;
}

interface LibraryDocumentCardProps {
  document: DocumentSummary;
  onOpen: (documentSurfaceId: string) => void;
}

/**
 * A document in the Library, with a way back to the thread that wrote it.
 *
 * Chat → artifact already worked (the thread header lists its assets); the
 * reverse did not, so a document opened from the Library was orphaned — no way
 * to see why it exists or to ask a follow-up in the thread that produced it.
 *
 * Honesty rule: the provenance row renders only when the daemon returned
 * `sourceConversation`, which it does only after confirming that conversation
 * row still exists. A document whose thread was deleted shows no link at all —
 * we never render a destination we can't prove resolves. The stored
 * `conversationId` alone is not enough to make the claim.
 */
export function LibraryDocumentCard({
  document,
  onOpen,
}: LibraryDocumentCardProps) {
  const source = document.sourceConversation;

  return (
    <div className="group relative flex flex-col gap-2">
      <button
        type="button"
        onClick={() => onOpen(document.surfaceId)}
        className={cn(
          "relative flex w-full cursor-pointer flex-col items-center justify-center gap-2 overflow-hidden rounded-xl border border-[var(--border-base)] bg-[var(--surface-base)]",
          "aspect-[16/10]",
          "outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
        )}
      >
        <LibraryCardPlaceholder
          seed={document.surfaceId}
          icon={FileText}
          label={formatWordCount(document.wordCount)}
        />
      </button>

      <div className="flex flex-col gap-0.5 px-0.5">
        <button
          type="button"
          onClick={() => onOpen(document.surfaceId)}
          className="flex cursor-pointer flex-col gap-0.5 text-left outline-none"
        >
          <span className="truncate text-body-large-default text-[color:var(--content-emphasised)]">
            {document.title}
          </span>
          <span className="text-body-small-default text-[color:var(--content-tertiary)]">
            {formatFriendlyDate(new Date(document.updatedAt))}
          </span>
        </button>

        {source ? (
          <Link
            to={routes.conversation(source.id)}
            title={`Open the conversation this document came from: ${
              source.title ?? "Untitled conversation"
            }`}
            className="mt-0.5 flex min-w-0 items-center gap-1 text-body-small-default text-[color:var(--content-tertiary)] outline-none hover:text-[color:var(--content-emphasised)] focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          >
            <MessageSquare size={12} className="shrink-0" />
            <span className="truncate">
              From {source.title ?? "Untitled conversation"}
            </span>
          </Link>
        ) : null}
      </div>
    </div>
  );
}
