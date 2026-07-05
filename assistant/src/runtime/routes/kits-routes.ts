/**
 * Route handlers for Create Studio's fan-out KITS — a coordinated single-pass
 * asset kit (one brief → deck + one-pager + social set + … produced together
 * and tracked as a set). POST launches the kit (one background generation per
 * format, each seeded with the shared brief + design-contract + brand); GET
 * reports the status of all assets; the regenerate route re-runs one asset
 * without touching the rest.
 *
 * Registered SCOPE-LESS (`kits`); the spec transform + gateway wrap the
 * `/assistants/{id}` scope around them — matching the agents / brand-profiles
 * convention. `:kid` is the kit id, `:aid` the asset id. Auth is enforced at
 * the transport layer; handlers contain only business logic and throw
 * RouteError subclasses.
 */

import { z } from "zod";

import { getBrandProfile } from "../../brand/brand-profile-store.js";
import {
  launchKit,
  regenerateAsset,
  resolveFormatMode,
} from "../../create/kit-orchestrator.js";
import {
  createKit,
  getKitAsset,
  getKitWithAssets,
} from "../../create/kit-store.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import type { RouteDefinition } from "./types.js";

/**
 * The daemon is single-assistant: gateway-proxied routes are registered
 * SCOPE-LESS and the spec transform + gateway add/strip the `/assistants/{id}`
 * scope around them (see brand-routes / agents-routes for the same
 * convention). The stores are therefore scoped to this one constant.
 */
const KIT_SCOPE = "default";

const kitAssetSchema = z.object({
  id: z.string(),
  kitId: z.string(),
  format: z.string(),
  mode: z.string(),
  conversationId: z.string().nullable(),
  status: z.enum(["pending", "running", "done", "failed"]),
  outputRef: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

const kitSchema = z.object({
  id: z.string(),
  assistantId: z.string(),
  brief: z.string(),
  brandKitId: z.string().nullable(),
  contractPreamble: z.string().nullable(),
  title: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  assets: z.array(kitAssetSchema),
});

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "createKit",
    endpoint: "kits",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Launch a fan-out kit",
    description:
      "Create + launch a coordinated asset kit: one background generation per format, each seeded with the SAME brief + compiled design-contract + active brand so the whole set reads as one launch. Fire-and-forget — returns the tracked set immediately; poll GET kits/{kid} for per-asset status. Each format maps to a Create mode/skill (deck→app-builder, one-pager/email/doc→document-editor, social→image, landing→canvas).",
    tags: ["create"],
    requestBody: z.object({
      brief: z
        .string()
        .min(1)
        .describe("The shared source brief for every asset"),
      formats: z
        .array(z.string().min(1))
        .min(1)
        .describe(
          "Fan-out format ids: 'slides' | 'one_pager' | 'social' | 'email' | 'landing'. Each becomes one tracked asset.",
        ),
      brandKitId: z
        .string()
        .nullable()
        .optional()
        .describe("Brand profile id applied to every asset; null = un-branded"),
      contractPreamble: z
        .string()
        .nullable()
        .optional()
        .describe(
          "The compiled design-contract block prepended to every asset's seed (from create-intent.ts).",
        ),
      title: z.string().nullable().optional(),
    }),
    responseStatus: "201",
    responseBody: z.object({ kit: kitSchema }),
    handler: ({ body }) => {
      const b = (body ?? {}) as {
        brief?: string;
        formats?: string[];
        brandKitId?: string | null;
        contractPreamble?: string | null;
        title?: string | null;
      };
      const brief = typeof b.brief === "string" ? b.brief.trim() : "";
      if (!brief) throw new BadRequestError("brief is required");
      const formatIds = Array.isArray(b.formats)
        ? b.formats.filter(
            (f): f is string => typeof f === "string" && !!f.trim(),
          )
        : [];
      if (formatIds.length === 0) {
        throw new BadRequestError("formats must be a non-empty array");
      }

      // Validate the brand kit up front so a bad id fails the launch loudly
      // rather than silently producing an un-branded set.
      if (b.brandKitId) {
        const brand = getBrandProfile(b.brandKitId);
        if (!brand || brand.assistantId !== KIT_SCOPE) {
          throw new BadRequestError(`Brand profile not found: ${b.brandKitId}`);
        }
      }

      const kit = createKit(KIT_SCOPE, {
        brief,
        brandKitId: b.brandKitId ?? null,
        contractPreamble: b.contractPreamble ?? null,
        title: b.title ?? null,
        formats: formatIds.map((format) => ({
          format,
          mode: resolveFormatMode(format),
        })),
      });

      // Kick off the background generations; the assets come back `pending`
      // and transition as their runs progress (observed via GET / SSE).
      launchKit(kit.id);

      return { kit };
    },
  },

  {
    operationId: "getKit",
    endpoint: "kits/:kid",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get a kit + all asset statuses",
    description:
      "The kit and every asset in it, with each asset's current status (pending | running | done | failed), run conversation, and produced output ref.",
    tags: ["create"],
    responseBody: z.object({ kit: kitSchema }),
    handler: ({ pathParams }) => {
      const kit = getKitWithAssets(pathParams!.kid);
      if (!kit || kit.assistantId !== KIT_SCOPE) {
        throw new NotFoundError(`Kit not found: ${pathParams!.kid}`);
      }
      return { kit };
    },
  },

  {
    operationId: "regenerateKitAsset",
    endpoint: "kits/:kid/assets/:aid/regenerate",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Regenerate one kit asset",
    description:
      "Re-run a single asset in a fresh background generation without touching the rest of the kit. Fire-and-forget — the asset resets to `pending` and transitions as the new run progresses.",
    tags: ["create"],
    responseBody: z.object({ asset: kitAssetSchema }),
    handler: ({ pathParams }) => {
      const kit = getKitWithAssets(pathParams!.kid);
      if (!kit || kit.assistantId !== KIT_SCOPE) {
        throw new NotFoundError(`Kit not found: ${pathParams!.kid}`);
      }
      const asset = kit.assets.find((a) => a.id === pathParams!.aid);
      if (!asset) {
        throw new NotFoundError(`Kit asset not found: ${pathParams!.aid}`);
      }
      regenerateAsset(pathParams!.kid, pathParams!.aid);
      // Return the freshly-reset asset so the client can reflect it immediately.
      const reset = getKitAsset(pathParams!.aid) ?? asset;
      return { asset: reset };
    },
  },
];
