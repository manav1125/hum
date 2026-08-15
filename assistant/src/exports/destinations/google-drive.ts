/**
 * Google Drive destination.
 *
 * Two routes, chosen by payload shape, because Composio's Drive toolkit
 * exposes two different actions and only one of them needs the file-upload
 * dance:
 *
 *  - binary (pdf, png, docx, xlsx) → `GOOGLEDRIVE_UPLOAD_FILE`, which takes a
 *    `file_uploadable` reference minted by `uploadBytesToComposio`. Capped at
 *    5 MB by Composio.
 *  - text (markdown, html) → `GOOGLEDRIVE_CREATE_FILE_FROM_TEXT`, which takes
 *    the content inline and skips object storage entirely. Capped at 10 MB.
 *
 * Both were exercised against the live Composio API on 2026-08-15.
 */

import {
  COMPOSIO_MAX_UPLOAD_BYTES,
  executeComposioAction,
  uploadBytesToComposio,
} from "./composio-transport.js";
import type {
  Destination,
  DestinationOutcome,
  DestinationSendContext,
  DestinationTarget,
  ExportPayload,
} from "./types.js";
import { notSent, payloadText, sent } from "./types.js";

const UPLOAD_ACTION = "GOOGLEDRIVE_UPLOAD_FILE";
const CREATE_FROM_TEXT_ACTION = "GOOGLEDRIVE_CREATE_FILE_FROM_TEXT";

/** The inline-text route's ceiling, per Composio's action description. */
const TEXT_MAX_BYTES = 10 * 1024 * 1024;

/** Build the Drive web link from a file id — Drive returns only the id. */
export function driveFileUrl(fileId: string): string {
  return `https://drive.google.com/file/d/${fileId}/view`;
}

export const googleDriveDestination: Destination = {
  id: "google_drive",
  label: "Google Drive",
  toolkit: "googledrive",
  accepts: { binary: true, text: true },
  // The binary route is the narrower of the two; the text route's larger
  // allowance is applied inside `send`, where the shape is known.
  maxBytes: TEXT_MAX_BYTES,
  targetHelp:
    "Google Drive folder ID (optional — omitted means My Drive root).",

  async send(
    payload: ExportPayload,
    target: DestinationTarget,
    context: DestinationSendContext,
  ): Promise<DestinationOutcome> {
    const folderId = target.id?.trim() || undefined;
    const text = payloadText(payload);

    if (text !== null) {
      const result = await executeComposioAction(
        CREATE_FROM_TEXT_ACTION,
        {
          file_name: payload.filename,
          text_content: text,
          mime_type: payload.mimeType,
          ...(folderId ? { parent_id: folderId } : {}),
        },
        context.signal,
      );
      if (!result.ok) {
        return notSent(
          result.notConnected ? "not_connected" : "destination_error",
          result.notConnected
            ? "Google Drive is not connected — connect it in Connectors, then try again."
            : `Google Drive refused the file: ${result.error}`,
        );
      }
      const fileId = String(result.data.id ?? "");
      if (!fileId) {
        return notSent(
          "destination_error",
          "Google Drive did not return a file ID, so the upload could not be confirmed.",
        );
      }
      return sent(`Saved ${payload.filename} to Google Drive.`, {
        fileId,
        url: driveFileUrl(fileId),
        ...(folderId ? { folderId } : {}),
      });
    }

    if (payload.bytes.length > COMPOSIO_MAX_UPLOAD_BYTES) {
      return notSent(
        "too_large",
        `${payload.filename} is ${Math.round(payload.bytes.length / 1024)} KB. Binary uploads to Google Drive are capped at 5 MB.`,
      );
    }

    const upload = await uploadBytesToComposio(
      "googledrive",
      UPLOAD_ACTION,
      payload,
      context.signal,
    );
    if (!upload.ok) {
      return notSent("destination_error", upload.error);
    }

    const result = await executeComposioAction(
      UPLOAD_ACTION,
      {
        file_to_upload: upload.ref,
        ...(folderId ? { folder_to_upload_to: folderId } : {}),
      },
      context.signal,
    );
    if (!result.ok) {
      return notSent(
        result.notConnected ? "not_connected" : "destination_error",
        result.notConnected
          ? "Google Drive is not connected — connect it in Connectors, then try again."
          : `Google Drive refused the upload: ${result.error}`,
      );
    }

    const fileId = String(result.data.id ?? "");
    if (!fileId) {
      return notSent(
        "destination_error",
        "Google Drive did not return a file ID, so the upload could not be confirmed.",
      );
    }
    return sent(`Uploaded ${payload.filename} to Google Drive.`, {
      fileId,
      url: driveFileUrl(fileId),
      ...(folderId ? { folderId } : {}),
    });
  },
};
