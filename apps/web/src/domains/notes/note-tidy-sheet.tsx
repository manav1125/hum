/**
 * The tidy diff — the screen S4 exists for.
 *
 * Cue never touches your text unless you ask, and when you ask it shows you
 * both versions rather than swapping one for the other. That is the whole
 * point: an assistant that silently rewrites what you typed makes the note
 * untrustworthy as a record of what you actually thought, which is the only
 * reason to keep notes at all.
 *
 * Three answers, never two — **use the tidied one, keep mine, keep both** —
 * and the original stays recoverable even after accepting, because the tidy
 * is a version rather than a replacement.
 *
 * Note what is absent from the editor that opens this: there is **no `✧`
 * button hovering in the note inviting a rewrite**. The tidy lives in `⋯`,
 * where you go looking for it. A button that offers to rewrite your words
 * every time you glance at them is an assistant with an opinion about your
 * writing, and this one is not supposed to have one.
 */

import { useCallback, useEffect, useState } from "react";

import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import {
  notesByIdTidyApplyPostMutation,
  notesByIdTidyPostMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { useInvalidateNotes } from "@/hooks/use-invalidate-notes";

const C = {
  card: "var(--mv1-card)",
  sunken: "var(--mv1-sunken)",
  line: "var(--mv1-line)",
  line2: "var(--mv1-line-strong)",
  t1: "var(--mv1-t1)",
  t2: "var(--mv1-t2)",
  t3: "var(--mv1-t3)",
  blueS: "var(--mv1-blue-strong)",
  green: "var(--mv1-green)",
  amberText: "var(--mv1-amber-text)",
} as const;

interface TidyResponse {
  status: "tidied" | "refused" | "failed";
  original: string | null;
  tidied: string | null;
}

export function NoteTidySheet({
  assistantId,
  noteId,
  onClose,
}: {
  assistantId: string;
  noteId: string;
  onClose: () => void;
}) {
  const invalidate = useInvalidateNotes();
  const [result, setResult] = useState<TidyResponse | null>(null);

  const propose = useMutation(notesByIdTidyPostMutation()) as unknown as {
    mutateAsync: (vars: {
      path: { assistant_id: string; id: string };
    }) => Promise<TidyResponse>;
    isPending: boolean;
  };

  const apply = useMutation(notesByIdTidyApplyPostMutation()) as unknown as {
    mutateAsync: (vars: {
      path: { assistant_id: string; id: string };
      body: { choice: string; tidied: string };
    }) => Promise<unknown>;
    isPending: boolean;
  };

  useEffect(() => {
    let cancelled = false;
    void propose
      .mutateAsync({ path: { assistant_id: assistantId, id: noteId } })
      .then((r) => {
        if (!cancelled) setResult(r);
      })
      .catch(() => {
        if (!cancelled) {
          setResult({ status: "failed", original: null, tidied: null });
        }
      });
    return () => {
      cancelled = true;
    };
    // Once, on open. Re-proposing on every render would be a model call per
    // keystroke, which is the cost mistake S6 exists to prevent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assistantId, noteId]);

  const choose = useCallback(
    async (choice: "use_tidied" | "keep_mine" | "keep_both") => {
      if (result?.status !== "tidied" || !result.tidied) return;
      await apply.mutateAsync({
        path: { assistant_id: assistantId, id: noteId },
        body: { choice, tidied: result.tidied },
      });
      invalidate();
      onClose();
    },
    [apply, assistantId, invalidate, noteId, onClose, result],
  );

  return (
    <div
      className="rounded-lg border p-3"
      style={{ borderColor: C.line2, background: C.card }}
      role="dialog"
      aria-label="Tidy this note"
    >
      <div className="mb-2 flex items-center justify-between">
        <p
          className="text-[10.5px] font-semibold tracking-wide uppercase"
          style={{ color: C.t3 }}
        >
          You asked me to tidy this up
        </p>
        <button
          type="button"
          onClick={onClose}
          className="text-[12px]"
          style={{ color: C.t3 }}
        >
          Close
        </button>
      </div>

      {propose.isPending || !result ? (
        <p
          className="flex items-center gap-2 text-[13px]"
          style={{ color: C.t2 }}
        >
          <Loader2 size={13} className="animate-spin" />
          Reading it back to you…
        </p>
      ) : result.status === "failed" ? (
        <p className="text-[13px]" style={{ color: C.amberText }}>
          I couldn&rsquo;t tidy that just now — your note is untouched.
        </p>
      ) : result.status === "refused" ? (
        // The model gave back something that had added or lost content. Cue
        // kept their words rather than showing a "tidy" that is not one.
        <p className="text-[13px]" style={{ color: C.t2 }}>
          What came back changed more than the wording, so I&rsquo;ve kept yours
          exactly as it is.
        </p>
      ) : (
        <>
          <div className="grid gap-3 md:grid-cols-2">
            <Column label="Yours" body={result.original ?? ""} mine />
            <Column label="Tidied" body={result.tidied ?? ""} />
          </div>

          {/* Three answers, never two. "Keep mine" leads because the default
              has to be the one that changes nothing. */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={apply.isPending}
              onClick={() => void choose("keep_mine")}
              className="rounded-full border px-2.5 py-1 text-[12px]"
              style={{ borderColor: C.line2, color: C.t1 }}
            >
              Keep mine
            </button>
            <button
              type="button"
              disabled={apply.isPending}
              onClick={() => void choose("use_tidied")}
              className="rounded-full px-2.5 py-1 text-[12px] font-medium text-white"
              style={{ background: C.green }}
            >
              Use the tidied one
            </button>
            <button
              type="button"
              disabled={apply.isPending}
              onClick={() => void choose("keep_both")}
              className="text-[12px]"
              style={{ color: C.blueS }}
            >
              Keep both
            </button>
          </div>

          <p className="mt-2 text-[11px]" style={{ color: C.t3 }}>
            Your original stays recoverable, even after you accept — the tidy is
            a version, not a replacement.
          </p>
        </>
      )}
    </div>
  );
}

function Column({
  label,
  body,
  mine,
}: {
  label: string;
  body: string;
  mine?: boolean;
}) {
  return (
    <div>
      <p
        className="mb-1 text-[10.5px] font-semibold tracking-wide uppercase"
        style={{ color: C.t3 }}
      >
        {label}
      </p>
      <div
        className="max-h-40 overflow-y-auto rounded-lg border p-2 text-[12.5px] leading-relaxed whitespace-pre-wrap"
        style={{
          // The owner's version is drawn on the plain surface and the tidied
          // one on the sunken one, so the eye can tell at a glance which is
          // theirs before reading a word of either.
          borderColor: mine ? C.line2 : C.line,
          background: mine ? C.card : C.sunken,
          color: C.t1,
        }}
      >
        {body}
      </div>
    </div>
  );
}
