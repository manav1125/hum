import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseImageDimensions } from "../context/image-dimensions.js";

// Anthropic's documented max dimension — images larger than this are scaled
// down server-side anyway, so pre-scaling is zero quality loss.
const MAX_DIMENSION = 1568;

// Threshold below which we skip optimization — small images don't need it.
const OPTIMIZE_THRESHOLD_BYTES = 300 * 1024; // 300 KB

// Anthropic rejects any single image whose source payload exceeds 5 MB,
// regardless of pixel dimensions. Cap at ~3.5 MB raw so the base64-encoded
// form (raw * 4/3) stays comfortably under 5 MB even after re-encoding.
const MAX_TRANSPORT_BYTES = Math.floor(3.5 * 1024 * 1024); // ~3.5 MB raw

const JPEG_QUALITY = 80;

// Content-addressed disk cache to avoid re-running sips on the same image.
const CACHE_MAX_ENTRIES = 500;

function getCacheDir(): string {
  return join(tmpdir(), "vellum-optimized-images");
}

/**
 * Whether these bytes are a complete JPEG.
 *
 * A cache entry is only useful if a provider will accept it, and the way this
 * cache produced unacceptable entries was truncation: a torn write left a file
 * that opens, reads, and base64-encodes perfectly while being half an image.
 * Checking the start-of-image and end-of-image markers costs four bytes of
 * comparison and is the difference between catching that here and having a
 * provider reject the whole request later.
 *
 * SOI is `FF D8`; EOI is `FF D9`. A JPEG that has both, in that order, with
 * something between them, is at minimum not truncated.
 */
function isCompleteJpeg(bytes: Buffer): boolean {
  return (
    bytes.length > 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[bytes.length - 2] === 0xff &&
    bytes[bytes.length - 1] === 0xd9
  );
}

/**
 * The image format these bytes actually are, or null if they are not a format
 * any provider accepts.
 *
 * Filenames lie and extensions go missing, so anything about to be declared to
 * a provider as `image/png` should have been read as a PNG first. Declaring
 * the wrong type is not a soft failure: the provider rejects the request, and
 * when the bytes have been written into a compacted history the rejection
 * repeats on every later turn.
 *
 * Magic numbers only — the first bytes of each container, plus WEBP's RIFF
 * wrapper, which needs its `WEBP` tag checked at offset 8 to distinguish it
 * from any other RIFF payload.
 */
/**
 * Whether a JPEG's marker structure walks cleanly to a terminal EOI, having
 * passed both a frame header and a scan.
 *
 * `sniffImageMime` reads only the SOI magic, which a truncated JPEG still
 * carries, so a half-written file sniffs as a valid `image/jpeg` and a
 * provider then rejects it. Once such bytes are baked into a compacted
 * history that rejection repeats on every later turn, so the structural check
 * has to happen before they are written.
 *
 * A raw search for the FF D9 byte pair is not enough either: a length-
 * delimited APP segment can carry an EXIF thumbnail, which is itself a
 * complete embedded JPEG, so a truncated image with intact metadata would
 * pass. This walks segment boundaries from SOI, skips segment payloads,
 * traverses entropy-coded scan data (stuffed FF 00 and RST0-7 stay inside the
 * scan), and accepts only a top-level EOI. Requiring a frame (SOF) and a scan
 * (SOS) first rejects a degenerate SOI+EOI payload that carries no image data.
 */
export function hasValidJpegStructure(bytes: Uint8Array): boolean {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return false;
  }
  let sawFrame = false;
  let sawScan = false;
  let i = 2;
  while (i + 1 < bytes.length) {
    if (bytes[i] !== 0xff) {
      return false;
    }
    // FF fill bytes before a marker are legal padding.
    let j = i + 1;
    while (j < bytes.length && bytes[j] === 0xff) {
      j++;
    }
    if (j >= bytes.length) {
      return false;
    }
    const marker = bytes[j];
    i = j + 1;
    if (marker === 0xd9) {
      return sawFrame && sawScan;
    }
    // SOF0-SOF15 occupy C0-CF, excluding DHT (C4), JPG (C8), and DAC (CC).
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      sawFrame = true;
    }
    // Standalone markers carry no length field: repeated SOI, TEM, RST0-7.
    if (
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      continue;
    }
    if (i + 1 >= bytes.length) {
      return false;
    }
    const segmentLength = (bytes[i]! << 8) | bytes[i + 1]!;
    if (segmentLength < 2) {
      return false;
    }
    i += segmentLength;
    if (marker === 0xda) {
      sawScan = true;
      // SOS: entropy-coded data follows the header. Scan to the next real
      // marker; FF 00 (stuffed data byte) and FF D0-D7 (restart) stay inside
      // the scan.
      while (i + 1 < bytes.length) {
        if (
          bytes[i] === 0xff &&
          bytes[i + 1] !== 0x00 &&
          !(bytes[i + 1]! >= 0xd0 && bytes[i + 1]! <= 0xd7)
        ) {
          break;
        }
        i++;
      }
    }
  }
  return false;
}

export function sniffImageMime(bytes: Buffer): string | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return "image/gif";
  }
  if (
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

function readFromCache(
  key: string,
): { data: string; mediaType: string } | null {
  const cachePath = join(getCacheDir(), `${key}.jpg`);
  try {
    if (!existsSync(cachePath)) return null;
    const buf = readFileSync(cachePath) as Buffer;
    if (!isCompleteJpeg(buf)) {
      // A poisoned entry is worse than a miss, because compaction bakes what
      // this returns into the rebuilt history: every later request then
      // carries bytes the provider rejects, and the conversation cannot be
      // used again. Drop it and let the caller re-convert.
      try {
        unlinkSync(cachePath);
      } catch {
        /* ignore */
      }
      return null;
    }
    return { data: buf.toString("base64"), mediaType: "image/jpeg" };
  } catch {
    return null;
  }
}

function writeToCache(key: string, optimizedBytes: Buffer): void {
  const dir = getCacheDir();
  // Write to a unique temp name and rename into place. `writeFileSync` to the
  // final path is not atomic, so a crash or a concurrent reader could observe
  // a half-written entry — and this cache is content-addressed, so that
  // truncated file would be served for that image for as long as it survived.
  // Rename within one directory is atomic, so a reader sees the old entry or
  // the new one, never a partial.
  const tempPath = join(dir, `.${key}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tempPath, optimizedBytes);
    renameSync(tempPath, join(dir, `${key}.jpg`));
    evictIfNeeded(dir);
  } catch {
    // Cache write failure is non-fatal — but the temp file must not be left
    // behind, or a failing disk accumulates them until it is full.
    try {
      unlinkSync(tempPath);
    } catch {
      /* ignore */
    }
  }
}

function evictIfNeeded(dir: string): void {
  try {
    const entries = readdirSync(dir)
      .filter((f) => f.endsWith(".jpg"))
      .map((f) => {
        const full = join(dir, f);
        return { path: full, mtimeMs: statSync(full).mtimeMs };
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
    const excess = entries.length - CACHE_MAX_ENTRIES;
    for (let i = 0; i < excess; i++) {
      try {
        unlinkSync(entries[i]!.path);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

/**
 * Downscale + re-encode with ffmpeg. This is the path that runs everywhere
 * that is not macOS — which, critically, includes the daemon's own Linux
 * container.
 *
 * Before this existed the only encoder was `sips`, an Apple binary. In the
 * deployed container there is no `sips`, so `runSips` failed on every call and
 * the optimizer returned the original bytes: image optimization had never once
 * run in production. One conversation opened with three phone screenshots and
 * carried a 7.3 MB message on every subsequent turn, which is how a thread ends
 * up re-sending megabytes per turn and losing track of its own subject.
 *
 * The scale filter clamps the box to `min(MAX, iw) x min(MAX, ih)` rather than
 * a fixed `MAX x MAX`, so an image already smaller than the cap passes through
 * at its own size. A plain `MAX:MAX` box would UPSCALE small images — more
 * bytes for no pixels.
 *
 * Exported solely so tests can exercise it on any platform. On macOS this is
 * the fallback and would otherwise never run in a test, which is precisely how
 * the reverse case — a container with no `sips` — went unnoticed in production
 * for as long as it did. The deployed path must be provable from a laptop.
 */
export async function runFfmpeg(inputBytes: Buffer): Promise<Buffer | null> {
  const srcPath = join(tmpdir(), `vellum-img-opt-${Date.now()}-src`);
  const outPath = join(tmpdir(), `vellum-img-opt-${Date.now()}-out.jpg`);
  try {
    writeFileSync(srcPath, inputBytes);
    const proc = Bun.spawn(
      [
        "ffmpeg",
        "-y",
        "-i",
        srcPath,
        "-vf",
        `scale=w='min(${MAX_DIMENSION},iw)':h='min(${MAX_DIMENSION},ih)':force_original_aspect_ratio=decrease`,
        // ffmpeg's mjpeg scale is 2 (best) to 31 (worst), inverted from the
        // 0-100 quality `sips` takes. Map so both encoders mean the same thing.
        "-q:v",
        String(Math.max(2, Math.round(31 - (JPEG_QUALITY / 100) * 29))),
        "-f",
        "mjpeg",
        outPath,
      ],
      { stdout: "ignore", stderr: "ignore", timeout: 15_000 },
    );
    await proc.exited;
    if (proc.exitCode !== 0) return null;
    return readFileSync(outPath) as Buffer;
  } catch {
    return null;
  } finally {
    try {
      unlinkSync(srcPath);
    } catch {
      /* ignore */
    }
    try {
      unlinkSync(outPath);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Re-encode using whichever encoder this machine has.
 *
 * macOS gets `sips` because it is always present there and needs no extra
 * dependency; everything else gets ffmpeg, which the container ships. If the
 * platform's first choice fails the other is still tried — a Mac without a
 * working `sips` should degrade to ffmpeg rather than to no optimization at
 * all, which is the state this whole function exists to end.
 */
async function encodeSmaller(inputBytes: Buffer): Promise<Buffer | null> {
  const order =
    process.platform === "darwin" ? [runSips, runFfmpeg] : [runFfmpeg, runSips];
  for (const encode of order) {
    const out = await encode(inputBytes);
    if (out) return out;
  }
  return null;
}

async function runSips(inputBytes: Buffer): Promise<Buffer | null> {
  const srcPath = join(tmpdir(), `vellum-img-opt-${Date.now()}-src`);
  const outPath = join(tmpdir(), `vellum-img-opt-${Date.now()}-out.jpg`);
  try {
    writeFileSync(srcPath, inputBytes);
    // Bun.spawn (not execFileSync): sips can take seconds on large images,
    // and a sync spawn would stall the daemon's event loop for the duration.
    const proc = Bun.spawn(
      [
        "sips",
        "--resampleHeightWidthMax",
        String(MAX_DIMENSION),
        "-s",
        "format",
        "jpeg",
        "-s",
        "formatOptions",
        String(JPEG_QUALITY),
        srcPath,
        "--out",
        outPath,
      ],
      { stdout: "ignore", stderr: "ignore", timeout: 15_000 },
    );
    await proc.exited;
    if (proc.exitCode !== 0) {
      return null;
    }
    return readFileSync(outPath) as Buffer;
  } catch {
    return null;
  } finally {
    try {
      unlinkSync(srcPath);
    } catch {
      /* ignore */
    }
    try {
      unlinkSync(outPath);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Downscale a base64 image to fit within Anthropic's recommended dimensions
 * (1568px max side). Returns the original data unchanged if the image is
 * already small enough or if optimization fails.
 *
 * Anthropic applies the same scaling server-side, so this is zero quality
 * loss — we just do it pre-flight to keep request payloads small and avoid
 * 413 "request too large" errors when many images accumulate in context.
 *
 * Results are cached on disk by content hash so repeated sends of the same
 * image (or daemon restarts) skip the sips call entirely.
 */
/**
 * Decide whether an image needs to be rescaled before sending.
 *
 * Two independent gates apply:
 *   1. Pixel dimensions — Anthropic rejects many-image requests when any
 *      image exceeds 2000 px on a side. A sparse screenshot can be under
 *      300 KB while still being 3000+ px wide.
 *   2. Byte size — Anthropic rejects any image whose source payload
 *      exceeds 5 MB. A 1500×1500 high-color screenshot can produce a >5 MB
 *      payload while staying well under the dimension cap.
 *
 * Exported for unit testing.
 */
export function shouldRescaleImage(
  dims: { width: number; height: number } | null,
  byteLength: number,
): boolean {
  if (byteLength > MAX_TRANSPORT_BYTES) return true;
  if (dims) {
    return dims.width > MAX_DIMENSION || dims.height > MAX_DIMENSION;
  }
  // Dimensions unparseable — fall back to file size as a rough proxy.
  return byteLength > OPTIMIZE_THRESHOLD_BYTES;
}

export async function optimizeImageForTransport(
  base64Data: string,
  mediaType: string,
): Promise<{ data: string; mediaType: string }> {
  const rawBytes = Buffer.from(base64Data, "base64");
  const dims = parseImageDimensions(base64Data, mediaType);

  if (!shouldRescaleImage(dims, rawBytes.length)) {
    return { data: base64Data, mediaType };
  }

  // Content-addressed cache lookup.
  const hash = createHash("sha256").update(rawBytes).digest("hex");
  const cacheKey = hash.slice(0, 16);
  const cached = readFromCache(cacheKey);
  if (cached) return cached;

  // sips on macOS, ffmpeg everywhere else — see `encodeSmaller`.
  const optimized = await encodeSmaller(rawBytes);
  if (!optimized || !isCompleteJpeg(optimized)) {
    // An encoder that exits 0 having written a truncated file (killed
    // mid-write, disk full) must not be cached or sent. The original bytes
    // are known-good; returning them costs size, not correctness.
    return { data: base64Data, mediaType };
  }

  // A re-encode that came out BIGGER is not an optimization. This happens on
  // already-compressed screenshots below the dimension cap, and shipping the
  // larger file would make the very problem this function exists to fix worse.
  if (optimized.length >= rawBytes.length) {
    return { data: base64Data, mediaType };
  }

  writeToCache(cacheKey, optimized);
  return { data: optimized.toString("base64"), mediaType: "image/jpeg" };
}
