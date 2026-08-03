/**
 * Mobile v3 Create — where it filed.
 *
 * Design: *"Every artefact card says where it filed — 'Filed onto Close the seed
 * · in Library'. That line is why Create lives in Cue."*
 *
 * It is also the line most likely to become a lie. Today the Create registry
 * carries a `provenance: { files: "Close the $500K seed" }` field whose own type
 * comment calls it *"Presentational provenance chip"* — a hardcoded string on the
 * template, not a link to a real project. `create-view.tsx` renders it directly
 * as "files onto Close the $500K seed" for every user, whether or not such a
 * project exists for them. This module does NOT read that field.
 *
 * The rule here follows the honest precedent already in the codebase — the
 * Library document card, which renders its provenance row only when the daemon
 * actually returned a `sourceConversation`, with the comment *"we never render a
 * destination we can't prove resolves."*
 *
 * So a destination is composed only from things that can be proven:
 *
 *   - **The thread** — always provable. The build IS a chat turn against a known
 *     conversation id, and the artefact lands in it. This is the floor: there is
 *     no state in which the card cannot honestly say at least this.
 *   - **Library** — provable when the run produced a real app / document /
 *     attachment id, because those are exactly what the Library surface lists.
 *   - **A project** — provable only when a caller passes a real, resolved
 *     project title. Nothing in the current pipeline supplies one, so it is
 *     normally absent, and the line simply omits it.
 *
 * Absent is a fine answer. Invented is not.
 */

/** The kinds of artefact the Library surface actually lists. */
export type LibraryKind = "app" | "document" | "attachment";

export interface FilingDestination {
  /**
   * The conversation the artefact landed in. Always present — the build is a
   * turn against this id, so this is the one thing that is never in doubt.
   */
  conversationId: string;
  /**
   * The artefact's real Library id + kind, when the run produced one. Presence
   * is what proves "in Library"; absence means we don't claim it.
   */
  library?: { kind: LibraryKind; id: string };
  /**
   * A real project / work-item title this was filed onto. Only set this from a
   * resolved record — never from a template's presentational hint.
   */
  project?: string;
}

/**
 * Compose the filing line.
 *
 * Never returns null: the thread is always provable, so there is always
 * something true to say. The shape matches design's line as closely as the
 * available truth allows —
 *
 *   both:    "Filed onto Close the seed · in Library"
 *   library: "Filed in Library · in this thread"
 *   floor:   "Filed in this thread"
 */
export function filingLine(dest: FilingDestination): string {
  const parts: string[] = [];

  if (dest.project?.trim()) {
    parts.push(`Filed onto ${dest.project.trim()}`);
    if (dest.library) parts.push("in Library");
    else parts.push("in this thread");
    return parts.join(" · ");
  }

  if (dest.library) {
    return "Filed in Library · in this thread";
  }

  return "Filed in this thread";
}

/**
 * Whether the destination carries anything beyond the floor. The card uses this
 * to decide whether the line earns its own emphasis — not to decide whether to
 * render it, which it always does.
 */
export function hasRichDestination(dest: FilingDestination): boolean {
  return Boolean(dest.project?.trim() || dest.library);
}

/* ----------------------------------------------------------------------- */
/* Deriving a destination from the one record that actually proves it       */
/* ----------------------------------------------------------------------- */

/**
 * The shape of an `outputs` row, structurally typed.
 *
 * `GET /v1/assistants/:id/outputs` is the only artefact listing that carries a
 * `projectId` — apps / documents / attachments do not. It is what the mobile
 * Library reads (`mobile-v3/library/use-library-outputs.ts`), and its
 * `projectId` is denormalised at capture from the producing work item. So an
 * output row is the single record that can prove BOTH halves of design's line.
 *
 * Typed structurally rather than imported so this module stays independent of
 * the Library surface's own model.
 */
export interface OutputRowLike {
  id: string;
  title?: string | null;
  projectId?: string | null;
  kind?: string | null;
}

/**
 * Compose a destination from a real output row plus a resolved project title.
 *
 * `projectTitle` must come from a real `projectsGet` lookup keyed on the row's
 * `projectId`. Passing a title without a matching id, or an id you could not
 * resolve, reintroduces exactly the fabrication this module exists to prevent —
 * so an unresolved id yields no project, and the line degrades to Library.
 */
export function destinationFromOutput(
  conversationId: string,
  row: OutputRowLike | null | undefined,
  projectTitle?: string | null,
): FilingDestination {
  if (!row) return { conversationId };
  const project =
    row.projectId && projectTitle?.trim() ? projectTitle.trim() : undefined;
  return {
    conversationId,
    library: { kind: "document", id: row.id },
    project,
  };
}
