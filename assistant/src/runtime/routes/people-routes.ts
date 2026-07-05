/**
 * People "relationship memory" routes — the API behind the Claude-Projects-style
 * contact dossier (Cue-Surfaces S4: trust badge, "WHAT CUE REMEMBERS",
 * "REACHABLE ON", interactions timeline).
 *
 * All routes are served by both the HTTP server and the IPC server via the
 * shared ROUTES array. Handlers are transport-agnostic: they take plain params
 * and return plain data, and throw RouteError subclasses for error cases.
 *
 * The dossier renders REAL data only — memory from the manual/told path (and,
 * later, from-conversation extraction), reachability derived from live channel
 * identities, interactions stitched from bound conversations + calls, and a
 * relationship score derived from channel interaction stats. Nothing is
 * fabricated.
 */

import { z } from "zod";

import {
  getContactDossier,
  getContactInteractions,
  getContactReachability,
} from "../../contacts/contact-dossier-store.js";
import {
  forgetFact,
  isContactMemoryKind,
  listContactMemory,
  rememberFact,
  updateContactMemory,
} from "../../contacts/contact-memory-store.js";
import { getContact } from "../../contacts/contact-store.js";
import type { ContactMemoryKind } from "../../contacts/memory-types.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ── Response schemas (drive OpenAPI → codegen → typed SDK) ──────────────

const contactMemorySchema = z.object({
  id: z.string(),
  contactId: z.string(),
  statement: z.string(),
  kind: z.string(),
  source: z.string(),
  sourceRef: z.string().nullable(),
  confidence: z.number(),
  createdAt: z.number(),
  lastSeenAt: z.number(),
});

const relationshipSchema = z.object({
  contactId: z.string(),
  score: z.number().describe("0..100 blended relationship strength"),
  tier: z.string().describe("weak | building | strong"),
  lastInteractionAt: z.number().nullable(),
  interactionCount: z.number(),
  updatedAt: z.number(),
});

const reachabilitySchema = z.object({
  channelId: z.string(),
  type: z.string(),
  address: z.string(),
  isPrimary: z.boolean(),
  status: z.string(),
  reachable: z.boolean(),
  lastSeenAt: z.number().nullable(),
});

const interactionSchema = z.object({
  kind: z.string().describe("conversation | call"),
  conversationId: z.string(),
  channel: z.string(),
  title: z.string().nullable(),
  at: z.number(),
});

const dossierSchema = z.object({
  ok: z.boolean(),
  dossier: z.object({
    contactId: z.string(),
    displayName: z.string(),
    contactType: z.string(),
    role: z.string(),
    relationship: relationshipSchema,
    memory: z.array(contactMemorySchema),
    reachability: z.array(reachabilitySchema),
    interactions: z.array(interactionSchema),
  }),
});

// ── Helpers ─────────────────────────────────────────────────────────────

function requireContact(contactId: string): void {
  if (!getContact(contactId)) {
    throw new NotFoundError(`Contact "${contactId}" not found`);
  }
}

function parseKind(value: unknown): ContactMemoryKind | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !isContactMemoryKind(value)) {
    throw new BadRequestError(
      `Invalid kind "${String(value)}". Must be one of: fact, preference, relationship, context`,
    );
  }
  return value;
}

// ── Handlers (transport-agnostic) ────────────────────────────────────────

function handleGetDossier({
  pathParams = {},
  queryParams = {},
}: RouteHandlerArgs) {
  const contactId = pathParams.id;
  const interactionLimit = queryParams.interactionLimit
    ? Number(queryParams.interactionLimit)
    : undefined;
  const dossier = getContactDossier(contactId, { interactionLimit });
  if (!dossier) {
    throw new NotFoundError(`Contact "${contactId}" not found`);
  }
  return { ok: true, dossier };
}

function handleListMemory({ pathParams = {} }: RouteHandlerArgs) {
  const contactId = pathParams.id;
  requireContact(contactId);
  return { ok: true, memory: listContactMemory(contactId) };
}

function handleAddMemory({ pathParams = {}, body = {} }: RouteHandlerArgs) {
  const contactId = pathParams.id;
  requireContact(contactId);

  const statement = typeof body.statement === "string" ? body.statement : "";
  if (!statement.trim()) {
    throw new BadRequestError("statement is required");
  }
  const kind = parseKind(body.kind);
  const confidence =
    typeof body.confidence === "number" ? body.confidence : undefined;

  const memory = rememberFact({
    contactId,
    statement,
    kind,
    // The route is the manual "remember about X" path: told + full confidence
    // unless the caller specifies otherwise.
    source: "told",
    confidence,
  });
  return { ok: true, memory };
}

function handleUpdateMemory({ pathParams = {}, body = {} }: RouteHandlerArgs) {
  const contactId = pathParams.id;
  const memoryId = pathParams.mid;
  requireContact(contactId);

  const existing = listContactMemory(contactId).find((m) => m.id === memoryId);
  if (!existing) {
    throw new NotFoundError(`Memory "${memoryId}" not found for this contact`);
  }

  const statement =
    typeof body.statement === "string" ? body.statement : undefined;
  const kind = parseKind(body.kind);
  const confidence =
    typeof body.confidence === "number" ? body.confidence : undefined;

  if (statement !== undefined && !statement.trim()) {
    throw new BadRequestError("statement cannot be empty");
  }

  const memory = updateContactMemory(memoryId, {
    statement,
    kind,
    confidence,
  });
  if (!memory) {
    throw new NotFoundError(`Memory "${memoryId}" not found`);
  }
  return { ok: true, memory };
}

function handleForgetMemory({ pathParams = {} }: RouteHandlerArgs) {
  const contactId = pathParams.id;
  const memoryId = pathParams.mid;
  requireContact(contactId);

  const existing = listContactMemory(contactId).find((m) => m.id === memoryId);
  if (!existing) {
    throw new NotFoundError(`Memory "${memoryId}" not found for this contact`);
  }
  const deleted = forgetFact(memoryId);
  return { ok: deleted, id: memoryId };
}

// ── Route definitions ─────────────────────────────────────────────────────

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "getContactDossier",
    endpoint: "contacts/:id/dossier",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get a contact's relationship dossier",
    description:
      "Return the full dossier for a contact: relationship score/tier, remembered facts (WHAT CUE REMEMBERS), reachable channels (REACHABLE ON), and a time-ordered interactions timeline.",
    tags: ["people"],
    pathParams: [{ name: "id", description: "Contact id" }],
    queryParams: [
      {
        name: "interactionLimit",
        schema: { type: "integer" },
        description: "Max interactions to return (default 50, max 200)",
      },
    ],
    responseBody: dossierSchema,
    additionalResponses: { "404": { description: "Contact not found" } },
    handler: handleGetDossier,
  },
  {
    operationId: "listContactMemory",
    endpoint: "contacts/:id/memory",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List what Cue remembers about a contact",
    description:
      "Return the remembered facts for a contact, newest-seen first.",
    tags: ["people"],
    pathParams: [{ name: "id", description: "Contact id" }],
    responseBody: z.object({
      ok: z.boolean(),
      memory: z.array(contactMemorySchema),
    }),
    additionalResponses: { "404": { description: "Contact not found" } },
    handler: handleListMemory,
  },
  {
    operationId: "addContactMemory",
    endpoint: "contacts/:id/memory",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    responseStatus: "201",
    summary: "Remember a fact about a contact",
    description:
      "Add a durable fact Cue should remember about a contact (the manual 'remember about X' path).",
    tags: ["people"],
    pathParams: [{ name: "id", description: "Contact id" }],
    requestBody: z.object({
      statement: z.string().describe("The fact to remember"),
      kind: z
        .string()
        .optional()
        .describe("fact | preference | relationship | context (default fact)"),
      confidence: z
        .number()
        .optional()
        .describe("0..1 confidence (default 1.0)"),
    }),
    responseBody: z.object({ ok: z.boolean(), memory: contactMemorySchema }),
    additionalResponses: {
      "400": { description: "Missing/invalid statement or kind" },
      "404": { description: "Contact not found" },
    },
    handler: handleAddMemory,
  },
  {
    operationId: "updateContactMemory",
    endpoint: "contacts/:id/memory/:mid",
    method: "PATCH",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Correct a remembered fact",
    description:
      "Correct the statement, kind, or confidence of a fact Cue remembers about a contact.",
    tags: ["people"],
    pathParams: [
      { name: "id", description: "Contact id" },
      { name: "mid", description: "Memory id" },
    ],
    requestBody: z.object({
      statement: z.string().optional(),
      kind: z.string().optional(),
      confidence: z.number().optional(),
    }),
    responseBody: z.object({ ok: z.boolean(), memory: contactMemorySchema }),
    additionalResponses: {
      "400": { description: "Invalid statement or kind" },
      "404": { description: "Contact or memory not found" },
    },
    handler: handleUpdateMemory,
  },
  {
    operationId: "forgetContactMemory",
    endpoint: "contacts/:id/memory/:mid",
    method: "DELETE",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Forget a fact about a contact",
    description: "Delete a fact Cue remembers about a contact.",
    tags: ["people"],
    pathParams: [
      { name: "id", description: "Contact id" },
      { name: "mid", description: "Memory id" },
    ],
    responseBody: z.object({ ok: z.boolean(), id: z.string() }),
    additionalResponses: {
      "404": { description: "Contact or memory not found" },
    },
    handler: handleForgetMemory,
  },
];

// Re-export the reachability/interactions helpers so IPC/tooling callers that
// only need a slice of the dossier don't have to assemble the whole thing.
export { getContactInteractions,getContactReachability };
