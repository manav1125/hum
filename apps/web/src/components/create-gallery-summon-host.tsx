/**
 * Create Studio — gallery summon host.
 *
 * A single, app-level mount that renders `CreateGalleryOverlay` whenever the
 * `create-gallery-summon-store` holds an active request. This is the bridge
 * that lets the chat-hosted remix cluster's **Restyle** action reopen the
 * gallery over a chat asset without the chat domain importing the create
 * domain: chat pushes a request into the shared store; this host (which is a
 * top-level `components/` file, so it CAN import the create overlay) renders it
 * and routes the confirmed selection back through the request's `onConfirm`.
 *
 * Mounted once at the app root (`RootLayout`) so it overlays whatever surface
 * is active. Renders nothing when no request is pending.
 */

import { useCallback } from "react";

import {
  CreateGalleryOverlay,
  type GallerySelection,
} from "@/domains/create/create-gallery-overlay";
import { useActiveBrand } from "@/domains/create/use-active-brand";
import { useCreateGallerySummonStore } from "@/stores/create-gallery-summon-store";

export function CreateGallerySummonHost() {
  const request = useCreateGallerySummonStore.use.request();
  const dismiss = useCreateGallerySummonStore.use.dismiss();
  // Resolve the active brand here so the gallery can label its live preview and
  // default the "In your brand" toggle even when the caller didn't pass a name.
  const { brand } = useActiveBrand();

  const handleConfirm = useCallback(
    (selection: GallerySelection) => {
      const req = useCreateGallerySummonStore.getState().request;
      // Clear first so the overlay unmounts, then hand the selection back.
      dismiss();
      req?.onConfirm(selection);
    },
    [dismiss],
  );

  if (!request) return null;

  const hasBrand = request.hasBrand || Boolean(brand);
  const brandName = request.brandName ?? brand?.name ?? null;
  // Default the brand toggle on when the asset's origin intent carried a kit.
  const initialInBrand = request.intent?.brandKitId != null;

  return (
    <CreateGalleryOverlay
      mode={request.mode}
      hasBrand={hasBrand}
      brandName={brandName}
      initialInBrand={initialInBrand}
      onConfirm={handleConfirm}
      onTakeAiDirection={dismiss}
      onClose={dismiss}
    />
  );
}
