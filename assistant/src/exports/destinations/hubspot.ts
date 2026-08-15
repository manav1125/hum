/**
 * HubSpot destination — a note on a CRM record.
 *
 * The blunt fact, checked against all 300 actions in Composio's HubSpot
 * toolkit: there is no file-upload action. HubSpot's Files API is multipart,
 * and Composio's execute surface is JSON-only, so there is no route by which a
 * PDF can become a HubSpot attachment from here. Pretending otherwise would
 * mean either a silent no-op or a broken link on a deal record.
 *
 * What does work, and is what people actually want on a deal, is the document
 * *content* as a note associated with the record. That is what this does: one
 * `notes` object carrying the text, associated to the contact/company/deal/
 * ticket in the same call.
 */

import { executeComposioAction } from "./composio-transport.js";
import type {
  Destination,
  DestinationOutcome,
  DestinationSendContext,
  DestinationTarget,
  ExportPayload,
} from "./types.js";
import { notSent, payloadText, sent } from "./types.js";

const CREATE_ACTION = "HUBSPOT_CREATE_CRM_OBJECT_WITH_PROPERTIES";

const HUBSPOT_MAX_BYTES = 1 * 1024 * 1024;

/**
 * HubSpot's standard association type IDs for a note attached to each object
 * type. These are HUBSPOT_DEFINED and stable across portals.
 */
const NOTE_ASSOCIATION_TYPE_IDS: Record<string, number> = {
  contacts: 202,
  companies: 190,
  deals: 214,
  tickets: 228,
};

export const HUBSPOT_OBJECT_TYPES = Object.keys(NOTE_ASSOCIATION_TYPE_IDS);

export const hubspotDestination: Destination = {
  id: "hubspot",
  label: "HubSpot",
  toolkit: "hubspot",
  accepts: { binary: false, text: true },
  maxBytes: HUBSPOT_MAX_BYTES,
  targetHelp:
    "HubSpot record ID to attach the note to, plus `object_type` (one of: " +
    `${HUBSPOT_OBJECT_TYPES.join(", ")}).`,

  async send(
    payload: ExportPayload,
    target: DestinationTarget,
    context: DestinationSendContext,
  ): Promise<DestinationOutcome> {
    const recordId = target.id?.trim();
    if (!recordId) {
      return notSent(
        "bad_target",
        "Name the HubSpot record ID the note should be attached to.",
      );
    }

    const objectType = (target.objectType ?? "deals").trim().toLowerCase();
    const associationTypeId = NOTE_ASSOCIATION_TYPE_IDS[objectType];
    if (associationTypeId === undefined) {
      return notSent(
        "bad_target",
        `"${objectType}" is not a HubSpot object type a note can attach to. Use one of: ${HUBSPOT_OBJECT_TYPES.join(", ")}.`,
      );
    }

    const text = payloadText(payload);
    if (text === null) {
      return notSent(
        "unsupported_payload",
        "HubSpot can only take the document as `markdown` — Composio's HubSpot toolkit has no file-upload action, so a PDF or Office file cannot be attached to a record from here.",
      );
    }

    const heading = payload.title?.trim() || payload.filename;
    const result = await executeComposioAction(
      CREATE_ACTION,
      {
        objectType: "notes",
        properties: {
          hs_note_body: `${heading}\n\n${text}`,
          hs_timestamp: new Date().toISOString(),
        },
        associations: [
          {
            to__id: recordId,
            types: [
              {
                associationCategory: "HUBSPOT_DEFINED",
                associationTypeId,
              },
            ],
          },
        ],
      },
      context.signal,
    );

    if (!result.ok) {
      return notSent(
        result.notConnected ? "not_connected" : "destination_error",
        result.notConnected
          ? "HubSpot is not connected — connect it in Connectors, then try again."
          : `HubSpot refused the note: ${result.error}`,
      );
    }

    const noteId = String(result.data.id ?? "");
    if (!noteId) {
      return notSent(
        "destination_error",
        "HubSpot did not return a note ID, so the write could not be confirmed.",
      );
    }

    return sent(
      `Added "${heading}" as a note on ${objectType.replace(/s$/, "")} ${recordId}.`,
      { noteId, recordId, objectType },
    );
  },
};
