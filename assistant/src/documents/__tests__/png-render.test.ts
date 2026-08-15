/**
 * The browser-driven half of this module is exercised the same way the PDF
 * renderer is — by running it, not by unit test — so what is asserted here is
 * the part that decides whether a shared image is usable: the header we read
 * dimensions back out of, and the guard that turns Chromium's opaque
 * capture-surface failure into an answer the model can act on.
 */

import { describe, expect, test } from "bun:test";

import { readPngDimensions } from "../png-render.js";

/** A minimal valid PNG header: signature, IHDR length/type, width, height. */
function pngHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  bytes.writeUInt32BE(0x89504e47, 0);
  bytes.writeUInt32BE(0x0d0a1a0a, 4);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

describe("readPngDimensions", () => {
  test("reads width and height out of the IHDR chunk", () => {
    expect(readPngDimensions(pngHeader(1800, 2332))).toEqual({
      width: 1800,
      height: 2332,
    });
  });

  test("rejects anything that isn't a PNG rather than reporting nonsense", () => {
    // A caller acting on a fabricated 0x0 would report a "successful" export
    // of a file nobody can open.
    expect(() =>
      readPngDimensions(Buffer.from("not a png at all!!!!!!!!")),
    ).toThrow(/not a PNG/);
    expect(() => readPngDimensions(Buffer.alloc(4))).toThrow(/not a PNG/);
  });
});
