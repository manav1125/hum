/**
 * Mv3FilesPage — the mobile "Files" gallery (round-4 frame 64): what Cue has
 * MADE, not a file browser. Hero card = newest artifact, then a 2-col grid of
 * cards with corner type chips, human titles + date + folder sub-lines.
 * Flat newest-50, read-only — no tree, no create/rename/delete.
 *
 * DATA (real endpoints only):
 *  · listing    — the existing workspace/tree endpoint, walked breadth-first
 *                 (bounded: depth ≤ 3, ≤ 24 directory fetches) and flattened
 *                 to the newest 50 files
 *  · thumbnails — the spec's first-page render endpoint does NOT exist; the
 *                 sanctioned degrade ships instead: images render themselves
 *                 (workspace/file/content blob), everything else paints the
 *                 tinted type-chip block
 *  · tap        — an in-app preview sheet (image / markdown / text via the
 *                 file endpoints); other types say so honestly and offer
 *                 share/download. No native Quick Look claims.
 *  · ⇪          — navigator.share with the real file when the platform
 *                 allows it, else a blob download.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { FileMarkdown, isMarkdown } from "@/components/file-markdown";
import {
  fileContext,
  fileTypeChip,
  humanFileTitle,
  isImageFile,
  isTextPreviewable,
  selectNewestFiles,
  typeTint,
  type WorkspaceFileEntry,
} from "@/domains/workspace/mobile/files-gallery-model";
import { formatFileSize } from "@/domains/workspace/utils/format-file-size";
import {
  workspaceFileContentGet,
  workspaceFileGet,
  workspaceTreeGet,
} from "@/generated/daemon/sdk.gen";
import { GlassCard } from "@/mobile-v3/glass-card";
import { microLabel, primaryBtn, rise, secondaryBtn } from "@/mobile-v3/mv3-kit";
import { SheetShell } from "@/mobile-v3/sheet-shell";
import { YouScreen } from "@/mobile-v3/you/you-kit";
import { captureError } from "@/lib/sentry/capture-error";
import { formatRelativeDate } from "@/utils/format-date";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

const GALLERY_LIMIT = 50;
const WALK_MAX_DEPTH = 3;
const WALK_MAX_DIRS = 24;

/**
 * Bounded breadth-first walk over the existing per-directory tree endpoint,
 * one PARALLEL fetch wave per depth level (a sequential walk against a
 * remote daemon took 10s+). The root listing must succeed; subdirectory
 * listings that fail are skipped — a half-full gallery beats an error wall
 * on a read-only surface.
 */
async function walkWorkspaceFiles(
  assistantId: string,
): Promise<WorkspaceFileEntry[]> {
  const files: WorkspaceFileEntry[] = [];
  let level: Array<string | undefined> = [undefined];
  let depth = 0;
  let dirBudget = WALK_MAX_DIRS;
  while (level.length > 0 && dirBudget > 0 && depth <= WALK_MAX_DEPTH) {
    const wave = level.slice(0, dirBudget);
    dirBudget -= wave.length;
    const listings = await Promise.all(
      wave.map(async (path) => {
        const { data, error } = await workspaceTreeGet({
          path: { assistant_id: assistantId },
          query: path ? { path } : {},
        });
        if (error || !data) {
          if (path === undefined) {
            throw error ?? new Error("Failed to load workspace");
          }
          return null;
        }
        return data;
      }),
    );
    const nextLevel: string[] = [];
    for (const listing of listings) {
      for (const entry of listing?.entries ?? []) {
        if (entry.type === "file") {
          files.push(entry);
        } else if (!entry.name.startsWith(".")) {
          nextLevel.push(entry.path);
        }
      }
    }
    level = nextLevel;
    depth += 1;
  }
  return files;
}

function useFilesGallery(assistantId: string) {
  return useQuery({
    queryKey: ["mv3-files-gallery", assistantId],
    queryFn: async () =>
      selectNewestFiles(await walkWorkspaceFiles(assistantId), GALLERY_LIMIT),
    staleTime: 30_000,
  });
}

/** Blob → object URL for an image artifact acting as its own thumbnail. */
function useImageObjectUrl(
  assistantId: string,
  path: string | null,
): string | null {
  const { data } = useQuery({
    queryKey: ["mv3-files-image", assistantId, path],
    queryFn: async () => {
      const res = await workspaceFileContentGet({
        path: { assistant_id: assistantId },
        query: { path: path! },
        parseAs: "blob",
      });
      if (res.error || !res.data) throw res.error ?? new Error("no blob");
      return URL.createObjectURL(res.data);
    },
    enabled: path != null,
    staleTime: Infinity,
    // Object URLs leak if garbage-collected queries drop them silently;
    // gallery scale (≤50, images only) keeps this bounded for the session.
    gcTime: Infinity,
  });
  return data ?? null;
}

async function shareOrDownloadFile(
  assistantId: string,
  entry: WorkspaceFileEntry,
  mode: "share" | "download",
): Promise<void> {
  const res = await workspaceFileContentGet({
    path: { assistant_id: assistantId },
    query: { path: entry.path },
    parseAs: "blob",
  });
  if (res.error || !res.data) {
    throw res.error ?? new Error("Failed to fetch file");
  }
  const blob = res.data;
  const file = new File([blob], entry.name, {
    type: entry.mimeType ?? (blob.type || "application/octet-stream"),
  });
  const nav = navigator as Navigator & {
    canShare?: (data: ShareData) => boolean;
  };
  if (
    mode === "share" &&
    typeof nav.share === "function" &&
    nav.canShare?.({ files: [file] })
  ) {
    try {
      await nav.share({ files: [file], title: humanFileTitle(entry.name) });
      return;
    } catch (error) {
      // User cancelled the share sheet — not an error, and no fallback.
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      // Share failed for real: fall through to download.
    }
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = entry.name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const chipStyle = (tones: {
  chipBg: string;
  chipColor: string;
}): React.CSSProperties => ({
  position: "absolute",
  top: 8,
  right: 8,
  ...microLabel,
  fontSize: 8,
  letterSpacing: "0.06em",
  color: tones.chipColor,
  background: tones.chipBg,
  borderRadius: 4,
  padding: "2px 6px",
});

/** Thumbnail block: real image when the artifact IS an image, tinted type
 *  block otherwise (the sanctioned degrade — no fake page renders). */
function ThumbBlock({
  assistantId,
  entry,
  height,
}: {
  assistantId: string;
  entry: WorkspaceFileEntry;
  height: number;
}) {
  const image = isImageFile(entry);
  const chip = fileTypeChip(entry.name, entry.mimeType);
  const tones = typeTint(chip);
  const objectUrl = useImageObjectUrl(assistantId, image ? entry.path : null);
  return (
    <div
      aria-hidden
      style={{
        height,
        position: "relative",
        background:
          image && objectUrl
            ? `left top / cover no-repeat url("${objectUrl}")`
            : tones.blockBg,
      }}
    >
      {!(image && objectUrl) ? (
        <span
          style={{
            position: "absolute",
            left: 10,
            bottom: 8,
            ...microLabel,
            fontSize: height > 100 ? 13 : 11,
            letterSpacing: "0.08em",
            color: tones.blockFg,
          }}
        >
          {chip}
        </span>
      ) : null}
      <span style={chipStyle(tones)}>{chip}</span>
    </div>
  );
}

function subLine(entry: WorkspaceFileEntry): string {
  const parts = [formatRelativeDate(entry.modifiedAt)];
  const ctx = fileContext(entry.path);
  if (ctx) parts.push(ctx);
  return parts.join(" · ");
}

export function Mv3FilesPage({ assistantId }: { assistantId: string }) {
  const gallery = useFilesGallery(assistantId);
  const [previewEntry, setPreviewEntry] = useState<WorkspaceFileEntry | null>(
    null,
  );
  const [shareBusyPath, setShareBusyPath] = useState<string | null>(null);

  const files = useMemo(() => gallery.data ?? [], [gallery.data]);
  const hero = files[0] ?? null;
  const rest = useMemo(() => files.slice(1), [files]);

  const share = (entry: WorkspaceFileEntry, mode: "share" | "download") => {
    haptic.light();
    setShareBusyPath(entry.path);
    void shareOrDownloadFile(assistantId, entry, mode)
      .catch((error) =>
        captureError(error, {
          context: "mv3-files.share",
          bestEffort: true,
        }),
      )
      .finally(() => setShareBusyPath(null));
  };

  return (
    <YouScreen
      tint="blue"
      testId="mv3-files"
      back={routes.channels}
      backLabel="You"
      title="Files"
      sub="What Cue has made · read-only here"
    >
      {gallery.isError ? (
        <GlassCard padding="15px 16px" style={rise(0.1)}>
          <div style={{ fontSize: 13, color: "var(--mv3-muted)" }}>
            Couldn't load the workspace.
          </div>
          <button
            type="button"
            onClick={() => void gallery.refetch()}
            style={{
              marginTop: 8,
              fontSize: 12.5,
              fontWeight: 600,
              color: "var(--mv3-accent)",
              background: "none",
              border: "none",
              padding: 0,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            Retry
          </button>
        </GlassCard>
      ) : gallery.isLoading ? (
        <GlassCard padding="18px 16px" style={rise(0.1)}>
          <div style={{ fontSize: 13, color: "var(--mv3-faint)" }}>
            Loading what Cue has made…
          </div>
        </GlassCard>
      ) : !hero ? (
        <GlassCard padding="18px 16px" style={rise(0.1)}>
          <div style={{ fontSize: 13.5, fontWeight: 600 }}>Nothing yet</div>
          <div
            style={{
              fontSize: 12.5,
              color: "var(--mv3-muted)",
              marginTop: 4,
              lineHeight: 1.5,
            }}
          >
            When Cue makes documents, sheets or images, the newest land here.
          </div>
        </GlassCard>
      ) : (
        <>
          {/* Hero — the newest artifact, with provenance eyebrow. */}
          <div style={rise(0.1)}>
            <div
              style={{
                ...microLabel,
                color: "var(--mv3-micro)",
                padding: "0 4px 8px",
              }}
            >
              Newest · {formatRelativeDate(hero.modifiedAt)}
            </div>
            <div
              role="button"
              tabIndex={0}
              aria-label={`Preview ${humanFileTitle(hero.name)}`}
              onClick={() => {
                haptic.light();
                setPreviewEntry(hero);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setPreviewEntry(hero);
                }
              }}
              style={{
                borderRadius: 20,
                overflow: "hidden",
                border: "1px solid var(--mv3-card-border)",
                boxShadow: "0 24px 50px -24px rgba(61,110,232,.45)",
                cursor: "pointer",
              }}
            >
              <ThumbBlock assistantId={assistantId} entry={hero} height={150} />
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 11,
                  background: "var(--mv3-glass)",
                  padding: "12px 15px",
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 14,
                      fontWeight: 600,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {humanFileTitle(hero.name)}
                  </div>
                  <div
                    style={{
                      fontSize: 10.5,
                      color: "var(--mv3-muted)",
                      marginTop: 1,
                    }}
                  >
                    {hero.size != null
                      ? `${formatFileSize(hero.size)} · ${subLine(hero)}`
                      : subLine(hero)}
                  </div>
                </div>
                <button
                  type="button"
                  aria-label={`Share ${humanFileTitle(hero.name)}`}
                  disabled={shareBusyPath === hero.path}
                  onClick={(e) => {
                    e.stopPropagation();
                    share(hero, "share");
                  }}
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: "50%",
                    background: "linear-gradient(160deg, #4E7CEC, #3560CC)",
                    border: "none",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 13,
                    color: "#fff",
                    boxShadow: "0 8px 18px -6px rgba(61,110,232,.5)",
                    cursor: "pointer",
                    flexShrink: 0,
                    opacity: shareBusyPath === hero.path ? 0.6 : 1,
                    fontFamily: "inherit",
                  }}
                >
                  ⇪
                </button>
              </div>
            </div>
          </div>

          {/* 2-col grid of the rest. */}
          {rest.length > 0 ? (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 9,
                ...rise(0.2),
              }}
            >
              {rest.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  aria-label={`Preview ${humanFileTitle(entry.name)}`}
                  onClick={() => {
                    haptic.light();
                    setPreviewEntry(entry);
                  }}
                  style={{
                    borderRadius: 16,
                    overflow: "hidden",
                    border: "1px solid var(--mv3-card-border)",
                    background: "var(--mv3-card)",
                    padding: 0,
                    textAlign: "left",
                    cursor: "pointer",
                    fontFamily: "inherit",
                    color: "var(--mv3-text)",
                  }}
                >
                  <ThumbBlock
                    assistantId={assistantId}
                    entry={entry}
                    height={72}
                  />
                  <div style={{ padding: "8px 11px 10px" }}>
                    <div
                      style={{
                        fontSize: 11.5,
                        fontWeight: 600,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {humanFileTitle(entry.name)}
                    </div>
                    <div
                      style={{
                        fontSize: 9.5,
                        color: "var(--mv3-faint)",
                        marginTop: 2,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {subLine(entry)}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          ) : null}

          <div
            style={{
              fontSize: 10.5,
              color: "var(--mv3-faint)",
              textAlign: "center",
              marginTop: 2,
            }}
          >
            Tap to preview · ⇪ to share · newest {GALLERY_LIMIT} · read-only
          </div>
        </>
      )}

      <FilePreviewSheet
        assistantId={assistantId}
        entry={previewEntry}
        busy={previewEntry != null && shareBusyPath === previewEntry.path}
        onShare={share}
        onClose={() => setPreviewEntry(null)}
      />
    </YouScreen>
  );
}

/**
 * The tap target: an in-app preview sheet. Images and small text/markdown
 * files preview inline via the real file endpoints; anything else states the
 * limit honestly and offers share/download.
 */
function FilePreviewSheet({
  assistantId,
  entry,
  busy,
  onShare,
  onClose,
}: {
  assistantId: string;
  entry: WorkspaceFileEntry | null;
  busy: boolean;
  onShare: (entry: WorkspaceFileEntry, mode: "share" | "download") => void;
  onClose: () => void;
}) {
  return (
    <SheetShell
      open={entry != null}
      onClose={onClose}
      label={entry ? humanFileTitle(entry.name) : "File preview"}
    >
      {entry ? (
        <FilePreviewBody assistantId={assistantId} entry={entry} busy={busy} onShare={onShare} />
      ) : null}
    </SheetShell>
  );
}

function FilePreviewBody({
  assistantId,
  entry,
  busy,
  onShare,
}: {
  assistantId: string;
  entry: WorkspaceFileEntry;
  busy: boolean;
  onShare: (entry: WorkspaceFileEntry, mode: "share" | "download") => void;
}) {
  const image = isImageFile(entry);
  const text = !image && isTextPreviewable(entry);
  const chip = fileTypeChip(entry.name, entry.mimeType);

  const imageUrl = useImageObjectUrl(assistantId, image ? entry.path : null);
  const fileQuery = useQuery({
    queryKey: ["mv3-files-text", assistantId, entry.path],
    queryFn: async () => {
      const { data, error } = await workspaceFileGet({
        path: { assistant_id: assistantId },
        query: { path: entry.path },
      });
      if (error || !data) throw error ?? new Error("Failed to load file");
      return data;
    },
    enabled: text,
    staleTime: 30_000,
  });

  const markdown = isMarkdown(entry.name, entry.mimeType ?? undefined);

  return (
    // SheetShell already pads 18px horizontally + the safe-area bottom.
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        minHeight: 0,
      }}
    >
      <div>
        <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: "-.3px" }}>
          {humanFileTitle(entry.name)}
        </div>
        <div
          style={{ fontSize: 11.5, color: "var(--mv3-muted)", marginTop: 3 }}
        >
          {[
            chip,
            entry.size != null ? formatFileSize(entry.size) : null,
            subLine(entry),
          ]
            .filter(Boolean)
            .join(" · ")}
        </div>
      </div>

      <div
        style={{
          overflowY: "auto",
          WebkitOverflowScrolling: "touch",
          maxHeight: "48vh",
          borderRadius: 14,
          border: "1px solid var(--mv3-line)",
          background: image && imageUrl ? "transparent" : "var(--mv3-card)",
        }}
      >
        {image ? (
          imageUrl ? (
            <img
              src={imageUrl}
              alt={humanFileTitle(entry.name)}
              style={{
                display: "block",
                maxWidth: "100%",
                margin: "0 auto",
                borderRadius: 13,
              }}
            />
          ) : (
            <PreviewNote>Loading image…</PreviewNote>
          )
        ) : text ? (
          fileQuery.isLoading ? (
            <PreviewNote>Loading…</PreviewNote>
          ) : fileQuery.data?.content != null && !fileQuery.data.isBinary ? (
            <div style={{ padding: "12px 14px" }}>
              {markdown ? (
                <FileMarkdown content={fileQuery.data.content} />
              ) : (
                <pre
                  style={{
                    margin: 0,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    fontFamily: "var(--mv3-mono)",
                    fontSize: 11.5,
                    lineHeight: 1.5,
                  }}
                >
                  {fileQuery.data.content}
                </pre>
              )}
            </div>
          ) : (
            <PreviewNote>Couldn't read this file.</PreviewNote>
          )
        ) : (
          <PreviewNote>
            No in-app preview for {chip} files yet — share or download to open
            it in another app.
          </PreviewNote>
        )}
      </div>

      <div style={{ display: "flex", gap: 9 }}>
        <button
          type="button"
          disabled={busy}
          onClick={() => onShare(entry, "share")}
          style={{ ...primaryBtn, opacity: busy ? 0.6 : 1 }}
        >
          {busy ? "Preparing…" : "⇪ Share"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onShare(entry, "download")}
          style={secondaryBtn}
        >
          Download
        </button>
      </div>
    </div>
  );
}

function PreviewNote({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "26px 18px",
        fontSize: 12.5,
        lineHeight: 1.5,
        color: "var(--mv3-muted)",
        textAlign: "center",
      }}
    >
      {children}
    </div>
  );
}
