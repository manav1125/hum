/**
 * Library view — renders the user's apps and documents with search,
 * filtering, pinning, deploy, import, and delete capabilities.
 *
 * Thin orchestrator: composes the data-fetching hook, delegates rendering
 * to focused sub-components, and owns action callbacks inline (per the
 * domains/home/ pattern — callbacks stay inline when they are single-consumer
 * and don't involve data-fetching composition).
 */

import { useQueryClient } from "@tanstack/react-query";
import { Search, Upload } from "lucide-react";
import {
  type ChangeEvent,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";

import { DeployDialogs } from "@/components/deploy-dialogs";
import { useAttachmentPreview } from "@/hooks/use-attachment-preview";
import {
  type CoverKind,
  LibraryCoverCard,
} from "@/domains/library/components/library-cover-card";
import { DeleteAppDialog } from "@/domains/library/components/delete-app-dialog";
import { LibraryDocumentCard } from "@/domains/library/components/library-document-card";
import { LibraryMediaCard } from "@/domains/library/components/library-media-card";
import type { MediaSummary } from "@/types/media-types";
import { LibraryEmptyState } from "@/domains/library/components/library-empty-state";
import { LibraryGridSection } from "@/domains/library/components/library-grid-section";
import { useLibraryData } from "@/domains/library/use-library-data";
import { usePhoneLayout } from "@/hooks/use-is-mobile";
import {
  LibraryGrid,
  LibrarySectionLabel,
} from "@/mobile-v3/library/library-gallery";
import { useLibraryOutputs } from "@/mobile-v3/library/use-library-outputs";
import { useOpenLibraryEntry } from "@/mobile-v3/library/use-open-entry";
import { useProjects } from "@/pages/projects/use-projects";
import { formatFriendlyDate } from "@/utils/format-date";
import { appsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import { appsByIdDeletePost } from "@/generated/daemon/sdk.gen";
import { useDeployStore } from "@/stores/deploy-store";
import { usePinnedAppsStore } from "@/stores/pinned-apps-store";
import type { AppSummary } from "@/types/app-types";
import { clearAppHtmlCache, getCachedAppHtml } from "@/utils/app-html-cache";
import { importBundle } from "@/utils/import-bundle";
import { ApertureAvatar, Input, toast } from "@vellumai/design-library";

// Editorial tokens — restyled to the shipped HQ design language (Cue-Surfaces
// S3). These point at the theme-aware `--mv1-*` CSS-variable system so light +
// dark both render correctly instead of pasting a fixed light canvas onto dark
// chrome. Defined locally (not imported from domains/activity) to respect the
// cross-domain-import boundary; the CSS-var contract is the shared surface.
const C = {
  ink: "var(--mv1-t1)",
  t1: "var(--mv1-t1)",
  t2: "var(--mv1-t2)",
  t3: "var(--mv1-t3)",
  blue: "var(--mv1-blue)",
  blueS: "var(--mv1-blue-strong)",
  line: "var(--mv1-line)",
  bg: "var(--mv1-canvas)",
} as const;
const mono = "'DM Mono', ui-monospace, monospace";
const serif = "'Instrument Serif', Georgia, serif";

const sectionLabel = {
  fontFamily: mono,
  fontSize: 11,
  letterSpacing: ".1em",
  textTransform: "uppercase" as const,
  color: C.t3,
};

/** The library type filters. "Apps" holds generic tools/apps; "Dashboards" is
 *  reserved for actual dashboards (metrics/analytics/reports) so the two don't
 *  get lumped together. */
const LIBRARY_FILTERS = [
  "All",
  "Apps",
  "Decks",
  "Dashboards",
  "Sites",
  "Docs",
  "Media",
] as const;
type LibraryFilter = (typeof LIBRARY_FILTERS)[number];

/**
 * Coarse artifact type inferred from an app's name/icon — apps carry no
 * explicit type in the daemon response, so we bucket by keyword for the
 * type badge + filter. Only genuine dashboards go to "Dashboards"; everything
 * else that isn't a deck/site falls back to the generic "Apps" bucket.
 */
function inferAppType(
  name: string,
  icon?: string,
): {
  label: string;
  filter: Exclude<LibraryFilter, "All" | "Docs" | "Media">;
  /** Cover treatment for the mobile branded-cover card. */
  kind: CoverKind;
} {
  const hay = `${name} ${icon ?? ""}`.toLowerCase();
  if (/deck|slide|pitch|presentation/.test(hay))
    return { label: "Deck", filter: "Decks", kind: "Deck" };
  if (/site|landing|page|web/.test(hay))
    return { label: "Site", filter: "Sites", kind: "Site" };
  if (/video|sizzle|reel|clip/.test(hay))
    return { label: "Video", filter: "Apps", kind: "Video" };
  if (/dashboard|dash|metrics|analytics|report/.test(hay))
    return { label: "Dash", filter: "Dashboards", kind: "Dash" };
  return { label: "App", filter: "Apps", kind: "App" };
}

/** Upper-cased mono date, e.g. "4 JUL" — matches the S3 cover-card meta row. */
function monoDate(ms: number): string {
  return formatFriendlyDate(new Date(ms)).toUpperCase();
}

export interface LibraryViewProps {
  assistantId: string;
  assistantName?: string;
  title?: string;
  onNewConversation?: (initialMessage?: string) => void;
  onOpenDocument?: (documentSurfaceId: string) => void;
  onOpenApp: (appId: string) => void;
}

export function LibraryView({
  assistantId,
  assistantName,
  title: _title,
  onNewConversation,
  onOpenDocument,
  onOpenApp,
}: LibraryViewProps) {
  const queryClient = useQueryClient();
  const togglePin = usePinnedAppsStore.use.togglePin();
  const pinnedAppIds = usePinnedAppsStore.use.pinnedAppIds();
  const isDeploying = useDeployStore.use.isDeploying();
  // The phone rendering is POINTER-gated, not width-gated: a 720px desktop
  // window matched the old breakpoint and got a touch-only layout, which is
  // the exact bug that cost the People page its list.
  const isMobile = usePhoneLayout();
  // v23 C3: on a phone the Library leads with what Cue MADE — a card carrying
  // the agent and the thing. Apps, documents and media (which carry neither
  // field) keep their grid underneath, so the phone loses nothing.
  const made = useLibraryOutputs(isMobile ? assistantId : null);
  // Same query key the rail's counts already hold, so this costs no request.
  const { projects } = useProjects(assistantId);
  const madeThingTitleOf = useMemo(() => {
    const map = new Map(projects.map((p) => [p.id, p.title]));
    return (projectId: string | null) =>
      projectId ? (map.get(projectId) ?? null) : null;
  }, [projects]);
  const { openEntry, previewModal: madePreviewModal } =
    useOpenLibraryEntry(assistantId);
  const [madeNow] = useState(() => Date.now());

  const {
    apps,
    documents,
    media,
    filteredApps,
    filteredDocuments,
    filteredMedia,
    searchText,
    setSearchText,
    loading,
    error,
  } = useLibraryData(assistantId);

  // Full-screen preview for media attachments. The modal lazily fetches the
  // file content from the daemon (previewUrl is null here) and plays
  // audio/video or renders images inline.
  const { openPreview, previewModal } = useAttachmentPreview(assistantId);

  const handleOpenMedia = useCallback(
    (item: MediaSummary) =>
      openPreview({
        id: item.id,
        filename: item.original_filename,
        mimeType: item.mime_type,
        sizeBytes: item.size_bytes,
        previewUrl: null,
      }),
    [openPreview],
  );

  // --- Filter tabs (All / Decks / Docs / Dashboards / Sites) ---
  const [activeFilter, setActiveFilter] = useState<LibraryFilter>("All");

  // --- Delete state ---
  const [appPendingDelete, setAppPendingDelete] = useState<AppSummary | null>(
    null,
  );
  const [isDeleting, setIsDeleting] = useState(false);

  const handleConfirmDelete = useCallback(async () => {
    const target = appPendingDelete;
    if (!target || isDeleting) return;
    setIsDeleting(true);
    try {
      await appsByIdDeletePost({
        path: { assistant_id: assistantId, id: target.id },
        throwOnError: true,
      });
      clearAppHtmlCache(assistantId, target.id);
      void queryClient.invalidateQueries({
        queryKey: appsGetQueryKey({ path: { assistant_id: assistantId } }),
      });
      if (pinnedAppIds.has(target.id)) {
        togglePin(target);
      }
      setAppPendingDelete(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete app");
    } finally {
      setIsDeleting(false);
    }
  }, [
    appPendingDelete,
    isDeleting,
    assistantId,
    pinnedAppIds,
    togglePin,
    queryClient,
  ]);

  const handleCancelDelete = useCallback(() => {
    if (!isDeleting) setAppPendingDelete(null);
  }, [isDeleting]);

  // --- Import state ---
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isImporting, setIsImporting] = useState(false);

  const handleImportBundle = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file || isImporting) return;
      setIsImporting(true);
      try {
        const result = await importBundle(assistantId, file);
        await queryClient.invalidateQueries({
          queryKey: appsGetQueryKey({ path: { assistant_id: assistantId } }),
        });
        toast.success(result.name + " imported");
        onOpenApp(result.appId);
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to import app",
        );
      } finally {
        setIsImporting(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [assistantId, isImporting, queryClient, onOpenApp],
  );

  // --- Deploy ---
  const handleDeploy = useCallback(
    async (appId: string) => {
      if (isDeploying) return;
      const app = apps.find((a) => a.id === appId);
      const appName = app?.name ?? "this app";
      try {
        const html = await getCachedAppHtml(assistantId, appId);
        void useDeployStore
          .getState()
          .deployApp(assistantId, appId, appName, html);
      } catch {
        void useDeployStore
          .getState()
          .deployApp(assistantId, appId, appName, "");
      }
    },
    [assistantId, isDeploying, apps],
  );

  const handlePinToggle = useCallback(
    (app: AppSummary) => togglePin(app),
    [togglePin],
  );

  // --- Tab filtering: narrow the search-filtered lists by the active tab. ---
  const tabApps = useMemo(() => {
    if (activeFilter === "All") return filteredApps;
    if (activeFilter === "Docs" || activeFilter === "Media") return [];
    return filteredApps.filter(
      (a) => inferAppType(a.name, a.icon).filter === activeFilter,
    );
  }, [filteredApps, activeFilter]);

  const tabDocuments = useMemo(() => {
    if (activeFilter === "All" || activeFilter === "Docs")
      return filteredDocuments;
    return [];
  }, [filteredDocuments, activeFilter]);

  // Generated audio/video/image assets. Shown under "All" and the "Media" tab.
  const tabMedia = useMemo(
    () =>
      activeFilter === "All" || activeFilter === "Media" ? filteredMedia : [],
    [filteredMedia, activeFilter],
  );

  const byRecent = (
    a: { updatedAt: number; createdAt: number },
    b: { updatedAt: number; createdAt: number },
  ) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt;
  const tabPinnedApps = useMemo(
    () => tabApps.filter((a) => pinnedAppIds.has(a.id)).sort(byRecent),
    [tabApps, pinnedAppIds],
  );
  const tabRecentApps = useMemo(
    () => tabApps.filter((a) => !pinnedAppIds.has(a.id)).sort(byRecent),
    [tabApps, pinnedAppIds],
  );

  // --- Render: loading ---
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div
          className="h-6 w-6 animate-spin rounded-full border-2"
          role="status"
          aria-label="Loading apps"
          style={{ borderColor: C.line, borderTopColor: C.blue }}
        />
      </div>
    );
  }

  // --- Render: error ---
  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-4">
        <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
          {error}
        </p>
        <button
          type="button"
          className="rounded-lg bg-[var(--primary-base)] px-4 py-2 text-body-medium-default text-[var(--content-inset)] transition-colors hover:bg-[var(--primary-hover)]"
          onClick={() => window.location.reload()}
        >
          Retry
        </button>
      </div>
    );
  }

  // --- Render: empty state ---
  if (apps.length === 0 && documents.length === 0 && media.length === 0) {
    return (
      <LibraryEmptyState
        fileInputRef={fileInputRef}
        isImporting={isImporting}
        onImportBundle={handleImportBundle}
        onNewConversation={
          onNewConversation ? () => onNewConversation() : undefined
        }
      />
    );
  }

  // --- Render: main library grid ---
  const noResults =
    tabApps.length === 0 &&
    tabDocuments.length === 0 &&
    tabMedia.length === 0;
  return (
    <div
      className="flex h-full flex-col overflow-hidden"
      style={{
        fontFamily: "'DM Sans', system-ui, sans-serif",
        color: C.ink,
      }}
    >
      {/* Editorial hero — "Everything you and Cue have made together." (S3) */}
      <div className="mb-5 flex shrink-0 items-center gap-4">
        <ApertureAvatar
          state="listening"
          size={42}
          className="rounded-[12px]"
        />
        <div className="flex-1 min-w-0">
          <div style={sectionLabel}>Library</div>
          <div
            style={{
              fontFamily: serif,
              fontSize: 27,
              letterSpacing: "-.2px",
              lineHeight: 1.14,
              color: C.ink,
              marginTop: 2,
            }}
          >
            Everything you and Cue have{" "}
            <span style={{ fontStyle: "italic", color: C.blueS }}>
              made together.
            </span>
          </div>
          <div style={{ fontSize: 12.5, color: C.t2, marginTop: 3 }}>
            Decks, docs, sites, and artifacts — pick up where you left off, or
            import your own.
          </div>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".vellum"
          className="hidden"
          onChange={handleImportBundle}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={isImporting}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            fontSize: 13.5,
            background: C.ink,
            color: C.bg,
            border: "none",
            borderRadius: 10,
            padding: "10px 18px",
            cursor: isImporting ? "default" : "pointer",
            flexShrink: 0,
          }}
        >
          {isImporting ? (
            <span
              className="h-4 w-4 animate-spin rounded-full border-2"
              style={{
                borderColor:
                  "color-mix(in srgb, currentColor 40%, transparent)",
                borderTopColor: "currentColor",
              }}
            />
          ) : (
            <Upload size={14} />
          )}
          Import
        </button>
      </div>

      <div className="mb-4 shrink-0">
        <Input
          fullWidth
          type="text"
          placeholder="Search your library"
          value={searchText}
          onChange={(e: ChangeEvent<HTMLInputElement>) =>
            setSearchText(e.target.value)
          }
          leftIcon={<Search size={16} />}
        />
      </div>

      {/* Filter tabs — RECENTS · All / Decks / Docs / Dashboards / Sites. */}
      <div className="mb-5 flex shrink-0 items-center gap-2.5 overflow-x-auto">
        <span style={{ ...sectionLabel, flexShrink: 0 }}>Types</span>
        <div className="flex items-center gap-1.5">
          {LIBRARY_FILTERS.map((f) => {
            const active = f === activeFilter;
            return (
              <button
                key={f}
                type="button"
                onClick={() => setActiveFilter(f)}
                aria-pressed={active}
                style={{
                  fontSize: 12.5,
                  fontWeight: active ? 600 : 500,
                  padding: "5px 12px",
                  borderRadius: 999,
                  border: `1px solid ${active ? "transparent" : C.line}`,
                  background: active ? C.ink : "transparent",
                  color: active ? C.bg : C.t2,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  flexShrink: 0,
                }}
              >
                {f}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {noResults ? (
          <div className="flex flex-col items-center justify-center py-16">
            <Search size={32} className="mb-4" style={{ color: C.t3 }} />
            <p style={{ fontSize: 13.5, color: C.t3 }}>
              {searchText
                ? `No apps or documents matched “${searchText}”`
                : "Nothing here yet in this filter."}
            </p>
          </div>
        ) : isMobile ? (
          /* MOBILE — 2-col branded-cover grid (no live-preview iframes). */
          <div style={{ paddingBottom: 16 }}>
            {/* What Cue made, with provenance on every card (C3). Only shown
                on the All tab: the kind chips below filter apps/documents,
                and silently ignoring them here would be a lying filter. */}
            {activeFilter === "All" && made.entries.length > 0 ? (
              <div style={{ marginBottom: 22 }}>
                <LibrarySectionLabel>What Cue made</LibrarySectionLabel>
                <LibraryGrid
                  assistantId={assistantId}
                  entries={made.entries.slice(0, 24)}
                  thingTitleOf={madeThingTitleOf}
                  now={madeNow}
                  onOpen={openEntry}
                />
              </div>
            ) : null}
            {activeFilter === "All" && made.entries.length > 0 ? (
              <LibrarySectionLabel>Apps &amp; files</LibrarySectionLabel>
            ) : null}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 12,
            }}
          >
            {[...tabPinnedApps, ...tabRecentApps].map((app) => (
              <LibraryCoverCard
                key={app.id}
                kind={inferAppType(app.name, app.icon).kind}
                title={app.name}
                dateLabel={monoDate(app.createdAt)}
                onOpen={() => onOpenApp(app.id)}
              />
            ))}
            {tabDocuments.map((doc) => (
              <LibraryCoverCard
                key={doc.surfaceId}
                kind="Doc"
                title={doc.title}
                dateLabel={monoDate(doc.updatedAt)}
                onOpen={() => onOpenDocument?.(doc.surfaceId)}
              />
            ))}
            {tabMedia.map((item) => (
              <LibraryMediaCard
                key={item.id}
                media={item}
                onOpen={handleOpenMedia}
              />
            ))}
          </div>
          </div>
        ) : (
          <div className="flex flex-col gap-8">
            <LibraryGridSection
              title="Pinned"
              apps={tabPinnedApps}
              assistantId={assistantId}
              pinnedAppIds={pinnedAppIds}
              onOpen={onOpenApp}
              onPin={handlePinToggle}
              onDelete={setAppPendingDelete}
              onDeploy={handleDeploy}
            />
            <LibraryGridSection
              title="Recents"
              apps={tabRecentApps}
              assistantId={assistantId}
              pinnedAppIds={pinnedAppIds}
              onOpen={onOpenApp}
              onPin={handlePinToggle}
              onDelete={setAppPendingDelete}
              onDeploy={handleDeploy}
            />
            {tabDocuments.length > 0 ? (
              <section>
                <h2 className="mb-4" style={sectionLabel}>
                  Documents
                </h2>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(max(220px,calc((100%-6rem)/5)),1fr))] gap-6">
                  {tabDocuments.map((doc) => (
                    <LibraryDocumentCard
                      key={doc.surfaceId}
                      document={doc}
                      onOpen={(documentSurfaceId) => {
                        if (onOpenDocument) {
                          onOpenDocument(documentSurfaceId);
                        }
                      }}
                    />
                  ))}
                </div>
              </section>
            ) : null}
            {tabMedia.length > 0 ? (
              <section>
                <h2 className="mb-4" style={sectionLabel}>
                  Media
                </h2>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(max(220px,calc((100%-6rem)/5)),1fr))] gap-6">
                  {tabMedia.map((item) => (
                    <LibraryMediaCard
                      key={item.id}
                      media={item}
                      onOpen={handleOpenMedia}
                    />
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        )}
      </div>

      {previewModal}
      {madePreviewModal}

      <DeployDialogs
        assistantId={assistantId}
        assistantName={assistantName}
        onStartConversation={onNewConversation}
      />

      <DeleteAppDialog
        app={appPendingDelete}
        isDeleting={isDeleting}
        onConfirm={handleConfirmDelete}
        onCancel={handleCancelDelete}
      />
    </div>
  );
}
