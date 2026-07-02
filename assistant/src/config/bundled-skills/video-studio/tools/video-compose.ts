/**
 * video_compose — assemble a finished video from generated assets.
 *
 * This is the one deterministic primitive the video-studio pipeline needs:
 * generation (images / clips / narration / music) is done upstream via
 * `replicate_run`; this tool stitches those assets into a single rendered mp4
 * with burned captions and a mixed audio bed, then delivers it as an
 * in-chat attachment.
 *
 * Strategy — robust per-segment rendering rather than one giant filtergraph:
 *   1. Localise every source (download http(s) URLs, accept local paths).
 *   2. Render each segment to a normalised, fixed-size, fixed-fps silent mp4
 *      (images are looped to their duration; clips are trimmed/scaled/padded),
 *      burning the segment caption if a usable font is present.
 *   3. Concat the segment files (stream copy — they share codec params).
 *   4. Mux the audio bed (narration and/or looped, ducked music) onto the
 *      concatenated video, padding audio to the video length.
 *
 * FFmpeg is resolved from an explicit override, then a candidate list (the
 * daemon may run with a minimal PATH and a non-standard Homebrew prefix), then
 * bare `ffmpeg`. If it cannot be found/executed the tool returns a clear,
 * actionable message instead of throwing — exactly like replicate_run does for
 * a missing token.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

import ffmpegStaticPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

import { uploadFileBackedAttachment } from "../../../../memory/attachments-store.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import {
  FFMPEG_CLIP_TIMEOUT_MS,
  FFPROBE_TIMEOUT_MS,
  spawnWithTimeout,
} from "../../../../util/spawn.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_SEGMENTS = 40;
const DEFAULT_IMAGE_DURATION_SEC = 4;
const MIN_SEGMENT_DURATION_SEC = 0.5;
const MAX_SEGMENT_DURATION_SEC = 60;
const DEFAULT_FPS = 30;
const DEFAULT_MUSIC_VOLUME = 0.22;

/** Fonts to try for caption burn-in, in preference order (macOS then Linux). */
const FONT_CANDIDATES = [
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/System/Library/Fonts/Helvetica.ttc",
  "/Library/Fonts/Arial.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
];

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

/** Path to the vendored static binary (full-featured: includes drawtext). */
function staticBinaryPath(name: "ffmpeg" | "ffprobe"): string | null {
  try {
    if (name === "ffmpeg") {
      return typeof ffmpegStaticPath === "string" ? ffmpegStaticPath : null;
    }
    const p = (ffprobeStatic as { path?: string } | undefined)?.path;
    return typeof p === "string" ? p : null;
  } catch {
    return null;
  }
}

function resolveBinary(name: "ffmpeg" | "ffprobe"): string {
  const override =
    name === "ffmpeg"
      ? process.env.CUE_FFMPEG_PATH
      : process.env.CUE_FFPROBE_PATH;
  if (override && existsSync(override)) return override;

  // Prefer the vendored static build: it includes libfreetype/drawtext (for
  // caption burn-in) and is identical across macOS and the Render Linux host,
  // so behaviour doesn't depend on whatever ffmpeg the system happens to have.
  const vendored = staticBinaryPath(name);
  if (vendored && existsSync(vendored)) return vendored;

  const home = process.env.HOME ?? "";
  const candidates = [
    home ? join(home, "homebrew", "bin", name) : "",
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`,
    home ? join(home, ".local", "bin", name) : "",
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  return name; // last resort: rely on PATH (spawnWithTimeout augments it)
}

function resolveFont(): string | null {
  for (const f of FONT_CANDIDATES) if (existsSync(f)) return f;
  return null;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

function targetDims(
  aspect: string,
  resolution: string,
): { width: number; height: number } {
  const lo = resolution === "720p";
  switch (aspect) {
    case "9:16":
      return lo ? { width: 720, height: 1280 } : { width: 1080, height: 1920 };
    case "1:1":
      return lo ? { width: 720, height: 720 } : { width: 1080, height: 1080 };
    case "16:9":
    default:
      return lo ? { width: 1280, height: 720 } : { width: 1920, height: 1080 };
  }
}

// ---------------------------------------------------------------------------
// Small ffmpeg/ffprobe helpers
// ---------------------------------------------------------------------------

async function probeDurationSec(
  ffprobe: string,
  file: string,
): Promise<number> {
  const r = await spawnWithTimeout(
    [
      ffprobe,
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
      file,
    ],
    FFPROBE_TIMEOUT_MS,
  );
  if (r.exitCode !== 0) return 0;
  const d = parseFloat(r.stdout.trim());
  return Number.isFinite(d) && d > 0 ? d : 0;
}

function extFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const e = extname(u.pathname);
    return /^\.[a-z0-9]{1,5}$/i.test(e) ? e : "";
  } catch {
    const e = extname(url);
    return /^\.[a-z0-9]{1,5}$/i.test(e) ? e : "";
  }
}

async function localizeSource(
  source: string,
  dest: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source, { signal });
    if (!res.ok) {
      throw new Error(`download failed (HTTP ${res.status}) for ${source}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0)
      throw new Error(`downloaded empty file: ${source}`);
    await writeFile(dest, buf);
    return dest;
  }
  // Local path — accept file:// and bare absolute/relative paths.
  const local = source.startsWith("file://")
    ? source.slice("file://".length)
    : source;
  if (!existsSync(local)) throw new Error(`source file not found: ${source}`);
  return local;
}

/** Escape a path for use inside an ffmpeg filter option value. */
function filterPath(p: string): string {
  // Inside filtergraph, ':' and '\' and '\'' need escaping. Our paths live under
  // a uuid temp dir so this is belt-and-suspenders.
  return p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SegmentInput {
  source: string;
  duration_seconds?: number;
  caption?: string;
}

// ---------------------------------------------------------------------------
// Tool entry point
// ---------------------------------------------------------------------------

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  // ---- Validate segments --------------------------------------------------
  const rawSegments = input.segments;
  if (!Array.isArray(rawSegments) || rawSegments.length === 0) {
    return {
      content:
        "Provide a non-empty `segments` array. Each segment needs a `source` (an image/clip URL or local path) and optionally `duration_seconds` and `caption`.",
      isError: true,
    };
  }
  if (rawSegments.length > MAX_SEGMENTS) {
    return {
      content: `Too many segments (${rawSegments.length}). Maximum is ${MAX_SEGMENTS}.`,
      isError: true,
    };
  }
  const segments: SegmentInput[] = [];
  for (let i = 0; i < rawSegments.length; i++) {
    const s = rawSegments[i] as Record<string, unknown>;
    if (!s || typeof s.source !== "string" || !s.source.trim()) {
      return {
        content: `Segment ${i} is missing a string \`source\` (image/clip URL or local path).`,
        isError: true,
      };
    }
    segments.push({
      source: s.source.trim(),
      duration_seconds:
        typeof s.duration_seconds === "number" ? s.duration_seconds : undefined,
      caption:
        typeof s.caption === "string" && s.caption.trim()
          ? s.caption.trim()
          : undefined,
    });
  }

  // ---- Options ------------------------------------------------------------
  const aspect =
    typeof input.aspect_ratio === "string" ? input.aspect_ratio : "16:9";
  const resolution = input.resolution === "720p" ? "720p" : "1080p";
  const fps =
    typeof input.fps === "number" && input.fps >= 1 && input.fps <= 60
      ? Math.round(input.fps)
      : DEFAULT_FPS;
  const burnCaptions = input.captions !== false; // default true
  const musicVolume =
    typeof input.music_volume === "number"
      ? Math.min(1, Math.max(0, input.music_volume))
      : DEFAULT_MUSIC_VOLUME;
  const narrationUrl =
    typeof input.narration_url === "string" && input.narration_url.trim()
      ? input.narration_url.trim()
      : undefined;
  const musicUrl =
    typeof input.music_url === "string" && input.music_url.trim()
      ? input.music_url.trim()
      : undefined;
  const outputTitle =
    typeof input.output_title === "string" && input.output_title.trim()
      ? input.output_title.trim()
      : "video";

  const { width, height } = targetDims(aspect, resolution);

  // ---- Resolve ffmpeg / verify it runs ------------------------------------
  const ffmpeg = resolveBinary("ffmpeg");
  const ffprobe = resolveBinary("ffprobe");
  const versionCheck = await spawnWithTimeout(
    [ffmpeg, "-version"],
    FFPROBE_TIMEOUT_MS,
  ).catch(() => ({ exitCode: 1, stdout: "", stderr: "" }));
  if (versionCheck.exitCode !== 0) {
    return {
      content:
        "FFmpeg is required to compose videos but was not found. Install it (on macOS: `brew install ffmpeg`), then retry. If it is installed in a non-standard location, set the CUE_FFMPEG_PATH and CUE_FFPROBE_PATH environment variables to the binaries. Report this to the user as-is; do not attempt another tool.",
      isError: true,
    };
  }

  // Caption burn-in needs the `drawtext` filter (libfreetype) AND a usable
  // font file. Some ffmpeg builds ship without freetype — probe so we degrade
  // gracefully (skip captions) instead of failing the whole render.
  const filtersProbe = await spawnWithTimeout(
    [ffmpeg, "-hide_banner", "-filters"],
    FFPROBE_TIMEOUT_MS,
  ).catch(() => ({ exitCode: 1, stdout: "", stderr: "" }));
  const hasDrawtext = /(^|\s)drawtext\s/m.test(filtersProbe.stdout);
  const font = burnCaptions && hasDrawtext ? resolveFont() : null;
  const captionsRequested = segments.some((s) => s.caption);
  const captionsCapable = Boolean(font); // font only set when drawtext present
  const captionsDropped = burnCaptions && captionsRequested && !captionsCapable;

  // ---- Work directory (persistent so the attachment can be served) --------
  const jobId = randomUUID().slice(0, 8);
  const baseDir =
    process.env.VELLUM_WORKSPACE_DIR || context.workingDir || tmpdir();
  let workDir = join(baseDir, "media", "video-studio", jobId);
  try {
    await mkdir(workDir, { recursive: true });
  } catch {
    workDir = join(tmpdir(), "cue-video-studio", jobId);
    await mkdir(workDir, { recursive: true });
  }

  const emit = (msg: string) => context.onOutput?.(msg);

  try {
    // ---- 1 + 2. Localise + render each segment ---------------------------
    const segFiles: string[] = [];
    for (let i = 0; i < segments.length; i++) {
      if (context.signal?.aborted) {
        return { content: "Cancelled.", isError: true };
      }
      const seg = segments[i];
      emit(`Preparing scene ${i + 1}/${segments.length}…\n`);

      const srcPath = await localizeSource(
        seg.source,
        join(workDir, `src_${i}${extFromUrl(seg.source) || ""}`),
        context.signal,
      );
      const srcDuration = await probeDurationSec(ffprobe, srcPath);
      const isVideo = srcDuration > 0.05;
      let duration =
        seg.duration_seconds && seg.duration_seconds > 0
          ? seg.duration_seconds
          : isVideo
            ? srcDuration
            : DEFAULT_IMAGE_DURATION_SEC;
      duration = Math.min(
        MAX_SEGMENT_DURATION_SEC,
        Math.max(MIN_SEGMENT_DURATION_SEC, duration),
      );

      const vf: string[] = [
        `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
        "setsar=1",
        `fps=${fps}`,
      ];

      if (seg.caption && font) {
        const capFile = join(workDir, `cap_${i}.txt`);
        await writeFile(capFile, seg.caption, "utf8");
        const fontSize = Math.max(20, Math.round(height / 24));
        const margin = Math.round(height / 10);
        vf.push(
          [
            `drawtext=fontfile='${filterPath(font)}'`,
            `textfile='${filterPath(capFile)}'`,
            "fontcolor=white",
            `fontsize=${fontSize}`,
            "box=1",
            "boxcolor=black@0.5",
            `boxborderw=${Math.round(fontSize * 0.4)}`,
            "x=(w-text_w)/2",
            `y=h-text_h-${margin}`,
            `line_spacing=${Math.round(fontSize * 0.25)}`,
          ].join(":"),
        );
      }

      const segOut = join(workDir, `seg_${i}.mp4`);
      const baseArgs = isVideo
        ? [ffmpeg, "-y", "-i", srcPath, "-t", String(duration)]
        : [ffmpeg, "-y", "-loop", "1", "-t", String(duration), "-i", srcPath];
      const renderArgs = [
        ...baseArgs,
        "-vf",
        vf.join(","),
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
        "-r",
        String(fps),
        segOut,
      ];
      const r = await spawnWithTimeout(renderArgs, FFMPEG_CLIP_TIMEOUT_MS);
      if (r.exitCode !== 0 || !existsSync(segOut)) {
        return {
          content: `Failed to render scene ${i + 1}: ${r.stderr.slice(-600)}`,
          isError: true,
        };
      }
      segFiles.push(segOut);
    }

    // ---- 3. Concatenate segments (stream copy) ---------------------------
    emit("Stitching scenes together…\n");
    const listFile = join(workDir, "concat.txt");
    await writeFile(
      listFile,
      segFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"),
      "utf8",
    );
    const silentOut = join(workDir, "silent.mp4");
    let concat = await spawnWithTimeout(
      [
        ffmpeg,
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listFile,
        "-c",
        "copy",
        silentOut,
      ],
      FFMPEG_CLIP_TIMEOUT_MS,
    );
    if (concat.exitCode !== 0 || !existsSync(silentOut)) {
      // Re-encode fallback (covers rare param drift between segment files).
      concat = await spawnWithTimeout(
        [
          ffmpeg,
          "-y",
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          listFile,
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-pix_fmt",
          "yuv420p",
          "-r",
          String(fps),
          silentOut,
        ],
        FFMPEG_CLIP_TIMEOUT_MS,
      );
      if (concat.exitCode !== 0 || !existsSync(silentOut)) {
        return {
          content: `Failed to stitch scenes: ${concat.stderr.slice(-600)}`,
          isError: true,
        };
      }
    }

    const videoDuration = await probeDurationSec(ffprobe, silentOut);

    // ---- 4. Mux the audio bed --------------------------------------------
    const finalOut = join(
      workDir,
      `${outputTitle.replace(/[^a-z0-9]+/gi, "-").slice(0, 40) || "video"}-${jobId}.mp4`,
    );
    let narrationPath: string | undefined;
    let musicPath: string | undefined;
    if (narrationUrl) {
      narrationPath = await localizeSource(
        narrationUrl,
        join(workDir, `narration${extFromUrl(narrationUrl) || ".audio"}`),
        context.signal,
      );
    }
    if (musicUrl) {
      musicPath = await localizeSource(
        musicUrl,
        join(workDir, `music${extFromUrl(musicUrl) || ".audio"}`),
        context.signal,
      );
    }

    let muxArgs: string[];
    if (narrationPath && musicPath) {
      emit("Mixing narration and music…\n");
      muxArgs = [
        ffmpeg,
        "-y",
        "-i",
        silentOut,
        "-i",
        narrationPath,
        "-stream_loop",
        "-1",
        "-i",
        musicPath,
        "-filter_complex",
        `[2:a]volume=${musicVolume}[m];[1:a][m]amix=inputs=2:normalize=0:dropout_transition=0[mix];[mix]apad[a]`,
        "-map",
        "0:v:0",
        "-map",
        "[a]",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-shortest",
        finalOut,
      ];
    } else if (narrationPath) {
      emit("Adding narration…\n");
      muxArgs = [
        ffmpeg,
        "-y",
        "-i",
        silentOut,
        "-i",
        narrationPath,
        "-filter_complex",
        "[1:a]apad[a]",
        "-map",
        "0:v:0",
        "-map",
        "[a]",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-shortest",
        finalOut,
      ];
    } else if (musicPath) {
      emit("Adding music…\n");
      muxArgs = [
        ffmpeg,
        "-y",
        "-i",
        silentOut,
        "-stream_loop",
        "-1",
        "-i",
        musicPath,
        "-filter_complex",
        `[1:a]volume=${musicVolume},apad[a]`,
        "-map",
        "0:v:0",
        "-map",
        "[a]",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-shortest",
        finalOut,
      ];
    } else {
      // No audio — just finalise the silent video.
      muxArgs = [ffmpeg, "-y", "-i", silentOut, "-c", "copy", finalOut];
    }

    const mux = await spawnWithTimeout(muxArgs, FFMPEG_CLIP_TIMEOUT_MS);
    if (mux.exitCode !== 0 || !existsSync(finalOut)) {
      return {
        content: `Failed to add audio / finalise the video: ${mux.stderr.slice(-600)}`,
        isError: true,
      };
    }

    const outStat = await stat(finalOut);
    if (outStat.size === 0) {
      return { content: "Composition produced an empty file.", isError: true };
    }

    const filename = finalOut.split("/").pop() ?? `${outputTitle}.mp4`;
    const attachment = uploadFileBackedAttachment(
      filename,
      "video/mp4",
      finalOut,
      outStat.size,
    );

    const notes: string[] = [];
    if (captionsDropped) {
      notes.push(
        hasDrawtext
          ? "Captions were requested but no usable font was found, so they were skipped."
          : "Captions were skipped because this ffmpeg build lacks the drawtext filter (no libfreetype). Install a freetype-enabled ffmpeg to burn captions.",
      );
    }

    return {
      content: JSON.stringify(
        {
          message: "Video composed successfully.",
          attachmentId: attachment.id,
          filename,
          mimeType: "video/mp4",
          sizeBytes: outStat.size,
          durationSeconds: Math.round(videoDuration * 10) / 10,
          dimensions: `${width}x${height}`,
          aspectRatio: aspect,
          scenes: segments.length,
          hasNarration: Boolean(narrationPath),
          hasMusic: Boolean(musicPath),
          captionsBurned: burnCaptions && Boolean(font) && captionsRequested,
          notes: notes.length ? notes : undefined,
          outputPath: finalOut,
        },
        null,
        2,
      ),
      isError: false,
      // Typed side channel: lets the daemon link the stored attachment onto
      // the assistant message row so history reloads return it.
      attachmentIds: [attachment.id],
    };
  } catch (err) {
    if (context.signal?.aborted) {
      return { content: "Cancelled.", isError: true };
    }
    return {
      content: `Video composition failed: ${(err as Error).message}`,
      isError: true,
    };
  }
}
