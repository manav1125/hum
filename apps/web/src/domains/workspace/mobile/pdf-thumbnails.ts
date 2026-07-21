/**
 * Client-side first-page PDF thumbnails for the mobile Files gallery.
 *
 * The daemon has no page-render endpoint, so page 1 is rendered in the
 * client with pdf.js and cached. WKWebView perf guardrails, all enforced
 * here rather than at the call site:
 *   · pdf.js (and its worker) load lazily, only once a PDF card is actually
 *     on screen — the library stays out of the main bundle (dynamic
 *     import; the worker comes from the version-pinned CDN URL, the same
 *     WKWebView-proven recipe as chat's pdf-preview.tsx);
 *   · one PDF renders at a time (serial queue);
 *   · render size is capped at 2× the card box;
 *   · a 4s per-item budget (fetch + render, not queue wait) — on timeout or
 *     any failure the caller silently keeps the tinted type-chip block;
 *   · results cache in-memory (object URLs, session-bounded like the image
 *     thumbnails) and in IndexedDB keyed by path+size+mtime, so revisits
 *     don't re-rasterize.
 *
 * Deck/app artifacts deliberately keep their type chips: Library apps carry
 * only an emoji `icon` (no preview asset) and nothing maps a workspace file
 * to an app, so there is no honest artwork to show for them.
 */
import { workspaceFileContentGet } from "@/generated/daemon/sdk.gen";

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/** Identity of a rendered thumb: same path re-written = new key. */
export function pdfThumbCacheKey(entry: {
  path: string;
  size: number | null;
  modifiedAt: string;
}): string {
  return `${entry.path}|${entry.size ?? "?"}|${entry.modifiedAt}`;
}

/**
 * Rendered-canvas scale for a page of `pageW`×`pageH` CSS units shown in a
 * `cardW`×`cardH` box. Target: cover the box at up to 2× (retina), but the
 * canvas AREA never exceeds the 2×-card pixel budget (2·cardW × 2·cardH) —
 * the WKWebView guardrail — so an extreme-aspect page can't rasterize a
 * giant strip. The area cap wins over cover when they conflict; the card
 * then upscales slightly instead of the client burning memory.
 */
export function pdfThumbScale(
  pageW: number,
  pageH: number,
  cardW: number,
  cardH: number,
): number {
  if (pageW <= 0 || pageH <= 0 || cardW <= 0 || cardH <= 0) return 1;
  const cover = Math.max(cardW / pageW, cardH / pageH);
  const areaCap = Math.sqrt((4 * cardW * cardH) / (pageW * pageH));
  return Math.max(Math.min(2 * cover, areaCap), 0.05);
}

/** Serial task queue — at most one task in flight, FIFO. */
export function createSerialQueue(): {
  run<T>(task: () => Promise<T>): Promise<T>;
} {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      const next = tail.then(task, task);
      // Keep the chain alive whether the task fails or not.
      tail = next.catch(() => undefined);
      return next;
    },
  };
}

/** Reject with `PdfThumbTimeout` when `task` outlives `ms`. */
export class PdfThumbTimeout extends Error {
  constructor(ms: number) {
    super(`PDF thumbnail exceeded ${ms}ms budget`);
    this.name = "PdfThumbTimeout";
  }
}

export function withBudget<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new PdfThumbTimeout(ms)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------

export const PDF_THUMB_BUDGET_MS = 4_000;

const IDB_NAME = "cue-mv3-file-thumbs";
const IDB_STORE = "pdf-first-pages";

/**
 * In-memory result cache. A Promise so concurrent cards for the same file
 * share one render; resolves to an object URL or null (= failed — the
 * negative result is only cached in memory, so a transient failure retries
 * next session).
 */
const memoryCache = new Map<string, Promise<string | null>>();

function openThumbDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(IDB_STORE)) {
          req.result.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function idbGetThumb(key: string): Promise<Blob | null> {
  const db = await openThumbDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () =>
        resolve(req.result instanceof Blob ? req.result : null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    } finally {
      db.close();
    }
  });
}

async function idbPutThumb(key: string, blob: Blob): Promise<void> {
  const db = await openThumbDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(blob, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    } finally {
      db.close();
    }
  });
}

// ---------------------------------------------------------------------------
// Render pipeline
// ---------------------------------------------------------------------------

/** One PDF at a time, module-wide (shared by hero + grid cards). */
const renderQueue = createSerialQueue();

let pdfJsConfigured = false;

/**
 * Same lazy-load recipe as chat's pdf-preview.tsx: the legacy build is the
 * WKWebView/Capacitor-safe entry, and the worker is fetched from a CDN URL
 * pinned to the imported version so it never lands in the app bundle.
 */
async function loadPdfJs() {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (!pdfJsConfigured) {
    pdfjs.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjs.version}/legacy/build/pdf.worker.min.mjs`;
    pdfJsConfigured = true;
  }
  return pdfjs;
}

async function fetchPdfBytes(
  assistantId: string,
  path: string,
): Promise<Uint8Array> {
  const res = await workspaceFileContentGet({
    path: { assistant_id: assistantId },
    query: { path },
    parseAs: "blob",
  });
  if (res.error || !res.data) {
    throw res.error ?? new Error("Failed to fetch PDF bytes");
  }
  return new Uint8Array(await (res.data as Blob).arrayBuffer());
}

async function renderFirstPageToBlob(
  bytes: Uint8Array,
  cardW: number,
  cardH: number,
): Promise<Blob> {
  const pdfjs = await loadPdfJs();
  const doc = await pdfjs.getDocument({ data: bytes }).promise;
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({
      scale: pdfThumbScale(base.width, base.height, cardW, cardH),
    });

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("No 2d canvas context");
    // PDF pages are transparent by default — paint paper white first.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // "print" intent: renders without interactive annotations (right for a
    // static thumb) and — critically — without the display intent's
    // requestAnimationFrame-driven continuation, which never fires in a
    // hidden/backgrounded WebView and would wedge the render until the 4s
    // budget kills it.
    await page.render({ canvas, viewport, intent: "print" }).promise;

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) =>
          blob ? resolve(blob) : reject(new Error("canvas.toBlob failed")),
        "image/jpeg",
        0.82,
      );
    });
  } finally {
    void doc.destroy();
  }
}

/**
 * Object URL of the first-page thumbnail, or null on any failure/timeout
 * (the caller keeps its type-chip fallback — silently, per spec). Cached;
 * safe to call repeatedly from every card.
 */
export function getPdfThumbnail(
  assistantId: string,
  entry: { path: string; size: number | null; modifiedAt: string },
  cardW: number,
  cardH: number,
): Promise<string | null> {
  const key = pdfThumbCacheKey(entry);
  const cached = memoryCache.get(key);
  if (cached) return cached;

  const result = (async (): Promise<string | null> => {
    try {
      const persisted = await idbGetThumb(key);
      if (persisted) return URL.createObjectURL(persisted);
      // The 4s budget covers the work itself, not time spent waiting in the
      // queue behind other PDFs — queued cards must not fail spuriously.
      const blob = await renderQueue.run(() =>
        withBudget(
          (async () => {
            const bytes = await fetchPdfBytes(assistantId, entry.path);
            return renderFirstPageToBlob(bytes, cardW, cardH);
          })(),
          PDF_THUMB_BUDGET_MS,
        ),
      );
      void idbPutThumb(key, blob);
      return URL.createObjectURL(blob);
    } catch {
      return null;
    }
  })();

  memoryCache.set(key, result);
  return result;
}

/** @internal test hook. */
export function clearPdfThumbMemoryCache(): void {
  memoryCache.clear();
}
