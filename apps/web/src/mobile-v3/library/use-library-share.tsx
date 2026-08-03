/**
 * The ⇪ affordance's state — one hook per gallery, shared by every card in it.
 *
 * It exists to keep three promises the raw runner cannot keep on its own:
 *
 *  · **A completed share is felt.** `.medium` fires on `shared` and on
 *    nothing else — never on appear, never on a dismissal, never on a
 *    failure. The haptic IS the success signal, so it must not be reachable
 *    without one.
 *  · **A failed share is an error state.** It surfaces in the mv3 toast with
 *    the error tone, which promotes above a sheet scrim — the Library's other
 *    door is a sheet, and a failure buried under it would be a silent no-op
 *    wearing a pill.
 *  · **A dismissal is silence.** Backing out of the share sheet is a
 *    decision, not a fault, and reporting it would train people to ignore the
 *    surface that also reports real breakage.
 *
 * The busy id is per-entry so the tapped card alone dims — a whole-grid
 * spinner would claim the gallery is doing something it isn't.
 */
import { useCallback, useRef, useState } from "react";

import { UndoToast, type Mv3Toast } from "@/mobile-v3/undo-toast";
import { haptic } from "@/utils/haptics";

import type { LibraryEntry } from "./library-model";
import {
  detectShareReach,
  shareLibraryEntry,
  type ShareReach,
} from "./library-share";

export function useLibraryShare(assistantId: string): {
  /** What this shell can actually do — drives both the ⇪ and the footer. */
  reach: ShareReach;
  /** Id of the entry mid-share, or null. */
  sharingId: string | null;
  shareEntry: (entry: LibraryEntry) => void;
  /** Render this once, near the gallery. */
  shareToast: React.ReactNode;
} {
  // Resolved once on first client render: the shell does not change under us,
  // and re-probing per render would re-create a File on every paint.
  const [reach] = useState<ShareReach>(() => detectShareReach());
  const [sharingId, setSharingId] = useState<string | null>(null);
  const [toast, setToast] = useState<Mv3Toast | null>(null);
  const toastKey = useRef(0);

  const shareEntry = useCallback(
    (entry: LibraryEntry) => {
      if (sharingId) return;
      // The tap itself is a tap — the commit haptic is reserved for the
      // completed share, so this leg stays light.
      haptic.light();
      setSharingId(entry.id);
      const fail = (message: string) => {
        haptic.error();
        toastKey.current += 1;
        setToast({
          key: toastKey.current,
          tone: "error",
          message: `${message} Nothing was sent.`,
        });
      };
      void shareLibraryEntry(entry, { assistantId, reach })
        .then((result) => {
          if (result.status === "shared") {
            haptic.medium();
            return;
          }
          if (result.status === "dismissed") return;
          fail(result.message);
        })
        // The runner's contract is that it never throws. If that contract
        // ever breaks, it breaks LOUDLY — an unhandled rejection here would
        // leave a share that reported nothing at all.
        .catch(() => fail("Couldn’t share that."))
        .finally(() => setSharingId(null));
    },
    [assistantId, reach, sharingId],
  );

  return {
    reach,
    sharingId,
    shareEntry,
    shareToast: <UndoToast toast={toast} onClear={() => setToast(null)} />,
  };
}
