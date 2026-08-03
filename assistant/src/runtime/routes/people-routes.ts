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
import { getContactMemoryHealth } from "../../contacts/contact-memory-extract-job.js";
import {
  CONTACT_MEMORY_BULK_MAX_CONTACTS,
  CONTACT_MEMORY_BULK_MAX_ROWS_PER_CONTACT,
  forgetFact,
  isContactMemoryKind,
  listContactMemory,
  readContactMemoryForContacts,
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

const contactMemoryReadSchema = z.object({
  contactId: z.string(),
  status: z
    .enum(["learned", "empty", "unavailable"])
    .describe(
      "learned = rows follow; empty = we looked and there is nothing yet; " +
        "unavailable = we could NOT look (read failed, or no such contact). " +
        "Never render `unavailable` as 'nothing learned yet'.",
    ),
  memory: z
    .array(contactMemorySchema)
    .describe("Newest-seen first, capped per contact. Empty unless `learned`."),
  total: z
    .number()
    .describe("Rows this contact actually has; `memory` may be a prefix"),
  reason: z
    .string()
    .nullable()
    .describe("Why we could not look. Only set when status is `unavailable`."),
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
    interactionsDegraded: z
      .boolean()
      .describe(
        "True when the interactions history couldn't fully load (query error or budget); interactions is then partial/empty",
      ),
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

/**
 * Bulk memory read — one request for a page of People cards.
 *
 * A POST for a read is deliberate: the input is a list of ids, which belongs
 * in a body rather than a query string, and the handler is side-effect free
 * (the GET-idempotency rule constrains GETs; it does not make read-only POSTs
 * illegal, and `contacts/search` / `tasks/list` already work this way).
 *
 * Over the cap this rejects instead of truncating. A truncated answer would
 * come back as a set of contacts with no rows, which is exactly the shape of
 * "nothing learned yet" — the caller would be told a falsehood in the one
 * response format designed to prevent it.
 */
function handleBulkMemory({ body = {} }: RouteHandlerArgs) {
  const raw = body.contactIds;
  if (!Array.isArray(raw)) {
    throw new BadRequestError("contactIds must be an array of contact ids");
  }
  if (raw.length > CONTACT_MEMORY_BULK_MAX_CONTACTS) {
    throw new BadRequestError(
      `contactIds has ${raw.length} entries; at most ${CONTACT_MEMORY_BULK_MAX_CONTACTS} may be read at once. ` +
        "Ask for fewer — this request is rejected rather than truncated, because a short answer " +
        "is indistinguishable from contacts with nothing learned.",
    );
  }
  const ids: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string" || !value.trim()) {
      throw new BadRequestError(
        "contactIds must contain only non-empty contact id strings",
      );
    }
    ids.push(value.trim());
  }

  return {
    ok: true,
    maxContacts: CONTACT_MEMORY_BULK_MAX_CONTACTS,
    maxRowsPerContact: CONTACT_MEMORY_BULK_MAX_ROWS_PER_CONTACT,
    contacts: readContactMemoryForContacts(ids),
  };
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
    operationId: "getContactMemoryHealth",
    endpoint: "people/memory/health",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Contact-memory extraction health",
    description:
      "What contact-memory extraction has actually been doing in this daemon " +
      "process. This exists because a pass that resolves no contact is " +
      "indistinguishable from a pass with nothing to learn — from the " +
      "outside, both are a completed job and an empty People surface. The " +
      "extraction job ran several hundred times and wrote nothing, and no " +
      "counter anywhere was carrying it. `degraded` plus `degradedReason` is " +
      "what a 'Cue has learned nothing about anybody' empty state should " +
      "read, instead of inferring health from an empty dossier. In-memory " +
      "and per-process by design: it describes behaviour since this daemon " +
      "started, and a restart genuinely does reset what we know.",
    tags: ["people"],
    responseBody: z.object({
      conversationRuns: z
        .number()
        .describe("Conversation-keyed extractions attempted"),
      conversationsIdentified: z
        .number()
        .describe("Of those, how many resolved to a contact at all"),
      consecutiveUnidentified: z
        .number()
        .describe("Consecutive conversation runs that resolved nobody"),
      sweeps: z.number().describe("Correspondence sweeps run"),
      lastSweepAt: z.number().nullable().describe("Epoch ms of the last sweep"),
      lastSweepExamined: z
        .number()
        .describe("People the last sweep read mail for"),
      lastSweepSaved: z.number().describe("Facts the last sweep wrote"),
      consecutiveUnproductiveSweeps: z
        .number()
        .describe("Consecutive sweeps that read mail and wrote nothing"),
      contactsProvisioned: z
        .number()
        .describe("Contacts minted or refreshed from correspondence"),
      factsWritten: z
        .number()
        .describe("Facts written by either path since this daemon started"),
      degraded: z
        .boolean()
        .describe("True when extraction runs but learns nothing"),
      degradedReason: z
        .string()
        .nullable()
        .describe("Plain-language reason in the owner's terms, or null"),
    }),
    handler: () => getContactMemoryHealth(),
  },
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
    operationId: "readContactMemoryBulk",
    endpoint: "people/memory/bulk",
    method: "POST",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "What Cue remembers about many contacts, in one call",
    description:
      "Read contact memory for up to " +
      `${CONTACT_MEMORY_BULK_MAX_CONTACTS} contacts in a single request, so a ` +
      "People list costs one call per page instead of one per card. Read-only " +
      "despite the verb: the id list belongs in a body, not a query string.\n\n" +
      "Every contact comes back with an explicit status — `learned`, `empty` " +
      "(we looked, there is nothing yet) or `unavailable` (we could not look: " +
      "the read failed, or no contact has that id). The third state exists " +
      "because most people genuinely have nothing learned, so a failure that " +
      "renders as an absence is invisible. `total` reports the real row count " +
      "when `memory` is capped.\n\n" +
      `Requests over ${CONTACT_MEMORY_BULK_MAX_CONTACTS} ids are rejected with ` +
      "400, never truncated.",
    tags: ["people"],
    requestBody: z.object({
      contactIds: z
        .array(z.string())
        .describe(
          `Contact ids to read, at most ${CONTACT_MEMORY_BULK_MAX_CONTACTS}. Duplicates collapse.`,
        ),
    }),
    responseBody: z.object({
      ok: z.boolean(),
      maxContacts: z
        .number()
        .describe("Ids this endpoint accepts per call (the cap that rejects)"),
      maxRowsPerContact: z
        .number()
        .describe("Rows returned per contact before `memory` is capped"),
      contacts: z
        .array(contactMemoryReadSchema)
        .describe("One entry per distinct requested id, in the order given"),
    }),
    additionalResponses: {
      "400": { description: "contactIds missing, malformed, or over the cap" },
    },
    handler: handleBulkMemory,
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
export { getContactInteractions, getContactReachability };
