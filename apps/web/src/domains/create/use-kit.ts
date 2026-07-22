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

/** Fast poll while runs are live; the slow poll a stalled kit backs off to. */
const KIT_POLL_MS = 2500;
const KIT_SLOW_POLL_MS = 30_000;
/**
 * A kit whose newest asset transition is older than this has stalled — the
 * runs are fire-and-forget, so an interrupted daemon leaves rows stuck
 * mid-flight. Keep polling (a restart can still finish them) but stop
 * hammering, and let the view say the run is taking longer than usual.
 */
const KIT_STALL_MS = 12 * 60_000;

/**
 * Poll a kit's status while any asset is still working. Stops polling once
 * every asset is terminal (done/failed) so a finished kit doesn't spin the
 * network, and backs off to a slow poll once a kit has visibly stalled.
 * Disabled until a kitId exists.
 */
export function useKit(kitId: string | null) {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  return useQuery({
    ...kitsByKidGetOptions({
      path: { assistant_id: assistantId ?? "", kid: kitId ?? "" },
    }),
    enabled: Boolean(assistantId && kitId),
    refetchInterval: (query) => {
      const kit = query.state.data?.kit;
      if (!kit) return KIT_POLL_MS;
      // A kit with no assets will never change — nothing is running.
      if (kit.assets.length === 0) return false;
      const settled = kit.assets.every(
        (a) => a.status === "done" || a.status === "failed",
      );
      if (settled) return false;
      const lastChange = Math.max(...kit.assets.map((a) => a.updatedAt));
      return Date.now() - lastChange > KIT_STALL_MS
        ? KIT_SLOW_POLL_MS
        : KIT_POLL_MS;
    },
  });
}
