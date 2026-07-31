/**
 * Mv3PluginsPage — the mobile Plugins surface (spec frame 66: Explore /
 * Installed + the frame-67 detail sheet + the frame-68 untrusted install).
 * Rendered by `PluginsTab`'s mobile branch; the desktop marketplace grid is
 * untouched. Built to the same v3 grammar as the Skills page it sits beside.
 *
 * Segments:
 *  · Explore   — the registry search (`GET /v1/plugins/search`), already
 *                installed names suppressed. A card tap opens the frame-67
 *                detail sheet; "Get" opens the SAME sheet with the confirm
 *                card focused and runs the real `POST /v1/plugins/install`.
 *  · Installed — the installed list (`GET /v1/plugins`); tap → the same sheet
 *                in read-only mode with an Uninstall affordance.
 *
 * A curation chip row filters Explore on the registry's real `reviewStatus`
 * (`GET /v1/plugins/search` returns it per match) — "Cue reviewed" vs
 * "Community". Install-count is still NOT exposed over HTTP, so that filter
 * stays deliberately absent rather than faked.
 *
 * The Installed segment renders the rest of the lifecycle: each row shows
 * Enabled or Disabled from the list response's `disabled` field, and the
 * detail sheet carries the Enable / Disable / Uninstall actions.
 *
 * The dashed "Install from GitHub URL · unreviewed" row opens the red-edged
 * frame-68 warning sheet.
 */
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  pluginsByNameGetOptions,
  pluginsByNameGetQueryKey,
  pluginsGetOptions,
  pluginsGetQueryKey,
  pluginsSearchGetOptions,
  usePluginsByNameDeleteMutation,
  usePluginsByNameDisablePostMutation,
  usePluginsByNameEnablePostMutation,
  usePluginsInstallPostMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type {
  PluginsGetResponse,
  PluginsSearchGetResponse,
} from "@/generated/daemon/types.gen";
import {
  curationBadge,
  type CurationFilter,
  isCurated,
  matchesCuration,
} from "@/lib/plugin-curation";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

import { GlassCard } from "../glass-card";
import { microLabel, primaryBtn, rise } from "../mv3-kit";
import {
  parseRepoSlug,
  pluginDetailModel,
  PluginDetailSheet,
  PluginUntrustedInstallSheet,
} from "./plugin-detail-sheet";
import { SegRail, TrustFootnote, YouScreen } from "./you-kit";

type Segment = "explore" | "installed";

type SearchMatch = PluginsSearchGetResponse["matches"][number];
type InstalledPlugin = PluginsGetResponse["plugins"][number];

const CATALOG_STALE_MS = 5 * 60 * 1000;

function PluginTile({ size = 36 }: { size?: number }) {
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.3),
        background: "rgba(167,159,240,.2)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: Math.round(size * 0.44),
        flexShrink: 0,
      }}
    >
      🧩
    </span>
  );
}

function CurationBadge({ reviewStatus }: { reviewStatus: string | null }) {
  const curated = isCurated(reviewStatus);
  return (
    <span
      style={{
        ...microLabel,
        fontSize: 9,
        color: curated ? "var(--mv3-micro)" : "var(--mv3-muted)",
        background: curated ? "rgba(61,110,232,.16)" : "var(--mv3-btn2-bg)",
        borderRadius: 5,
        padding: "2px 7px",
        flexShrink: 0,
      }}
    >
      {curationBadge(reviewStatus)}
    </span>
  );
}

export function Mv3PluginsPage({ assistantId }: { assistantId: string }) {
  const queryClient = useQueryClient();
  const [segment, setSegment] = useState<Segment>("explore");
  const [curation, setCuration] = useState<CurationFilter>("all");

  // Detail sheet: card tap → detail; "Get" → same sheet, confirm focused.
  const [detailName, setDetailName] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [detailInstalled, setDetailInstalled] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  // Untrusted (raw-URL) install.
  const [urlSheetOpen, setUrlSheetOpen] = useState(false);
  const [urlValue, setUrlValue] = useState("");
  const [untrustedError, setUntrustedError] = useState<string | null>(null);

  const installedQuery = useQuery({
    ...pluginsGetOptions({
      path: { assistant_id: assistantId },
      query: {},
    }),
    enabled: Boolean(assistantId),
    staleTime: CATALOG_STALE_MS,
  });
  const searchQuery = useQuery({
    ...pluginsSearchGetOptions({
      path: { assistant_id: assistantId },
      query: {},
    }),
    enabled: Boolean(assistantId),
    staleTime: CATALOG_STALE_MS,
  });

  const installed = useMemo<InstalledPlugin[]>(
    () =>
      [...(installedQuery.data?.plugins ?? [])].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
      ),
    [installedQuery.data?.plugins],
  );
  const installedNames = useMemo(
    () => new Set(installed.map((p) => p.name)),
    [installed],
  );

  const matches = useMemo<SearchMatch[]>(() => {
    const all = searchQuery.data?.matches ?? [];
    return all.filter(
      (m) =>
        !installedNames.has(m.name) &&
        matchesCuration(curation, m.reviewStatus),
    );
  }, [searchQuery.data?.matches, installedNames, curation]);

  const detailQuery = useQuery({
    ...pluginsByNameGetOptions({
      path: { assistant_id: assistantId, name: detailName ?? "" },
    }),
    enabled: Boolean(assistantId) && Boolean(detailName),
  });
  const detailModel = detailQuery.data
    ? pluginDetailModel(detailQuery.data)
    : null;

  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: pluginsGetQueryKey({ path: { assistant_id: assistantId } }),
    });
    if (detailName) {
      // The detail read carries `disabled`, so a toggle must refresh it too —
      // otherwise the sheet would keep rendering the pre-toggle state.
      void queryClient.invalidateQueries({
        queryKey: pluginsByNameGetQueryKey({
          path: { assistant_id: assistantId, name: detailName },
        }),
      });
    }
  };

  const installMutation = usePluginsInstallPostMutation();
  const uninstallMutation = usePluginsByNameDeleteMutation();
  const enableMutation = usePluginsByNameEnablePostMutation();
  const disableMutation = usePluginsByNameDisablePostMutation();

  const openDetail = (name: string, isInstalled: boolean) => {
    haptic.light();
    setInstallError(null);
    setConfirming(false);
    setDetailInstalled(isInstalled);
    setDetailName(name);
  };
  const openConfirm = (name: string) => {
    setInstallError(null);
    setDetailInstalled(false);
    setDetailName(name);
    setConfirming(true);
  };
  const closeDetail = () => {
    setDetailName(null);
    setConfirming(false);
    setInstallError(null);
  };

  const confirmInstall = () => {
    if (!detailName) return;
    setInstallError(null);
    installMutation.mutate(
      { path: { assistant_id: assistantId }, body: { name: detailName } },
      {
        onSuccess: () => {
          haptic.success();
          invalidate();
          closeDetail();
        },
        onError: (err) =>
          setInstallError(
            err instanceof Error
              ? err.message
              : "Couldn't install this plugin.",
          ),
      },
    );
  };

  const uninstallCurrent = () => {
    if (!detailName) return;
    haptic.medium();
    uninstallMutation.mutate(
      { path: { assistant_id: assistantId, name: detailName } },
      {
        onSuccess: () => {
          haptic.success();
          invalidate();
          closeDetail();
        },
        onError: (err) =>
          setInstallError(
            err instanceof Error ? err.message : "Couldn't uninstall.",
          ),
      },
    );
  };

  /**
   * Flip the `.disabled` sentinel for the plugin the sheet is showing. The
   * sheet stays open on success so the state change is visible in place —
   * disabling is reversible, so it doesn't dismiss like uninstall does.
   */
  const toggleEnabled = () => {
    if (!detailName || !detailModel) return;
    haptic.medium();
    setInstallError(null);
    const mutation = detailModel.disabled ? enableMutation : disableMutation;
    mutation.mutate(
      { path: { assistant_id: assistantId, name: detailName } },
      {
        onSuccess: () => {
          haptic.success();
          invalidate();
        },
        onError: (err) =>
          setInstallError(
            err instanceof Error
              ? err.message
              : "Couldn't change this plugin's state.",
          ),
      },
    );
  };

  const confirmUntrusted = () => {
    const slug = parseRepoSlug(urlValue);
    if (!slug) {
      setUntrustedError("That doesn't look like a GitHub repo URL.");
      return;
    }
    setUntrustedError(null);
    const name = slug.split("/")[1] ?? slug;
    installMutation.mutate(
      { path: { assistant_id: assistantId }, body: { name } },
      {
        onSuccess: () => {
          haptic.success();
          invalidate();
          setUrlSheetOpen(false);
          setUrlValue("");
        },
        onError: () =>
          // The web install path resolves only reviewed marketplace names by
          // design (a caller ref is rejected), so an unreviewed URL can't be
          // installed here — surface the honest CLI fallback.
          setUntrustedError(
            `Cue only installs reviewed plugins over the web. To install ${slug} unreviewed, run "cue plugins install ${slug}" from the CLI.`,
          ),
      },
    );
  };

  return (
    <YouScreen
      tint="violet"
      testId="mv3-plugins"
      back={routes.channels}
      header={
        <div
          style={{
            padding: "6px 22px 10px",
            flexShrink: 0,
            position: "relative",
            zIndex: 2,
          }}
        >
          <div
            style={{ fontSize: 30, fontWeight: 700, letterSpacing: "-.8px" }}
          >
            Plugins
          </div>
          <div style={{ marginTop: 10 }}>
            <SegRail<Segment>
              ariaLabel="Plugins sections"
              value={segment}
              onChange={setSegment}
              items={[
                { value: "explore", label: "Explore" },
                {
                  value: "installed",
                  label:
                    installed.length > 0
                      ? `Installed · ${installed.length}`
                      : "Installed",
                },
              ]}
            />
          </div>
          {segment === "explore" ? (
            <div style={{ marginTop: 8 }}>
              <SegRail<CurationFilter>
                ariaLabel="Filter plugins by curation"
                value={curation}
                onChange={setCuration}
                items={[
                  { value: "all", label: "All" },
                  { value: "curated", label: "Cue reviewed" },
                  { value: "community", label: "Community" },
                ]}
              />
            </div>
          ) : null}
        </div>
      }
    >
      {segment === "explore" ? (
        <>
          {searchQuery.isLoading ? (
            <div
              style={{
                fontSize: 13,
                color: "var(--mv3-muted)",
                padding: "16px 4px",
              }}
            >
              Indexing the plugin registry…
            </div>
          ) : searchQuery.isError ? (
            <GlassCard padding="18px 16px">
              <div style={{ fontSize: 13.5, color: "var(--mv3-muted)" }}>
                Couldn't reach the plugin registry — pull to retry.
              </div>
            </GlassCard>
          ) : matches.length === 0 ? (
            <GlassCard padding="18px 16px">
              <div style={{ fontSize: 13.5, color: "var(--mv3-muted)" }}>
                {curation === "curated"
                  ? "Cue doesn't publish its own plugins yet — everything in the registry is third-party, reviewed and pinned to a commit. Check Community."
                  : "Nothing to explore in this filter."}
              </div>
            </GlassCard>
          ) : (
            matches.slice(0, 40).map((m, i) => {
              return (
                <GlassCard
                  key={m.name}
                  padding="14px 16px"
                  radius={20}
                  blur={i < 3}
                  style={rise(0.1 + Math.min(i, 3) * 0.12)}
                >
                  <div
                    style={{ display: "flex", alignItems: "center", gap: 11 }}
                  >
                    <button
                      type="button"
                      aria-label={`About ${m.name}`}
                      className="cue-pressable"
                      onClick={() => openDetail(m.name, false)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 11,
                        flex: 1,
                        minWidth: 0,
                        background: "none",
                        border: "none",
                        padding: 0,
                        textAlign: "left",
                        cursor: "pointer",
                        color: "var(--mv3-text)",
                        fontFamily: "inherit",
                      }}
                    >
                      <PluginTile />
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 7,
                          }}
                        >
                          <span style={{ fontSize: 14.5, fontWeight: 600 }}>
                            {m.name}
                          </span>
                          <CurationBadge reviewStatus={m.reviewStatus} />
                        </span>
                        <span
                          style={{
                            display: "block",
                            fontSize: 11,
                            color: "var(--mv3-muted)",
                            marginTop: 1,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {m.source.repo}
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        haptic.medium();
                        openConfirm(m.name);
                      }}
                      style={{
                        ...primaryBtn,
                        flex: "none",
                        padding: "10px 16px",
                        minHeight: 40,
                        fontSize: 12.5,
                      }}
                    >
                      Get
                    </button>
                  </div>
                  {m.description ? (
                    <div
                      style={{
                        fontSize: 12,
                        color: "var(--mv3-muted)",
                        marginTop: 9,
                        lineHeight: 1.5,
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                      }}
                    >
                      {m.description}
                    </div>
                  ) : null}
                </GlassCard>
              );
            })
          )}

          {/* Install from GitHub URL — the dashed unreviewed row (frame 66). */}
          <button
            type="button"
            onClick={() => {
              haptic.light();
              setUntrustedError(null);
              setUrlSheetOpen(true);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 11,
              width: "100%",
              textAlign: "left",
              background: "transparent",
              border: "1.5px dashed var(--mv3-btn2-border)",
              borderRadius: 18,
              padding: "14px 16px",
              minHeight: 56,
              cursor: "pointer",
              fontFamily: "inherit",
              color: "var(--mv3-text)",
            }}
          >
            <span
              aria-hidden
              style={{ fontSize: 18, color: "var(--mv3-muted)" }}
            >
              ＋
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span
                style={{ display: "block", fontSize: 13.5, fontWeight: 600 }}
              >
                Install from GitHub URL
              </span>
              <span
                style={{
                  display: "block",
                  fontSize: 11,
                  color: "var(--mv3-amber-text)",
                  marginTop: 1,
                }}
              >
                Unreviewed · Cue hasn't checked it
              </span>
            </span>
          </button>

          <TrustFootnote>
            Reviewed plugins are pinned to a commit — you can uninstall anytime
          </TrustFootnote>
        </>
      ) : installed.length === 0 ? (
        <GlassCard padding="18px 16px">
          <div style={{ fontSize: 13.5, color: "var(--mv3-muted)" }}>
            {installedQuery.isLoading
              ? "Loading installed plugins…"
              : "No plugins installed yet — browse Explore to add one."}
          </div>
        </GlassCard>
      ) : (
        <GlassCard
          padding={0}
          radius={20}
          style={{ overflow: "hidden", ...rise(0.1) }}
        >
          {installed.map((p, i) => (
            <button
              key={p.id}
              type="button"
              aria-label={`Manage ${p.name}`}
              className="cue-pressable"
              onClick={() => openDetail(p.name, true)}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "12px 15px",
                minHeight: 56,
                textAlign: "left",
                background: "transparent",
                border: "none",
                borderBottom:
                  i === installed.length - 1
                    ? "none"
                    : "1px solid var(--mv3-line)",
                cursor: "pointer",
                fontFamily: "inherit",
                color: "var(--mv3-text)",
              }}
            >
              <span style={{ opacity: p.disabled ? 0.5 : 1 }}>
                <PluginTile size={32} />
              </span>
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  opacity: p.disabled ? 0.55 : 1,
                }}
              >
                <span
                  style={{
                    display: "block",
                    fontSize: 14,
                    fontWeight: 600,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {p.name}
                </span>
                <span
                  style={{
                    display: "block",
                    fontSize: 11,
                    color: p.disabled
                      ? "var(--mv3-muted)"
                      : "var(--mv3-green, var(--mv3-muted))",
                    marginTop: 1,
                  }}
                >
                  {p.disabled ? "Disabled" : "Enabled"}
                  {p.version ? ` · v${p.version}` : ""}
                  {p.issues && p.issues.length > 0 ? " · needs attention" : ""}
                </span>
              </span>
              <span style={{ color: "var(--mv3-faint)" }} aria-hidden>
                ›
              </span>
            </button>
          ))}
        </GlassCard>
      )}

      {/* Frame 67 — detail + install confirm + installed-state uninstall. */}
      <PluginDetailSheet
        open={detailName !== null}
        model={detailModel}
        loading={detailQuery.isLoading}
        installed={detailInstalled}
        confirming={confirming}
        installing={installMutation.isPending}
        uninstalling={uninstallMutation.isPending}
        toggling={enableMutation.isPending || disableMutation.isPending}
        error={installError}
        onGet={() => detailName && openConfirm(detailName)}
        onConfirm={confirmInstall}
        onUninstall={uninstallCurrent}
        onToggleEnabled={toggleEnabled}
        onClose={closeDetail}
      />

      {/* Frame 68 — the red-edged untrusted install warning. */}
      <PluginUntrustedInstallSheet
        open={urlSheetOpen}
        value={urlValue}
        onChange={setUrlValue}
        repoSlug={parseRepoSlug(urlValue)}
        installing={installMutation.isPending}
        error={untrustedError}
        onConfirm={confirmUntrusted}
        onClose={() => {
          setUrlSheetOpen(false);
          setUntrustedError(null);
        }}
      />
    </YouScreen>
  );
}
