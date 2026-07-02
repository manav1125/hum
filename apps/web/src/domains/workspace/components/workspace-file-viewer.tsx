/**
 * Viewer for individual workspace files. Supports markdown (preview/source
 * toggle), JSON (pretty-printed preview), plain text, images, video, and a
 * binary-fallback metadata card. Text-based files can be edited in-place with
 * Ctrl+S / Cmd+S to save.
 */

import {
    queryOptions,
    useMutation,
    useQuery,
    useQueryClient,
} from "@tanstack/react-query";
import {
    Check,
    Copy,
    Download,
    FileIcon,
    FileText,
    FilePlus,
    FolderOpen,
    Image as ImageIcon,
    Loader2,
    Pencil,
    Send,
    Sparkles,
    Video,
} from "lucide-react";
import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type ReactNode,
} from "react";

import { useNavigate } from "react-router";

import { FileMarkdown, isMarkdown } from "@/components/file-markdown";
import { isJson, prettifyJson } from "@/domains/workspace/utils/file-json";
import { formatFileSize } from "@/domains/workspace/utils/format-file-size";
import { isHiddenPath } from "@/domains/workspace/utils/is-hidden-path";
import {
    workspaceFileContentGet,
    workspaceFileGet,
    workspaceWritePost,
} from "@/generated/daemon/sdk.gen";
import type { WorkspaceFileGetResponse } from "@/generated/daemon/types.gen";
import { usePendingDeepLinkStore } from "@/stores/pending-deep-link-store";
import { formatRelativeDate } from "@/utils/format-date";
import { routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library/components/button";

import type { WorkspaceViewMode } from "@/domains/workspace/components/workspace-browser";

// Design tokens from surfaces/Workspace.dc.html, mapped by role onto the
// theme-aware `--mv1-*` palette so the viewer reads correctly in dark mode.
const C = {
  ink: "var(--mv1-chip)",
  blue: "var(--mv1-blue)",
  blueWash: "var(--mv1-blue-wash)",
  line: "var(--mv1-line)",
  surfaceTint: "var(--mv1-canvas)",
  t1: "var(--mv1-t1)",
  t2: "var(--mv1-t2)",
  t3: "var(--mv1-t3)",
} as const;
const mono = "'DM Mono', ui-monospace, monospace";

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

function workspaceFileRetrieveOptions(opts: {
  path: { assistant_id: string };
  query: { path: string; showHidden?: boolean };
}) {
  return queryOptions<WorkspaceFileGetResponse>({
    queryFn: async () => {
      const { data, error } = await workspaceFileGet({
        path: opts.path,
        query: {
          path: opts.query.path,
          ...(opts.query.showHidden ? { showHidden: "true" } : {}),
        },
      });
      if (error) throw error;
      return data!;
    },
    queryKey: ["assistantsWorkspaceFileRetrieve", opts],
  });
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function FileHeaderIcon({ mimeType }: { mimeType: string }) {
  const semi = mimeType.indexOf(";");
  const baseMime = (semi === -1 ? mimeType : mimeType.slice(0, semi)).trim();
  let Icon = FileText;
  if (baseMime.startsWith("image/")) Icon = ImageIcon;
  else if (baseMime.startsWith("video/")) Icon = Video;
  else if (
    !baseMime.startsWith("text/") &&
    baseMime !== "application/json" &&
    baseMime !== "application/octet-stream"
  ) {
    Icon = FileIcon;
  }
  return (
    <span
      className="flex shrink-0 items-center justify-center"
      style={{
        width: 26,
        height: 26,
        borderRadius: 7,
        background: C.blueWash,
      }}
    >
      <Icon className="h-3.5 w-3.5" style={{ color: C.blue }} />
    </span>
  );
}

/**
 * The mock's "✦ edited by Cue · 4m ago" badge. We can't attribute the editor,
 * so this shows an honest "edited · {relative time}" from the real
 * `modifiedAt`, keeping the mock's ink pill + Sparkles glyph.
 */
function EditedBadge({ modifiedAt }: { modifiedAt?: string | null }) {
  if (!modifiedAt) return null;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5"
      style={{
        fontFamily: mono,
        fontSize: 10,
        background: C.ink,
        color: "#fff",
        padding: "3px 9px",
        borderRadius: 6,
      }}
    >
      <Sparkles style={{ width: 11, height: 11 }} aria-hidden />
      edited · {formatRelativeDate(modifiedAt)}
    </span>
  );
}

function ViewModeToggle({
  viewMode,
  onChange,
}: {
  viewMode: WorkspaceViewMode;
  onChange: (mode: WorkspaceViewMode) => void;
}) {
  return (
    <div
      className="inline-flex rounded-md p-0.5"
      style={{ backgroundColor: "var(--mv1-sunken)" }}
    >
      {(["preview", "source"] as const).map((mode) => {
        const active = viewMode === mode;
        return (
          <Button
            key={mode}
            variant="ghost"
            onClick={() => onChange(mode)}
            className="h-auto rounded border-0 px-2.5 py-1 text-body-small-default hover:bg-transparent"
            style={{
              backgroundColor: active ? "var(--mv1-card)" : "transparent",
              color: active ? C.t1 : C.t3,
              boxShadow: active ? "0 1px 2px rgba(26,34,48,.12)" : undefined,
            }}
          >
            {mode === "preview" ? "Preview" : "Source"}
          </Button>
        );
      })}
    </div>
  );
}

function FileHeader({
  name,
  mimeType,
  size,
  modifiedAt,
  rightContent,
}: {
  name: string;
  mimeType: string;
  size?: number;
  modifiedAt?: string | null;
  rightContent?: ReactNode;
}) {
  return (
    <div
      className="flex items-center gap-[11px] border-b px-[18px] py-[14px]"
      style={{ borderColor: C.line }}
    >
      <FileHeaderIcon mimeType={mimeType} />
      <span
        className="truncate"
        style={{ fontSize: 14, fontWeight: 600, color: C.t1 }}
      >
        {name}
      </span>
      {size != null && (
        <span
          className="shrink-0"
          style={{ fontFamily: mono, fontSize: 10, color: C.t3 }}
        >
          {formatFileSize(size)}
        </span>
      )}
      <EditedBadge modifiedAt={modifiedAt} />
      {rightContent && (
        <div className="ml-auto flex items-center gap-3">{rightContent}</div>
      )}
    </div>
  );
}

function BinaryContentViewer({
  assistantId,
  path,
  mimeType,
  showHidden,
}: {
  assistantId: string;
  path: string;
  mimeType: string;
  showHidden?: boolean;
}) {
  const { data: blob, isLoading } = useQuery({
    queryFn: async () => {
      const res = await workspaceFileContentGet({
        path: { assistant_id: assistantId },
        query: { path, ...(showHidden ? { showHidden: "true" } : {}) },
        parseAs: "blob",
      });
      if (res.error) throw res.error;
      return res.data!;
    },
    queryKey: [
      "assistantsWorkspaceFileContentRetrieve",
      { assistantId, path, showHidden },
    ],
    enabled: !!path,
  });

  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    setObjectUrl(url);
    return () => {
      URL.revokeObjectURL(url);
      setObjectUrl(null);
    };
  }, [blob]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2
          className="h-6 w-6 animate-spin"
          style={{ color: "var(--content-tertiary)" }}
        />
      </div>
    );
  }

  if (!objectUrl) return null;

  if (mimeType.startsWith("image/")) {
    return (
      <div className="flex items-center justify-center p-4">
        <img
          src={objectUrl}
          alt={path.split("/").pop() ?? "image"}
          className="max-h-[70vh] max-w-full rounded object-contain"
        />
      </div>
    );
  }

  if (mimeType.startsWith("video/")) {
    return (
      <div className="flex items-center justify-center p-4">
        <video
          src={objectUrl}
          controls
          className="max-h-[70vh] max-w-full rounded"
        />
      </div>
    );
  }

  return null;
}

function EditFooter({
  isDirty,
  isSaving,
  onSave,
  onDiscard,
}: {
  isDirty: boolean;
  isSaving: boolean;
  onSave: () => void;
  onDiscard: () => void;
}) {
  return (
    <div
      className="flex items-center justify-end gap-2 border-t px-3 py-2"
      style={{ borderColor: "var(--border-element)" }}
    >
      <Button
        variant="ghost"
        size="compact"
        disabled={isSaving}
        onClick={onDiscard}
      >
        Discard
      </Button>
      {isSaving && (
        <Loader2
          className="h-4 w-4 animate-spin"
          style={{ color: "var(--content-tertiary)" }}
        />
      )}
      <Button
        variant="primary"
        size="compact"
        disabled={!isDirty || isSaving}
        onClick={onSave}
      >
        Save
      </Button>
    </div>
  );
}

function ContentActionBar({
  content,
  downloadContent,
  fileName,
  mimeType,
  showEdit,
  isEditing,
  onToggleEdit,
}: {
  content: string;
  downloadContent?: string;
  fileName: string;
  mimeType: string;
  showEdit: boolean;
  isEditing: boolean;
  onToggleEdit: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    });
  }, [content]);

  const rawContent = downloadContent ?? content;
  const handleDownload = useCallback(() => {
    const blob = new Blob([rawContent], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  }, [rawContent, fileName, mimeType]);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  if (isEditing) {
    return null;
  }

  return (
    <div className="absolute right-3 top-3 z-10 flex items-center gap-1 rounded-md bg-[var(--surface-primary)] shadow-sm">
      {showEdit && (
        <Button
          variant="ghost"
          size="regular"
          iconOnly={<Pencil aria-hidden />}
          onClick={onToggleEdit}
          aria-label="Edit file"
          className="hover:bg-[var(--surface-base)]"
        />
      )}
      <Button
        variant="ghost"
        size="regular"
        iconOnly={copied ? <Check aria-hidden /> : <Copy aria-hidden />}
        onClick={handleCopy}
        aria-label={copied ? "Copied" : "Copy file contents"}
        className="hover:bg-[var(--surface-base)]"
      />
      <Button
        variant="ghost"
        size="regular"
        iconOnly={<Download aria-hidden />}
        onClick={handleDownload}
        aria-label="Download file"
        className="hover:bg-[var(--surface-base)]"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Textarea editor — shared across markdown source, JSON source, and plain text
// ---------------------------------------------------------------------------

const MONO_FONT =
  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace";

function FileTextarea({
  value,
  onChange,
  onSave,
}: {
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  return (
    <textarea
      className="m-0 h-full w-full resize-none overflow-auto border-none bg-transparent p-4 text-body-medium-lighter leading-relaxed outline-none"
      style={{ color: "var(--content-default)", fontFamily: MONO_FONT }}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "s") {
          e.preventDefault();
          onSave();
        }
      }}
      spellCheck={false}
    />
  );
}

function SourcePre({
  content,
  readOnly,
  whiteSpace = "pre-wrap",
  onStartEdit,
}: {
  content: string;
  readOnly: boolean;
  whiteSpace?: "pre" | "pre-wrap";
  onStartEdit?: () => void;
}) {
  return (
    <pre
      className={`m-0 h-full overflow-auto p-4 text-body-medium-lighter leading-relaxed${!readOnly ? " cursor-text" : ""}`}
      style={{
        color: "var(--content-default)",
        fontFamily: MONO_FONT,
        whiteSpace,
      }}
      onClick={!readOnly ? onStartEdit : undefined}
    >
      {content}
    </pre>
  );
}

// ---------------------------------------------------------------------------
// Preview actions — the mock's "Send" / "Ask Cue to revise" row
// ---------------------------------------------------------------------------

function FilePreviewActions({
  onSend,
  onRevise,
}: {
  onSend: () => void;
  onRevise: () => void;
}) {
  return (
    <div
      className="flex items-center gap-2 border-t px-9 py-3"
      style={{ borderColor: "var(--mv1-line)", background: "var(--mv1-canvas)" }}
    >
      <button
        type="button"
        onClick={onSend}
        className="inline-flex items-center gap-2"
        style={{
          fontSize: 12.5,
          fontWeight: 500,
          background: "var(--mv1-blue)",
          color: "#fff",
          border: "none",
          borderRadius: 8,
          padding: "8px 16px",
          cursor: "pointer",
        }}
      >
        <Send style={{ width: 13, height: 13 }} aria-hidden />
        Send
      </button>
      <button
        type="button"
        onClick={onRevise}
        className="inline-flex items-center gap-2"
        style={{
          fontSize: 12.5,
          color: "var(--mv1-t1)",
          background: "var(--mv1-card)",
          border: "1px solid var(--mv1-line-strong)",
          borderRadius: 8,
          padding: "8px 14px",
          cursor: "pointer",
        }}
      >
        <Sparkles style={{ width: 13, height: 13 }} aria-hidden />
        Ask Cue to revise
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function WorkspaceFileViewer({
  assistantId,
  selectedPath,
  showHidden,
  viewMode,
  onChangeViewMode,
  onBrowse,
  pathRename,
  pathDelete,
  hasFiles,
  onCreateFile,
}: {
  assistantId: string;
  selectedPath: string | null;
  showHidden?: boolean;
  viewMode: WorkspaceViewMode;
  onChangeViewMode: (mode: WorkspaceViewMode) => void;
  onBrowse?: () => void;
  /** Last successful workspace rename, so edit state can follow the file. */
  pathRename?: { from: string; to: string } | null;
  /** Last successful workspace delete, so drafts for the path are discarded. */
  pathDelete?: { path: string } | null;
  /**
   * Whether the workspace has any entries. `undefined` while stats load;
   * `false` drives the calm on-brand empty state with a real create CTA.
   */
  hasFiles?: boolean;
  /** Opens the tree's real "New File" flow from the empty state. */
  onCreateFile?: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    ...workspaceFileRetrieveOptions({
      path: { assistant_id: assistantId },
      query: { path: selectedPath ?? "", showHidden },
    }),
    enabled: !!selectedPath,
  });

  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [editOverride, setEditOverride] = useState<{
    path: string;
    content: string;
  } | null>(null);

  // Keep an in-progress edit attached to the file when it (or an ancestor
  // folder) is renamed — otherwise the draft is orphaned under the old path
  // and silently disappears from the editor.
  useEffect(() => {
    if (!pathRename) return;
    const { from, to } = pathRename;
    const remap = (p: string) =>
      p === from
        ? to
        : p.startsWith(`${from}/`)
          ? to + p.slice(from.length)
          : p;
    setEditingPath((prev) => (prev == null ? prev : remap(prev)));
    setEditOverride((prev) =>
      prev == null ? prev : { ...prev, path: remap(prev.path) },
    );
  }, [pathRename]);

  // Discard drafts tied to a deleted file (or one under a deleted folder) so
  // recreating the same path doesn't resurrect the old contents — and Save
  // can't write them into the new file.
  useEffect(() => {
    if (!pathDelete) return;
    const { path } = pathDelete;
    const covers = (p: string) => p === path || p.startsWith(`${path}/`);
    setEditingPath((prev) => (prev != null && covers(prev) ? null : prev));
    setEditOverride((prev) =>
      prev != null && covers(prev.path) ? null : prev,
    );
  }, [pathDelete]);

  const isEditing = editingPath != null && editingPath === selectedPath;
  const originalContent = data?.content ?? "";
  const editableContent =
    editOverride?.path === selectedPath
      ? editOverride.content
      : originalContent;

  const stopEditing = () => {
    setEditingPath(null);
    setEditOverride(null);
  };

  const saveMutation = useMutation({
    mutationFn: async ({
      path,
      content,
    }: {
      path: string;
      content: string;
    }) => {
      const { error, response } = await workspaceWritePost({
        path: { assistant_id: assistantId },
        body: { path, content, encoding: "utf8" },
        throwOnError: false,
      });
      if (!response?.ok || error) {
        throw new Error("Failed to save file");
      }
    },
    onSuccess: (_data, variables) => {
      setEditingPath((current) =>
        current === variables.path ? null : current,
      );
      setEditOverride((current) =>
        current?.path === variables.path ? null : current,
      );
      void queryClient.invalidateQueries({
        queryKey: ["assistantsWorkspaceFileRetrieve"],
      });
    },
  });

  const isDirty = editableContent !== originalContent;

  const handleSave = useCallback(() => {
    if (selectedPath && isDirty && !saveMutation.isPending) {
      saveMutation.mutate({ path: selectedPath, content: editableContent });
    }
  }, [selectedPath, isDirty, saveMutation, editableContent]);

  // Seed the chat composer with a real prompt and open a new conversation —
  // backs the mock's "Send" / "Ask Cue to revise" actions with the live chat
  // surface instead of a no-op. Parks the prompt in the shared pending-deep-
  // link store (the cross-domain narrow waist) and navigates to chat, where
  // `useDeepLinkConsumer` applies it to the composer on mount.
  const seedChat = useCallback(
    (prompt: string) => {
      usePendingDeepLinkStore.getState().setPendingComposerMessage(prompt);
      void navigate(routes.assistant);
    },
    [navigate],
  );

  // --- Empty / loading / error states ---

  if (!selectedPath) {
    // Empty workspace — calm on-brand state with a real "New file" CTA.
    if (hasFiles === false) {
      return (
        <div
          className="flex h-full flex-col items-center justify-center px-8 text-center"
          style={{ background: C.surfaceTint }}
        >
          <span
            className="flex items-center justify-center"
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              background: C.blueWash,
            }}
          >
            <FilePlus style={{ width: 20, height: 20, color: C.blue }} aria-hidden />
          </span>
          <div
            style={{
              fontSize: 18,
              fontWeight: 600,
              letterSpacing: "-.3px",
              color: C.t1,
              marginTop: 16,
            }}
          >
            Nothing here yet
          </div>
          <p
            style={{
              fontSize: 13.5,
              lineHeight: 1.6,
              color: C.t2,
              marginTop: 6,
              maxWidth: 320,
            }}
          >
            This is Cue&apos;s sandboxed workspace — the files it reads and
            writes for you. Create the first one to get started.
          </p>
          {onCreateFile && (
            <button
              type="button"
              onClick={onCreateFile}
              className="inline-flex items-center gap-2"
              style={{
                marginTop: 18,
                fontSize: 12.5,
                fontWeight: 500,
                background: C.blue,
                color: "#fff",
                border: "none",
                borderRadius: 9,
                padding: "9px 16px",
                cursor: "pointer",
              }}
            >
              <FilePlus style={{ width: 14, height: 14 }} aria-hidden />
              New file
            </button>
          )}
        </div>
      );
    }
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-3"
        style={{ background: C.surfaceTint }}
      >
        <p style={{ fontSize: 13.5, color: C.t3 }}>Select a file to view</p>
        {onBrowse && (
          <Button
            type="button"
            onClick={onBrowse}
            leftIcon={<FolderOpen aria-hidden />}
            className="sm:hidden"
          >
            Browse files
          </Button>
        )}
      </div>
    );
  }

  if (isLoading) {
    return (
      <div
        className="flex h-full items-center justify-center"
        style={{ background: C.surfaceTint }}
      >
        <Loader2 className="h-6 w-6 animate-spin" style={{ color: C.t3 }} />
      </div>
    );
  }

  if (!data) {
    return (
      <div
        className="flex h-full items-center justify-center"
        style={{ background: C.surfaceTint }}
      >
        <p style={{ fontSize: 13.5, color: C.t3 }}>File not found</p>
      </div>
    );
  }

  // --- Render file content ---

  const mimeType = data.mimeType ?? "application/octet-stream";
  const name = data.name ?? selectedPath.split("/").pop() ?? selectedPath;
  const markdown = isMarkdown(name, mimeType);
  const json = isJson(name, mimeType);
  // The backend returns inline `content` for all text-renderable files,
  // including non-text/* MIME types like application/yaml, application/toml,
  // application/x-sh. Markdown and JSON are checked first in the rendering
  // cascade, so this catch-all is safe.
  const isText = data.content != null && !markdown && !json;
  const readOnly = selectedPath ? isHiddenPath(selectedPath) : true;

  const editFooter = isEditing && (
    <EditFooter
      isDirty={isDirty}
      isSaving={saveMutation.isPending}
      onSave={handleSave}
      onDiscard={stopEditing}
    />
  );

  // Markdown: Preview/Source toggle
  if (markdown && data.content != null) {
    const sourceContent = isEditing ? editableContent : data.content;
    const showActions = !isEditing && viewMode === "preview";
    return (
      <div className="flex h-full flex-col">
        <FileHeader
          name={name}
          mimeType={mimeType}
          modifiedAt={data.modifiedAt}
          rightContent={
            <ViewModeToggle
              viewMode={viewMode}
              onChange={(mode) => {
                if (isEditing) stopEditing();
                onChangeViewMode(mode);
              }}
            />
          }
        />
        <div
          className="relative flex-1 overflow-hidden"
          style={{ background: C.surfaceTint }}
        >
          <ContentActionBar
            content={sourceContent}
            fileName={name}
            mimeType={mimeType}
            showEdit={!readOnly && viewMode === "source"}
            isEditing={isEditing}
            onToggleEdit={() =>
              isEditing ? stopEditing() : setEditingPath(selectedPath)
            }
          />
          {viewMode === "preview" ? (
            <div
              className="h-full overflow-auto"
              style={{ color: C.t1, padding: "30px 36px" }}
            >
              <div style={{ maxWidth: 620 }}>
                <FileMarkdown content={sourceContent} />
              </div>
            </div>
          ) : isEditing ? (
            <FileTextarea
              value={editableContent}
              onChange={(v) =>
                setEditOverride({ path: selectedPath, content: v })
              }
              onSave={handleSave}
            />
          ) : (
            <SourcePre
              content={data.content}
              readOnly={readOnly}
              onStartEdit={() => setEditingPath(selectedPath)}
            />
          )}
        </div>
        {showActions && (
          <FilePreviewActions
            onSend={() =>
              seedChat(
                `Here's my workspace file \`${selectedPath}\`. Please send it / act on it:\n\n${sourceContent}`,
              )
            }
            onRevise={() =>
              seedChat(
                `Please revise my workspace file \`${selectedPath}\`:\n\n${sourceContent}`,
              )
            }
          />
        )}
        {editFooter}
      </div>
    );
  }

  // JSON: Preview (pretty-printed) / Source (raw) toggle
  if (json && data.content != null) {
    const sourceContent = isEditing ? editableContent : data.content;
    const previewContent = prettifyJson(sourceContent);
    return (
      <div className="flex h-full flex-col">
        <FileHeader
          name={name}
          mimeType={mimeType}
          modifiedAt={data.modifiedAt}
          rightContent={
            <ViewModeToggle
              viewMode={viewMode}
              onChange={(mode) => {
                if (isEditing) stopEditing();
                onChangeViewMode(mode);
              }}
            />
          }
        />
        <div
          className="relative flex-1 overflow-hidden"
          style={{ background: C.surfaceTint }}
        >
          <ContentActionBar
            content={viewMode === "preview" ? previewContent : sourceContent}
            downloadContent={sourceContent}
            fileName={name}
            mimeType={mimeType}
            showEdit={!readOnly && viewMode === "source"}
            isEditing={isEditing}
            onToggleEdit={() =>
              isEditing ? stopEditing() : setEditingPath(selectedPath)
            }
          />
          {viewMode === "preview" ? (
            <SourcePre content={previewContent} readOnly whiteSpace="pre" />
          ) : isEditing ? (
            <FileTextarea
              value={editableContent}
              onChange={(v) =>
                setEditOverride({ path: selectedPath, content: v })
              }
              onSave={handleSave}
            />
          ) : (
            <SourcePre
              content={data.content}
              readOnly={readOnly}
              onStartEdit={() => setEditingPath(selectedPath)}
            />
          )}
        </div>
        {!isEditing && (
          <FilePreviewActions
            onSend={() =>
              seedChat(
                `Here's my workspace file \`${selectedPath}\`. Please send it / act on it:\n\n${sourceContent}`,
              )
            }
            onRevise={() =>
              seedChat(
                `Please revise my workspace file \`${selectedPath}\`:\n\n${sourceContent}`,
              )
            }
          />
        )}
        {editFooter}
      </div>
    );
  }

  // Plain text — source only, consistent header
  if (isText) {
    const textContent = data.content ?? "";
    return (
      <div className="flex h-full flex-col">
        <FileHeader
          name={name}
          mimeType={mimeType}
          size={data.size}
          modifiedAt={data.modifiedAt}
        />
        <div
          className="relative flex-1 overflow-hidden"
          style={{ background: C.surfaceTint }}
        >
          <ContentActionBar
            content={isEditing ? editableContent : textContent}
            fileName={name}
            mimeType={mimeType}
            showEdit={!readOnly}
            isEditing={isEditing}
            onToggleEdit={() =>
              isEditing ? stopEditing() : setEditingPath(selectedPath)
            }
          />
          {isEditing ? (
            <FileTextarea
              value={editableContent}
              onChange={(v) =>
                setEditOverride({ path: selectedPath, content: v })
              }
              onSave={handleSave}
            />
          ) : (
            <SourcePre
              content={textContent}
              readOnly={readOnly}
              onStartEdit={() => setEditingPath(selectedPath)}
            />
          )}
        </div>
        {!isEditing && (
          <FilePreviewActions
            onSend={() =>
              seedChat(
                `Here's my workspace file \`${selectedPath}\`. Please send it / act on it:\n\n${textContent}`,
              )
            }
            onRevise={() =>
              seedChat(
                `Please revise my workspace file \`${selectedPath}\`:\n\n${textContent}`,
              )
            }
          />
        )}
        {editFooter}
      </div>
    );
  }

  // Image / video
  if (mimeType.startsWith("image/") || mimeType.startsWith("video/")) {
    return (
      <div className="flex h-full flex-col">
        <FileHeader
          name={name}
          mimeType={mimeType}
          size={data.size}
          modifiedAt={data.modifiedAt}
        />
        <div
          className="flex-1 overflow-auto"
          style={{ background: C.surfaceTint }}
        >
          <BinaryContentViewer
            assistantId={assistantId}
            path={selectedPath}
            mimeType={mimeType}
            showHidden={showHidden}
          />
        </div>
      </div>
    );
  }

  // Binary fallback — metadata card
  return (
    <div className="flex h-full flex-col">
      <FileHeader
        name={name}
        mimeType={mimeType}
        size={data.size}
        modifiedAt={data.modifiedAt}
      />
      <div
        className="flex flex-1 items-center justify-center p-8"
        style={{ background: C.surfaceTint }}
      >
        <div
          className="w-full max-w-sm rounded-lg border p-6 text-center"
          style={{ borderColor: C.line, backgroundColor: "var(--mv1-card)" }}
        >
          <FileIcon className="mx-auto h-10 w-10" style={{ color: C.t3 }} />
          <p className="mt-3" style={{ fontSize: 14, fontWeight: 600, color: C.t1 }}>
            {name}
          </p>
          <div className="mt-2 space-y-1">
            <p style={{ fontFamily: mono, fontSize: 11, color: C.t2 }}>
              {mimeType}
            </p>
            <p style={{ fontFamily: mono, fontSize: 11, color: C.t2 }}>
              {formatFileSize(data.size, "Unknown size")}
            </p>
            {data.modifiedAt && (
              <p style={{ fontFamily: mono, fontSize: 11, color: C.t2 }}>
                Modified: {new Date(data.modifiedAt).toLocaleString()}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
