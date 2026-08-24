/**
 * A truncated cache entry used to be permanent.
 *
 * The conversion cache is content-addressed and was written with a
 * non-atomic `writeFileSync`, so a torn write left a file that opens, reads
 * and base64-encodes perfectly while being half a JPEG. `readFromCache`
 * returned it unchecked, compaction re-hydrates retained images through this
 * same path, and the truncated bytes were then written into the rebuilt
 * history — after which every provider call failed on an image the
 * conversation could no longer get rid of.
 *
 * These cover the three places that now refuse to pass bad bytes along.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  optimizeImageForTransport,
  sniffImageMime,
} from "../agent/image-optimize.js";

const CACHE_DIR = join(tmpdir(), "vellum-optimized-images");

/** A complete, if tiny, JPEG: SOI … EOI. */
function completeJpeg(padding = 4096): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.alloc(padding, 0x41),
    Buffer.from([0xff, 0xd9]),
  ]);
}

/** The same image with its tail lost, as a torn write leaves it. */
function truncatedJpeg(): Buffer {
  return completeJpeg().subarray(0, 2048);
}

function cachePathFor(sourceBytes: Buffer): string {
  const key = createHash("sha256")
    .update(sourceBytes)
    .digest("hex")
    .slice(0, 16);
  return join(CACHE_DIR, `${key}.jpg`);
}

describe("sniffImageMime", () => {
  test("reads the format out of the bytes", () => {
    expect(sniffImageMime(completeJpeg())).toBe("image/jpeg");
    expect(
      sniffImageMime(
        Buffer.concat([
          Buffer.from([0x89, 0x50, 0x4e, 0x47]),
          Buffer.alloc(16),
        ]),
      ),
    ).toBe("image/png");
    expect(
      sniffImageMime(Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(16)])),
    ).toBe("image/gif");
  });

  test("a RIFF container that is not WEBP is not an image", () => {
    const riffWave = Buffer.concat([
      Buffer.from("RIFF"),
      Buffer.alloc(4),
      Buffer.from("WAVE"),
      Buffer.alloc(16),
    ]);

    expect(sniffImageMime(riffWave)).toBeNull();
  });

  test("WEBP is recognised by its tag, not just RIFF", () => {
    const webp = Buffer.concat([
      Buffer.from("RIFF"),
      Buffer.alloc(4),
      Buffer.from("WEBP"),
      Buffer.alloc(16),
    ]);

    expect(sniffImageMime(webp)).toBe("image/webp");
  });

  // The filename said PNG; the bytes are the authority.
  test("arbitrary bytes are not an image", () => {
    expect(sniffImageMime(Buffer.alloc(64, 0x7a))).toBeNull();
    expect(sniffImageMime(Buffer.from([0xff]))).toBeNull();
  });
});

describe("poisoned cache entries", () => {
  // A big enough source that optimization is attempted at all.
  const source = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.alloc(400 * 1024, 0x5a),
    Buffer.from([0xff, 0xd9]),
  ]);

  beforeEach(() => {
    mkdirSync(CACHE_DIR, { recursive: true });
  });

  afterEach(() => {
    const path = cachePathFor(source);
    if (existsSync(path)) rmSync(path);
  });

  test("a truncated entry is deleted rather than served", async () => {
    const poisoned = cachePathFor(source);
    writeFileSync(poisoned, truncatedJpeg());

    await optimizeImageForTransport(source.toString("base64"), "image/jpeg");

    // Whatever the platform did next, the poisoned file is gone: it was never
    // a valid answer for this key.
    if (existsSync(poisoned)) {
      expect(sniffImageMime(readFileSync(poisoned))).toBe("image/jpeg");
      expect(readFileSync(poisoned).length).toBeGreaterThan(2048);
    }
  });

  test("a truncated entry never reaches the caller", async () => {
    writeFileSync(cachePathFor(source), truncatedJpeg());

    const result = await optimizeImageForTransport(
      source.toString("base64"),
      "image/jpeg",
    );

    // Either re-converted or fallen back to the original — never the 2048
    // bytes that were sitting in the cache.
    expect(Buffer.from(result.data, "base64").length).not.toBe(2048);
    expect(sniffImageMime(Buffer.from(result.data, "base64"))).not.toBeNull();
  });

  // A crash between write and rename must not leave a `.tmp` that a later
  // reader could mistake for an entry, nor accumulate on a failing disk.
  test("no temp files are left behind by a successful write", async () => {
    await optimizeImageForTransport(source.toString("base64"), "image/jpeg");

    const leftovers = readdirSync(CACHE_DIR).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });
});
