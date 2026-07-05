/**
 * Create Studio — active Brand Kit fetch (read-only).
 *
 * The Create composer's "In your brand" toggle needs the assistant's active
 * Brand Profile so `applyCreateIntent()` can compile the brand contract into
 * the seeded prompt. This hook GETs the assistant's brand profiles
 * (`/v1/assistants/:id/brand-profiles`) and returns the one carrying
 * `isActive=1`, mapped to the `BrandProfileLike` shape the intent compiler
 * consumes.
 *
 * READ-ONLY: the Brand Kit surfaces / settings / onboarding are owned by
 * another workstream. This hook only reads the active profile so Create can
 * apply it — it never writes.
 *
 * The route is scoped to the owning assistant (`:id` === the active assistant
 * id; `assistant_id` is injected by the platform gateway but the generated SDK
 * still requires it in the path). We read the assistant id from the raw
 * resolved-assistants store (nullable) rather than `useActiveAssistantId()`,
 * because the Create surface can render across pre-active states — the query
 * simply stays disabled until an id is available.
 */

import { useMemo } from "react";

import { useQuery } from "@tanstack/react-query";

import { brandprofilesGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

import type { BrandProfileLike } from "@/domains/create/create-intent";

export interface ActiveBrand extends BrandProfileLike {
  /** The active brand profile's id (→ CreateIntent.brandKitId). */
  id: string;
}

export interface UseActiveBrandResult {
  /** The active Brand Kit, or null when none is active / not loaded. */
  brand: ActiveBrand | null;
  isLoading: boolean;
}

/**
 * Returns the assistant's active Brand Kit (isActive=1), mapped to the shape
 * the CreateIntent compiler consumes, or null when there's no active kit.
 */
export function useActiveBrand(): UseActiveBrandResult {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();

  const query = useQuery({
    ...brandprofilesGetOptions({
      // `:id` is the owning assistant id; `assistant_id` is the gateway scope.
      // Both resolve to the active assistant (see assistant/.../brand-routes.ts).
      path: { assistant_id: assistantId ?? "" },
    }),
    enabled: Boolean(assistantId),
    staleTime: 60_000,
  });

  const brand = useMemo<ActiveBrand | null>(() => {
    const profiles = query.data?.brandProfiles;
    if (!profiles?.length) return null;
    const active = profiles.find((p) => p.isActive === 1);
    if (!active) return null;
    return {
      id: active.id,
      name: active.name,
      palette: active.palette,
      fonts: active.fonts,
      logo: active.logo,
      voice: active.voice,
    };
  }, [query.data]);

  return { brand, isLoading: query.isLoading };
}
