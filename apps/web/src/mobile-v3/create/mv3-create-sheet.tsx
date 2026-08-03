/**
 * Mobile v3 Create — the connected host.
 *
 * Mounted once, near the app root. It reads the summon store, resolves the real
 * inputs the flow needs, and turns a `BuildRequest` into an actual run using the
 * exact path the desktop Create page uses (`create-page.tsx`): mint a draft
 * conversation id, stamp the origin intent, navigate with `?prompt=`, and let
 * the chat route's auto-send fire it. That is what makes the artefact land in a
 * thread the user can leave and return to.
 *
 * Everything it resolves is real or absent:
 *
 * - **Brand** — `useActiveBrand()`, server-backed, `null` when none is active.
 * - **Known facts** — retrieved memory statements, verbatim. A failed or empty
 *   fetch yields no facts, and the fill screen states that plainly instead of
 *   claiming to remember things.
 * - **Suggestions** — not resolved. There is no client-readable link from a
 *   conversation to a project, so "because you're working on X" cannot be
 *   proven at this point in the flow; the row is therefore absent rather than
 *   filled with a template's hardcoded provenance hint.
 */

import { useCallback, useMemo } from "react";
import { useNavigate } from "react-router";

import { useQuery } from "@tanstack/react-query";

import { memoryitemsGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { useActiveBrand } from "@/domains/create/use-active-brand";
import { useConversationStore } from "@/stores/conversation-store";
import { useCreateProvenanceStore } from "@/stores/create-provenance-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useViewerStore } from "@/stores/viewer-store";
import { routes } from "@/utils/routes";

import { CreateFlow } from "./create-flow";
import { useMv3CreateStore } from "./create-store";
import {
  brandFact,
  memoryFacts,
  type KnownFact,
  type MemoryItemLike,
} from "./create-known-facts";
import { composeRun } from "./create-run";
import type { BuildRequest } from "./create-spine";

/** How many memory items to pull before filtering down to showable facts. */
const MEMORY_FETCH = 40;

/**
 * A fresh draft conversation id. Mirrors `create-page.tsx`, which in turn
 * mirrors chat's own `createDraftConversationId` — inlined in both places so
 * neither reaches into the chat domain's internals.
 */
function newDraftConversationId(): string {
  return typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `draft-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function Mv3CreateSheet() {
  const navigate = useNavigate();
  const open = useMv3CreateStore.use.open();
  const closeCreate = useMv3CreateStore.use.closeCreate();
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const { brand } = useActiveBrand();

  // Memory is fetched only while the sheet is open — Create should not add a
  // background query to every screen that merely mounts the host.
  const memoryQuery = useQuery({
    ...memoryitemsGetOptions({
      path: { assistant_id: assistantId ?? "" },
      query: { limit: MEMORY_FETCH },
    }),
    enabled: open && Boolean(assistantId),
    staleTime: 60_000,
    // A memory miss must not block Create, and must not retry into a spinner.
    retry: false,
  });

  const known = useMemo<KnownFact[]>(() => {
    const facts: KnownFact[] = [];
    const fromBrand = brandFact(brand);
    if (fromBrand) facts.push(fromBrand);
    facts.push(
      ...memoryFacts(memoryQuery.data?.items as MemoryItemLike[] | undefined),
    );
    return facts;
  }, [brand, memoryQuery.data]);

  const onRun = useCallback(
    (request: BuildRequest) => {
      const { prompt, intent } = composeRun(request, brand);
      useViewerStore.getState().setMainView("chat");
      const id = newDraftConversationId();
      useConversationStore.getState().setActiveConversationId(id);
      if (intent) {
        useCreateProvenanceStore.getState().stampIntent(id, intent);
      }
      void navigate(
        `${routes.conversation(id)}?prompt=${encodeURIComponent(prompt)}`,
      );
    },
    [brand, navigate],
  );

  return (
    <CreateFlow
      open={open}
      onClose={closeCreate}
      onRun={onRun}
      known={known}
      brandName={brand?.name ?? null}
    />
  );
}
