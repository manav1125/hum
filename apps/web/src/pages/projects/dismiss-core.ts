/**
 * Dismiss core — the surface-agnostic archive/undo engine behind every ✕.
 *
 * Extracted from `mobile-v3/undo-toast.tsx` so desktop (frame D3's hover ✕ +
 * ink undo pill) and mobile (frame 45's glass pill) share ONE mutation path:
 *   · dismiss → optional 150ms collapse → the daemon's REAL full-record PATCH
 *     (`status: "archived"` — archive, never delete, never complete)
 *   · undo    → the same PATCH restoring the previous status
 * Presentation (toast pill, haptics, ⌘Z) stays with the caller via handlers.
 */
import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { workitemsByIdPatchMutation } from "@/generated/daemon/@tanstack/react-query.gen";
import { fullPatchBody } from "@/mobile-v3/work-kit";
import type { HqWorkItem } from "@/pages/hq/use-missions";

export interface DismissHandlers {
  /** Archive landed — surface the undo affordance (5s pill / ⌘Z). */
  onArchived: (item: HqWorkItem, undo: () => void) => void;
  /** Archive failed — the row is already restored; say so quietly. */
  onArchiveError: (item: HqWorkItem) => void;
  /** Undo landed — the row is back. */
  onRestored?: (item: HqWorkItem) => void;
  /** Undo failed — the item stays archived. */
  onRestoreError?: (item: HqWorkItem) => void;
}

function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)
  );
}

export function useDismissEngine(
  assistantId: string,
  handlers: DismissHandlers,
): {
  /** One-tap/-click dismiss. `immediate` skips the collapse (caller animated). */
  dismiss: (item: HqWorkItem, opts?: { immediate?: boolean }) => void;
  /** Optimistically-hidden ids — filter these out of the rendered list. */
  gone: Set<string>;
  /** The row currently playing its 150ms collapse. */
  leavingId: string | null;
} {
  const queryClient = useQueryClient();
  const patch = useMutation({ ...workitemsByIdPatchMutation() });
  const [gone, setGone] = useState<Set<string>>(() => new Set());
  const [leavingId, setLeavingId] = useState<string | null>(null);

  // Handlers ride a ref so a re-rendering caller never re-arms the engine.
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  }, [handlers]);

  const refresh = () => void queryClient.invalidateQueries();

  const unhide = (id: string) =>
    setGone((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });

  const dismiss = (item: HqWorkItem, opts?: { immediate?: boolean }) => {
    if (gone.has(item.id) || leavingId === item.id) return;
    const prevStatus = item.status;
    const pathOpts = { path: { assistant_id: assistantId, id: item.id } };

    const undo = () => {
      patch.mutate(
        { ...pathOpts, body: fullPatchBody(item, { status: prevStatus }) },
        {
          onSuccess: () => {
            unhide(item.id);
            refresh();
            handlersRef.current.onRestored?.(item);
          },
          onError: () => handlersRef.current.onRestoreError?.(item),
        },
      );
    };

    const commit = () => {
      setLeavingId((v) => (v === item.id ? null : v));
      setGone((prev) => new Set(prev).add(item.id));
      patch.mutate(
        { ...pathOpts, body: fullPatchBody(item, { status: "archived" }) },
        {
          onSuccess: () => {
            refresh();
            handlersRef.current.onArchived(item, undo);
          },
          onError: () => {
            // Restore the row + let the surface say so quietly.
            unhide(item.id);
            handlersRef.current.onArchiveError(item);
          },
        },
      );
    };

    if (opts?.immediate || reducedMotion()) {
      commit();
    } else {
      setLeavingId(item.id);
      window.setTimeout(commit, 160);
    }
  };

  return { dismiss, gone, leavingId };
}
