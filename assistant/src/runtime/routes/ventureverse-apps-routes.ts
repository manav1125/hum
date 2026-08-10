/**
 * VentureVerse apps — the catalog behind the embedded VentureVerse app store
 * (the web "Apps" sidebar surface, `ventureverse-apps` feature flag).
 *
 * GET /v1/ventureverse-apps — the catalog of VentureVerse apps, fetched
 * server-side from ventureverse.com's public catalog API and cached in the
 * workspace (`ventureverse-apps-cache.json`, 24h TTL). When ventureverse.com
 * is unreachable the route falls back to a static curated snapshot of the
 * catalog so the surface always renders. 404s while the feature flag is off
 * (the marketplace pattern) so the disabled state has zero side effects.
 *
 * VentureVerse is Cue's parent-org app store (24 founder-focused AI apps —
 * same org as the `com.ventureverse.cue` iOS bundle id). The web surface
 * embeds `www.ventureverse.com/apps?launch=<slug>` in an iframe; users sign
 * into VentureVerse inside the frame, and no Cue credentials cross the
 * boundary. `appUrl` (the per-app deployment VentureVerse itself iframes) is
 * carried through for the planned direct-embed/token handoff phase but is not
 * what clients load today.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { isAssistantFeatureFlagEnabled } from "../../config/assistant-feature-flags.js";
import { getConfig } from "../../config/loader.js";
import { getLogger } from "../../util/logger.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("ventureverse-apps");

export const VENTUREVERSE_APPS_FLAG_KEY = "ventureverse-apps";

const CATALOG_API = "https://www.ventureverse.com/api/v1/apps";
export const VENTUREVERSE_ORIGIN = "https://www.ventureverse.com";
/** Catalog cache TTL — the app list moves slowly. */
const CATALOG_TTL_MS = 24 * 60 * 60_000;
const CACHE_FILENAME = "ventureverse-apps-cache.json";
/** Hard page cap so a misbehaving `has_next` can never loop forever. */
const MAX_PAGES = 10;

export interface VentureverseApp {
  /** VentureVerse's numeric app id. */
  id: number;
  name: string;
  /**
   * The launch slug VentureVerse's shell uses: `<id>-<kebab-name>`
   * (e.g. `10-alchemy`). Clients embed
   * `${VENTUREVERSE_ORIGIN}/apps?launch=<slug>` — `launchUrl` below is that
   * URL prebuilt so no client re-derives it.
   */
  slug: string;
  category: string;
  description: string;
  /** App icon off assets.ventureverse.com. Clients degrade to a monogram. */
  iconUrl?: string;
  /**
   * The app's own deployment origin (what VentureVerse's shell iframes with a
   * short-lived `iframe_token`). Not loaded by clients today — kept for the
   * direct-embed phase.
   */
  appUrl?: string;
  /** The URL clients embed: the VentureVerse shell launching this app. */
  launchUrl: string;
}

/** `Market Sizing Calculator` → `market-sizing-calculator`. */
function kebab(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function launchSlug(id: number, name: string): string {
  return `${id}-${kebab(name)}`;
}

function launchUrl(slug: string): string {
  return `${VENTUREVERSE_ORIGIN}/apps?launch=${slug}`;
}

// ---------------------------------------------------------------------------
// Curated fallback — a static snapshot of the live catalog (2026-08-10), used
// when ventureverse.com is unreachable and no cache exists yet. Descriptions
// are trimmed; the live API carries the full copy.
// ---------------------------------------------------------------------------

type CatalogEntry = Omit<VentureverseApp, "slug" | "launchUrl">;

const CURATED_APPS: ReadonlyArray<CatalogEntry> = [
  {
    id: 10,
    name: "Alchemy",
    category: "Legal",
    description:
      "Drop your legal agreement and get a clause-by-clause breakdown: what is standard, what is risky, and exactly how to negotiate.",
    iconUrl:
      "https://assets.ventureverse.com/apps/10/icons/92f516a6-2038-4fce-95fb-e66a5b1c38af--.png",
    appUrl: "https://alchemy-legal.vercel.app/",
  },
  {
    id: 30,
    name: "Fundraising Readiness",
    category: "Fundraising Strategy",
    description:
      "Fundraising Readiness is a tool that helps startup founders understand whether they are ready to pitch investors.",
    iconUrl:
      "https://assets.ventureverse.com/apps/30/icons/5d2c28ec-032e-40e8-8462-435471648983--.png",
    appUrl: "https://fundraising-readiness-scorecard-pro.vercel.app/",
  },
  {
    id: 34,
    name: "Autopsy AI",
    category: "Business Strategy",
    description:
      "Autopsy AI writes the obituary your startup might earn. Upload a pitch deck and it produces a forward-dated pre-mortem built on live research.",
    iconUrl:
      "https://assets.ventureverse.com/apps/34/icons/8c027470-9a4c-4dc4-9daf-a89400858ae9--logo.png",
    appUrl: "https://autopsy-ai-prod.vercel.app",
  },
  {
    id: 28,
    name: "Risk Matrix",
    category: "Investment Strategy",
    description:
      "Risk Matrix is the risk layer for an investment team. Feed it a company URL or deck and get a defensible 5x5 risk matrix in minutes, with every score traceable to the evidence behind it.",
    iconUrl:
      "https://assets.ventureverse.com/apps/28/icons/28990079-5283-4b02-af87-dafbd3965cac--.png",
    appUrl: "https://risk-matrix-constructor.vercel.app/",
  },
  {
    id: 25,
    name: "Market Sizing Calculator",
    category: "Business Strategy",
    description:
      "Size the TAM, SAM, and SOM for anything in your category, with math an investor will actually trust.",
    iconUrl:
      "https://assets.ventureverse.com/apps/25/icons/ab4d51f5-6ba3-47ac-b639-a75d575fc441---250.png",
    appUrl: "https://market-sizing-calculator-iota.vercel.app/",
  },
  {
    id: 35,
    name: "Unit Economics Calculator",
    category: "Marketing Analytics",
    description:
      "Calculate CAC, LTV, payback period and gross margin from your raw numbers with live-updating charts, then benchmark every metric against real stage and industry data.",
    iconUrl:
      "https://assets.ventureverse.com/apps/35/icons/81c1b97e-2eb8-428b-9d3c-baa080057634--logo.png",
    appUrl: "https://unit-economics-calculator-prod.vercel.app/",
  },
  {
    id: 18,
    name: "Market match",
    category: "Fundraising Strategy",
    description:
      "Most founders waste months chasing VCs who were never going to invest: wrong stage, wrong sector, wrong thesis. MarketMatch fixes that.",
    iconUrl:
      "https://assets.ventureverse.com/apps/18/icons/df97d824-05ca-4489-bfed-a5cf49adb8a0-mm-logo-250.png",
    appUrl: "https://market-match-test.vercel.app",
  },
  {
    id: 17,
    name: "Deck Analysis",
    category: "Fundraising Strategy",
    description:
      "Upload your pitch deck and get institutional-grade analysis across 15 investment dimensions. Any format works: PDF, PPTX, DOCX, even image-heavy decks.",
    iconUrl:
      "https://assets.ventureverse.com/apps/17/icons/ac97ea45-1abd-4a1f-919c-2bca8d4c0414-deck-analysis-.png",
    appUrl: "https://deck-analysis.vercel.app",
  },
  {
    id: 33,
    name: "User Interview Analyser",
    category: "Business Strategy",
    description:
      "Turn customer interviews into clear, evidence-backed product decisions: collect interviews, extract key signals, and synthesize a cross-interview report.",
    iconUrl:
      "https://assets.ventureverse.com/apps/33/icons/a608004a-b4ff-46f4-868e-48405b431c42--.png",
    appUrl: "https://user-interview-analyser-prod.vercel.app/",
  },
  {
    id: 32,
    name: "Price Well",
    category: "Business Strategy",
    description:
      "Pricewell turns a company URL and an optional pitch deck into a complete, implementation-ready pricing architecture.",
    iconUrl:
      "https://assets.ventureverse.com/apps/32/icons/a6e8bdde-bd48-40ff-92c1-516a43066239--logo.png",
    appUrl: "https://pricing-strategy-prod.vercel.app/",
  },
  {
    id: 31,
    name: "Investor Update Generator",
    category: "Investor Updates",
    description:
      "Turn monthly startup metrics into investor updates people actually read — MRR, burn, runway, ARR and growth into a clear, board-ready narrative.",
    iconUrl:
      "https://assets.ventureverse.com/apps/31/icons/96787f82-41f8-4008-a8b7-64f70a244ee8-investor-chat-data-logo.png",
    appUrl: "https://investor-update-generator-prod.vercel.app/",
  },
  {
    id: 29,
    name: "Rolesmith",
    category: "Hiring",
    description:
      "An AI-powered recruiting asset generator that turns structured role inputs into complete, market-calibrated hiring packages.",
    iconUrl:
      "https://assets.ventureverse.com/apps/29/icons/7f6957e4-a123-4de3-b043-3eb1396475d8--.png",
    appUrl: "https://job-description-generator-prod.vercel.app/",
  },
  {
    id: 27,
    name: "Feature Matrix Builder",
    category: "Business Strategy",
    description:
      "Feature Matrix Builder turns a week of manual competitor research into a 90-second analyst brief.",
    iconUrl:
      "https://assets.ventureverse.com/apps/27/icons/f4b2a97a-02e2-4670-aa45-a57999b0f148-logo-250-square.png",
    appUrl: "https://feature-matrix-builder-prod.vercel.app/",
  },
  {
    id: 26,
    name: "Prep",
    category: "Sales Pipeline",
    description:
      "Prep gets you ready for a sales call in about 30 seconds: a company snapshot, a profile of who you are meeting, and a time-boxed call playbook.",
    iconUrl:
      "https://assets.ventureverse.com/apps/26/icons/33f42823-12f9-4c99-a24e-6593734d9da3-prep-logo-oval-gradient.png",
    appUrl: "https://sales-call-prep.vercel.app/",
  },
  {
    id: 24,
    name: "GTM Pricing Decoder",
    category: "Product Strategy",
    description:
      "Decode any company's pricing, positioning, and go-to-market strategy in under 90 seconds, with a full breakdown of how they sell and where the gaps are.",
    iconUrl:
      "https://assets.ventureverse.com/apps/24/icons/4ce1b3a4-78fe-45d1-af8e-f0f08b38d4b8--.png",
    appUrl: "https://gtm-pricing-decoder.vercel.app/",
  },
  {
    id: 23,
    name: "Meridian",
    category: "Finance",
    description:
      "Meridian does what a financial analyst does, in about two minutes: executive briefing, bankruptcy probability, earnings manipulation detection, and a 22-point due diligence checklist.",
    iconUrl:
      "https://assets.ventureverse.com/apps/23/icons/0d4683d7-8a4e-4352-9f79-582499219209-meridian-square-logo.png",
    appUrl: "https://meridian-zeta-steel.vercel.app/",
  },
  {
    id: 21,
    name: "ESOP Canvas",
    category: "Company Formation",
    description:
      "ESOP Canvas is the post-raise layer for equity: design it, value it, and communicate it clearly.",
    iconUrl:
      "https://assets.ventureverse.com/apps/21/icons/a17b6a1c-cc83-40f5-bc25-7f248a16a055-esop-canvas-logo-folded-e-9ddc.png",
    appUrl: "https://esop-canvas.replit.app/",
  },
  {
    id: 15,
    name: "Launchpad",
    category: "Market Positioning",
    description:
      "A marketing strategy without a CMO, an agency, or $10,000 for a consultant.",
    iconUrl:
      "https://assets.ventureverse.com/apps/15/icons/85b23535-f7a1-4de1-b4dc-47b6f74cc7ac--logo.png",
    appUrl: "https://launchpad-marketing.vercel.app/",
  },
  {
    id: 11,
    name: "Dealscope",
    category: "Fundraising Strategy",
    description:
      "Enter a company URL and get an Investment Committee-ready report: overview, comparables, valuation scenarios, competitive mapping, and investment thesis.",
    iconUrl:
      "https://assets.ventureverse.com/apps/11/icons/3e0220b0-670a-4fab-9261-d57d3c1d7e2d---250.png",
    appUrl: "https://dealscope.vercel.app/",
  },
  {
    id: 8,
    name: "LeadLexis",
    category: "Business Strategy",
    description:
      "Turn bare email addresses into complete company profiles with verified domains, industry classifications, employee counts, funding history, and tech stacks.",
    iconUrl:
      "https://assets.ventureverse.com/apps/8/icons/b1fb3ec3-3d1a-4405-bde6-e1cfef99b14c--logo-250.png",
    appUrl: "https://leadlexis.vercel.app/",
  },
  {
    id: 22,
    name: "Name Forge",
    category: "Culture Building",
    description:
      "Discover the perfect brand name, secure your domain instantly, and dodge reputation traps before they happen.",
    iconUrl:
      "https://assets.ventureverse.com/apps/22/icons/4c876cd1-624a-4851-aff0-f3b7afe9d23c-name-forge-logo-250.png",
    appUrl: "https://ai-name-forge.replit.app/",
  },
  {
    id: 16,
    name: "Term sheet Analyzer",
    category: "Legal",
    description:
      "Term-sheet drafting and review without the $2,000–$10,000 legal bill.",
    iconUrl:
      "https://assets.ventureverse.com/apps/16/icons/f24398d2-b466-428b-8afc-f7f1ce48c758-termsheet-coral-icon.png",
    appUrl: "https://brinc-termsheet-main.vercel.app/",
  },
  {
    id: 14,
    name: "Instagram Marketing",
    category: "Marketing Analytics",
    description:
      "Enter a product URL and target audience, and get a brand narrative, positioning, content pillars, key messages, and ready-to-use Instagram post concepts.",
    iconUrl:
      "https://assets.ventureverse.com/apps/14/icons/627671d2-5606-466f-a1bf-6b098c2840b2--.png",
    appUrl: "https://instagram-marketing-ai.vercel.app/",
  },
  {
    id: 13,
    name: "DiluViz",
    category: "Fundraising Strategy",
    description:
      "Design your funding rounds — valuations, round sizes, option pools — and instantly see how your stake holds up.",
    iconUrl:
      "https://assets.ventureverse.com/apps/13/icons/f9243c78-8130-4be6-8aad-362f9f5c392e-logo-.png",
    appUrl: "https://diluviz.replit.app/",
  },
] as const;

// ---------------------------------------------------------------------------
// Catalog — remote fetch with workspace-file + in-memory caching, curated
// fallback when unavailable. Same shape as connector-apps-routes.ts.
// ---------------------------------------------------------------------------

/** Bump when `CatalogEntry` gains fields so stale-shaped caches refetch. */
const CACHE_VERSION = 1;

interface CatalogCacheFile {
  version?: number;
  fetchedAt: number;
  apps: CatalogEntry[];
}

let catalogMemo: CatalogCacheFile | null = null;

function cachePath(): string | null {
  const ws = process.env.VELLUM_WORKSPACE_DIR;
  return ws ? join(ws, CACHE_FILENAME) : null;
}

function readCatalogCache(): CatalogCacheFile | null {
  if (catalogMemo) return catalogMemo;
  const path = cachePath();
  if (!path) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as CatalogCacheFile;
    if (
      raw.version === CACHE_VERSION &&
      typeof raw.fetchedAt === "number" &&
      Array.isArray(raw.apps) &&
      raw.apps.length > 0
    ) {
      catalogMemo = raw;
      return raw;
    }
  } catch {
    // No cache yet — fall through.
  }
  return null;
}

function writeCatalogCache(apps: CatalogEntry[]): void {
  const next: CatalogCacheFile = {
    version: CACHE_VERSION,
    fetchedAt: Date.now(),
    apps,
  };
  catalogMemo = next;
  const path = cachePath();
  if (!path) return;
  try {
    writeFileSync(path, JSON.stringify(next));
  } catch (err) {
    log.warn({ err }, "ventureverse-apps cache write failed");
  }
}

/** Parse one item of VentureVerse's `/api/v1/apps` — skip anything malformed. */
function parseApiItem(item: unknown): CatalogEntry | null {
  if (typeof item !== "object" || item === null) return null;
  const a = item as {
    id?: unknown;
    app_name?: unknown;
    description?: unknown;
    category?: { name?: unknown };
    icon_url?: unknown;
    app_url?: unknown;
    status?: unknown;
  };
  if (typeof a.id !== "number" || typeof a.app_name !== "string") return null;
  if (a.app_name.length === 0) return null;
  // Only active apps are launchable in the shell.
  if (typeof a.status === "string" && a.status !== "active") return null;
  return {
    id: a.id,
    name: a.app_name,
    category:
      typeof a.category?.name === "string" && a.category.name.length > 0
        ? a.category.name
        : "App",
    description: typeof a.description === "string" ? a.description : "",
    ...(typeof a.icon_url === "string" && a.icon_url.length > 0
      ? { iconUrl: a.icon_url }
      : {}),
    ...(typeof a.app_url === "string" && a.app_url.length > 0
      ? { appUrl: a.app_url }
      : {}),
  };
}

/** Fetch every page of the public catalog API. Throws on any failed page. */
async function fetchRemoteCatalog(): Promise<CatalogEntry[]> {
  const apps: CatalogEntry[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetch(`${CATALOG_API}?page=${page}`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`ventureverse catalog page ${page} -> ${res.status}`);
    }
    const data = (await res.json()) as {
      data?: { apps?: unknown[]; has_next?: unknown };
    };
    apps.push(
      ...(data.data?.apps ?? [])
        .map(parseApiItem)
        .filter((a): a is CatalogEntry => a !== null),
    );
    if (data.data?.has_next !== true) break;
  }
  return apps;
}

/**
 * The catalog: fresh cache → ventureverse.com (re-cache) → stale cache →
 * curated static snapshot. Never throws.
 */
async function loadCatalog(): Promise<{
  apps: CatalogEntry[];
  source: "remote" | "curated";
}> {
  const cached = readCatalogCache();
  if (cached && Date.now() - cached.fetchedAt < CATALOG_TTL_MS) {
    return { apps: cached.apps, source: "remote" };
  }
  try {
    const apps = await fetchRemoteCatalog();
    if (apps.length > 0) {
      writeCatalogCache(apps);
      return { apps, source: "remote" };
    }
  } catch (err) {
    log.warn({ err }, "ventureverse catalog fetch failed — using fallback");
  }
  // Stale cache beats the static snapshot; the snapshot beats nothing.
  if (cached) return { apps: cached.apps, source: "remote" };
  return { apps: [...CURATED_APPS], source: "curated" };
}

/** Test hook: drop the module memo so a test starts from a clean slate. */
export function resetVentureverseAppsMemoForTest(): void {
  catalogMemo = null;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

function assertVentureverseAppsEnabled(): void {
  if (!isAssistantFeatureFlagEnabled(VENTUREVERSE_APPS_FLAG_KEY, getConfig())) {
    throw new NotFoundError("VentureVerse apps are disabled");
  }
}

async function handleListVentureverseApps({
  queryParams = {},
}: RouteHandlerArgs) {
  assertVentureverseAppsEnabled();
  const { apps, source } = await loadCatalog();

  const query = (queryParams.query ?? "").trim().toLowerCase();
  const filtered = query
    ? apps.filter(
        (a) =>
          a.name.toLowerCase().includes(query) ||
          a.category.toLowerCase().includes(query) ||
          a.description.toLowerCase().includes(query),
      )
    : apps;

  return {
    source,
    origin: VENTUREVERSE_ORIGIN,
    apps: filtered.map((a): VentureverseApp => {
      const slug = launchSlug(a.id, a.name);
      return { ...a, slug, launchUrl: launchUrl(slug) };
    }),
  };
}

// ---------------------------------------------------------------------------
// Route definitions (shared HTTP + IPC)
// ---------------------------------------------------------------------------

const ventureverseAppSchema = z.object({
  id: z.number().describe("VentureVerse's numeric app id."),
  name: z.string(),
  slug: z
    .string()
    .describe(
      "Launch slug (`<id>-<kebab-name>`, e.g. '10-alchemy') — what the " +
        "VentureVerse shell's `?launch=` parameter takes.",
    ),
  category: z.string(),
  description: z.string(),
  iconUrl: z
    .string()
    .optional()
    .describe(
      "App icon URL (assets.ventureverse.com). Clients render a monogram " +
        "chip when missing or when the image fails to load.",
    ),
  appUrl: z
    .string()
    .optional()
    .describe(
      "The app's own deployment origin. Informational — clients embed " +
        "`launchUrl`, not this.",
    ),
  launchUrl: z
    .string()
    .describe(
      "The URL clients embed in an iframe: the VentureVerse shell with " +
        "this app launched.",
    ),
});

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "listVentureverseApps",
    endpoint: "ventureverse-apps",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List VentureVerse apps",
    description:
      "Return the VentureVerse app-store catalog for the embedded Apps " +
      "surface. Server-side cached (24h) from ventureverse.com's public " +
      "catalog API; falls back to a static curated snapshot when " +
      "unreachable. 404 while the `ventureverse-apps` feature flag is off.",
    tags: ["ventureverse"],
    queryParams: [
      {
        name: "query",
        schema: { type: "string" },
        description:
          "Case-insensitive filter over name, category, and description.",
      },
    ],
    responseBody: z.object({
      source: z
        .enum(["remote", "curated"])
        .describe(
          "'remote' = live (or cached) ventureverse.com data; 'curated' = " +
            "the static fallback snapshot.",
        ),
      origin: z
        .string()
        .describe(
          "The VentureVerse web origin the client should embed and allow " +
            "framing for.",
        ),
      apps: z.array(ventureverseAppSchema),
    }),
    handler: handleListVentureverseApps,
  },
];
