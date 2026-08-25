/**
 * The optimizer's one job: a large image must come back smaller.
 *
 * This file exists because that job silently stopped being done. The only
 * encoder was `sips`, an Apple binary, so in the Linux container every call
 * failed and the function returned its input unchanged. Image optimization had
 * never run in production. One conversation opened with three screenshots and
 * carried a 7.3 MB message on every turn thereafter.
 *
 * Nothing caught it because nothing asserted the *outcome* — only that the
 * function returned something well-formed, which it faithfully did. So the
 * mutation check here is deliberately on bytes: did this actually get smaller.
 */

import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import {
  optimizeImageForTransport,
  runFfmpeg,
  shouldRescaleImage,
} from "./image-optimize.js";

const scratch: string[] = [];
afterEach(() => {
  for (const p of scratch.splice(0)) rmSync(p, { force: true });
});

/**
 * Noise, not a test pattern. A synthetic gradient compresses to a few KB and
 * would sit under the size threshold, so it would pass this file while proving
 * nothing about a real screenshot.
 *
 * The WIDTH is jittered per call, and that is load-bearing.
 * `optimizeImageForTransport` keeps a content-addressed disk cache, so a
 * fixture with stable bytes is encoded once and served from cache forever
 * after — every later run then asserts only that the cache works, while the
 * encoder underneath could be entirely broken. This was not hypothetical: with
 * a fixed fixture, deleting every encoder still passed this file.
 *
 * Jittering the size rather than ffmpeg's noise seed is deliberate.
 * `geq=random(N)` IGNORES N — two different seeds produce byte-identical
 * output — so seeding looks like it varies the fixture while changing nothing.
 */
function makeLargeImage(baseW: number, h: number): string {
  const w = baseW + Math.floor(Math.random() * 64);
  const path = join(tmpdir(), `img-opt-test-${w}x${h}-${Date.now()}.png`);
  scratch.push(path);
  const r = Bun.spawnSync([
    "ffmpeg",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `nullsrc=s=${w}x${h}`,
    "-vf",
    "geq=random(1)*255:128:128",
    "-frames:v",
    "1",
    path,
  ]);
  if (r.exitCode !== 0) throw new Error("ffmpeg unavailable for fixture");
  return readFileSync(path).toString("base64");
}

const bytesOf = (b64: string) => Buffer.from(b64, "base64").length;

describe("a large image comes back smaller", () => {
  test("MUTATION CHECK: an oversized image is actually shrunk", async () => {
    // The regression this guards is total and silent: with no working encoder
    // the function returns its input and every caller keeps shipping the
    // original megabytes.
    const src = makeLargeImage(3000, 2000);
    const srcBytes = bytesOf(src);
    expect(srcBytes).toBeGreaterThan(1_000_000);

    const out = await optimizeImageForTransport(src, "image/png");
    expect(bytesOf(out.data)).toBeLessThan(srcBytes / 2);
    expect(out.mediaType).toBe("image/jpeg");
  }, 60_000);

  test("the result is a complete, decodable image", async () => {
    const src = makeLargeImage(2400, 1600);
    const out = await optimizeImageForTransport(src, "image/png");
    const buf = Buffer.from(out.data, "base64");
    // JPEG SOI ... EOI. A truncated encode must never be returned.
    expect(buf[0]).toBe(0xff);
    expect(buf[1]).toBe(0xd8);
    expect(buf[buf.length - 2]).toBe(0xff);
    expect(buf[buf.length - 1]).toBe(0xd9);
  }, 60_000);
});

describe("it never makes things worse", () => {
  test("MUTATION CHECK: a small image is returned untouched, not grown", async () => {
    // Re-encoding an already-small image can produce a LARGER file. Shipping
    // that would make the problem this function exists to solve worse.
    const src = makeLargeImage(320, 240);
    const out = await optimizeImageForTransport(src, "image/png");
    expect(bytesOf(out.data)).toBeLessThanOrEqual(bytesOf(src));
  }, 60_000);

  test("undersized images are not selected for rescaling at all", () => {
    expect(shouldRescaleImage({ width: 800, height: 600 }, 50_000)).toBe(false);
    expect(shouldRescaleImage({ width: 4000, height: 600 }, 50_000)).toBe(true);
    expect(shouldRescaleImage({ width: 800, height: 600 }, 9_000_000)).toBe(
      true,
    );
  });

  test("garbage in is returned as-is rather than throwing", async () => {
    // Callers sit on the message path; a throw here would fail the turn.
    const junk = Buffer.from("not an image at all").toString("base64");
    const out = await optimizeImageForTransport(junk, "image/png");
    expect(out.data).toBe(junk);
  }, 30_000);
});

describe("the encoder the container actually uses", () => {
  test("MUTATION CHECK: ffmpeg downscales — this is the deployed path", async () => {
    // The daemon runs Linux and has no `sips`, so ffmpeg is the ONLY encoder
    // in production. Exercised directly rather than through the platform
    // dispatch, because on a Mac the dispatch would silently pick sips and
    // this path would go untested — the exact blind spot that let image
    // optimization stay broken in prod.
    const src = makeLargeImage(3000, 2000);
    const out = await runFfmpeg(Buffer.from(src, "base64"));
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThan(Buffer.from(src, "base64").length / 2);
    // A complete JPEG, not a truncated write.
    expect(out![0]).toBe(0xff);
    expect(out![1]).toBe(0xd8);
    expect(out![out!.length - 1]).toBe(0xd9);
  }, 60_000);

  test("ffmpeg does not upscale an image already under the cap", async () => {
    // A fixed MAX x MAX box would enlarge small images: more bytes, no pixels.
    const src = makeLargeImage(400, 300);
    const out = await runFfmpeg(Buffer.from(src, "base64"));
    expect(out).not.toBeNull();
    // Re-encoded at its own size, so it cannot have grown by an order of scale.
    expect(out!.length).toBeLessThan(Buffer.from(src, "base64").length * 2);
  }, 60_000);
});
