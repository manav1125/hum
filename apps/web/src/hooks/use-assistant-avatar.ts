import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  clearAvatarFileAbsenceCache,
  fetchCharacterComponents,
  fetchAvatarState,
  fetchAvatarImageUrl,
  fetchCharacterTraits,
} from "@/assistant/avatar-api";
import type { CharacterComponents, CharacterTraits } from "@/types/avatar";
import { useSupportsAvatarStateManifest } from "@/lib/backwards-compat/avatar-state-manifest";
import { avatarQueryKey } from "@/lib/sync/query-tags";

interface AvatarData {
  traits: CharacterTraits | null;
  customImageUrl: string | null;
}

const activeBlobUrls = new Map<string, string>();

/**
 * Resolve the avatar render mode from the authoritative `/avatar/state`
 * manifest (assistants on `MIN_VERSION`+). Throws on a null state so React
 * Query keeps the previously cached avatar instead of blanking out — see
 * the `retry` / `staleTime` options below.
 */
async function fetchAvatarViaManifest(
  assistantId: string,
): Promise<{ traits: CharacterTraits | null; imageUrl: string | null }> {
  const state = await fetchAvatarState(assistantId);
  if (state === null) {
    // `fetchAvatarState` returns null only on transport failure. Throw
    // rather than resolve to an empty avatar: React Query keeps the
    // previously cached avatar data on error (it does not overwrite
    // `data`) and retries, so with `staleTime: Infinity` consumers keep
    // showing the last good avatar instead of blanking out to the "V".
    throw new Error("Failed to fetch avatar state");
  }

  if (state.kind === "character") {
    // Built/AI character: render the animated SVG from traits. The daemon
    // also writes a derived avatar-image.png raster, but the web never
    // uses it, so we skip the image fetch entirely.
    return { traits: state.traits, imageUrl: null };
  }
  if (state.kind === "image") {
    // Custom uploaded image: render the static circle.
    return { traits: null, imageUrl: await fetchAvatarImageUrl(assistantId) };
  }
  // kind === "none": both stay null, and ChatAvatar falls back to default
  // components / the "V".
  return { traits: null, imageUrl: null };
}

/**
 * Pre-manifest render-mode inference for assistants without `/avatar/state`:
 * a custom image exists ⇒ render it; otherwise read the character-traits
 * sidecar. Mirrors the daemon's legacy file-precedence ordering and is kept
 * alive behind the version gate — see
 * `lib/backwards-compat/avatar-state-manifest.ts`.
 */
async function fetchAvatarViaLegacyFiles(
  assistantId: string,
): Promise<{ traits: CharacterTraits | null; imageUrl: string | null }> {
  const imageUrl = await fetchAvatarImageUrl(assistantId);
  // Skip the traits fetch when a custom image exists — the traits file is
  // intentionally deleted on the daemon side in that case, so requesting it
  // just generates 404s. `AvatarRenderer` only reads `traits` when there is
  // no `customImageUrl`.
  const traits = imageUrl ? null : await fetchCharacterTraits(assistantId);
  return { traits, imageUrl };
}

/**
 * Shared hook for assistant avatar data backed by React Query.
 *
 * All consumers of the same `assistantId` share a single cached result.
 * Call `invalidate()` to trigger a refetch that every consumer sees.
 *
 * The render mode comes from the authoritative `/avatar/state` manifest on
 * assistants that expose it; older assistants fall back to inferring it from
 * the workspace sidecar files. The manifest-support flag is part of the query
 * key so the avatar re-fetches through the correct path the moment the
 * assistant version resolves.
 */
export function useAssistantAvatar(assistantId: string | null) {
  const queryClient = useQueryClient();
  const supportsManifest = useSupportsAvatarStateManifest();

  // Character components (~46 KB) are independent of the render-mode
  // resolution path, so they live under a stable key WITHOUT the
  // `supportsManifest` segment. The manifest-support flag flips false→true
  // when the assistant version resolves shortly after boot; when the
  // components shared the flag-keyed query they were re-downloaded on every
  // boot for nothing. Both queries share the `avatarQueryKey` prefix so all
  // existing invalidations (upload/remove/regenerate, SSE `avatar_updated`,
  // reconnect sweep) hit both.
  const componentsQuery = useQuery<CharacterComponents>({
    queryKey: [...avatarQueryKey(assistantId ?? ""), "components"],
    queryFn: async () => {
      const components = await fetchCharacterComponents(assistantId!);
      // Throw (rather than resolve null) so React Query keeps previously
      // cached components on a transient failure and retries — mirrors the
      // avatar-state error semantics above.
      if (!components) throw new Error("Failed to fetch character components");
      return components;
    },
    enabled: Boolean(assistantId),
    staleTime: Infinity,
    structuralSharing: false,
    retry: 1,
    retryOnMount: false,
  });

  const { data, isLoading } = useQuery<AvatarData>({
    queryKey: [...avatarQueryKey(assistantId ?? ""), "mode", supportsManifest],
    queryFn: async () => {
      const id = assistantId!;
      const { traits, imageUrl } = supportsManifest
        ? await fetchAvatarViaManifest(id)
        : await fetchAvatarViaLegacyFiles(id);

      const prev = activeBlobUrls.get(id);
      if (prev && prev !== imageUrl) {
        URL.revokeObjectURL(prev);
      }
      if (imageUrl) {
        activeBlobUrls.set(id, imageUrl);
      } else {
        activeBlobUrls.delete(id);
      }

      return { traits, customImageUrl: imageUrl };
    },
    enabled: Boolean(assistantId),
    staleTime: Infinity,
    structuralSharing: false,
    // Retry transient failures (character-components or avatar-state) once
    // so a flaky fetch or a briefly-unavailable daemon recovers without a
    // manual invalidate.
    retry: 1,
    // When the query settles in an error state (e.g. no avatar files AND
    // character components unavailable), every route navigation mounts new
    // consumers of this hook — the default retryOnMount would re-run the
    // queryFn each time, re-firing the legacy workspace-file probes whose
    // 404s the browser logs to the console on every navigation. The
    // root-layout keeps one observer of this query mounted for the whole
    // session, so disabling mount retries caps the probes at one attempt
    // (plus `retry: 1`) per session; genuine avatar changes still refetch
    // via the explicit invalidations (upload/remove/regenerate, SSE
    // `avatar_updated`, and the reconnect sweep in
    // `use-assistant-resource-sync`).
    retryOnMount: false,
  });

  const invalidate = useCallback(() => {
    if (!assistantId) return;
    // Explicit invalidation means "the avatar may have changed" — drop any
    // session-cached 404s so the refetch actually re-probes the files.
    clearAvatarFileAbsenceCache(assistantId);
    void queryClient.invalidateQueries({
      queryKey: avatarQueryKey(assistantId),
    });
  }, [assistantId, queryClient]);

  return {
    components: componentsQuery.data ?? null,
    traits: data?.traits ?? null,
    customImageUrl: data?.customImageUrl ?? null,
    isLoading: isLoading || componentsQuery.isLoading,
    invalidate,
  };
}
