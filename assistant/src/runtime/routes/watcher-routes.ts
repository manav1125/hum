/**
 * Transport-agnostic routes for watcher CRUD operations.
 */

import { z } from "zod";

import { checkCredentialForProvider } from "../../credential-health/credential-health-service.js";
import { unbindPlaybooksFromWatcher } from "../../playbooks/playbook-store.js";
import {
  getWatcherProvider,
  listWatcherProviders,
} from "../../watcher/provider-registry.js";
import {
  createWatcher,
  deleteWatcher,
  getWatcher,
  listWatcherEvents,
  listWatchers,
  updateWatcher,
  type Watcher,
} from "../../watcher/watcher-store.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

/**
 * Conservative default poll interval for watchers created via the Automations
 * UI (5 min). Standing pollers hit real quota/token budgets, so new watchers
 * default slower than the 60s store default; the route still enforces the 15s
 * floor for callers that opt into a tighter interval.
 */
const CONSERVATIVE_POLL_INTERVAL_MS = 5 * 60_000;

// ── Param schemas ─────────────────────────────────────────────────────

const WatcherCreateParams = z.object({
  name: z.string().min(1),
  provider: z.string().min(1),
  // Optional for 'came_in' watchers (the raw hit + playbooks carry the intent);
  // a default is supplied so the action_prompt NOT NULL column is satisfied.
  action_prompt: z.string().optional(),
  poll_interval_ms: z.number().int().min(15000).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  credential_service: z.string().optional(),
  intake_mode: z.enum(["came_in", "agent"]).optional(),
});

const WatcherListParams = z.object({
  watcher_id: z.string().optional(),
  enabled_only: z.boolean().optional().default(false),
});

const WatcherUpdateParams = z.object({
  watcher_id: z.string().min(1),
  name: z.string().optional(),
  action_prompt: z.string().optional(),
  poll_interval_ms: z.number().int().min(15000).optional(),
  enabled: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  intake_mode: z.enum(["came_in", "agent"]).optional(),
});

const WatcherDeleteParams = z.object({
  watcher_id: z.string().min(1),
});

const WatcherDigestParams = z.object({
  watcher_id: z.string().optional(),
  hours: z.number().positive().optional().default(24),
  limit: z.number().int().positive().optional().default(50),
});

// ── Response schemas ──────────────────────────────────────────────────

const WatcherResponse = z.object({}).passthrough();

// ── Handlers ──────────────────────────────────────────────────────────

function handleWatcherCreate({ body = {} }: RouteHandlerArgs) {
  const {
    name,
    provider: providerId,
    action_prompt: actionPrompt,
    poll_interval_ms: pollIntervalMs,
    config,
    credential_service: credentialServiceOverride,
    intake_mode: intakeMode,
  } = WatcherCreateParams.parse(body);

  const provider = getWatcherProvider(providerId);
  if (!provider) {
    const available =
      listWatcherProviders()
        .map((p) => p.id)
        .join(", ") || "none";
    throw new BadRequestError(
      `Unknown provider "${providerId}". Available: ${available}`,
    );
  }

  const credentialService =
    credentialServiceOverride ?? provider.requiredCredentialService;

  const watcher = createWatcher({
    name,
    providerId,
    // 'came_in' watchers don't need a prompt; keep the column satisfied.
    actionPrompt: actionPrompt ?? `Monitor ${provider.displayName}`,
    credentialService,
    // Conservative default (5 min) for new standing pollers — quota/token spend.
    pollIntervalMs: pollIntervalMs ?? CONSERVATIVE_POLL_INTERVAL_MS,
    configJson: config ? JSON.stringify(config) : null,
    intakeMode: intakeMode ?? "came_in",
  });

  return watcher;
}

/**
 * Resolve a watcher's connector-health signal for the UI health dot. Maps the
 * credential-health status onto the three states the board renders: 'ok',
 * 'reauth' (dead token — the user must reconnect), or 'unknown'. Best-effort:
 * a failed health probe reads as 'unknown', never blocks the list.
 */
async function resolveWatcherHealth(
  watcher: Watcher,
): Promise<"ok" | "reauth" | "unknown"> {
  try {
    const health = await checkCredentialForProvider(watcher.credentialService);
    if (!health) return "unknown";
    if (
      health.status === "revoked" ||
      health.status === "missing_token" ||
      (health.status === "expired" && !health.canAutoRecover)
    ) {
      return "reauth";
    }
    return "ok";
  } catch {
    return "unknown";
  }
}

async function handleWatcherList({ body = {} }: RouteHandlerArgs) {
  const { watcher_id: watcherId, enabled_only: enabledOnly } =
    WatcherListParams.parse(body);

  if (watcherId) {
    const watcher = getWatcher(watcherId);
    if (!watcher) {
      throw new NotFoundError(`Watcher not found: ${watcherId}`);
    }
    const events = listWatcherEvents({ watcherId, limit: 10 });
    const health = await resolveWatcherHealth(watcher);
    return { watcher: { ...watcher, health }, events };
  }

  const list = listWatchers({ enabledOnly });
  return Promise.all(
    list.map(async (w) => ({ ...w, health: await resolveWatcherHealth(w) })),
  );
}

function handleWatcherProviders() {
  return listWatcherProviders().map((p) => ({
    id: p.id,
    displayName: p.displayName,
    requiredCredentialService: p.requiredCredentialService,
  }));
}

function handleWatcherUpdate({ body = {} }: RouteHandlerArgs) {
  const {
    watcher_id: watcherId,
    name,
    action_prompt: actionPrompt,
    poll_interval_ms: pollIntervalMs,
    enabled,
    config,
    intake_mode: intakeMode,
  } = WatcherUpdateParams.parse(body);

  const updates: {
    name?: string;
    actionPrompt?: string;
    pollIntervalMs?: number;
    enabled?: boolean;
    configJson?: string | null;
    intakeMode?: string;
  } = {};

  if (name !== undefined) updates.name = name;
  if (actionPrompt !== undefined) updates.actionPrompt = actionPrompt;
  if (pollIntervalMs !== undefined) updates.pollIntervalMs = pollIntervalMs;
  if (enabled !== undefined) updates.enabled = enabled;
  if (config !== undefined) updates.configJson = JSON.stringify(config);
  if (intakeMode !== undefined) updates.intakeMode = intakeMode;

  if (Object.keys(updates).length === 0) {
    throw new BadRequestError(
      "No updates provided. Specify at least one field to update.",
    );
  }

  const watcher = updateWatcher(watcherId, updates);
  if (!watcher) {
    throw new NotFoundError(`Watcher not found: ${watcherId}`);
  }

  return watcher;
}

function handleWatcherDelete({ body = {} }: RouteHandlerArgs) {
  const { watcher_id: watcherId } = WatcherDeleteParams.parse(body);

  const watcher = getWatcher(watcherId);
  if (!watcher) {
    throw new NotFoundError(`Watcher not found: ${watcherId}`);
  }

  deleteWatcher(watcherId);
  // Orphan any playbooks bound to this watcher back to channel-wide so they
  // aren't silently stranded pointing at a deleted watcher.
  unbindPlaybooksFromWatcher(watcherId);

  const provider = getWatcherProvider(watcher.providerId);
  provider?.cleanup?.(watcherId);

  return { deleted: true, name: watcher.name };
}

function handleWatcherDigest({ body = {} }: RouteHandlerArgs) {
  const {
    watcher_id: watcherId,
    hours,
    limit,
  } = WatcherDigestParams.parse(body);

  const since = Date.now() - hours * 3_600_000;
  const events = listWatcherEvents({ watcherId, limit, since });

  const allWatchers = listWatchers();
  const watcherNames: Record<string, string> = {};
  for (const w of allWatchers) {
    watcherNames[w.id] = w.name;
  }

  return { events, watcherNames };
}

// ── Route definitions ─────────────────────────────────────────────────

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "watcher_create",
    endpoint: "watchers/create",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleWatcherCreate,
    summary: "Create a watcher",
    description: "Create a new watcher with a provider and action prompt.",
    tags: ["watchers"],
    requestBody: WatcherCreateParams,
    responseBody: WatcherResponse,
  },
  {
    operationId: "watcher_list",
    endpoint: "watchers/list",
    method: "POST",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleWatcherList,
    summary: "List watchers",
    description:
      "List all watchers, or get details for a specific watcher by ID.",
    tags: ["watchers"],
    requestBody: WatcherListParams,
    responseBody: WatcherResponse,
  },
  {
    operationId: "watcher_update",
    endpoint: "watchers/update",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleWatcherUpdate,
    summary: "Update a watcher",
    description: "Update an existing watcher's configuration.",
    tags: ["watchers"],
    requestBody: WatcherUpdateParams,
    responseBody: WatcherResponse,
  },
  {
    operationId: "watcher_delete",
    endpoint: "watchers/delete",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleWatcherDelete,
    summary: "Delete a watcher",
    description: "Delete a watcher by ID.",
    tags: ["watchers"],
    requestBody: WatcherDeleteParams,
    responseBody: WatcherResponse,
  },
  {
    operationId: "watcher_providers",
    endpoint: "watchers/providers",
    method: "POST",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleWatcherProviders,
    summary: "List watcher providers",
    description:
      "List the available watcher source providers (id, display name, required credential).",
    tags: ["watchers"],
    requestBody: z.object({}).optional(),
    responseBody: WatcherResponse,
  },
  {
    operationId: "watcher_digest",
    endpoint: "watchers/digest",
    method: "POST",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleWatcherDigest,
    summary: "Get watcher event digest",
    description:
      "Get recent watcher events, optionally filtered by watcher ID.",
    tags: ["watchers"],
    requestBody: WatcherDigestParams,
    responseBody: WatcherResponse,
  },
];
