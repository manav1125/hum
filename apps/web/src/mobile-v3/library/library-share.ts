/**
 * Sharing a made thing OUT of Cue — C3's "⇪ shares to Files, Mail, AirDrop",
 * made real.
 *
 * Why this is a module and not a one-line `navigator.share`: the frame's
 * promise needs two things the gallery did not have.
 *
 *  1. **The bytes.** `GET /outputs` hands a card an `attachmentId`, never a
 *     URL, so the artefact has to be pulled through the attachment content
 *     route and wrapped before any sheet can carry it. That the WebView can
 *     do this with the session it already has is not a guess — the gallery's
 *     image covers fetch the same route, same origin, and render real pixels.
 *  2. **A sheet to put them in.** `navigator.share({ files })` is refused
 *     inside a Capacitor WKWebView, which is why `runtime/native-file.ts`
 *     exists at all. The shell links `CapacitorShare` and
 *     `CapacitorFilesystem` (apps/ios/App/CapApp-SPM/Package.swift), and
 *     `SharePlugin.swift` presents a `UIActivityViewController` over the
 *     `file://` URL — which is *literally* where Files, Mail and AirDrop come
 *     from. So the native path is blob → base64 → `Filesystem.writeFile(
 *     Directory.Cache)` → `Share.share({ files: [uri] })`.
 *
 * The Library needs its own runner rather than calling `saveFile()` because
 * that one wraps the share in `catch {}` — it cannot tell a dismissed sheet
 * from a broken one, and a share that cannot fail cannot be honest about
 * succeeding.
 *
 * The rules this file exists to hold:
 *
 *  · **The footer is derived, never written down.** `shareFooterLine` reads
 *    the reach we actually have AND what the wall actually holds. A shell
 *    that cannot carry bytes does not get a line claiming it can, and a
 *    gallery of link-backed outputs does not get a line about files.
 *  · **No affordance without something behind it.** An entry with neither an
 *    attachment nor an external URL gets no ⇪, because a button that opens an
 *    empty sheet is the no-op this product refuses.
 *  · **Dismissed is not failed, and failed is not done.** `SharePlugin.swift`
 *    rejects with "Share canceled" when the user backs out of the sheet and
 *    "Error sharing item" when the activity itself errors; the web sheet
 *    throws `AbortError` for the same dismissal. The two are distinguishable,
 *    so they are kept apart: a dismissal is silent, a failure is an error
 *    state, and only a completed share reports success.
 */

import { Capacitor } from "@capacitor/core";

import { attachmentsByIdContentGet } from "@/generated/daemon/sdk.gen";

import type { LibraryEntry } from "./library-model";

/* -------------------------------------------------------------------------- */
/* Reach — what this shell can actually put in front of you                   */
/* -------------------------------------------------------------------------- */

export type ShareReach =
  /** Capacitor iOS: `UIActivityViewController` over a real file. Files, Mail, AirDrop. */
  | "ios-sheet"
  /** Capacitor elsewhere (Android): the platform sheet, over a real file. */
  | "native-sheet"
  /** Plain web where `navigator.canShare({ files })` is true. */
  | "web-files"
  /** Plain web with `navigator.share` but no file support: links only. */
  | "web-link"
  /** Nothing. No ⇪ is offered and the footer says only what tap does. */
  | "none";

/** True where the reach can carry the artefact itself, not just a link. */
export function reachCarriesFiles(reach: ShareReach): boolean {
  return (
    reach === "ios-sheet" || reach === "native-sheet" || reach === "web-files"
  );
}

/**
 * The probe, injectable so the decision is testable without a shell. The
 * defaults read the real platform.
 */
export interface ShareProbe {
  isNative: boolean;
  platform: string;
  hasWebShare: boolean;
  /** `navigator.canShare({ files: [...] })` against a representative file. */
  canShareFiles: () => boolean;
}

/**
 * A one-byte stand-in for a real artefact. `canShare` inspects the File's
 * type, not its contents, so this answers the platform question honestly
 * without fetching anything.
 */
function probeFile(): File {
  return new File([new Uint8Array([0])], "cue-artefact.pdf", {
    type: "application/pdf",
  });
}

export function defaultShareProbe(): ShareProbe {
  const nav =
    typeof navigator === "undefined"
      ? null
      : (navigator as Navigator & { canShare?: (d: ShareData) => boolean });
  return {
    isNative: typeof window !== "undefined" && Capacitor.isNativePlatform(),
    platform: typeof window === "undefined" ? "web" : Capacitor.getPlatform(),
    hasWebShare: typeof nav?.share === "function",
    canShareFiles: () =>
      typeof nav?.canShare === "function"
        ? nav.canShare({ files: [probeFile()] })
        : false,
  };
}

export function detectShareReach(
  probe: ShareProbe = defaultShareProbe(),
): ShareReach {
  // The native shell is checked first and trusted without a probe: the plugin's
  // own `canShare` hardcodes `true` on iOS, and `UIActivityViewController`
  // takes any `file://` URL we hand it.
  if (probe.isNative) {
    return probe.platform === "ios" ? "ios-sheet" : "native-sheet";
  }
  if (!probe.hasWebShare) return "none";
  let files = false;
  try {
    files = probe.canShareFiles();
  } catch {
    // A probe that throws is a NO. Reading a thrown exception as capability
    // is how a footer ends up promising a sheet that never opens.
    files = false;
  }
  return files ? "web-files" : "web-link";
}

/* -------------------------------------------------------------------------- */
/* What a given card can honestly offer                                       */
/* -------------------------------------------------------------------------- */

export type EntryShareMode = "file" | "link" | null;

/**
 * How this entry would be shared under this reach — `null` when it would be a
 * no-op, which is what suppresses the ⇪ entirely.
 *
 * File beats link when both exist and the shell can carry bytes: the artefact
 * is the thing you meant to send, and a URL to it is a consolation prize.
 */
export function entryShareMode(
  entry: LibraryEntry,
  reach: ShareReach,
): EntryShareMode {
  if (reach === "none") return null;
  if (entry.attachment && reachCarriesFiles(reach)) return "file";
  if (entry.externalUrl) return "link";
  return null;
}

/** Whether any card on this wall can be shared at all. */
export function anyShareable(
  entries: LibraryEntry[],
  reach: ShareReach,
): boolean {
  return entries.some((e) => entryShareMode(e, reach) !== null);
}

const TAP_LINE = "Tap opens it here.";

/**
 * The footer, computed from the truth twice over: the reach this shell has,
 * and the outputs this wall is actually showing.
 *
 * The full C3 line is only claimed where it is literally true — the iOS
 * share sheet, whose Files / Mail / AirDrop rows come from
 * `UIActivityViewController`. Every other reach gets the narrower promise it
 * can keep, and a reach of nothing gets no promise at all.
 */
export function shareFooterLine(
  reach: ShareReach,
  entries: LibraryEntry[],
): string {
  const modes = entries.map((e) => entryShareMode(e, reach));
  if (modes.some((m) => m === "file")) {
    return reach === "ios-sheet"
      ? `${TAP_LINE} ⇪ shares to Files, Mail, AirDrop.`
      : `${TAP_LINE} ⇪ opens your share sheet with the real file.`;
  }
  if (modes.some((m) => m === "link")) {
    return `${TAP_LINE} ⇪ shares a link to the published ones.`;
  }
  return TAP_LINE;
}

/* -------------------------------------------------------------------------- */
/* Doing it                                                                   */
/* -------------------------------------------------------------------------- */

export type ShareResult =
  | { status: "shared" }
  /** The sheet opened and the user backed out. Not a failure; not a success. */
  | { status: "dismissed" }
  | { status: "failed"; message: string };

/**
 * The three moving parts, injectable so a test can reject any one of them
 * without a shell, a network, or a `mock.module` factory.
 */
export interface ShareIo {
  fetchBlob(assistantId: string, attachmentId: string): Promise<Blob>;
  shareFile(input: {
    blob: Blob;
    filename: string;
    title: string;
    reach: ShareReach;
  }): Promise<void>;
  shareLink(input: {
    url: string;
    title: string;
    reach: ShareReach;
  }): Promise<void>;
}

/**
 * A dismissed sheet. iOS's plugin rejects with "Share canceled"; the web
 * sheet throws `AbortError`. "Error sharing item" — the plugin's genuine
 * failure — deliberately matches neither.
 */
export function isShareDismissal(error: unknown): boolean {
  if (
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "AbortError"
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /cancel/i.test(message);
}

/** Cache paths are flat; a filename carrying separators would escape it. */
function safeFilename(filename: string): string {
  const cleaned = filename.replace(/[/\\]/g, "_").trim();
  return cleaned.length > 0 ? cleaned : "cue-output";
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = String(reader.result ?? "").split(",")[1];
      if (base64) resolve(base64);
      else reject(new Error("Could not read the file"));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Read failed"));
    reader.readAsDataURL(blob);
  });
}

const defaultIo: ShareIo = {
  async fetchBlob(assistantId, attachmentId) {
    const { data } = await attachmentsByIdContentGet({
      path: { assistant_id: assistantId, id: attachmentId },
      parseAs: "blob",
      throwOnError: true,
    });
    return data as unknown as Blob;
  },

  async shareFile({ blob, filename, title, reach }) {
    if (reach === "ios-sheet" || reach === "native-sheet") {
      const { Filesystem, Directory } = await import("@capacitor/filesystem");
      const { Share } = await import("@capacitor/share");
      const path = safeFilename(filename);
      const written = await Filesystem.writeFile({
        path,
        data: await blobToBase64(blob),
        directory: Directory.Cache,
      });
      try {
        await Share.share({ files: [written.uri], title });
      } finally {
        // The sheet copies the file to wherever it was sent, so the cache
        // copy is spent either way — including after a dismissal.
        void Filesystem.deleteFile({
          path,
          directory: Directory.Cache,
        }).catch(() => {});
      }
      return;
    }
    const file = new File([blob], safeFilename(filename), {
      type: blob.type || "application/octet-stream",
    });
    const nav = navigator as Navigator & {
      canShare?: (d: ShareData) => boolean;
    };
    // The probe answered for a representative file; this one is real, and a
    // browser is allowed to refuse it. Saying so beats a silent nothing.
    if (!nav.canShare?.({ files: [file] })) {
      throw new Error("This browser wouldn’t take the file");
    }
    await nav.share({ files: [file], title });
  },

  async shareLink({ url, title, reach }) {
    if (reach === "ios-sheet" || reach === "native-sheet") {
      const { Share } = await import("@capacitor/share");
      await Share.share({ url, title });
      return;
    }
    await navigator.share({ url, title });
  },
};

/**
 * Share one made thing. Never throws — every path resolves to a result the
 * caller must render, which is what keeps a failure from becoming a shrug.
 */
export async function shareLibraryEntry(
  entry: LibraryEntry,
  opts: {
    assistantId: string;
    reach: ShareReach;
    io?: Partial<ShareIo>;
  },
): Promise<ShareResult> {
  const io: ShareIo = { ...defaultIo, ...opts.io };
  const mode = entryShareMode(entry, opts.reach);

  if (mode === "link" && entry.externalUrl) {
    try {
      await io.shareLink({
        url: entry.externalUrl,
        title: entry.title,
        reach: opts.reach,
      });
      return { status: "shared" };
    } catch (error) {
      if (isShareDismissal(error)) return { status: "dismissed" };
      return { status: "failed", message: "Couldn’t share the link." };
    }
  }

  if (mode === "file" && entry.attachment) {
    let blob: Blob;
    try {
      blob = await io.fetchBlob(opts.assistantId, entry.attachment.id);
    } catch {
      // The bytes never arrived, so nothing left this device. Say that,
      // rather than opening a sheet over an empty file.
      return { status: "failed", message: "Couldn’t fetch the file." };
    }
    try {
      await io.shareFile({
        blob,
        filename: entry.attachment.filename,
        title: entry.title,
        reach: opts.reach,
      });
      return { status: "shared" };
    } catch (error) {
      if (isShareDismissal(error)) return { status: "dismissed" };
      return { status: "failed", message: "Couldn’t open the share sheet." };
    }
  }

  // Unreachable through the UI — the ⇪ is not rendered without a mode — but a
  // programmatic caller gets a named refusal rather than a resolved nothing.
  return { status: "failed", message: "Nothing to share behind this one." };
}
