/**
 * Transport-agnostic routes for Playbook CRUD (WS-F).
 *
 * Every read returns the playbook's requested autonomy AND the effective
 * autonomy after the global-trust-dial clamp, plus the live dial, so the UI
 * can render the 🔒 capped state without recomputing the cap client-side —
 * the server is the single source of truth for the cap (autonomy-cap.ts).
 */

import { z } from "zod";

import { capAutonomy, getGlobalDial } from "../../playbooks/autonomy-cap.js";
import {
  createPlaybook,
  deletePlaybook,
  getPlaybook,
  listPlaybooks,
  type PlaybookRecord,
  updatePlaybook,
} from "../../playbooks/playbook-store.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const AutonomyLevel = z.enum(["auto", "draft", "notify"]);

const PlaybookCreateParams = z.object({
  name: z.string().min(1),
  trigger_text: z.string().min(1),
  action: z.string().min(1),
  channel: z.string().optional(),
  watcher_id: z.string().nullable().optional(),
  autonomy_level: AutonomyLevel.optional(),
  priority: z.number().int().optional(),
  enabled: z.boolean().optional(),
});

const PlaybookListParams = z.object({
  playbook_id: z.string().optional(),
  enabled_only: z.boolean().optional().default(false),
  watcher_id: z.string().optional(),
});

const PlaybookUpdateParams = z.object({
  playbook_id: z.string().min(1),
  name: z.string().optional(),
  trigger_text: z.string().optional(),
  action: z.string().optional(),
  channel: z.string().optional(),
  watcher_id: z.string().nullable().optional(),
  autonomy_level: AutonomyLevel.optional(),
  priority: z.number().int().optional(),
  enabled: z.boolean().optional(),
});

const PlaybookDeleteParams = z.object({
  playbook_id: z.string().min(1),
});

const PlaybookResponse = z.object({}).passthrough();

/** Decorate a stored playbook with the server-computed autonomy cap. */
function withAutonomy(playbook: PlaybookRecord) {
  const dial = getGlobalDial();
  const autonomy = capAutonomy(playbook.autonomyLevel, dial);
  return {
    ...playbook,
    effectiveAutonomy: autonomy.effective,
    autonomyCeiling: autonomy.ceiling,
    autonomyCapped: autonomy.capped,
    globalDial: dial,
  };
}

function handlePlaybookCreate({ body = {} }: RouteHandlerArgs) {
  const params = PlaybookCreateParams.parse(body);
  const playbook = createPlaybook({
    name: params.name,
    triggerText: params.trigger_text,
    action: params.action,
    channel: params.channel,
    watcherId: params.watcher_id ?? null,
    autonomyLevel: params.autonomy_level,
    priority: params.priority,
    enabled: params.enabled,
  });
  return withAutonomy(playbook);
}

function handlePlaybookList({ body = {} }: RouteHandlerArgs) {
  const {
    playbook_id: playbookId,
    enabled_only: enabledOnly,
    watcher_id: watcherId,
  } = PlaybookListParams.parse(body);

  if (playbookId) {
    const playbook = getPlaybook(playbookId);
    if (!playbook) throw new NotFoundError(`Playbook not found: ${playbookId}`);
    return withAutonomy(playbook);
  }

  const playbooks = listPlaybooks({
    enabledOnly,
    ...(watcherId !== undefined ? { watcherId } : {}),
  });
  return {
    globalDial: getGlobalDial(),
    playbooks: playbooks.map(withAutonomy),
  };
}

function handlePlaybookUpdate({ body = {} }: RouteHandlerArgs) {
  const params = PlaybookUpdateParams.parse(body);
  const updates: Parameters<typeof updatePlaybook>[1] = {};
  if (params.name !== undefined) updates.name = params.name;
  if (params.trigger_text !== undefined)
    updates.triggerText = params.trigger_text;
  if (params.action !== undefined) updates.action = params.action;
  if (params.channel !== undefined) updates.channel = params.channel;
  if (params.watcher_id !== undefined) updates.watcherId = params.watcher_id;
  if (params.autonomy_level !== undefined) {
    updates.autonomyLevel = params.autonomy_level;
  }
  if (params.priority !== undefined) updates.priority = params.priority;
  if (params.enabled !== undefined) updates.enabled = params.enabled;

  if (Object.keys(updates).length === 0) {
    throw new BadRequestError(
      "No updates provided. Specify at least one field to update.",
    );
  }

  const playbook = updatePlaybook(params.playbook_id, updates);
  if (!playbook) {
    throw new NotFoundError(`Playbook not found: ${params.playbook_id}`);
  }
  return withAutonomy(playbook);
}

function handlePlaybookDelete({ body = {} }: RouteHandlerArgs) {
  const { playbook_id: playbookId } = PlaybookDeleteParams.parse(body);
  const playbook = getPlaybook(playbookId);
  if (!playbook) throw new NotFoundError(`Playbook not found: ${playbookId}`);
  deletePlaybook(playbookId);
  return { deleted: true, name: playbook.name };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "playbook_create",
    endpoint: "playbooks/create",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handlePlaybookCreate,
    summary: "Create a playbook",
    description: "Create a trigger→action playbook rule.",
    tags: ["playbooks"],
    requestBody: PlaybookCreateParams,
    responseBody: PlaybookResponse,
  },
  {
    operationId: "playbook_list",
    endpoint: "playbooks/list",
    method: "POST",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handlePlaybookList,
    summary: "List playbooks",
    description:
      "List playbooks (with server-computed effective autonomy + the global dial), or get one by ID.",
    tags: ["playbooks"],
    requestBody: PlaybookListParams,
    responseBody: PlaybookResponse,
  },
  {
    operationId: "playbook_update",
    endpoint: "playbooks/update",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handlePlaybookUpdate,
    summary: "Update a playbook",
    description: "Update an existing playbook rule.",
    tags: ["playbooks"],
    requestBody: PlaybookUpdateParams,
    responseBody: PlaybookResponse,
  },
  {
    operationId: "playbook_delete",
    endpoint: "playbooks/delete",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handlePlaybookDelete,
    summary: "Delete a playbook",
    description: "Delete a playbook by ID.",
    tags: ["playbooks"],
    requestBody: PlaybookDeleteParams,
    responseBody: PlaybookResponse,
  },
];
