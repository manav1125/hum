/**
 * `captureVideoFrame` — the shutter's encode step: current `<video>` frame →
 * canvas → JPEG `File`. Unit-tested against a stubbed canvas because happy-dom
 * has no real 2D raster; what matters here is the contract, not the pixels:
 * no-frame-yet returns null (never a blank upload), the JPEG encode carries
 * the intended quality, and a canvas that cannot encode fails soft.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { captureVideoFrame } from "@/domains/chat/voice/voice-camera";

interface FakeContext {
  drawn: Array<[unknown, number, number, number, number]>;
  drawImage: (
    source: unknown,
    x: number,
    y: number,
    w: number,
    h: number,
  ) => void;
}

function stubCanvas(options: {
  context?: boolean;
  blob?: Blob | null;
  captureToBlobArgs?: (type: string, quality: number) => void;
}) {
  const context: FakeContext = {
    drawn: [],
    drawImage(source, x, y, w, h) {
      context.drawn.push([source, x, y, w, h]);
    },
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => (options.context === false ? null : context),
    toBlob(
      callback: (blob: Blob | null) => void,
      type: string,
      quality: number,
    ) {
      options.captureToBlobArgs?.(type, quality);
      callback(options.blob === undefined ? new Blob(["jpeg-bytes"]) : options.blob);
    },
  };

  const original = document.createElement.bind(document);
  document.createElement = ((tag: string) =>
    tag === "canvas"
      ? (canvas as unknown as HTMLCanvasElement)
      : original(tag)) as typeof document.createElement;

  return {
    canvas,
    context,
    restore: () => {
      document.createElement = original;
    },
  };
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

function fakeVideo(width: number, height: number): HTMLVideoElement {
  return { videoWidth: width, videoHeight: height } as HTMLVideoElement;
}

describe("captureVideoFrame", () => {
  test("encodes the current frame as a JPEG File at capture quality", async () => {
    // Captured on an object property: TS's control-flow narrowing would pin a
    // closed-over `let` to its null initializer at the assertion sites below.
    const encoded: { type: string | null; quality: number | null } = {
      type: null,
      quality: null,
    };
    const stub = stubCanvas({
      captureToBlobArgs: (type, quality) => {
        encoded.type = type;
        encoded.quality = quality;
      },
    });
    restore = stub.restore;

    const video = fakeVideo(1280, 720);
    const file = await captureVideoFrame(video, "photo-1.jpg");

    expect(file).not.toBeNull();
    expect(file!.name).toBe("photo-1.jpg");
    expect(file!.type).toBe("image/jpeg");
    expect(encoded.type).toBe("image/jpeg");
    expect(encoded.quality).toBe(0.85);
    // The frame is drawn at the track's own dimensions, no scaling.
    expect(stub.context.drawn).toEqual([[video, 0, 0, 1280, 720]]);
  });

  test("returns null before the first frame decodes (videoWidth 0)", async () => {
    const stub = stubCanvas({});
    restore = stub.restore;

    expect(await captureVideoFrame(fakeVideo(0, 0), "photo-1.jpg")).toBeNull();
    expect(stub.context.drawn).toHaveLength(0);
  });

  test("fails soft when the canvas cannot provide a 2d context", async () => {
    const stub = stubCanvas({ context: false });
    restore = stub.restore;

    expect(
      await captureVideoFrame(fakeVideo(1280, 720), "photo-1.jpg"),
    ).toBeNull();
  });

  test("fails soft when the encode produces no blob", async () => {
    const stub = stubCanvas({ blob: null });
    restore = stub.restore;

    expect(
      await captureVideoFrame(fakeVideo(1280, 720), "photo-1.jpg"),
    ).toBeNull();
  });
});
