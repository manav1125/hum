/**
 * Optional S3-compatible offsite target for DB snapshots.
 *
 * The codebase has no S3 SDK and the only offsite path before this was a
 * macOS iCloud directory (meaningless on Linux), so this is a minimal
 * AWS Signature V4 signed-PUT implementation over `fetch` — enough to
 * ship a snapshot file to Tigris (Fly's object storage), R2, MinIO, or
 * real S3, with zero new dependencies.
 *
 * Env contract (all-or-nothing; incomplete config disables offsite):
 *
 *   CUE_BACKUP_S3_BUCKET             required — bucket name
 *   CUE_BACKUP_S3_ACCESS_KEY_ID      required — credential (never forwarded
 *                                    to agent child processes)
 *   CUE_BACKUP_S3_SECRET_ACCESS_KEY  required — credential (same)
 *   CUE_BACKUP_S3_ENDPOINT           optional — default
 *                                    https://fly.storage.tigris.dev
 *   CUE_BACKUP_S3_REGION             optional — default "auto"
 *   CUE_BACKUP_S3_PREFIX             optional — object key prefix; default
 *                                    $FLY_APP_NAME, else "cue-instance"
 *
 * Uploads use path-style URLs (`<endpoint>/<bucket>/<key>`) and
 * UNSIGNED-PAYLOAD (transport is TLS; hashing a multi-hundred-MB file
 * in-process is exactly the kind of memory/CPU spike this backup path is
 * designed to avoid). The body streams from disk via `Bun.file` so the
 * daemon never buffers the snapshot.
 *
 * Offsite RETENTION is intentionally not implemented here — configure a
 * lifecycle/expiry rule on the bucket (see docs/qa-night-2026-07-19/
 * backup-notes.md). Upload-only keeps this credential's blast radius to
 * "write new objects" if the instance is ever compromised; prefer an
 * access key without delete permission.
 */

import { createHash, createHmac } from "node:crypto";

const DEFAULT_ENDPOINT = "https://fly.storage.tigris.dev";
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

export interface S3OffsiteConfig {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Key prefix (no trailing slash). */
  prefix: string;
}

/**
 * Reads the CUE_BACKUP_S3_* contract. Returns null (offsite disabled)
 * unless bucket + both credentials are present.
 */
export function readS3ConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): S3OffsiteConfig | null {
  const bucket = env.CUE_BACKUP_S3_BUCKET?.trim();
  const accessKeyId = env.CUE_BACKUP_S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.CUE_BACKUP_S3_SECRET_ACCESS_KEY?.trim();
  if (!bucket || !accessKeyId || !secretAccessKey) return null;

  const endpoint = (env.CUE_BACKUP_S3_ENDPOINT?.trim() || DEFAULT_ENDPOINT)
    // A trailing slash would double up in the path-style URL.
    .replace(/\/+$/, "");
  const region = env.CUE_BACKUP_S3_REGION?.trim() || "auto";
  const prefix = (
    env.CUE_BACKUP_S3_PREFIX?.trim() ||
    env.FLY_APP_NAME?.trim() ||
    "cue-instance"
  ).replace(/\/+$/, "");

  return { endpoint, bucket, region, accessKeyId, secretAccessKey, prefix };
}

// ---------------------------------------------------------------------------
// SigV4
// ---------------------------------------------------------------------------

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** RFC 3986 encode a key, preserving `/` segment separators. */
function encodeS3Key(key: string): string {
  return key
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");
}

function toAmzDate(date: Date): { amzDate: string; dateStamp: string } {
  const iso = date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

export interface SignedPutRequest {
  url: string;
  headers: Record<string, string>;
}

/**
 * Builds a SigV4-signed PUT request for `<endpoint>/<bucket>/<key>`.
 * Exported for deterministic unit testing.
 */
export function signS3Put(
  config: S3OffsiteConfig,
  key: string,
  contentLength: number,
  now: Date = new Date(),
): SignedPutRequest {
  const endpointUrl = new URL(config.endpoint);
  const host = endpointUrl.host;
  const canonicalUri = `/${config.bucket}/${encodeS3Key(key)}`;
  const { amzDate, dateStamp } = toAmzDate(now);

  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": UNSIGNED_PAYLOAD,
    "x-amz-date": amzDate,
  };
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${headers[name]!.trim()}\n`)
    .join("");
  const signedHeaders = signedHeaderNames.join(";");

  const canonicalRequest = [
    "PUT",
    canonicalUri,
    "", // no query string
    canonicalHeaders,
    signedHeaders,
    UNSIGNED_PAYLOAD,
  ].join("\n");

  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = hmac(`AWS4${config.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, config.region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = hmac(kSigning, stringToSign).toString("hex");

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    url: `${config.endpoint}${canonicalUri}`,
    headers: {
      Authorization: authorization,
      "Content-Length": String(contentLength),
      "x-amz-content-sha256": UNSIGNED_PAYLOAD,
      "x-amz-date": amzDate,
    },
  };
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export interface S3UploadResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/** 30 minutes — generous for a few hundred MB on Fly's internal egress. */
const UPLOAD_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * PUT a local file to the configured bucket under `key`. Streams from
 * disk; never throws — callers treat a failed upload as a logged,
 * non-fatal event (the local snapshot is already durable).
 */
export async function uploadFileToS3(
  localPath: string,
  key: string,
  config: S3OffsiteConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<S3UploadResult> {
  try {
    const file = Bun.file(localPath);
    const size = file.size;
    const signed = signS3Put(config, key, size);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref();

    let response: Response;
    try {
      response = await fetchImpl(signed.url, {
        method: "PUT",
        headers: signed.headers,
        body: file,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return {
        ok: false,
        status: response.status,
        error: body.slice(0, 500),
      };
    }
    return { ok: true, status: response.status };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
