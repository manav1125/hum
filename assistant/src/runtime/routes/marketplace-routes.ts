/**
 * Route handlers for the skill marketplace (WS1 — open GitHub ingestion).
 *
 * Endpoints are daemon-relative (`marketplace/...`); the platform gateway
 * proxies them under `/v1/assistants/{id}/marketplace/...` and strips the
 * assistant scope, exactly like the `skills/*` routes.
 *
 * Every handler is gated on `assertMarketplaceEnabled()` — with the
 * `marketplace` flag (or `skills.marketplace.enabled`) OFF the routes
 * answer 404 and perform no work: no source seeding, no index fetches, no
 * cache writes. Indexing is lazy/on-demand; nothing marketplace-related
 * runs at startup or inside the skill-load hot path.
 */

import { z } from "zod";

import { listSkills } from "../../daemon/handlers/skills.js";
import { assertMarketplaceEnabled } from "../../skills/marketplace/flag.js";
import {
  fetchRawFile,
  fetchRepoInfo,
} from "../../skills/marketplace/github.js";
import {
  findItemById,
  indexSource,
  matchesQuery,
} from "../../skills/marketplace/indexer.js";
import {
  applyUpdate,
  checkUpdates,
  listInstalled,
  performInstall,
  planInstall,
} from "../../skills/marketplace/install.js";
import {
  addSource,
  CUE_OFFICIAL_ADDRESS,
  loadSources,
  normalizeGithubAddress,
  removeSource,
  setSourceEnabled,
} from "../../skills/marketplace/sources.js";
import type {
  MarketplaceItem,
  MarketplaceSource,
} from "../../skills/marketplace/types.js";
import { getLogger } from "../../util/logger.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError, InternalError, NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("marketplace-routes");

// ─── Response schemas ────────────────────────────────────────────────────────

const capabilityManifestSchema = z.object({
  secrets: z.array(z.string()),
  connectors: z.array(z.string()),
  network: z.array(z.string()),
  writes: z.array(z.string()),
});

const marketplaceItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string(),
  description: z.string(),
  source: z.string(),
  sourceLabel: z.string(),
  skillPath: z.string(),
  ref: z.string(),
  url: z.string().optional(),
  emoji: z.string().optional(),
  license: z.string().optional(),
  capabilities: capabilityManifestSchema,
  installed: z.boolean().optional(),
});

const marketplaceSourceSchema = z.object({
  address: z.string(),
  kind: z.enum(["github", "catalog"]),
  ref: z.string().optional(),
  label: z.string().optional(),
  enabled: z.boolean(),
  builtIn: z.boolean().optional(),
  license: z.string().optional(),
});

const skippedFileSchema = z.object({
  path: z.string(),
  reason: z.string(),
});

const lockEntrySchema = z.object({
  source: z.string(),
  sourceType: z.literal("github"),
  ref: z.string(),
  skillPath: z.string(),
  computedHash: z.record(z.string(), z.string()),
  gitSha: z.record(z.string(), z.string()).optional(),
  installedAt: z.string(),
  consent: z.object({
    consentedAt: z.string(),
    capabilities: capabilityManifestSchema,
    undeclared: z.boolean(),
  }),
  skippedFiles: z.array(skippedFileSchema).optional(),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function enabledSources(): MarketplaceSource[] {
  return loadSources().filter((s) => s.enabled);
}

function withInstalledFlag(
  items: MarketplaceItem[],
  installedIds: Set<string>,
): Array<MarketplaceItem & { installed: boolean }> {
  return items.map((item) => ({
    ...item,
    installed: installedIds.has(item.id),
  }));
}

function installedIdSet(): Set<string> {
  // Marketplace-lock installs are keyed by their namespaced managed-dir id
  // (`owner--repo--skill`); GitHub-sourced items match here.
  const ids = new Set(listInstalled().map((i) => i.skillId));
  // First-party catalog items carry the plain skill id (`entry.id`), which is
  // also the id every skill already present in the assistant reports. Union
  // those in so bundled / catalog-installed / manually-added skills (e.g.
  // Amazon, Browser) surface as "Installed" instead of offering "Install".
  for (const skill of listSkills()) ids.add(skill.id);
  return ids;
}

async function resolveItem(itemId: string): Promise<MarketplaceItem> {
  const item = await findItemById(loadSources(), itemId);
  if (!item) {
    throw new NotFoundError(`Marketplace item "${itemId}" not found`);
  }
  return item;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "listMarketplaceItems",
    endpoint: "marketplace/items",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List marketplace items",
    description:
      "Return indexed skills across enabled sources. Pass ?source= to index a single source (the UI streams results per source) and ?query= for text search. Indexes are cached per source for 24h.",
    tags: ["marketplace"],
    queryParams: [
      {
        name: "query",
        schema: { type: "string" },
        description: "Text search across name, description, id, and source.",
      },
      {
        name: "source",
        schema: { type: "string" },
        description:
          "Restrict to one source address (e.g. 'anthropics/skills' or 'cue-official').",
      },
      {
        name: "refresh",
        schema: { type: "string", enum: ["true"] },
        description: "Force a re-index, bypassing the 24h cache.",
      },
    ],
    responseBody: z.object({
      items: z.array(marketplaceItemSchema),
      errors: z
        .array(z.object({ source: z.string(), error: z.string() }))
        .optional()
        .describe("Sources that failed to index (partial results returned)"),
      truncated: z.boolean().optional(),
    }),
    handler: async ({ queryParams = {} }: RouteHandlerArgs) => {
      assertMarketplaceEnabled();
      const query = queryParams.query ?? "";
      const force = queryParams.refresh === "true";
      const sourceFilter = queryParams.source;

      const sources = sourceFilter
        ? loadSources().filter((s) => s.address === sourceFilter)
        : enabledSources();
      if (sourceFilter && sources.length === 0) {
        throw new NotFoundError(`Unknown source "${sourceFilter}"`);
      }

      const items: MarketplaceItem[] = [];
      const errors: Array<{ source: string; error: string }> = [];
      let truncated = false;
      for (const source of sources) {
        try {
          const index = await indexSource(source, { force });
          truncated = truncated || index.truncated === true;
          for (const item of index.items) {
            if (matchesQuery(item, query)) items.push(item);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn({ err, address: source.address }, "Source index failed");
          errors.push({ source: source.address, error: message });
        }
      }
      if (items.length === 0 && errors.length > 0 && sourceFilter) {
        throw new InternalError(errors[0].error);
      }
      return {
        items: withInstalledFlag(items, installedIdSet()),
        ...(errors.length > 0 ? { errors } : {}),
        ...(truncated ? { truncated } : {}),
      };
    },
  },
  {
    operationId: "getMarketplaceItem",
    endpoint: "marketplace/items/:id",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get marketplace item detail",
    description:
      "Return one indexed item plus a SKILL.md preview and the install plan (files that would be installed, files skipped by the markdown-only safety boundary, declared capabilities).",
    tags: ["marketplace"],
    responseBody: z.object({
      item: marketplaceItemSchema,
      skillMd: z.string().nullable().describe("Raw SKILL.md content preview"),
      files: z.array(
        z.object({ path: z.string(), size: z.number().optional() }),
      ),
      skipped: z.array(skippedFileSchema),
      capabilities: capabilityManifestSchema,
      notice: z.string(),
      alreadyInstalled: z.boolean(),
    }),
    handler: async ({ pathParams }: RouteHandlerArgs) => {
      assertMarketplaceEnabled();
      const item = await resolveItem(pathParams!.id);
      const plan = await planInstall(item);
      let skillMd: string | null = null;
      if (item.source !== CUE_OFFICIAL_ADDRESS) {
        try {
          const sourcePath = item.skillPath
            ? `${item.skillPath}/SKILL.md`
            : "SKILL.md";
          skillMd = await fetchRawFile(item.source, item.ref, sourcePath);
        } catch (err) {
          log.warn({ err, itemId: item.id }, "SKILL.md preview fetch failed");
        }
      }
      return {
        item: { ...item, installed: installedIdSet().has(item.id) },
        skillMd,
        files: plan.files,
        skipped: plan.skipped,
        capabilities: plan.capabilities,
        notice: plan.notice,
        alreadyInstalled: plan.alreadyInstalled,
      };
    },
  },
  {
    operationId: "listMarketplaceSources",
    endpoint: "marketplace/sources",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List marketplace sources",
    description:
      "Return the source registry (seed sources plus user-added repos).",
    tags: ["marketplace"],
    responseBody: z.object({
      sources: z.array(marketplaceSourceSchema),
    }),
    handler: async () => {
      assertMarketplaceEnabled();
      return { sources: loadSources() };
    },
  },
  {
    operationId: "addMarketplaceSource",
    endpoint: "marketplace/sources",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Add marketplace source",
    description:
      "Add a public GitHub repo (owner/repo or github.com URL) as a skill source. The repo is verified via the GitHub API and its license is recorded; repos without a detectable license are added with a warning. Pass enabled=false with an existing address to disable instead.",
    tags: ["marketplace"],
    requestBody: z.object({
      address: z.string().describe("owner/repo or a github.com URL"),
      ref: z
        .string()
        .optional()
        .describe("Git ref (defaults to the default branch)"),
      label: z.string().optional(),
      enabled: z
        .boolean()
        .optional()
        .describe("Toggle an existing source instead of adding"),
    }),
    responseBody: z.object({
      source: marketplaceSourceSchema,
      warning: z.string().optional(),
    }),
    handler: async ({ body = {} }: RouteHandlerArgs) => {
      assertMarketplaceEnabled();
      const rawAddress = body.address;
      if (typeof rawAddress !== "string" || rawAddress.trim().length === 0) {
        throw new BadRequestError("address is required");
      }

      // Toggle path for existing sources (incl. built-ins like cue-official).
      if (typeof body.enabled === "boolean") {
        const address =
          rawAddress === CUE_OFFICIAL_ADDRESS
            ? rawAddress
            : (normalizeGithubAddress(rawAddress) ?? rawAddress);
        if (!setSourceEnabled(address, body.enabled)) {
          throw new NotFoundError(`Unknown source "${address}"`);
        }
        const source = loadSources().find((s) => s.address === address)!;
        return { source };
      }

      const address = normalizeGithubAddress(rawAddress);
      if (!address) {
        throw new BadRequestError(
          "address must be owner/repo or a github.com repo URL",
        );
      }

      let license: string | undefined;
      let warning: string | undefined;
      try {
        const info = await fetchRepoInfo(address);
        license = info.licenseSpdxId;
        if (!license) {
          warning =
            "No license detected on this repo — installs are for personal use; review the repo's terms before redistributing.";
        }
      } catch (err) {
        throw new BadRequestError(
          `Could not verify GitHub repo "${address}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const source = addSource({
        address,
        ...(typeof body.ref === "string" && body.ref ? { ref: body.ref } : {}),
        ...(typeof body.label === "string" && body.label
          ? { label: body.label }
          : {}),
        ...(license ? { license } : {}),
      });
      return { source, ...(warning ? { warning } : {}) };
    },
  },
  {
    operationId: "removeMarketplaceSource",
    endpoint: "marketplace/sources",
    method: "DELETE",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Remove marketplace source",
    description:
      "Remove a source by ?address=. Built-in seed sources are disabled rather than deleted.",
    tags: ["marketplace"],
    queryParams: [
      {
        name: "address",
        schema: { type: "string" },
        required: true,
        description: "Source address (owner/repo or cue-official)",
      },
    ],
    responseBody: z.object({ ok: z.boolean() }),
    handler: async ({ queryParams = {} }: RouteHandlerArgs) => {
      assertMarketplaceEnabled();
      const address = queryParams.address;
      if (!address) {
        throw new BadRequestError("address query parameter is required");
      }
      if (!removeSource(address)) {
        throw new NotFoundError(`Unknown source "${address}"`);
      }
      return { ok: true };
    },
  },
  {
    operationId: "installMarketplaceSkill",
    endpoint: "marketplace/install",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Install marketplace skill",
    description:
      "Two-phase install with capability consent. Without confirm:true the response is the install-confirmation payload (files, skipped executables, declared capabilities — or the 'no declared capabilities' notice). With confirm:true the skill's markdown/text assets are written into the managed skills dir and a hash-pinned entry is recorded in skills-lock.json.",
    tags: ["marketplace"],
    requestBody: z.object({
      itemId: z
        .string()
        .describe("Namespaced item id ({owner}--{repo}--{skill})"),
      confirm: z
        .boolean()
        .optional()
        .describe("Explicit consent — required to actually install"),
    }),
    responseBody: z.object({
      requiresConfirmation: z.boolean().optional(),
      ok: z.boolean().optional(),
      skillId: z.string(),
      item: marketplaceItemSchema.optional(),
      files: z
        .array(z.object({ path: z.string(), size: z.number().optional() }))
        .optional(),
      skipped: z.array(skippedFileSchema),
      capabilities: capabilityManifestSchema,
      notice: z.string().optional(),
      alreadyInstalled: z.boolean().optional(),
      lock: lockEntrySchema.optional(),
    }),
    handler: async ({ body = {} }: RouteHandlerArgs) => {
      assertMarketplaceEnabled();
      const itemId = body.itemId;
      if (typeof itemId !== "string" || itemId.trim().length === 0) {
        throw new BadRequestError("itemId is required");
      }
      const item = await resolveItem(itemId);

      if (body.confirm !== true) {
        const plan = await planInstall(item);
        return {
          requiresConfirmation: true,
          skillId: plan.skillId,
          item: plan.item,
          files: plan.files,
          skipped: plan.skipped,
          capabilities: plan.capabilities,
          notice: plan.notice,
          alreadyInstalled: plan.alreadyInstalled,
        };
      }

      try {
        const result = await performInstall(item);
        return {
          ok: true,
          skillId: result.skillId,
          skipped: result.skipped,
          capabilities: result.lock.consent.capabilities,
          lock: result.lock,
        };
      } catch (err) {
        throw new InternalError(
          err instanceof Error ? err.message : String(err),
        );
      }
    },
  },
  {
    operationId: "listMarketplaceInstalled",
    endpoint: "marketplace/installed",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List installed marketplace skills",
    description:
      "Return skills-lock.json entries (marketplace installs only; catalog installs are tracked by install-meta.json as before).",
    tags: ["marketplace"],
    responseBody: z.object({
      installed: z.array(
        z.object({
          skillId: z.string(),
          source: z.string(),
          ref: z.string(),
          skillPath: z.string(),
          installedAt: z.string(),
          present: z.boolean(),
          undeclaredCapabilities: z.boolean(),
          skippedFiles: z.array(skippedFileSchema).optional(),
        }),
      ),
    }),
    handler: async () => {
      assertMarketplaceEnabled();
      return { installed: listInstalled() };
    },
  },
  {
    operationId: "checkMarketplaceUpdates",
    endpoint: "marketplace/updates",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Check marketplace updates",
    description:
      "Re-resolve every lock entry against its source and diff per-file hashes. Read-only — nothing is applied; the client presents the diff and applies via POST marketplace/update on explicit confirm.",
    tags: ["marketplace"],
    responseBody: z.object({
      updates: z.array(
        z.object({
          skillId: z.string(),
          source: z.string(),
          upToDate: z.boolean(),
          error: z.string().optional(),
          changes: z.array(
            z.object({
              path: z.string(),
              status: z.enum(["added", "removed", "changed"]),
            }),
          ),
        }),
      ),
    }),
    handler: async () => {
      assertMarketplaceEnabled();
      return { updates: await checkUpdates() };
    },
  },
  {
    operationId: "applyMarketplaceUpdate",
    endpoint: "marketplace/update",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Apply marketplace update",
    description:
      "Re-install one lock-tracked skill from its pinned source. Requires confirm:true — clients must present the diff from GET marketplace/updates first.",
    tags: ["marketplace"],
    requestBody: z.object({
      skillId: z.string(),
      confirm: z.literal(true),
    }),
    responseBody: z.object({
      ok: z.boolean(),
      skillId: z.string(),
      lock: lockEntrySchema,
      skipped: z.array(skippedFileSchema),
    }),
    handler: async ({ body = {} }: RouteHandlerArgs) => {
      assertMarketplaceEnabled();
      const skillId = body.skillId;
      if (typeof skillId !== "string" || skillId.trim().length === 0) {
        throw new BadRequestError("skillId is required");
      }
      if (body.confirm !== true) {
        throw new BadRequestError(
          "confirm:true is required — present the diff from GET marketplace/updates first",
        );
      }
      try {
        const result = await applyUpdate(skillId);
        return {
          ok: true,
          skillId: result.skillId,
          lock: result.lock,
          skipped: result.skipped,
        };
      } catch (err) {
        throw new InternalError(
          err instanceof Error ? err.message : String(err),
        );
      }
    },
  },
];
