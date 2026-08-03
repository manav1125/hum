/**
 * The Library route — one list for the surface called "Library".
 *
 * Before this existed, a client that wanted a library had to fan out to
 * `GET apps`, `GET documents` and `GET attachments` and stitch them, or pick
 * one and hope. The phone picked `GET outputs` — the work-run deliverable
 * registry — and rendered two cards for an owner with 89 real assets. A screen
 * cannot be honest about a scope it never fetched, so the scope now has an
 * endpoint.
 *
 * See `src/library/library-store.ts` for what the scope IS and why uploads are
 * not in it.
 */

import { z } from "zod";

import {
  LIBRARY_LIMIT_MAX,
  listLibraryItems,
} from "../../library/library-store.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import type { RouteDefinition } from "./types.js";

const libraryItemSchema = z.object({
  id: z.string(),
  source: z
    .enum(["output", "file", "document", "app"])
    .describe(
      "Which registry it came from: a run-registered deliverable, a file Cue generated in a thread, a canvas document, or a built app",
    ),
  workItemId: z
    .string()
    .nullable()
    .describe("Set only on run-registered deliverables"),
  missionId: z.string().nullable(),
  projectId: z.string().nullable(),
  attachmentId: z
    .string()
    .nullable()
    .describe("Set for file-backed items; bytes via the attachment routes"),
  externalUrl: z.string().nullable(),
  documentId: z
    .string()
    .nullable()
    .describe("Canvas document surface id — how the client opens it"),
  appId: z.string().nullable(),
  kind: z.enum([
    "document",
    "deck",
    "spreadsheet",
    "pdf",
    "image",
    "video",
    "app",
    "other",
  ]),
  title: z.string(),
  why: z.string().nullable(),
  agent: z
    .string()
    .nullable()
    .describe('The assignee that produced it; null reads as "cue"'),
  reviewState: z
    .enum(["pending", "approved"])
    .nullable()
    .describe(
      "null means the artefact was never queued for review — NOT that review is pending. Only run-registered deliverables carry one.",
    ),
  createdAt: z.number().int(),
  attachment: z
    .object({
      id: z.string(),
      filename: z.string(),
      mimeType: z.string(),
      sizeBytes: z.number().int(),
      hasThumbnail: z.boolean(),
    })
    .nullable(),
});

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "listLibrary",
    endpoint: "library",
    method: "GET",
    policy: {
      // Both, and honestly so: the response composes settings-scoped
      // registries (apps, documents, outputs) with attachment metadata.
      requiredScopes: ["settings.read", "attachments.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List everything made with Cue",
    description:
      "Newest-first library across every source: files Cue generated, the documents it wrote, the apps it built, and the deliverables work runs registered. Excludes files you uploaded (inputs live in their thread) and tool-internal captures.",
    tags: ["library"],
    queryParams: [
      {
        name: "limit",
        description: `Max items to return (default 200, cap ${LIBRARY_LIMIT_MAX})`,
        schema: { type: "integer" },
      },
    ],
    responseBody: z.object({ items: z.array(libraryItemSchema) }),
    handler: ({ queryParams }) => {
      const rawLimit = Number(queryParams?.limit);
      const limit = Number.isFinite(rawLimit) ? rawLimit : undefined;
      return { items: listLibraryItems(limit ? { limit } : undefined) };
    },
  },
];
