/**
 * Binary transport for Composio actions — the piece that did not exist.
 *
 * Composio's tool-execute surface is JSON all the way down: there is no
 * multipart body and no inline base64 field. Actions that take a file declare
 * a `file_uploadable` parameter whose value is `{name, mimetype, s3key}`, and
 * the `s3key` has to be minted first by handing the bytes to Composio's own
 * object store. So "upload this file" is three calls, not one:
 *
 *   1. POST /files/upload/request  → { key, new_presigned_url, type }
 *   2. PUT  <new_presigned_url>    → the raw bytes
 *   3. POST /tools/execute/<SLUG>  → { file_to_upload: {name, mimetype, s3key} }
 *
 * Step 1 is content-addressed by MD5, so re-sending the same bytes for the
 * same action returns a non-"new" `type` and step 2 can be skipped — Composio
 * already has them.
 *
 * Verified against the live Composio API on 2026-08-15 (a real PDF landed in
 * Drive through exactly this sequence). The 5 MB ceiling is Composio's, stated
 * in the `GOOGLEDRIVE_UPLOAD_FILE` action description.
 */

import { createHash } from "node:crypto";

import { readOwnComposioIdentity } from "../../capabilities/composio-mcp-provision.js";
import { getLogger } from "../../util/logger.js";

const log = getLogger("composio-transport");

const COMPOSIO_API = "https://backend.composio.dev/api/v3";

/**
 * Composio's documented ceiling for a `file_uploadable` parameter. Enforced
 * locally so an oversized export fails before it costs a round trip.
 */
export const COMPOSIO_MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** The `{name, mimetype, s3key}` triple a `file_uploadable` parameter wants. */
export interface ComposioFileRef {
  name: string;
  mimetype: string;
  s3key: string;
}

export type ComposioResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string; notConnected: boolean };

interface ComposioIdentity {
  apiKey: string;
  userId: string;
}

function identity(): ComposioIdentity | null {
  const own = readOwnComposioIdentity();
  if (!own?.apiKey || !own.userId) return null;
  return { apiKey: own.apiKey, userId: own.userId };
}

/**
 * Whether an error string is the connector being unusable rather than the
 * request being wrong. Worth distinguishing because the two have completely
 * different fixes — reconnect the account vs. fix the call — and the user only
 * ever acts on the first.
 */
function looksLikeAuthFailure(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("no connected account") ||
    m.includes("not connected") ||
    m.includes("connection not found") ||
    m.includes("expired") ||
    m.includes("invalid_grant") ||
    m.includes("unauthorized") ||
    m.includes("401") ||
    m.includes("403")
  );
}

/**
 * Execute one Composio action and report honestly whether it worked.
 *
 * Composio reports per-action failures *inside* an HTTP 200 envelope
 * (`{data, successful, error, log_id}`), so an HTTP-only check would call a
 * failed send a success. Both layers are checked here, and the result type has
 * no "probably fine" state.
 */
export async function executeComposioAction(
  toolSlug: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ComposioResult> {
  const creds = identity();
  if (!creds) {
    return {
      ok: false,
      error: "This instance has no Composio connector credentials.",
      notConnected: true,
    };
  }

  let response: Response;
  try {
    response = await fetch(
      `${COMPOSIO_API}/tools/execute/${encodeURIComponent(toolSlug)}`,
      {
        method: "POST",
        headers: {
          "x-api-key": creds.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ user_id: creds.userId, arguments: args }),
        signal,
      },
    );
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.warn({ toolSlug, err }, "Composio execute transport failed");
    return { ok: false, error, notConnected: false };
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const error = `Composio ${toolSlug} returned HTTP ${response.status}${
      detail ? `: ${detail.slice(0, 300)}` : ""
    }`;
    return { ok: false, error, notConnected: looksLikeAuthFailure(error) };
  }

  let envelope: {
    data?: unknown;
    successful?: boolean;
    error?: unknown;
  };
  try {
    envelope = (await response.json()) as typeof envelope;
  } catch {
    return {
      ok: false,
      error: `Composio ${toolSlug} returned a body that is not JSON.`,
      notConnected: false,
    };
  }

  // The envelope check, not the HTTP check, is what makes a silent failure
  // impossible: `successful: false` arrives with a 200.
  const envelopeError =
    typeof envelope.error === "string" && envelope.error
      ? envelope.error
      : null;
  if (envelope.successful === false || envelopeError) {
    const error = envelopeError ?? `Composio ${toolSlug} reported failure.`;
    return { ok: false, error, notConnected: looksLikeAuthFailure(error) };
  }

  // A success with no data is not evidence of a write. Treat it as a failure
  // rather than telling the user their file arrived somewhere unverifiable.
  if (!envelope.data || typeof envelope.data !== "object") {
    return {
      ok: false,
      error: `Composio ${toolSlug} reported success but returned nothing to confirm it.`,
      notConnected: false,
    };
  }

  return { ok: true, data: envelope.data as Record<string, unknown> };
}

/**
 * Hand raw bytes to Composio's object store and get back the file reference a
 * `file_uploadable` action parameter expects.
 *
 * `toolSlug` is part of the storage key, so the reference is only valid for
 * the action it was minted for.
 */
export async function uploadBytesToComposio(
  toolkitSlug: string,
  toolSlug: string,
  file: { bytes: Buffer; filename: string; mimeType: string },
  signal?: AbortSignal,
): Promise<{ ok: true; ref: ComposioFileRef } | { ok: false; error: string }> {
  const creds = identity();
  if (!creds) {
    return { ok: false, error: "This instance has no Composio credentials." };
  }
  if (file.bytes.length > COMPOSIO_MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      error: `File is ${Math.round(file.bytes.length / 1024)} KB; Composio uploads are capped at 5 MB.`,
    };
  }

  const md5 = createHash("md5").update(file.bytes).digest("hex");

  let presign: {
    key?: string;
    new_presigned_url?: string;
    type?: string;
  };
  try {
    const res = await fetch(`${COMPOSIO_API}/files/upload/request`, {
      method: "POST",
      headers: {
        "x-api-key": creds.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        toolkit_slug: toolkitSlug,
        tool_slug: toolSlug,
        filename: file.filename,
        mimetype: file.mimeType,
        md5,
      }),
      signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return {
        ok: false,
        error: `Composio upload presign failed (HTTP ${res.status})${
          detail ? `: ${detail.slice(0, 200)}` : ""
        }`,
      };
    }
    presign = (await res.json()) as typeof presign;
  } catch (err) {
    return {
      ok: false,
      error: `Composio upload presign failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  if (!presign.key) {
    return { ok: false, error: "Composio upload presign returned no key." };
  }

  // Content-addressed: a non-"new" type means Composio already holds these
  // exact bytes for this action and the PUT would be redundant.
  if (presign.type === "new") {
    if (!presign.new_presigned_url) {
      return {
        ok: false,
        error: "Composio upload presign returned no upload URL.",
      };
    }
    try {
      const put = await fetch(presign.new_presigned_url, {
        method: "PUT",
        headers: { "Content-Type": file.mimeType },
        body: new Uint8Array(file.bytes),
        signal,
      });
      if (!put.ok) {
        return {
          ok: false,
          error: `Uploading the file to Composio storage failed (HTTP ${put.status}).`,
        };
      }
    } catch (err) {
      return {
        ok: false,
        error: `Uploading the file to Composio storage failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  }

  return {
    ok: true,
    ref: {
      name: file.filename,
      mimetype: file.mimeType,
      s3key: presign.key,
    },
  };
}
