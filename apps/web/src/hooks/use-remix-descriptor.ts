/**
 * Create Studio — remix descriptor assembly (shared, top-level).
 *
 * The chat-hosted app viewer renders the remix cluster under a generated asset,
 * but the chat domain can't reach into the `create` domain to (a) read the
 * asset's origin `CreateIntent` provenance or (b) summon the gallery for the
 * Restyle action — the `no-cross-domain-imports` rule forbids it. This hook
 * lives in the top-level `hooks/` dir (so it MAY import from `create`) and
 * assembles the full `AppViewerRemix` descriptor the chat layouts hand to
 * `AppViewerContainer`, from plain primitives the chat side already has.
 *
 * What it threads:
 *   - **Provenance**: looks up the origin intent by the asset's source
 *     conversation id (create-provenance-store) and folds its mode / template /
 *     style / brand-kit into the `RemixAsset`, so Restyle & Rebrand start from
 *     the REAL prior selection rather than the asset name alone. Falls back to
 *     a slides/deck default when no intent was stamped (e.g. after a reload).
 *   - **Restyle**: returns an `onRestyle` that summons the gallery for the
 *     asset's mode (create-gallery-summon-store) pre-scoped to the provenance,
 *     and on confirm re-seeds a restyle generation (`buildRestylePrompt`) via
 *     the caller's re-seed path — the same content, a new template/style.
 */

import { useCallback, useMemo } from "react";

import {
  assetNoun,
  buildRestylePrompt,
  type RemixAsset,
} from "@/domains/create/create-remix";
import type { BrandProfileLike } from "@/domains/create/create-intent";
import type { GallerySelection } from "@/domains/create/create-gallery-overlay";
import { useActiveBrand } from "@/domains/create/use-active-brand";
import type { AppViewerRemix } from "@/components/app-viewer-container";
import { useCreateGallerySummonStore } from "@/stores/create-gallery-summon-store";
import { useCreateProvenanceStore } from "@/stores/create-provenance-store";

export interface UseRemixDescriptorArgs {
  /** The opened asset's display name (from OpenedAppState). */
  assetName: string | null | undefined;
  /**
   * The source conversation the asset was generated in — the key its origin
   * intent was stamped under. Null → no provenance lookup (name-only fallback).
   */
  sourceConversationId: string | null | undefined;
  /** Re-seed the source conversation with a prompt (`?prompt=` path). */
  onReseed: (prompt: string) => void;
  /** Open the Brand Kit creation flow ("New brand kit…"). */
  onNewBrandKit: () => void;
  /** Enable the 4g STRETCH multi-format fan-out affordance. */
  enableFanout?: boolean;
}

/**
 * Turn a chosen gallery template/style id into a restyle re-seed. Slides/docs
 * carry a `templateId`; image/video carry a `styleId` — `buildRestylePrompt`
 * takes a template id, so for style modes we thread the style id through the
 * same channel (the compiled contract resolves it downstream).
 */
function restyleTargetId(selection: GallerySelection): string | undefined {
  return selection.templateId ?? selection.styleId;
}

export function useRemixDescriptor({
  assetName,
  sourceConversationId,
  onReseed,
  onNewBrandKit,
  enableFanout,
}: UseRemixDescriptorArgs): AppViewerRemix | undefined {
  const { brand } = useActiveBrand();
  const intent = useCreateProvenanceStore.use.byConversationId()[
    sourceConversationId ?? ""
  ];
  const summon = useCreateGallerySummonStore.use.summon();

  // Assemble the remix asset from real provenance when we have it. Absent an
  // intent (fresh reload, or a non-Create app), fall back to the prior
  // slides/deck default the cluster used before provenance existed.
  const asset = useMemo<RemixAsset>(() => {
    const mode = intent?.mode ?? "slides";
    return {
      name: assetName ?? "this asset",
      mode,
      templateId: intent?.templateId,
      styleId: intent?.styleId,
      brandKitId: intent?.brandKitId ?? null,
      noun: assetNoun({ mode, noun: undefined }),
    };
  }, [assetName, intent]);

  const brandForRemix: BrandProfileLike | null = brand;

  const handleRestyle = useCallback(() => {
    summon({
      mode: asset.mode,
      intent: intent ?? null,
      hasBrand: Boolean(brand),
      brandName: brand?.name ?? null,
      onConfirm: (selection: GallerySelection) => {
        const targetId = restyleTargetId(selection);
        if (!targetId) return;
        onReseed(buildRestylePrompt(asset, targetId, brandForRemix));
      },
    });
  }, [summon, asset, intent, brand, brandForRemix, onReseed]);

  return useMemo<AppViewerRemix | undefined>(
    () =>
      assetName != null
        ? {
            asset,
            brand: brandForRemix,
            onReseed,
            onRestyle: handleRestyle,
            onNewBrandKit,
            enableFanout,
          }
        : undefined,
    [
      assetName,
      asset,
      brandForRemix,
      onReseed,
      handleRestyle,
      onNewBrandKit,
      enableFanout,
    ],
  );
}
