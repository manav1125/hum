/**
 * Create Studio — gallery summon store.
 *
 * The gallery overlay (`CreateGalleryOverlay`, "Pick a look") lives in the
 * `create` domain and is normally opened from the Create surface. The remix
 * cluster's **Restyle** action, however, rides UNDER a generated asset in the
 * chat-hosted app viewer — a different domain that can't reach into `create` to
 * summon the overlay directly (the `no-cross-domain-imports` rule).
 *
 * This store is the app-level bridge: a caller (the chat viewer wiring, via the
 * shared `AppViewerRemix.onRestyle` handler) requests "open the gallery for
 * mode X, seeded from this asset's provenance", and a single top-level host
 * (`components/create-gallery-summon-host.tsx`) — which CAN import the create
 * overlay because it's not inside a domain folder — renders it. On confirm the
 * host invokes the request's `onConfirm(selection)`, which the caller turns into
 * a restyle re-seed via the existing `?prompt=` path.
 *
 * Keeping the request (mode + provenance + brand context + callbacks) in a
 * top-level store means neither domain imports the other; they communicate
 * through this shared surface. `GallerySelection` is imported here purely as a
 * type, which is allowed because this file is not inside a domain folder.
 *
 * Reference: {@link https://zustand.docs.pmnd.rs/}
 */

import { create } from "zustand";

import type { CreateIntent } from "@/domains/create/create-intent";
import type { GallerySelection } from "@/domains/create/create-gallery-overlay";
import { createSelectors } from "@/utils/create-selectors";

/** An active request to open the gallery over some host surface. */
export interface GallerySummonRequest {
  /** The Create mode the gallery opens in (slides / images / docs / …). */
  mode: string;
  /**
   * The asset's origin intent, so the gallery can seed its brand toggle (and,
   * in future, pre-select the prior template). Optional — absent → neutral.
   */
  intent?: CreateIntent | null;
  /** Whether an active Brand Kit exists (enables the "In your brand" toggle). */
  hasBrand: boolean;
  /** The active brand's display name (labels the in-gallery preview). */
  brandName?: string | null;
  /** Confirm — the picked selection rides back to the caller. */
  onConfirm: (selection: GallerySelection) => void;
}

interface GallerySummonState {
  /** The active summon request, or null when the gallery is not summoned. */
  request: GallerySummonRequest | null;
}

interface GallerySummonActions {
  /** Open the gallery with `request` (replaces any prior one). */
  summon: (request: GallerySummonRequest) => void;
  /** Dismiss the summoned gallery without confirming. */
  dismiss: () => void;
}

type GallerySummonStore = GallerySummonState & GallerySummonActions;

const useCreateGallerySummonStoreBase = create<GallerySummonStore>()((set) => ({
  request: null,
  summon: (request) => set({ request }),
  dismiss: () => set({ request: null }),
}));

export const useCreateGallerySummonStore = createSelectors(
  useCreateGallerySummonStoreBase,
);
