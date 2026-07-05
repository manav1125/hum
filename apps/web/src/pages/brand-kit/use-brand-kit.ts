/**
 * Data hooks for the Brand Kit surfaces — thin wrappers over the generated
 * daemon SDK, kept local so the brand-kit dir stays self-contained (no
 * dependency on other page/domain module graphs).
 *
 * Backend (daemon, already built):
 *   GET  /v1/assistants/:id/brand-profiles              — list
 *   POST /v1/assistants/:id/brand-profiles              — create (first = active)
 *   GET  /v1/assistants/:id/brand-profiles/:bid         — one
 *   PATCH .../:bid                                       — update
 *   DELETE .../:bid                                      — delete
 *   PATCH .../:bid/activate                              — make active
 *   POST .../extract                                     — draft from upload/website
 *
 * The generated path shape is `{ assistant_id, id }` — the platform gateway
 * injects `assistant_id`, and the spec's own `{id}` is the same assistant id.
 * Both carry the active assistant id.
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";

import {
  brandprofilesGetOptions,
  brandprofilesGetQueryKey,
  brandprofilesPostMutation,
  brandprofilesByBidPatchMutation,
  brandprofilesByBidDeleteMutation,
  brandprofilesByBidActivatePatchMutation,
  brandprofilesExtractPostMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import {
  attachmentsPost,
  brandprofilesExtractPost,
} from "@/generated/daemon/sdk.gen";
import type {
  BrandprofilesGetResponse,
  BrandprofilesExtractPostResponse,
} from "@/generated/daemon/types.gen";

// ---------------------------------------------------------------------------
// Types — one saved Brand Kit + the palette/font/logo/voice sub-shapes.
// ---------------------------------------------------------------------------

export type BrandProfile =
  BrandprofilesGetResponse["brandProfiles"][number];
export type BrandDraft =
  BrandprofilesExtractPostResponse["draft"];

export type BrandPalette = BrandProfile["palette"];
export type BrandFonts = BrandProfile["fonts"];
export type BrandLogo = BrandProfile["logo"];
export type BrandVoice = BrandProfile["voice"];
export type BrandSource = BrandProfile["source"];

/** The editable body carried through the review screen and POST/PATCH calls. */
export interface BrandProfileInput {
  name: string;
  palette: BrandPalette;
  fonts: BrandFonts;
  logo: BrandLogo;
  voice: BrandVoice;
  assets: string[];
  source?: BrandSource;
}

/** Path both the gateway `assistant_id` and the spec `{id}` resolve to. */
function brandPath(assistantId: string) {
  return { assistant_id: assistantId };
}

function invalidateList(queryClient: QueryClient, assistantId: string) {
  return queryClient.invalidateQueries({
    queryKey: brandprofilesGetQueryKey({
      path: brandPath(assistantId),
    }),
  });
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export function useBrandProfiles(assistantId: string) {
  const query = useQuery({
    ...brandprofilesGetOptions({ path: brandPath(assistantId) }),
    staleTime: 30_000,
  });
  const profiles = query.data?.brandProfiles ?? [];
  return {
    profiles,
    active: profiles.find((p) => p.isActive === 1) ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

// ---------------------------------------------------------------------------
// Mutations — create / update / delete / activate
// ---------------------------------------------------------------------------

export function useCreateBrandProfile(assistantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    ...brandprofilesPostMutation(),
    onSettled: () => void invalidateList(queryClient, assistantId),
  });
}

export function useUpdateBrandProfile(assistantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    ...brandprofilesByBidPatchMutation(),
    onSettled: () => void invalidateList(queryClient, assistantId),
  });
}

export function useDeleteBrandProfile(assistantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    ...brandprofilesByBidDeleteMutation(),
    onSettled: () => void invalidateList(queryClient, assistantId),
  });
}

export function useActivateBrandProfile(assistantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    ...brandprofilesByBidActivatePatchMutation(),
    onSettled: () => void invalidateList(queryClient, assistantId),
  });
}

/** Extract a DRAFT profile from a website URL (not persisted). */
export function useExtractBrandProfile() {
  return useMutation({
    ...brandprofilesExtractPostMutation(),
  });
}

/**
 * Upload path: two-step — POST the file as an attachment, then hand its id to
 * the extract route. Returns the draft profile for the review screen.
 */
export function useExtractFromUpload(assistantId: string) {
  return useMutation({
    mutationFn: async (file: File): Promise<BrandDraft> => {
      const uploaded = await attachmentsPost({
        path: { assistant_id: assistantId },
        body: {
          file,
          filename: file.name,
          mimeType: file.type || "application/octet-stream",
        },
        throwOnError: true,
      });
      const extracted = await brandprofilesExtractPost({
        path: brandPath(assistantId),
        body: { source: "upload", ref: uploaded.data.id },
        throwOnError: true,
      });
      return extracted.data.draft;
    },
  });
}

// ---------------------------------------------------------------------------
// Draft → editable input coercion. The draft/profile sub-objects are optional
// per field; the review screen wants concrete defaults to render swatches and
// specimens without holes.
// ---------------------------------------------------------------------------

const DEFAULT_PALETTE: Required<Pick<BrandPalette, never>> & BrandPalette = {
  primary: "#5B7CFA",
  accent: "#1F9E8F",
  bg: "#0E1116",
  surface: "#F4F1EA",
  text: "#12161C",
};

export function toBrandInput(
  source: Partial<BrandProfile> | BrandDraft | null,
  fallbackName = "Untitled brand",
): BrandProfileInput {
  const palette = { ...DEFAULT_PALETTE, ...(source?.palette ?? {}) };
  return {
    name: source?.name?.trim() || fallbackName,
    palette,
    fonts: {
      heading: source?.fonts?.heading ?? "",
      body: source?.fonts?.body ?? "",
    },
    logo: {
      light: source?.logo?.light ?? "",
      dark: source?.logo?.dark ?? "",
      mark: source?.logo?.mark ?? "",
    },
    voice: {
      tone: source?.voice?.tone ?? "",
      doList: source?.voice?.doList ?? [],
      dontList: source?.voice?.dontList ?? [],
      boilerplate: source?.voice?.boilerplate ?? "",
    },
    assets: source?.assets ?? [],
    source: source?.source,
  };
}

export const brandKitPath = brandPath;
