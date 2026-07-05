/**
 * Create Studio — fan-out kit client (4g).
 *
 * Wraps the daemon `/v1/kits` endpoints (scope-less; the gateway adds the
 * `/assistants/{id}` scope): launch a coordinated multi-format kit, poll its
 * per-asset status, and regenerate one asset. This is the real single-launch
 * orchestration that replaces the earlier N-separate-re-seed approximation —
 * one POST fans the brief out across formats server-side, each produced in-brand
 * and tracked together under a `kitId`.
 */

import { useMutation, useQuery } from "@tanstack/react-query";

import {
  kitsByKidAssetsByAidRegeneratePostMutation,
  kitsByKidGetOptions,
  kitsPostMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

/** One produced asset in a kit (mirrors the daemon `kit_assets` row). */
export interface KitAssetStatus {
  id: string;
  format: string;
  mode: string;
  conversationId: string | null;
  status: "pending" | "running" | "done" | "failed";
  outputRef: string | null;
  error: string | null;
}

export interface LaunchKitBody {
  brief: string;
  formats: string[];
  brandKitId?: string;
  contractPreamble?: string;
  title?: string;
}

/** Launch + regenerate mutations, scoped to the active assistant. */
export function useKitLauncher() {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const create = useMutation(kitsPostMutation());
  const regen = useMutation(kitsByKidAssetsByAidRegeneratePostMutation());
  return {
    ready: Boolean(assistantId),
    async launchKit(body: LaunchKitBody): Promise<string | null> {
      if (!assistantId) return null;
      const res = await create.mutateAsync({
        path: { assistant_id: assistantId },
        body,
      });
      return res.kit?.id ?? null;
    },
    async regenerateAsset(kid: string, aid: string): Promise<void> {
      if (!assistantId) return;
      await regen.mutateAsync({
        path: { assistant_id: assistantId, kid, aid },
      });
    },
  };
}

/**
 * Poll a kit's status while any asset is still working. Stops polling once
 * every asset is terminal (done/failed) so a finished kit doesn't spin the
 * network. Disabled until a kitId exists.
 */
export function useKit(kitId: string | null) {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  return useQuery({
    ...kitsByKidGetOptions({
      path: { assistant_id: assistantId ?? "", kid: kitId ?? "" },
    }),
    enabled: Boolean(assistantId && kitId),
    refetchInterval: (query) => {
      const assets = query.state.data?.kit?.assets ?? [];
      const settled =
        assets.length > 0 &&
        assets.every((a) => a.status === "done" || a.status === "failed");
      return settled ? false : 2500;
    },
  });
}
