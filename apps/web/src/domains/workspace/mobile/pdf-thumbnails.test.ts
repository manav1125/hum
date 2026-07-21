import { describe, expect, test } from "bun:test";

import {
  createSerialQueue,
  PDF_THUMB_BUDGET_MS,
  PdfThumbTimeout,
  pdfThumbCacheKey,
  pdfThumbScale,
  withBudget,
} from "@/domains/workspace/mobile/pdf-thumbnails";

describe("pdfThumbCacheKey", () => {
  test("keyed by path + size + mtime — any change invalidates", () => {
    const base = {
      path: "reports/q3.pdf",
      size: 1024,
      modifiedAt: "2026-07-20T10:00:00Z",
    };
    const key = pdfThumbCacheKey(base);
    expect(key).toBe("reports/q3.pdf|1024|2026-07-20T10:00:00Z");
    expect(pdfThumbCacheKey({ ...base, size: 2048 })).not.toBe(key);
    expect(
      pdfThumbCacheKey({ ...base, modifiedAt: "2026-07-21T10:00:00Z" }),
    ).not.toBe(key);
    expect(pdfThumbCacheKey({ ...base, size: null })).toBe(
      "reports/q3.pdf|?|2026-07-20T10:00:00Z",
    );
  });
});

describe("pdfThumbScale", () => {
  test("covers the card box for typical portrait pages", () => {
    // A4-ish page (612×792) in the grid card and the hero card: the render
    // must reach at least the cover fit so the box shows real page pixels.
    for (const [cw, ch] of [
      [174, 72],
      [358, 150],
    ]) {
      const scale = pdfThumbScale(612, 792, cw, ch);
      const cover = Math.max(cw / 612, ch / 792);
      expect(scale).toBeGreaterThanOrEqual(cover * 0.99);
    }
  });

  test("canvas area never exceeds the 2x-card pixel budget (the WKWebView guardrail)", () => {
    for (const [pw, ph, cw, ch] of [
      [612, 792, 174, 72],
      [612, 792, 358, 150],
      [2000, 200, 174, 72], // extreme landscape
      [200, 4000, 174, 72], // extreme portrait
    ]) {
      const scale = pdfThumbScale(pw, ph, cw, ch);
      expect(scale * pw * (scale * ph)).toBeLessThanOrEqual(
        4 * cw * ch + 1e-3,
      );
    }
  });

  test("never renders beyond 2x cover (no wasted retina overshoot)", () => {
    const scale = pdfThumbScale(612, 792, 358, 150);
    const cover = Math.max(358 / 612, 150 / 792);
    expect(scale).toBeLessThanOrEqual(2 * cover + 1e-6);
  });

  test("degenerate dimensions fall back to scale 1", () => {
    expect(pdfThumbScale(0, 792, 174, 72)).toBe(1);
    expect(pdfThumbScale(612, 792, 0, 72)).toBe(1);
  });
});

describe("createSerialQueue", () => {
  test("runs tasks one at a time, in order", async () => {
    const queue = createSerialQueue();
    const events: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const task = (name: string, delay: number) => async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      events.push(`start:${name}`);
      await new Promise((r) => setTimeout(r, delay));
      events.push(`end:${name}`);
      inFlight -= 1;
      return name;
    };
    const results = await Promise.all([
      queue.run(task("a", 20)),
      queue.run(task("b", 5)),
      queue.run(task("c", 1)),
    ]);
    expect(results).toEqual(["a", "b", "c"]);
    expect(maxInFlight).toBe(1);
    expect(events).toEqual([
      "start:a",
      "end:a",
      "start:b",
      "end:b",
      "start:c",
      "end:c",
    ]);
  });

  test("a failing task does not wedge the queue", async () => {
    const queue = createSerialQueue();
    await expect(
      queue.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(queue.run(async () => "still alive")).resolves.toBe(
      "still alive",
    );
  });
});

describe("withBudget", () => {
  test("passes fast results through", async () => {
    await expect(withBudget(Promise.resolve(42), 1000)).resolves.toBe(42);
  });

  test("rejects with PdfThumbTimeout when the budget elapses", async () => {
    const never = new Promise<void>(() => {});
    await expect(withBudget(never, 10)).rejects.toBeInstanceOf(
      PdfThumbTimeout,
    );
  });

  test("propagates the task's own failure", async () => {
    await expect(
      withBudget(Promise.reject(new Error("fetch failed")), 1000),
    ).rejects.toThrow("fetch failed");
  });

  test("the shipped budget is the spec'd 4 seconds", () => {
    expect(PDF_THUMB_BUDGET_MS).toBe(4000);
  });
});
