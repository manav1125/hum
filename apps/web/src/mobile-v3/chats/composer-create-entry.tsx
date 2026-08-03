/**
 * ✎ Create — the composer's second mode (v25 · G4/G6).
 *
 *   "A sheet over the composer, not a destination … Result lands in the thread
 *    as an artefact card."
 *
 * This file is the ENTRY POINT only. The Create flow itself lives in
 * `domains/create` and is owned elsewhere; all this does is put the pencil in
 * the composer and lift that sheet over the current thread.
 *
 * It lives under `mobile-v3/` rather than inside the chat composer for a
 * boring but real reason: `domains/chat` may not import `domains/create`
 * (`local/no-cross-domain-imports` — a chat that reaches into Create is a chat
 * that has to be rebuilt when Create moves). `mobile-v3` is not a domain, so it
 * is allowed to compose the two, which is the same seam the overflow menu
 * already uses for its own Create door.
 *
 * The sheet is lazy: it pulls the whole template and gallery catalogue, and a
 * conversation must not pay for that until somebody taps the pencil.
 */

import { Suspense, lazy, useState } from "react";
import { PencilLine } from "lucide-react";

import { ComposerAffordance } from "./composer-affordance";

const CreateSheet = lazy(() =>
  import("@/domains/create/create-sheet").then((m) => ({
    default: m.CreateSheet,
  })),
);

export function ComposerCreateEntry() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <ComposerAffordance
        label="Create something"
        text="Create"
        expanded={open}
        onPress={() => setOpen(true)}
      >
        <PencilLine size={15} aria-hidden />
      </ComposerAffordance>
      {open ? (
        <Suspense fallback={null}>
          <CreateSheet open onClose={() => setOpen(false)} />
        </Suspense>
      ) : null}
    </>
  );
}
