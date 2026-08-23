/**
 * Route handlers for Notes — the capture surface, and the proposals Cue
 * finds inside it.
 *
 * The shape of this API is the feature's central rule made concrete: reads
 * and writes to `notes` are ordinary CRUD, reading a note produces
 * PROPOSALS, and **`POST notes/:id/extractions/:extractionId/accept` is the
 * only route in the file that can put anything into HQ, memory or People.**
 * There is deliberately no "auto-accept", no "accept everything above
 * confidence X", and no accept side-effect on any other route.
 *
 * Two response distinctions the clients depend on:
 *
 *   · `extractionState: "done"` with an empty `extractions` array means
 *     "nothing to file here — this reads like thinking, not commitments".
 *     `extractionState: "failed"` means the request failed and the note is
 *     saved. One is about the note, the other about the request, and they are
 *     never the same sentence.
 *   · `confidenceTier` is `confident` | `unsure`, never a number. A client
 *     draws confidence; it does not print it.
 *
 * Deleting a note deletes its proposals and **nothing else**. Work accepted
 * out of it stays, because provenance runs one way — see
 * `memory/schema/notes.ts`.
 */

import { z } from "zod";

import type { ServerMessage } from "../../daemon/message-protocol.js";
import {
  acceptExtraction,
  dismissExtraction,
  undoExtraction,
} from "../../notes/note-accept.js";
import { landArrivalAsNote } from "../../notes/note-arrivals.js";
import { askNotes } from "../../notes/note-ask.js";
import { createOptionsFor } from "../../notes/note-create.js";
import { readNote } from "../../notes/note-extraction.js";
import { importNotes, MAX_IMPORT_NOTES } from "../../notes/note-import.js";
import { buildNotesWeek } from "../../notes/note-ritual.js";
import {
  createNote,
  deleteNote,
  getAcceptRates,
  getNote,
  getNoteCounts,
  listExtractionsForNote,
  listNotes,
  listWaitingExtractions,
  MAX_NOTE_PAGE,
  type NoteFilter,
  updateNote,
} from "../../notes/note-store.js";
import {
  applyTidy,
  proposeTidy,
  type TidyChoice,
} from "../../notes/note-tidy.js";
import { alignSummaryToTranscript } from "../../notes/note-voice.js";
import { createVoiceNote } from "../../notes/note-voice.js";
import { buildAssistantEvent } from "../assistant-event.js";
import { assistantEventHub } from "../assistant-event-hub.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import type { RouteDefinition } from "./types.js";

const noteSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  source: z
    .enum(["typed", "voice", "selection", "arrival", "import"])
    .describe(
      "How it got here. An arrival obeys acceptance exactly like something typed by hand — this only drives the card's provenance line.",
    ),
  sourceDetail: z
    .string()
    .nullable()
    .describe(
      "The app a selection came from, the channel an arrival used, the tool an import came out of.",
    ),
  projectId: z
    .string()
    .nullable()
    .describe(
      "Null is a legitimate resting state, forever. Unfiled is not a backlog.",
    ),
  audioPath: z
    .string()
    .nullable()
    .describe("Local path. Audio never leaves the machine."),
  audioDurationMs: z.number().int().nullable(),
  transcript: z
    .string()
    .nullable()
    .describe(
      "What was actually said — quotes, not Cue's prose. Kept apart from `body` so a summary can never be laundered as a transcript.",
    ),
  bodyIsSummary: z
    .boolean()
    .describe(
      "True when `body` is Cue's summary rather than the owner's words. A summary is always labelled as one.",
    ),
  extractionState: z
    .enum(["idle", "reading", "done", "failed"])
    .describe(
      "`done` with no extractions = nothing to file, which is the common case and not a failure. `failed` = the request failed and the note is saved. Never render these as the same state.",
    ),
  lastReadHash: z.string().nullable(),
  lastReadAt: z.number().int().nullable(),
  occurredAt: z
    .number()
    .int()
    .describe(
      "When the thought happened, which is not always when the row was made. The list sorts on this.",
    ),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

const conflictSchema = z.object({
  existing: z.string(),
  existingSource: z.string(),
  existingAt: z.number().int().nullable(),
  incoming: z.string(),
  incomingSource: z.string(),
  incomingAt: z.number().int().nullable(),
});

const extractionSchema = z.object({
  id: z.string(),
  noteId: z.string(),
  kind: z.enum(["task", "memory", "person_trait"]),
  payload: z.record(z.string(), z.unknown()),
  confidenceTier: z
    .enum(["confident", "unsure"])
    .describe(
      "A tier, never a percentage. `confident` draws as a solid card with a pre-ticked box; `unsure` draws dashed and hollow with `reason` and an explicit Add.",
    ),
  reason: z
    .string()
    .nullable()
    .describe("Why Cue is unsure, in plain words. Null for `confident`."),
  state: z.enum(["proposed", "accepted", "dismissed"]),
  conflict: conflictSchema
    .nullable()
    .describe(
      "Set when this disagrees with something Cue already believes. The one place accepting can destroy rather than add — offer three answers, never two.",
    ),
  conflictResolution: z.enum(["replace", "keep_both", "ignore"]).nullable(),
  acceptedRefType: z.enum(["work_item", "memory_page", "contact"]).nullable(),
  acceptedRefId: z.string().nullable(),
  createdAt: z.number().int(),
  decidedAt: z.number().int().nullable(),
});

const countsSchema = z.object({
  notes: z.number().int(),
  tasks: z.number().int().describe("Accepted task proposals, counted."),
  memories: z.number().int().describe("Accepted memory proposals, counted."),
  waiting: z
    .number()
    .int()
    .describe(
      "Notes carrying at least one undecided proposal — 'Waiting on you · 3'. The honest consequence of requiring acceptance.",
    ),
  unfiled: z.number().int(),
  recorded: z.number().int(),
});

const FILTERS: readonly NoteFilter[] = [
  "all",
  "waiting",
  "unfiled",
  "recorded",
];

function parseFilter(raw: string | undefined): NoteFilter {
  if (!raw) return "all";
  const found = FILTERS.find((f) => f === raw);
  if (!found) {
    throw new BadRequestError(
      `Unknown filter "${raw}". Expected one of: ${FILTERS.join(", ")}.`,
    );
  }
  return found;
}

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    throw new BadRequestError("`limit` must be a positive number.");
  }
  return Math.min(Math.floor(n), MAX_NOTE_PAGE);
}

function notesChanged(): void {
  void assistantEventHub.publish(
    buildAssistantEvent({ type: "notes_changed" } as ServerMessage),
  );
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "listNotes",
    endpoint: "notes",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "The note list, newest first",
    description:
      "Notes ordered by when the thought happened, not when the row was " +
      "made — a Halo capture, a forwarded mail and an import all carry their " +
      "own time.\n\n" +
      "`filter=waiting` is the pile that acceptance creates: notes with " +
      "proposals nobody has looked at. It exists because requiring " +
      "acceptance means unreviewed findings would otherwise rot invisibly.\n\n" +
      "`filter=unfiled` is a resting state, not a backlog to work through.",
    tags: ["notes"],
    queryParams: [
      {
        name: "filter",
        description: "all (default) | waiting | unfiled | recorded",
        schema: { type: "string" },
      },
      { name: "projectId", schema: { type: "string" } },
      { name: "limit", schema: { type: "number" } },
      { name: "offset", schema: { type: "number" } },
    ],
    responseBody: z.object({
      notes: z.array(noteSchema),
      counts: countsSchema,
    }),
    handler: ({ queryParams }) => {
      const filter = parseFilter(queryParams?.filter);
      const limit = parseLimit(queryParams?.limit);
      const offsetRaw = queryParams?.offset;
      return {
        notes: listNotes({
          filter,
          ...(queryParams?.projectId
            ? { projectId: queryParams.projectId }
            : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(offsetRaw ? { offset: Math.max(0, Number(offsetRaw) || 0) } : {}),
        }),
        counts: getNoteCounts(),
      };
    },
  },

  {
    operationId: "getNote",
    endpoint: "notes/:id",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "One note and its proposals",
    description:
      "The note, plus every proposal Cue has made about it — including ones " +
      "already accepted or dismissed, so the card can say what it produced.",
    tags: ["notes"],
    pathParams: [{ name: "id", type: "uuid" }],
    responseBody: z.object({
      note: noteSchema,
      extractions: z.array(extractionSchema),
    }),
    handler: ({ pathParams }) => {
      const id = pathParams?.id ?? "";
      const note = getNote(id);
      if (!note) throw new NotFoundError("No such note.");
      return { note, extractions: listExtractionsForNote(id) };
    },
  },

  {
    operationId: "createNote",
    endpoint: "notes",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Write a note",
    description:
      "Saves and returns immediately. Nothing is read, proposed or filed " +
      "here: **capture never asks where it goes**, and a note must exist the " +
      "instant the owner stops writing. Reading happens on close or on " +
      "demand, later and separately.\n\n" +
      "Pass a client-minted `id` to make the write idempotent — that is how " +
      "a note captured offline is pushed safely once the connection is back.",
    tags: ["notes"],
    requestBody: z.object({
      id: z
        .string()
        .uuid()
        .optional()
        .describe(
          "A client-minted id. Capture works with no signal, so a note gets its id on the device that wrote it — which makes this write idempotent: the same note pushed twice (a retry after a dropped connection, a relaunch mid-sync) resolves to one row, and the existing row wins rather than being overwritten.",
        ),
      body: z.string(),
      title: z.string().optional(),
      source: z
        .enum(["typed", "voice", "selection", "arrival", "import"])
        .optional(),
      sourceDetail: z.string().nullable().optional(),
      projectId: z.string().nullable().optional(),
      audioPath: z.string().nullable().optional(),
      audioDurationMs: z.number().int().nullable().optional(),
      transcript: z.string().nullable().optional(),
      bodyIsSummary: z.boolean().optional(),
      occurredAt: z.number().int().optional(),
    }),
    responseBody: z.object({ note: noteSchema }),
    responseStatus: "201",
    handler: ({ body }) => {
      const input = (body ?? {}) as Record<string, unknown>;
      if (typeof input.body !== "string") {
        throw new BadRequestError("`body` is required.");
      }
      const note = createNote(
        input as unknown as Parameters<typeof createNote>[0],
      );
      notesChanged();
      return { note };
    },
  },

  {
    operationId: "updateNote",
    endpoint: "notes/:id",
    method: "PATCH",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Edit a note, or file it",
    description:
      "Pass `projectId: null` to unfile. Editing the body does not trigger a " +
      "read — reading is on close or on demand, so that a model call never " +
      "lands mid-sentence on unfinished text.",
    tags: ["notes"],
    pathParams: [{ name: "id", type: "uuid" }],
    requestBody: z.object({
      title: z.string().optional(),
      body: z.string().optional(),
      projectId: z.string().nullable().optional(),
      audioPath: z.string().nullable().optional(),
      transcript: z.string().nullable().optional(),
      bodyIsSummary: z.boolean().optional(),
    }),
    responseBody: z.object({ note: noteSchema }),
    handler: ({ pathParams, body }) => {
      const id = pathParams?.id ?? "";
      const note = updateNote(id, (body ?? {}) as Record<string, never>);
      if (!note) throw new NotFoundError("No such note.");
      notesChanged();
      return { note };
    },
  },

  {
    operationId: "deleteNote",
    endpoint: "notes/:id",
    method: "DELETE",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Delete a note",
    description:
      "Removes the note and its proposals. **Work accepted out of it is not " +
      "touched** — provenance is one-way, so the task keeps pointing back " +
      "and renders 'from a note you deleted'. Cascading would mean tidying " +
      "your notes silently empties your HQ.",
    tags: ["notes"],
    pathParams: [{ name: "id", type: "uuid" }],
    responseBody: z.object({ deleted: z.boolean() }),
    handler: ({ pathParams }) => {
      const deleted = deleteNote(pathParams?.id ?? "");
      if (!deleted) throw new NotFoundError("No such note.");
      notesChanged();
      return { deleted };
    },
  },

  {
    operationId: "readNote",
    endpoint: "notes/:id/read",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Find things to do in this note",
    description:
      "Runs the read — on close, or when the owner explicitly asks. " +
      "**Proposes only; writes nothing anywhere else.**\n\n" +
      'Unchanged text is never re-read (`status: "skipped"`), so reopening ' +
      "and closing a note without editing it costs nothing. Pass " +
      "`force: true` for the explicit 'find things to do' action.\n\n" +
      "Read `status` carefully: `done` with an empty `extractions` array is " +
      "a successful read that found nothing — the common case — while " +
      "`failed` means the request failed and the note is still saved. They " +
      "are different sentences to a person.\n\n" +
      "Spend appears in the ledger under 'Reading your notes'.",
    tags: ["notes"],
    pathParams: [{ name: "id", type: "uuid" }],
    requestBody: z.object({ force: z.boolean().optional() }),
    responseBody: z.object({
      status: z.enum(["skipped", "done", "failed"]),
      skippedReason: z.enum(["unchanged", "disabled", "missing"]).nullable(),
      extractions: z.array(extractionSchema),
    }),
    handler: async ({ pathParams, body }) => {
      const id = pathParams?.id ?? "";
      if (!getNote(id)) throw new NotFoundError("No such note.");
      const force = (body as { force?: boolean } | undefined)?.force === true;
      const outcome = await readNote(id, { force });
      notesChanged();
      if (outcome.status === "done") {
        return {
          status: "done",
          skippedReason: null,
          extractions: outcome.proposals,
        };
      }
      if (outcome.status === "failed") {
        return { status: "failed", skippedReason: null, extractions: [] };
      }
      return {
        status: "skipped",
        skippedReason: outcome.reason,
        extractions: listExtractionsForNote(id),
      };
    },
  },

  {
    operationId: "listWaitingExtractions",
    endpoint: "notes/extractions/waiting",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Every proposal nobody has decided yet",
    description:
      "What 'Waiting on you' reads — in Notes, and in the morning brief and " +
      "weekly review. Acceptance only works if the pile is visible from the " +
      "surfaces that come to you, not just from the one you have to remember " +
      "to visit.",
    tags: ["notes"],
    queryParams: [{ name: "limit", schema: { type: "number" } }],
    responseBody: z.object({ extractions: z.array(extractionSchema) }),
    handler: ({ queryParams }) => ({
      extractions: listWaitingExtractions(parseLimit(queryParams?.limit) ?? 50),
    }),
  },

  {
    operationId: "acceptNoteExtraction",
    endpoint: "notes/:id/extractions/:extractionId/accept",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Accept one proposal",
    description:
      "**The only route in Notes that writes to HQ, memory or People.** A " +
      "task becomes a work item carrying this note's id; a memory becomes a " +
      "concept page; a person trait lands on the contact.\n\n" +
      "When the proposal carries a `conflict`, pass `resolution`: `replace` " +
      "(the old value was wrong), `keep_both` (the default — prices and " +
      "dates legitimately change, so Cue keeps the history and uses the " +
      "newer) or `ignore` (record nothing). Omitting it on a conflicting " +
      "proposal defaults to `keep_both`, because a caller that forgot to ask " +
      "must never be the reason a true fact is overwritten.\n\n" +
      "If the write fails the proposal stays `proposed` — it is never marked " +
      "accepted for something that did not happen.",
    tags: ["notes"],
    pathParams: [
      { name: "id", type: "uuid" },
      { name: "extractionId", type: "uuid" },
    ],
    requestBody: z.object({
      resolution: z.enum(["replace", "keep_both", "ignore"]).optional(),
    }),
    responseBody: z.object({
      status: z.enum(["accepted", "dismissed", "already_decided", "failed"]),
      extraction: extractionSchema.nullable(),
      refType: z.enum(["work_item", "memory_page", "contact"]).nullable(),
      refId: z.string().nullable(),
      error: z.string().nullable(),
    }),
    handler: async ({ pathParams, body }) => {
      const extractionId = pathParams?.extractionId ?? "";
      const resolution = (
        body as { resolution?: "replace" | "keep_both" | "ignore" } | undefined
      )?.resolution;
      const result = await acceptExtraction(extractionId, {
        ...(resolution ? { resolution } : {}),
      });
      if (result.status === "not_found") {
        throw new NotFoundError("No such proposal.");
      }
      notesChanged();
      return {
        status: result.status,
        extraction: "extraction" in result ? result.extraction : null,
        refType: result.status === "accepted" ? result.refType : null,
        refId: result.status === "accepted" ? result.refId : null,
        error: result.status === "failed" ? result.error : null,
      };
    },
  },

  {
    operationId: "undoNoteExtraction",
    endpoint: "notes/:id/extractions/:extractionId/undo",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Take back an acceptance",
    description:
      "Undo is a **reversal, not a delete**. It exists so pressing Accept is " +
      "not a decision you have to be sure about — which is only true while " +
      "the thing acceptance created is still exactly as it left it.\n\n" +
      "So it is bounded, and it says why it refused. Once Cue has started " +
      "the task, or the memory page has been edited around the line, taking " +
      "it back would destroy work rather than reverse a click — `too_late` " +
      "carries a sentence explaining that. A refusal someone understands " +
      "beats an undo that silently does the wrong thing.\n\n" +
      "It removes exactly what acceptance wrote, recorded at the time rather " +
      "than reconstructed now: a rebuilt line drifts the moment the " +
      "formatting changes, and removing the wrong line is worse than none.",
    tags: ["notes"],
    pathParams: [
      { name: "id", type: "uuid" },
      { name: "extractionId", type: "uuid" },
    ],
    responseBody: z.object({
      status: z.enum(["undone", "not_accepted", "too_late", "failed"]),
      extraction: extractionSchema.nullable(),
      reason: z.string().nullable(),
    }),
    handler: async ({ pathParams }) => {
      const result = await undoExtraction(pathParams?.extractionId ?? "");
      if (result.status === "not_found") {
        throw new NotFoundError("No such proposal.");
      }
      notesChanged();
      return {
        status: result.status,
        extraction: "extraction" in result ? result.extraction : null,
        reason: result.status === "too_late" ? result.reason : null,
      };
    },
  },

  {
    operationId: "dismissNoteExtraction",
    endpoint: "notes/:id/extractions/:extractionId/dismiss",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Dismiss one proposal",
    description: "Writes nothing anywhere. That is the entire point.",
    tags: ["notes"],
    pathParams: [
      { name: "id", type: "uuid" },
      { name: "extractionId", type: "uuid" },
    ],
    responseBody: z.object({
      status: z.enum(["dismissed", "already_decided"]),
      extraction: extractionSchema,
    }),
    handler: ({ pathParams }) => {
      const result = dismissExtraction(pathParams?.extractionId ?? "");
      if (result.status === "not_found") {
        throw new NotFoundError("No such proposal.");
      }
      if (!("extraction" in result)) {
        throw new BadRequestError("That proposal cannot be dismissed.");
      }
      notesChanged();
      return { status: result.status, extraction: result.extraction };
    },
  },

  {
    operationId: "getNoteCreateOptions",
    endpoint: "notes/:id/create-options",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "What Cue could make from this note",
    description:
      "A note is a brief. This connects three surfaces that were islands — " +
      "Notes → Create → Library — with provenance running the whole way: the " +
      "deck knows its brief, the brief knows its note, so a deck can always " +
      "answer 'where did this come from?'\n\n" +
      "The options are the note's **plausible** outputs, not a menu of " +
      "everything Create can do: a note about a customer offers a deck and " +
      "an email, not a video style. Never more than four.\n\n" +
      "Provenance stays one-way — deleting the note never deletes the deck.",
    tags: ["notes"],
    pathParams: [{ name: "id", type: "uuid" }],
    responseBody: z.object({
      options: z.array(
        z.object({
          kind: z.enum(["deck", "one_pager", "email", "plan", "doc"]),
          label: z.string(),
          prompt: z
            .string()
            .describe(
              "The brief to hand Create. Says the note is the source and that nothing outside it may be invented.",
            ),
        }),
      ),
    }),
    handler: ({ pathParams }) => {
      const note = getNote(pathParams?.id ?? "");
      if (!note) throw new NotFoundError("No such note.");
      return { options: createOptionsFor(note) };
    },
  },

  {
    operationId: "tidyNote",
    endpoint: "notes/:id/tidy",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Propose a tidied version — only when asked",
    description:
      "**Writes nothing.** Returns both texts so the client can show a diff " +
      "and offer three answers: use the tidied one, keep mine, keep both.\n\n" +
      "Cue never touches the owner's text unless asked. Nothing calls this " +
      "on a timer, on save or on close, and there is deliberately no `✧` " +
      "button in the editor inviting a rewrite — the tidy lives in `⋯`, " +
      "where you go looking for it. An assistant that silently rewrites what " +
      "you typed makes the note untrustworthy as a record of what you " +
      "actually thought, which is the only reason to keep notes at all.\n\n" +
      "`refused` means the model gave back something that was not a tidy — it " +
      "added or lost too much — so the owner's words were kept. That is " +
      "different from `failed`, which means the request did not complete.",
    tags: ["notes"],
    pathParams: [{ name: "id", type: "uuid" }],
    responseBody: z.object({
      status: z.enum(["tidied", "refused", "failed"]),
      original: z.string().nullable(),
      tidied: z.string().nullable(),
    }),
    handler: async ({ pathParams }) => {
      const result = await proposeTidy(pathParams?.id ?? "");
      if (result.status === "not_found") {
        throw new NotFoundError("No such note.");
      }
      return {
        status: result.status,
        original: result.status === "tidied" ? result.original : null,
        tidied: result.status === "tidied" ? result.tidied : null,
      };
    },
  },

  {
    operationId: "applyNoteTidy",
    endpoint: "notes/:id/tidy/apply",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Record what the owner chose about a tidy",
    description:
      "`use_tidied` swaps the body **and keeps the original**, so 'keep mine' " +
      "still works tomorrow — the tidy is a version, not a replacement, and " +
      "that promise has to survive the session it was made in. The note is " +
      "then marked as carrying Cue's words rather than the owner's, so every " +
      "surface labels it.\n\n" +
      "`keep_both` appends the tidied text below the original. `keep_mine` " +
      "writes nothing at all.",
    tags: ["notes"],
    pathParams: [{ name: "id", type: "uuid" }],
    requestBody: z.object({
      choice: z.enum(["use_tidied", "keep_mine", "keep_both"]),
      tidied: z.string(),
    }),
    responseBody: z.object({ note: noteSchema }),
    handler: ({ pathParams, body }) => {
      const input = (body ?? {}) as { choice?: unknown; tidied?: unknown };
      if (typeof input.tidied !== "string") {
        throw new BadRequestError("`tidied` is required.");
      }
      const note = applyTidy(
        pathParams?.id ?? "",
        input.choice as TidyChoice,
        input.tidied,
      );
      if (!note) throw new NotFoundError("No such note.");
      notesChanged();
      return { note };
    },
  },

  {
    operationId: "createVoiceNote",
    endpoint: "notes/voice",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Turn a recording into a note",
    description:
      "The same note, entered by speaking.\n\n" +
      "**A summary is never laundered as a transcript.** What was said and " +
      "what Cue made of it are two artefacts: `transcript` is quotes, `body` " +
      "is Cue's prose, and `bodyIsSummary` says which the body is. Collapsing " +
      "them is how someone quotes a sentence to a colleague that nobody " +
      "actually said.\n\n" +
      "Short recordings are not summarised at all — 'don't lead with price' " +
      "IS the summary, and paraphrasing it takes the owner's words away for " +
      "nothing.\n\n" +
      "**Audio is local.** `audioPath` points at this device and is nullable " +
      "precisely so 'delete audio, keep note' is always available.\n\n" +
      "`empty` means nothing intelligible was in the recording — people " +
      "misfire, and that is not an error.",
    tags: ["notes"],
    requestBody: z.object({
      audioBase64: z.string(),
      mimeType: z.string(),
      audioPath: z.string().nullable().optional(),
      audioDurationMs: z.number().int().nullable().optional(),
      occurredAt: z.number().int().optional(),
      projectId: z.string().nullable().optional(),
    }),
    responseBody: z.object({
      status: z.enum(["created", "empty", "no_provider", "failed"]),
      note: noteSchema.nullable(),
      reason: z.string().nullable(),
    }),
    responseStatus: "201",
    handler: async ({ body }) => {
      const input = (body ?? {}) as {
        audioBase64?: unknown;
        mimeType?: unknown;
      };
      if (typeof input.audioBase64 !== "string" || !input.audioBase64) {
        throw new BadRequestError("`audioBase64` is required.");
      }
      if (typeof input.mimeType !== "string") {
        throw new BadRequestError("`mimeType` is required.");
      }
      const rest = body as Record<string, unknown>;
      const result = await createVoiceNote({
        audio: Buffer.from(input.audioBase64, "base64"),
        mimeType: input.mimeType,
        ...(rest.audioPath !== undefined
          ? { audioPath: rest.audioPath as string | null }
          : {}),
        ...(rest.audioDurationMs !== undefined
          ? { audioDurationMs: rest.audioDurationMs as number | null }
          : {}),
        ...(rest.occurredAt !== undefined
          ? { occurredAt: rest.occurredAt as number }
          : {}),
        ...(rest.projectId !== undefined
          ? { projectId: rest.projectId as string | null }
          : {}),
      });
      if (result.status === "created") notesChanged();
      return {
        status: result.status,
        note: result.status === "created" ? result.note : null,
        reason:
          result.status === "no_provider" || result.status === "failed"
            ? result.reason
            : null,
      };
    },
  },

  {
    operationId: "getNoteSummaryAlignment",
    endpoint: "notes/:id/alignment",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Where each summary sentence came from in the recording",
    description:
      "Makes a summary **checkable against its source** instead of asking to " +
      "be believed: tap a sentence, hear that moment.\n\n" +
      "`atMs` is null where a sentence could not be located. That is honest " +
      "and renders as a sentence you cannot tap — a link that played the " +
      "wrong moment would defeat the entire point of being able to check.",
    tags: ["notes"],
    pathParams: [{ name: "id", type: "uuid" }],
    responseBody: z.object({
      sentences: z.array(
        z.object({ text: z.string(), atMs: z.number().int().nullable() }),
      ),
    }),
    handler: ({ pathParams }) => {
      const note = getNote(pathParams?.id ?? "");
      if (!note) throw new NotFoundError("No such note.");
      // Only a real summary has anything to align. A verbatim body IS the
      // source, so every sentence would trivially "match" itself.
      if (!note.bodyIsSummary || !note.transcript) return { sentences: [] };
      return {
        sentences: alignSummaryToTranscript(
          note.body,
          note.transcript,
          note.audioDurationMs,
        ),
      };
    },
  },

  {
    operationId: "landArrivalNote",
    endpoint: "notes/arrivals",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Land an inbound capture as a note",
    description:
      "Halo, forwarded mail and meeting capture all land here.\n\n" +
      "**An arrival becomes a NOTE, never a task.** That restraint is what " +
      "stops inbound capture becoming the silent-write problem at volume — a " +
      "wearable that hears six hours of your day, turned straight into work " +
      "items, fills your HQ with things you never agreed to. As a note it " +
      "obeys acceptance exactly like something you typed.\n\n" +
      "It is also what gives Halo a real destination: a wearable that " +
      "captures your day needs somewhere for the day to land, and a note is " +
      "the right shape — unstructured, reviewable, already wired to become " +
      "work.\n\n" +
      "`bodyIsSummary` defaults to true for `halo` and `meeting`: both arrive " +
      "as Cue's prose over someone's speech, and prose not labelled a summary " +
      "reads as a quote.",
    tags: ["notes"],
    requestBody: z.object({
      channel: z.enum(["halo", "email", "meeting"]),
      title: z.string(),
      body: z.string(),
      occurredAt: z
        .number()
        .int()
        .optional()
        .describe(
          "When it HAPPENED. A kitchen conversation at 09:14 that syncs at 18:00 belongs at 09:14, or the day reads out of order.",
        ),
      audioPath: z
        .string()
        .nullable()
        .optional()
        .describe("Local path. Audio never leaves the device."),
      audioDurationMs: z.number().int().nullable().optional(),
      transcript: z.string().nullable().optional(),
      bodyIsSummary: z.boolean().optional(),
      projectId: z.string().nullable().optional(),
    }),
    responseBody: z.object({ note: noteSchema.nullable() }),
    responseStatus: "201",
    handler: ({ body }) => {
      const input = (body ?? {}) as { channel?: unknown; body?: unknown };
      if (typeof input.body !== "string" || !input.body.trim()) {
        throw new BadRequestError("`body` is required.");
      }
      const note = landArrivalAsNote(
        input as unknown as Parameters<typeof landArrivalAsNote>[0],
      );
      if (note) notesChanged();
      return { note };
    },
  },

  {
    operationId: "importNotes",
    endpoint: "notes/import",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Bring an existing pile of notes in",
    description:
      "Turns Notes from a feature that needs six months of discipline into " +
      "one that is worth something on night one.\n\n" +
      "**Imported notes are searchable immediately, always.** The only " +
      "question `window` answers is what gets PROPOSED as work, and it " +
      "defaults to `last_month` deliberately: proposing 73 tasks from two " +
      "years of archive makes someone's HQ unusable on their first day, and " +
      'a two-year-old "call the dentist" is not a live commitment.\n\n' +
      "An import creates NOTES, never tasks — imported findings obey " +
      "acceptance exactly like something typed by hand.\n\n" +
      "Parsing happens here, on the owner's own machine. Nothing is uploaded.",
    tags: ["notes"],
    requestBody: z.object({
      notes: z.array(
        z.object({
          title: z.string().optional(),
          body: z.string(),
          occurredAt: z
            .number()
            .int()
            .optional()
            .describe(
              "The note's own date from the export. Without it every imported note dates from the import, which puts a decade of writing at the top of today's list and makes the window meaningless.",
            ),
        }),
      ),
      tool: z
        .enum([
          "apple-notes",
          "notion",
          "obsidian",
          "mem",
          "markdown",
          "unknown",
        ])
        .optional(),
      window: z.enum(["last_month", "all", "none"]).optional(),
    }),
    responseBody: z.object({
      imported: z.number().int(),
      skipped: z.number().int(),
      queuedForReading: z
        .number()
        .int()
        .describe(
          "How many fall inside the window and will be read. Shown BEFORE anything is proposed, so 'only the last month' is checkable rather than a promise to trust.",
        ),
      window: z.enum(["last_month", "all", "none"]),
    }),
    responseStatus: "201",
    handler: ({ body }) => {
      const input = (body ?? {}) as {
        notes?: unknown;
        tool?: never;
        window?: never;
      };
      if (!Array.isArray(input.notes)) {
        throw new BadRequestError("`notes` must be an array.");
      }
      if (input.notes.length > MAX_IMPORT_NOTES) {
        throw new BadRequestError(
          `That is more than ${MAX_IMPORT_NOTES} notes — split it into smaller batches.`,
        );
      }
      const { summary } = importNotes(
        input.notes as Parameters<typeof importNotes>[0],
        {
          ...(input.tool ? { tool: input.tool } : {}),
          ...(input.window ? { window: input.window } : {}),
        },
      );
      notesChanged();
      return summary;
    },
  },

  {
    operationId: "askNotes",
    endpoint: "notes/ask",
    method: "POST",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Ask a question across notes, mail, work and memory",
    description:
      "Answers out of the owner's notes AND their mail AND the work already " +
      "queued AND memory. Scoping it to notes alone would make the answer " +
      "**wrong by omission** — the five-month-old note that nobody would " +
      "have gone looking for is the whole point, and it only surfaces " +
      "because the question was asked of everything at once.\n\n" +
      "**Every claim is numbered to a citation, and an unsourced sentence " +
      "never renders** — that is enforced on the model's output in code, not " +
      "requested in the prompt. A true sentence the model forgot to cite is " +
      "dropped, which is the right way to be wrong here.\n\n" +
      "`nothing_found` and `failed` are different answers and must be shown " +
      "differently: one is about the question, the other about the request.\n\n" +
      "**Nothing is saved.** Asking a question must not quietly create a note, " +
      "and the answer itself is not persisted anywhere.",
    tags: ["notes"],
    requestBody: z.object({ question: z.string() }),
    responseBody: z.object({
      status: z.enum(["answered", "nothing_found", "failed"]),
      answer: z.string().nullable(),
      citations: z.array(
        z.object({
          n: z.number().int().describe("Matches the [n] markers in `answer`."),
          source: z.string(),
          title: z.string(),
          locator: z
            .string()
            .describe(
              "Resolvable by the client — `notes/<id>`, `work/<id>`, `arrivals/<id>` — so a citation is something you can open rather than a claim you must believe.",
            ),
          excerpt: z.string(),
          timestampMs: z.number().int().nullable(),
          stale: z
            .boolean()
            .describe(
              "Old enough that its age is part of judging it. Say so in the UI; do not hide it and do not drop it.",
            ),
        }),
      ),
    }),
    handler: async ({ body }) => {
      const question = (body as { question?: unknown } | undefined)?.question;
      if (typeof question !== "string" || !question.trim()) {
        throw new BadRequestError("`question` is required.");
      }
      const result = await askNotes(question);
      return {
        status: result.status,
        answer: result.status === "answered" ? result.answer : null,
        citations: result.status === "answered" ? result.citations : [],
      };
    },
  },

  {
    operationId: "getNotesWeek",
    endpoint: "notes/week",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "What the week's notes actually did",
    description:
      "The weekly review's line — 'you took 14 notes, 9 became work, 5 were " +
      "just thinking'.\n\n" +
      "The second half matters as much as the first. A review that counted " +
      "only conversions would teach people that unfiled notes are debt, and " +
      "they are not: the walking-to-work thought is the highest-value note " +
      "in the system.\n\n" +
      "`becameWork` counts NOTES that produced an accepted task, not accepted " +
      "proposals — otherwise one note with three tasks reads as three notes " +
      "that became work.\n\n" +
      "Null when no notes were taken: a weekly that says 'you took 0 notes' " +
      "is a line people learn to skip.",
    tags: ["notes"],
    queryParams: [
      {
        name: "sinceMs",
        description:
          "Start of the window, epoch ms. Defaults to seven days ago.",
        schema: { type: "number" },
      },
    ],
    responseBody: z.object({
      week: z
        .object({
          taken: z.number().int(),
          becameWork: z.number().int(),
          line: z.string().describe("Already written. Render it as-is."),
        })
        .nullable(),
    }),
    handler: ({ queryParams }) => {
      const raw = queryParams?.sinceMs;
      const since = raw ? Number(raw) : Date.now() - 7 * 24 * 3600_000;
      if (!Number.isFinite(since)) {
        throw new BadRequestError("`sinceMs` must be a number.");
      }
      return { week: buildNotesWeek(since) };
    },
  },

  {
    operationId: "getNoteAcceptRates",
    endpoint: "notes/accept-rates",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Accept rate per extraction type",
    description:
      "The number that says whether this feature works, available from day " +
      "one rather than retrofitted after a week of not knowing. Split by " +
      "kind and tier because they fail differently: a low `unsure` accept " +
      "rate means the tier is doing its job, a low `confident` rate means " +
      "the extractor is wrong.\n\n" +
      "If it is low, the answer is fewer and better extractions — not more " +
      "prompting.",
    tags: ["notes"],
    queryParams: [
      {
        name: "sinceMs",
        description: "Only count proposals made at or after this epoch ms.",
        schema: { type: "number" },
      },
    ],
    responseBody: z.object({
      rates: z.array(
        z.object({
          kind: z.enum(["task", "memory", "person_trait"]),
          confidenceTier: z.enum(["confident", "unsure"]),
          proposed: z.number().int(),
          accepted: z.number().int(),
          dismissed: z.number().int(),
        }),
      ),
    }),
    handler: ({ queryParams }) => {
      const raw = queryParams?.sinceMs;
      const since = raw ? Number(raw) : undefined;
      if (raw && !Number.isFinite(since)) {
        throw new BadRequestError("`sinceMs` must be a number.");
      }
      return { rates: getAcceptRates(since) };
    },
  },
];
