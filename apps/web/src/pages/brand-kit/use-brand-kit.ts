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

export type BrandProfile = BrandprofilesGetResponse["brandProfiles"][number];
export type BrandDraft = BrandprofilesExtractPostResponse["draft"];

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

// ---------------------------------------------------------------------------
// Extraction outcome — the signal that says whether a draft means anything.
// ---------------------------------------------------------------------------

/** Mirrors `BrandExtractionStatus` in assistant/src/brand/brand-extract-job.ts. */
export type BrandExtractionStatus =
  "extracted" | "empty" | "unreachable" | "blocked" | "unreadable" | "disabled";

export interface BrandExtraction {
  status: BrandExtractionStatus;
  detail: string;
}

const EXTRACTION_STATUSES = new Set<string>([
  "extracted",
  "empty",
  "unreachable",
  "blocked",
  "unreadable",
  "disabled",
]);

/** `true` only when the draft's values were actually observed on the source. */
export function extractionSucceeded(e: BrandExtraction): boolean {
  return e.status === "extracted";
}

/** Does this draft carry any observed brand value at all? (name doesn't count) */
function draftHasSignal(draft: BrandDraft | null | undefined): boolean {
  const filled = (o: object | undefined) =>
    Object.values(o ?? {}).some(
      (v) =>
        (typeof v === "string" && v.trim().length > 0) ||
        (Array.isArray(v) && v.length > 0),
    );
  return (
    filled(draft?.palette) ||
    filled(draft?.fonts) ||
    filled(draft?.logo) ||
    filled(draft?.voice)
  );
}

/**
 * Read the extraction outcome off the extract response.
 *
 * The daemon returns `extraction` as a sibling of `draft` (declared in
 * `assistant/openapi.yaml`, so the generated client carries it). This still
 * reads it structurally because the web app can be talking to a daemon on an
 * older release, where the field simply won't be there.
 *
 * When it's absent the outcome is INFERRED from the draft rather than assumed
 * successful: a draft with no brand values in it is reported as `empty`, so
 * the failure paths stay honest against an old daemon too.
 */
export function readExtraction(res: unknown): BrandExtraction {
  const body = (res ?? {}) as {
    draft?: BrandDraft;
    extraction?: { status?: unknown; detail?: unknown };
  };
  const raw = body.extraction;
  if (
    raw &&
    typeof raw.status === "string" &&
    EXTRACTION_STATUSES.has(raw.status)
  ) {
    return {
      status: raw.status as BrandExtractionStatus,
      detail:
        typeof raw.detail === "string" && raw.detail.trim()
          ? raw.detail
          : FALLBACK_DETAIL[raw.status as BrandExtractionStatus],
    };
  }
  return draftHasSignal(body.draft)
    ? { status: "extracted", detail: FALLBACK_DETAIL.extracted }
    : { status: "empty", detail: FALLBACK_DETAIL.empty };
}

const FALLBACK_DETAIL: Record<BrandExtractionStatus, string> = {
  extracted: "Read the brand signal from your source.",
  empty: "Nothing brand-like was found — no colours, type, logo or voice.",
  unreachable: "That source couldn't be loaded.",
  blocked: "That address couldn't be resolved or fetched.",
  unreadable: "That file couldn't be read.",
  disabled: "Brand extraction is turned off on this instance.",
};

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
    mutationFn: async (
      file: File,
    ): Promise<{ draft: BrandDraft; extraction: BrandExtraction }> => {
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
      return {
        draft: extracted.data.draft,
        extraction: readExtraction(extracted.data),
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Draft → editable input coercion.
// ---------------------------------------------------------------------------

/**
 * Coerce a draft/profile into the editable review shape.
 *
 * A missing colour stays MISSING. This used to spread a hardcoded
 * `DEFAULT_PALETTE` (a blue/teal/ink five-slot set) underneath the extracted
 * one, so any extraction that returned nothing — an unreachable site, a
 * blocked host, no LLM configured — arrived at the review screen wearing a
 * complete, plausible, and *identical* palette. Two different domains produced
 * the same brand kit, and "Save & apply everywhere" then wrote that invention
 * to every Create output. Rendering an absent value is the surfaces' problem
 * to solve honestly; inventing one here is not a solution.
 */
export function toBrandInput(
  source: Partial<BrandProfile> | BrandDraft | null,
  fallbackName = "Untitled brand",
): BrandProfileInput {
  const palette: BrandPalette = { ...(source?.palette ?? {}) };
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
