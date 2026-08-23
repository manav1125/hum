/**
 * "Make something from this" — a note as a brief.
 *
 * One step, and it connects three surfaces that were islands: Notes → Create
 * → Library, with provenance running the whole way. The output remembers the
 * note it came from, so a deck can always answer "where did this come from?"
 * — which is what makes generated work defensible rather than merely fast.
 *
 * The options are the note's **plausible** outputs, not a menu of everything
 * Create can do: a note about a customer offers a deck and an email, not a
 * video style. That restraint is the difference between a suggestion and a
 * toy box, and a toy box is what makes people stop trusting suggestions
 * everywhere else in the product.
 *
 * Provenance stays one-way, as everywhere else in Notes: **deleting the note
 * never deletes the deck.**
 */

import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";

import { notesByIdCreateoptionsGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { useConversationStore } from "@/stores/conversation-store";
import { routes } from "@/utils/routes";

const C = {
  line2: "var(--mv1-line-strong)",
  t1: "var(--mv1-t1)",
  t3: "var(--mv1-t3)",
} as const;

interface CreateOption {
  kind: string;
  label: string;
  prompt: string;
}

/**
 * A local draft-conversation id, mirroring `domains/create/create-page.tsx`
 * and `domains/library/library-page.tsx`. Duplicated deliberately rather than
 * imported — the same cross-domain convention those files cite.
 */
function newDraftConversationId(): string {
  return typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `draft-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function NoteCreateOptions({
  assistantId,
  noteId,
}: {
  assistantId: string;
  noteId: string;
}) {
  const navigate = useNavigate();

  const query = useQuery({
    ...notesByIdCreateoptionsGetOptions({
      path: { assistant_id: assistantId, id: noteId },
    }),
    enabled: Boolean(assistantId && noteId),
    staleTime: 60_000,
  }) as unknown as { data?: { options: CreateOption[] } };

  const options = query.data?.options ?? [];
  if (options.length === 0) return null;

  const open = (option: CreateOption) => {
    // Seeds Create with the note as the brief, the same way Library seeds a
    // prompt: mint a draft conversation and hand the text over on `?prompt=`.
    const id = newDraftConversationId();
    useConversationStore.getState().setActiveConversationId(id);
    void navigate(
      `${routes.conversation(id)}?prompt=${encodeURIComponent(option.prompt)}`,
    );
  };

  return (
    <div className="mt-3">
      <p
        className="mb-1.5 text-[10.5px] font-semibold tracking-wide uppercase"
        style={{ color: C.t3 }}
      >
        Make something from this
      </p>
      <div className="flex flex-wrap gap-1.5">
        {options.map((option) => (
          <button
            key={option.kind}
            type="button"
            onClick={() => open(option)}
            className="rounded-full border px-2.5 py-1 text-[12px]"
            style={{ borderColor: C.line2, color: C.t1 }}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p className="mt-1.5 text-[11px]" style={{ color: C.t3 }}>
        The result lands in Library and remembers this note as its brief.
        Deleting the note never deletes it.
      </p>
    </div>
  );
}
