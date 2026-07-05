/**
 * Route handlers for the Brand Kit registry — the stored per-assistant brand
 * identities behind Create Studio (Layer 2). Full CRUD plus an activate toggle
 * (single-active-per-assistant, enforced in the store) and a stateless
 * `extract` endpoint that turns an upload/website into a draft BrandProfile the
 * review screen can accept.
 *
 * Registered SCOPE-LESS (`brand-profiles`); the spec transform + gateway wrap
 * the `/assistants/{id}` scope around them. `:bid` is the brand-profile id.
 * Auth is enforced at the transport layer; handlers contain only business
 * logic and throw RouteError subclasses.
 */

import { z } from "zod";

import {
  extractFromDocument,
  extractFromWebsite,
} from "../../brand/brand-extract-job.js";
import {
  createBrandProfile,
  deleteBrandProfile,
  getBrandProfile,
  listBrandProfiles,
  setActiveBrandProfile,
  updateBrandProfile,
} from "../../brand/brand-profile-store.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import type { RouteDefinition } from "./types.js";

const paletteSchema = z
  .object({
    primary: z.string().optional(),
    accent: z.string().optional(),
    bg: z.string().optional(),
    surface: z.string().optional(),
    text: z.string().optional(),
  })
  .passthrough();

const fontsSchema = z.object({
  heading: z.string().optional(),
  body: z.string().optional(),
});

const logoSchema = z.object({
  light: z.string().optional(),
  dark: z.string().optional(),
  mark: z.string().optional(),
});

const voiceSchema = z.object({
  tone: z.string().optional(),
  doList: z.array(z.string()).optional(),
  dontList: z.array(z.string()).optional(),
  boilerplate: z.string().optional(),
});

const sourceSchema = z.enum(["upload", "website", "guided"]);

const brandProfileSchema = z.object({
  id: z.string(),
  assistantId: z.string(),
  name: z.string(),
  palette: paletteSchema,
  fonts: fontsSchema,
  logo: logoSchema,
  voice: voiceSchema,
  assets: z.array(z.string()),
  source: sourceSchema,
  isActive: z.number().int().describe("0/1 — the kit applied everywhere"),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

/** Narrow an arbitrary body value into the store's input shape. */
function readProfileInput(body: unknown): {
  name?: string;
  palette?: Record<string, string | undefined>;
  fonts?: { heading?: string; body?: string };
  logo?: { light?: string; dark?: string; mark?: string };
  voice?: {
    tone?: string;
    doList?: string[];
    dontList?: string[];
    boilerplate?: string;
  };
  assets?: string[];
  source?: "upload" | "website" | "guided";
} {
  return (body ?? {}) as ReturnType<typeof readProfileInput>;
}

/**
 * The daemon is single-assistant: gateway-proxied routes are registered
 * SCOPE-LESS (e.g. `brand-profiles`), and the spec transform + gateway add and
 * strip the `/assistants/{id}` scope around them (see agents-routes for the
 * same convention). The handler therefore has no assistant id in its path, so
 * the store is scoped to this one constant. (Earlier this route was wrongly
 * registered as `assistants/:id/brand-profiles`, which double-scoped the
 * client path and 404'd on the stripped daemon path.)
 */
const BRAND_SCOPE = "default";

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "listBrandProfiles",
    endpoint: "brand-profiles",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List brand profiles",
    description:
      "Every saved Brand Kit for the assistant (palette, fonts, logo, voice, assets, source), oldest first. At most one carries isActive=1 — the kit applied to every Create output.",
    tags: ["brand"],
    responseBody: z.object({ brandProfiles: z.array(brandProfileSchema) }),
    handler: () => ({
      brandProfiles: listBrandProfiles(BRAND_SCOPE),
    }),
  },

  {
    operationId: "createBrandProfile",
    endpoint: "brand-profiles",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Save a brand profile",
    description:
      "Persist a Brand Kit for the assistant. The assistant's first profile is made active automatically; later ones start inactive.",
    tags: ["brand"],
    requestBody: z.object({
      name: z.string().min(1),
      palette: paletteSchema.optional(),
      fonts: fontsSchema.optional(),
      logo: logoSchema.optional(),
      voice: voiceSchema.optional(),
      assets: z.array(z.string()).optional(),
      source: sourceSchema.optional(),
    }),
    responseStatus: "201",
    responseBody: z.object({ brandProfile: brandProfileSchema }),
    handler: ({ body }) => {
      const b = readProfileInput(body);
      const name = typeof b.name === "string" ? b.name.trim() : "";
      if (!name) throw new BadRequestError("name is required");
      const brandProfile = createBrandProfile(BRAND_SCOPE, {
        name,
        ...(b.palette ? { palette: b.palette } : {}),
        ...(b.fonts ? { fonts: b.fonts } : {}),
        ...(b.logo ? { logo: b.logo } : {}),
        ...(b.voice ? { voice: b.voice } : {}),
        ...(b.assets ? { assets: b.assets } : {}),
        ...(b.source ? { source: b.source } : {}),
      });
      return { brandProfile };
    },
  },

  {
    operationId: "extractBrandProfile",
    endpoint: "brand-profiles/extract",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Extract a draft brand profile",
    description:
      "Turn an upload (attachment id) or website (url) into a DRAFT brand profile via a flash-LLM pass — palette, fonts, logo, voice. The draft is NOT persisted; POST it back to create once reviewed. Honest limits: binary PDF/PPTX text isn't parsed, and website extraction is static-HTML-only (no headless browser).",
    tags: ["brand"],
    requestBody: z.object({
      source: z.enum(["upload", "website"]),
      ref: z
        .string()
        .min(1)
        .describe("Attachment id (upload) or page URL (website)"),
    }),
    responseBody: z.object({ draft: brandProfileSchema.partial() }),
    handler: async ({ body }) => {
      const b = (body ?? {}) as { source?: string; ref?: string };
      const ref = typeof b.ref === "string" ? b.ref.trim() : "";
      if (!ref) throw new BadRequestError("ref is required");
      if (b.source === "upload") {
        return { draft: await extractFromDocument(ref) };
      }
      if (b.source === "website") {
        return { draft: await extractFromWebsite(ref) };
      }
      throw new BadRequestError('source must be "upload" or "website"');
    },
  },

  {
    operationId: "getBrandProfile",
    endpoint: "brand-profiles/:bid",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get a brand profile",
    tags: ["brand"],
    responseBody: z.object({ brandProfile: brandProfileSchema }),
    handler: ({ pathParams }) => {
      const brandProfile = getBrandProfile(pathParams!.bid);
      if (!brandProfile || brandProfile.assistantId !== BRAND_SCOPE) {
        throw new NotFoundError(`Brand profile not found: ${pathParams!.bid}`);
      }
      return { brandProfile };
    },
  },

  {
    operationId: "updateBrandProfile",
    endpoint: "brand-profiles/:bid",
    method: "PATCH",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Update a brand profile",
    description:
      "Patch name / palette / fonts / logo / voice / assets / source. To change which kit is active use the activate endpoint (single-active invariant).",
    tags: ["brand"],
    requestBody: z
      .object({
        name: z.string().min(1),
        palette: paletteSchema,
        fonts: fontsSchema,
        logo: logoSchema,
        voice: voiceSchema,
        assets: z.array(z.string()),
        source: sourceSchema,
      })
      .partial(),
    responseBody: z.object({ brandProfile: brandProfileSchema }),
    handler: ({ pathParams, body }) => {
      const existing = getBrandProfile(pathParams!.bid);
      if (!existing || existing.assistantId !== BRAND_SCOPE) {
        throw new NotFoundError(`Brand profile not found: ${pathParams!.bid}`);
      }
      const b = readProfileInput(body);
      const updates: Parameters<typeof updateBrandProfile>[1] = {};
      if (b.name !== undefined) {
        const name = b.name.trim();
        if (!name) throw new BadRequestError("name cannot be empty");
        updates.name = name;
      }
      if (b.palette !== undefined) updates.palette = b.palette;
      if (b.fonts !== undefined) updates.fonts = b.fonts;
      if (b.logo !== undefined) updates.logo = b.logo;
      if (b.voice !== undefined) updates.voice = b.voice;
      if (b.assets !== undefined) updates.assets = b.assets;
      if (b.source !== undefined) updates.source = b.source;
      const brandProfile = updateBrandProfile(pathParams!.bid, updates);
      return { brandProfile };
    },
  },

  {
    operationId: "deleteBrandProfile",
    endpoint: "brand-profiles/:bid",
    method: "DELETE",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Delete a brand profile",
    tags: ["brand"],
    responseBody: z.object({ id: z.string(), success: z.boolean() }),
    handler: ({ pathParams }) => {
      const existing = getBrandProfile(pathParams!.bid);
      if (!existing || existing.assistantId !== BRAND_SCOPE) {
        throw new NotFoundError(`Brand profile not found: ${pathParams!.bid}`);
      }
      deleteBrandProfile(pathParams!.bid);
      return { id: pathParams!.bid, success: true };
    },
  },

  {
    operationId: "activateBrandProfile",
    endpoint: "brand-profiles/:bid/activate",
    method: "PATCH",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Activate a brand profile",
    description:
      "Make this the assistant's active Brand Kit (applied to every Create output), clearing the flag on the assistant's other profiles in the same transaction.",
    tags: ["brand"],
    responseBody: z.object({ brandProfile: brandProfileSchema }),
    handler: ({ pathParams }) => {
      const existing = getBrandProfile(pathParams!.bid);
      if (!existing || existing.assistantId !== BRAND_SCOPE) {
        throw new NotFoundError(`Brand profile not found: ${pathParams!.bid}`);
      }
      const brandProfile = setActiveBrandProfile(pathParams!.bid);
      return { brandProfile };
    },
  },
];
