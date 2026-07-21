/**
 * Pure derivations for the mobile Files gallery (round-4 frame 64): newest-50
 * selection over workspace tree listings, filename → human title demotion,
 * and the type-chip / tinted-block treatment (the sanctioned degrade — the
 * spec's first-page render endpoint doesn't exist, so every non-image card
 * paints a tinted type block instead of a fake preview).
 */

export interface WorkspaceFileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size: number | null;
  mimeType: string | null;
  modifiedAt: string;
}

/** "acme-one-pager-v2.pdf" → "Acme one pager v2" (filename demoted). */
export function humanFileTitle(name: string): string {
  const base = name.replace(/\.[A-Za-z0-9]{1,8}$/, "");
  const spaced = base.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  if (!spaced) return name;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Corner chip label from the extension (spec chips: PDF/XLS/DECK/MD/PNG…). */
export function fileTypeChip(name: string, mimeType: string | null): string {
  const ext = extensionOf(name);
  switch (ext) {
    case "pdf":
      return "PDF";
    case "xls":
    case "xlsx":
    case "numbers":
      return "XLS";
    case "csv":
    case "tsv":
      return "CSV";
    case "ppt":
    case "pptx":
    case "key":
      return "DECK";
    case "md":
    case "markdown":
      return "MD";
    case "doc":
    case "docx":
      return "DOC";
    case "htm":
    case "html":
      return "HTML";
    case "jpeg":
      return "JPG";
    default:
      break;
  }
  if (ext) return ext.toUpperCase().slice(0, 4);
  if (mimeType?.startsWith("image/")) return "IMG";
  if (mimeType?.startsWith("text/")) return "TXT";
  return "FILE";
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

export function isImageFile(entry: {
  name: string;
  mimeType: string | null;
}): boolean {
  if (entry.mimeType?.startsWith("image/")) return true;
  return ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(
    extensionOf(entry.name),
  );
}

export function isTextPreviewable(entry: {
  name: string;
  mimeType: string | null;
  size: number | null;
}): boolean {
  if (entry.size != null && entry.size > 512 * 1024) return false;
  if (
    entry.mimeType?.startsWith("text/") ||
    entry.mimeType === "application/json"
  ) {
    return true;
  }
  return [
    "md",
    "markdown",
    "txt",
    "json",
    "csv",
    "tsv",
    "html",
    "htm",
    "log",
    "yaml",
    "yml",
  ].includes(extensionOf(entry.name));
}

/** Tinted degrade block + chip tones per type family (frame-64 palette). */
export function typeTint(chip: string): {
  blockBg: string;
  /** Watermark letter color on the block (adapts to the block's tone). */
  blockFg: string;
  chipBg: string;
  chipColor: string;
} {
  switch (chip) {
    case "PDF":
      return {
        blockBg: "linear-gradient(160deg, #3A2226, #1E1216)",
        blockFg: "rgba(255,255,255,.45)",
        chipBg: "#E5675B",
        chipColor: "#fff",
      };
    case "XLS":
    case "CSV":
      return {
        blockBg: "linear-gradient(160deg, #123B2E, #0B2018)",
        blockFg: "rgba(255,255,255,.45)",
        chipBg: "#6FD69A",
        chipColor: "#08281A",
      };
    case "DECK":
      return {
        blockBg: "linear-gradient(160deg, #1A2230, #3D6EE8)",
        blockFg: "rgba(255,255,255,.55)",
        chipBg: "rgba(255,255,255,.24)",
        chipColor: "#fff",
      };
    case "MD":
    case "TXT":
    case "DOC":
      // The spec's light-paper page tint (frame 64's MD card).
      return {
        blockBg: "linear-gradient(160deg, #F4F3EF, #E4E1D8)",
        blockFg: "rgba(26,34,48,.4)",
        chipBg: "#7FA3F2",
        chipColor: "#fff",
      };
    case "PNG":
    case "JPG":
    case "GIF":
    case "WEBP":
    case "SVG":
    case "IMG":
      return {
        blockBg: "linear-gradient(140deg, #2B3A5C, #3D2B5C)",
        blockFg: "rgba(255,255,255,.5)",
        chipBg: "rgba(255,255,255,.24)",
        chipColor: "#fff",
      };
    default:
      return {
        blockBg: "linear-gradient(160deg, #262A36, #171A22)",
        blockFg: "rgba(255,255,255,.4)",
        chipBg: "rgba(255,255,255,.22)",
        chipColor: "#fff",
      };
  }
}

/** The folder an artifact lives in ("projects/acme/x.pdf" → "acme"). */
export function fileContext(path: string): string | null {
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return parts[parts.length - 2];
}

/**
 * Runtime droppings that live in the sandbox next to real artifacts (unix
 * sockets, sqlite sidecars, pid/lock files). They're "files" to the tree
 * endpoint but not "what Cue made" — the gallery hides them.
 */
const SYSTEM_FILE_EXTENSIONS = new Set([
  "sock",
  "sqlite",
  "sqlite-wal",
  "sqlite-shm",
  "db",
  "wal",
  "shm",
  "lock",
  "pid",
  "tmp",
]);

function isSystemFile(name: string): boolean {
  const dot = name.indexOf(".");
  if (dot <= 0) return false;
  // Match the full compound suffix ("gateway.sqlite-wal" → "sqlite-wal").
  const suffix = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return SYSTEM_FILE_EXTENSIONS.has(suffix);
}

/**
 * Flatten walked tree listings into the gallery feed: files only, dotfiles
 * and runtime droppings out, newest `limit` by modifiedAt (ties keep
 * listing order).
 */
export function selectNewestFiles(
  entries: readonly WorkspaceFileEntry[],
  limit = 50,
): WorkspaceFileEntry[] {
  return entries
    .filter(
      (entry) =>
        entry.type === "file" &&
        !entry.name.startsWith(".") &&
        !isSystemFile(entry.name),
    )
    .map((entry, i) => ({ entry, i, ts: Date.parse(entry.modifiedAt) }))
    .sort((a, b) => {
      const at = Number.isFinite(a.ts) ? a.ts : 0;
      const bt = Number.isFinite(b.ts) ? b.ts : 0;
      return bt - at || a.i - b.i;
    })
    .slice(0, limit)
    .map(({ entry }) => entry);
}
