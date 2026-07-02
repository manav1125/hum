/**
 * Top-level workspace browser — a faithful translation of
 * surfaces/Workspace.dc.html. Renders three stat cards (files · size ·
 * last edit) above a two-column grid: a file tree sidebar (hidden on mobile
 * behind a drawer) and a rich file preview pane.
 *
 * Every visible value maps to real assistant-workspace data:
 * - stat cards: counts / total size / newest `modifiedAt` from the root tree
 *   listing (computed with `includeDirSizes` so folder bytes are real);
 * - tree: the live `workspace/tree` listing with real create / rename / delete;
 * - preview: the selected file's real content, with Send / Ask Cue to revise
 *   wired to a prefilled chat composer.
 */

import { useQuery } from "@tanstack/react-query";
import { FileText, Layers } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { useSearchParams } from "react-router";

import {
  MobileSidebarDrawer,
  MobileSidebarTrigger,
} from "@/components/mobile-sidebar-drawer";
import { WorkspaceFileViewer } from "@/domains/workspace/components/workspace-file-viewer";
import {
  WorkspaceTree,
  type WorkspaceSortMode,
} from "@/domains/workspace/components/workspace-tree";
import { formatFileSize } from "@/domains/workspace/utils/format-file-size";
import { workspaceTreeGet } from "@/generated/daemon/sdk.gen";
import type { WorkspaceTreeGetResponse } from "@/generated/daemon/types.gen";
import { formatRelativeDate } from "@/utils/format-date";

export type WorkspaceViewMode = "preview" | "source";

const C = {
  ink: "var(--mv1-chip)",
  blue: "var(--mv1-blue)",
  violet: "var(--mv1-violet-strong)",
  line: "var(--mv1-line)",
  t1: "var(--mv1-t1)",
  t3: "var(--mv1-t3)",
  blueWash: "var(--mv1-blue-wash)",
  violetWash: "color-mix(in srgb, var(--mv1-violet) 14%, transparent)",
} as const;
const mono = "'DM Mono', ui-monospace, monospace";

// ---------------------------------------------------------------------------
// Stat cards
// ---------------------------------------------------------------------------

interface WorkspaceStats {
  files: number;
  folders: number;
  totalSize: number | null;
  lastEdit: string | null;
}

function useWorkspaceStats(assistantId: string): WorkspaceStats | undefined {
  // A small dedicated root listing for the stat cards. `includeDirSizes` makes
  // each folder's `size` the real recursive byte total, so "sandboxed" size is
  // honest. Cached under its own key and shared across mounts of this page.
  const { data } = useQuery({
    queryFn: async (): Promise<WorkspaceTreeGetResponse> => {
      const { data: res, error } = await workspaceTreeGet({
        path: { assistant_id: assistantId },
        query: { includeDirSizes: "true" },
      });
      if (error) throw error;
      if (!res) throw new Error("Failed to load workspace tree");
      return res;
    },
    queryKey: [
      "assistantsWorkspaceTreeRetrieve",
      {
        path: { assistant_id: assistantId },
        query: { includeDirSizes: true },
      },
    ],
  });

  return useMemo(() => {
    if (!data) return undefined;
    const entries = data.entries ?? [];
    let files = 0;
    let folders = 0;
    let totalSize = 0;
    let hasSize = false;
    let lastEdit: number | null = null;
    for (const entry of entries) {
      if (entry.type === "directory") folders += 1;
      else files += 1;
      if (typeof entry.size === "number") {
        totalSize += entry.size;
        hasSize = true;
      }
      const ts = entry.modifiedAt ? Date.parse(entry.modifiedAt) : NaN;
      if (Number.isFinite(ts) && (lastEdit === null || ts > lastEdit)) {
        lastEdit = ts;
      }
    }
    return {
      files,
      folders,
      totalSize: hasSize ? totalSize : null,
      lastEdit: lastEdit === null ? null : new Date(lastEdit).toISOString(),
    };
  }, [data]);
}

function StatCard({
  icon,
  iconBg,
  iconColor,
  value,
  label,
}: {
  icon: React.ReactNode;
  iconBg: string;
  iconColor: string;
  value: string;
  label: string;
}) {
  return (
    <div
      style={{
        // 160px basis lets the three cards sit in one row on desktop but wrap
        // to a readable 2+1 / stacked layout on narrow (390px) viewports.
        flex: "1 1 160px",
        minWidth: 0,
        border: `1px solid ${C.line}`,
        borderRadius: 13,
        padding: "13px 16px",
        display: "flex",
        alignItems: "center",
        gap: 12,
        background: "var(--mv1-card)",
      }}
    >
      <span
        style={{
          width: 34,
          height: 34,
          borderRadius: 9,
          background: iconBg,
          color: iconColor,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        {icon}
      </span>
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: 18,
            fontWeight: 600,
            letterSpacing: "-.4px",
            color: C.t1,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {value}
        </div>
        <div
          style={{
            fontFamily: mono,
            fontSize: 10,
            color: C.t3,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </div>
      </div>
    </div>
  );
}

function StatCards({ stats }: { stats: WorkspaceStats | undefined }) {
  const hasFolders = stats != null && stats.folders > 0;
  const filesLabel = hasFolders
    ? `${stats.files} files · ${stats.folders} folders`
    : "files";
  const filesValue = !stats
    ? "—"
    : hasFolders
      ? String(stats.files + stats.folders)
      : String(stats.files);

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 18 }}>
      <StatCard
        icon={<Layers className="h-4 w-4" aria-hidden />}
        iconBg={C.blueWash}
        iconColor={C.blue}
        value={filesValue}
        label={filesLabel}
      />
      <StatCard
        icon={<FileText className="h-4 w-4" aria-hidden />}
        iconBg={C.violetWash}
        iconColor={C.violet}
        value={
          stats && stats.totalSize != null
            ? formatFileSize(stats.totalSize)
            : "—"
        }
        label="sandboxed"
      />
      <StatCard
        icon={<CueMark />}
        iconBg={C.ink}
        iconColor="#fff"
        value={stats && stats.lastEdit ? formatRelativeDate(stats.lastEdit) : "—"}
        label="last edit"
      />
    </div>
  );
}

/** The Cue `C` monogram with its blue pupil dot, per the mock's third card. */
function CueMark() {
  return (
    <span
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: "100%",
        height: "100%",
        fontSize: 13,
        fontWeight: 600,
        color: "#fff",
      }}
    >
      C
      <span
        style={{
          position: "absolute",
          width: 4,
          height: 4,
          borderRadius: "50%",
          background: C.blue,
          right: 8,
          bottom: 9,
        }}
      />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

export function WorkspaceBrowser({ assistantId }: { assistantId: string }) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [searchParams] = useSearchParams();
  const [sortMode, setSortMode] = useState<WorkspaceSortMode>(() =>
    searchParams.get("sort") === "size" ? "size" : "name",
  );
  const [viewMode, setViewMode] = useState<WorkspaceViewMode>("preview");

  const stats = useWorkspaceStats(assistantId);

  // Bumped by the viewer's empty-state CTA to open the tree's real "New File"
  // dialog (the tree owns the create flow, so we trigger it via a signal).
  const [createFileSignal, setCreateFileSignal] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const handleCreateFile = useCallback(() => {
    setDrawerOpen(true);
    setCreateFileSignal((n) => n + 1);
  }, []);

  const handleToggleExpand = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const handleExpandPath = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      if (prev.has(path)) return prev;
      const next = new Set(prev);
      next.add(path);
      return next;
    });
  }, []);

  const handleSelectPath = useCallback((path: string) => {
    setSelectedPath(path);
    setDrawerOpen(false);
  }, []);

  const [lastDelete, setLastDelete] = useState<{ path: string } | null>(null);

  const handlePathDeleted = useCallback((path: string) => {
    const isDeleted = (p: string) => p === path || p.startsWith(`${path}/`);
    setSelectedPath((prev) => (prev !== null && isDeleted(prev) ? null : prev));
    setExpandedPaths((prev) => {
      const next = new Set([...prev].filter((p) => !isDeleted(p)));
      return next.size === prev.size ? prev : next;
    });
    setLastDelete({ path });
  }, []);

  const [lastRename, setLastRename] = useState<{
    from: string;
    to: string;
  } | null>(null);

  const handlePathRenamed = useCallback((oldPath: string, newPath: string) => {
    const remap = (p: string) =>
      p === oldPath
        ? newPath
        : p.startsWith(`${oldPath}/`)
          ? newPath + p.slice(oldPath.length)
          : p;
    setSelectedPath((prev) => (prev === null ? prev : remap(prev)));
    setExpandedPaths((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const p of prev) {
        const mapped = remap(p);
        if (mapped !== p) changed = true;
        next.add(mapped);
      }
      return changed ? next : prev;
    });
    setLastRename({ from: oldPath, to: newPath });
  }, []);

  const treeProps = {
    assistantId,
    expandedPaths,
    selectedPath,
    showHidden,
    sortMode,
    onToggleExpand: handleToggleExpand,
    onExpandPath: handleExpandPath,
    onSelectPath: handleSelectPath,
    onToggleShowHidden: () => setShowHidden((v) => !v),
    onChangeSortMode: setSortMode,
    onPathDeleted: handlePathDeleted,
    onPathRenamed: handlePathRenamed,
    createFileSignal,
  };

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      style={{ fontFamily: "'DM Sans', system-ui, sans-serif", color: C.t1 }}
    >
      <div className="mb-3 flex items-center sm:hidden">
        <MobileSidebarTrigger onClick={() => setDrawerOpen(true)} />
      </div>

      <MobileSidebarDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title="Files"
      >
        <WorkspaceTree {...treeProps} />
      </MobileSidebarDrawer>

      <StatCards stats={stats} />

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-[18px] sm:grid-cols-[300px_1fr]">
        <div
          className="hidden min-h-0 min-w-0 flex-col overflow-hidden sm:flex"
          style={{
            background: "var(--mv1-card)",
            border: `1px solid ${C.line}`,
            borderRadius: 14,
          }}
        >
          <WorkspaceTree {...treeProps} />
        </div>
        <div
          className="flex min-h-0 min-w-0 flex-col overflow-hidden"
          style={{
            background: "var(--mv1-card)",
            border: `1px solid ${C.line}`,
            borderRadius: 14,
          }}
        >
          <WorkspaceFileViewer
            assistantId={assistantId}
            selectedPath={selectedPath}
            showHidden={showHidden}
            viewMode={viewMode}
            onChangeViewMode={setViewMode}
            onBrowse={() => setDrawerOpen(true)}
            pathRename={lastRename}
            pathDelete={lastDelete}
            hasFiles={stats == null ? undefined : stats.files + stats.folders > 0}
            onCreateFile={handleCreateFile}
          />
        </div>
      </div>
    </div>
  );
}
