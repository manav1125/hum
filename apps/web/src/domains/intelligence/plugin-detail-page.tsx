/**
 * PluginDetailPage — the W2 plugin detail page (cue-web-parityplus.html),
 * reached from a marketplace card. Serif-HQ grammar: an editorial header with
 * the source repo + pinned commit + version, a consent panel (the SAME ✓ / ‖
 * vocabulary as the mobile detail sheet), declared surfaces, an app-preview
 * affordance, version history, and Install / Upgrade / Uninstall actions.
 *
 * Honesty (the HTTP plugin surface is thinner than the design imagined):
 *  · `GET /v1/plugins/:name` returns description / homepage / license /
 *    version / source / reviewStatus / surfaces / disabled / readme /
 *    artifact — but NO per-capability manifest (which connectors or files a
 *    plugin actually touches). So the consent panel stands behind the real
 *    registry `reviewStatus` plus the declared `surfaces`, and never
 *    fabricates a permission list.
 *  · Version history is real: it reads the installed vs marketplace commit
 *    (+ committer timestamps) from `GET /v1/plugins/:name/inspect`.
 *  · The app-preview affordance is the real prebuilt-client `artifact`
 *    download when present; otherwise it's flagged NEEDS BACKEND (no preview
 *    endpoint) rather than mocked.
 *  · The full lifecycle is wired to real routes: install, enable / disable
 *    (`POST /v1/plugins/:name/{enable,disable}`), upgrade, uninstall.
 *
 * Mounted under `IntelligenceLayout`; gated by the same `external-plugins`
 * feature flag as `PluginsPage`.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useCallback, useState } from "react";
import { Link, Navigate, useParams } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { FileMarkdown } from "@/components/file-markdown";
import {
  hasLocalEdits,
  type PluginDrift,
  usePluginDrift,
} from "@/domains/intelligence/use-plugin-drift";
import {
  curationBadge,
  curationConsentLine,
  isCurated,
} from "@/lib/plugin-curation";
import {
  pluginsByNameGetOptions,
  pluginsByNameGetQueryKey,
  pluginsByNameInspectGetQueryKey,
  pluginsGetQueryKey,
  pluginsSearchGetQueryKey,
  usePluginsByNameDeleteMutation,
  usePluginsByNameDisablePostMutation,
  usePluginsByNameEnablePostMutation,
  usePluginsByNameUpgradePostMutation,
  usePluginsInstallPostMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { PluginsByNameGetResponse } from "@/generated/daemon/types.gen";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { routes } from "@/utils/routes";
import { ConfirmDialog, toast } from "@vellumai/design-library";

const C = {
  ink: "var(--mv1-ink)",
  blue: "var(--mv1-blue)",
  blueText: "var(--mv1-blue-text)",
  bg: "var(--mv1-canvas)",
  card: "var(--mv1-card)",
  line: "var(--mv1-line)",
  line2: "var(--mv1-line-strong)",
  t1: "var(--mv1-t1)",
  t2: "var(--mv1-t2)",
  t3: "var(--mv1-t3)",
  violet: "var(--mv1-violet)",
  violetWash: "var(--mv1-violet-strong)",
  green: "var(--mv1-success, #2E9E6B)",
  amber: "var(--mv1-warning, #C8811E)",
  danger: "var(--mv1-danger, #C0473C)",
  /** Text leg for small copy where colour is the only carrier (A1). */
  dangerText: "var(--mv1-danger-text)",
} as const;
const SERIF = "'Instrument Serif', Georgia, serif";
const MONO = "'DM Mono', ui-monospace, monospace";

/** First 7 chars of a commit SHA. */
function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "unknown";
}

function fmtDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function PluginDetailPage() {
  const hasHydrated = useAssistantFeatureFlagStore.use.hasHydrated();
  const externalPlugins = useAssistantFeatureFlagStore.use.externalPlugins();
  const assistantId = useActiveAssistantId();
  const { name } = useParams<{ name: string }>();
  const queryClient = useQueryClient();
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [confirmingUpgrade, setConfirmingUpgrade] = useState(false);

  const detailQuery = useQuery({
    ...pluginsByNameGetOptions({
      path: { assistant_id: assistantId, name: name ?? "" },
    }),
    enabled: Boolean(assistantId) && Boolean(name),
  });

  const installed = detailQuery.data?.installed ?? false;
  const driftQuery = usePluginDrift({
    assistantId,
    name: name ?? "",
    enabled: installed,
  });
  const drift = driftQuery.data;

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: pluginsGetQueryKey({ path: { assistant_id: assistantId } }),
    });
    void queryClient.invalidateQueries({
      queryKey: pluginsSearchGetQueryKey({
        path: { assistant_id: assistantId },
      }),
    });
    if (name) {
      void queryClient.invalidateQueries({
        queryKey: pluginsByNameGetQueryKey({
          path: { assistant_id: assistantId, name },
        }),
      });
      void queryClient.invalidateQueries({
        queryKey: pluginsByNameInspectGetQueryKey({
          path: { assistant_id: assistantId, name },
        }),
      });
    }
  }, [assistantId, name, queryClient]);

  const installMutation = usePluginsInstallPostMutation({
    onSuccess: () => {
      invalidate();
      toast.success(`Installed ${name ?? "plugin"}`);
    },
  });
  const removeMutation = usePluginsByNameDeleteMutation({
    onSuccess: invalidate,
  });
  const upgradeMutation = usePluginsByNameUpgradePostMutation({
    onSuccess: (result) => {
      invalidate();
      toast.success(
        result.outcome === "already-up-to-date"
          ? `${name ?? "Plugin"} is already up to date`
          : `Upgraded ${name ?? "plugin"} to ${shortSha(result.toCommit)}`,
      );
    },
  });
  // Enabled ⟷ Disabled. The toast reports the restart caveat honestly: the
  // sentinel gates the loader's import, so a live plugin keeps running until
  // the assistant restarts.
  const toggleSuccess =
    (verb: "Enabled" | "Disabled") =>
    (result: { restartRequired: boolean }) => {
      invalidate();
      toast.success(
        result.restartRequired
          ? `${verb} ${name ?? "plugin"} — takes effect after the assistant restarts`
          : `${name ?? "Plugin"} was already ${verb.toLowerCase()}`,
      );
    };
  const enableMutation = usePluginsByNameEnablePostMutation({
    onSuccess: toggleSuccess("Enabled"),
  });
  const disableMutation = usePluginsByNameDisablePostMutation({
    onSuccess: toggleSuccess("Disabled"),
  });

  if (!hasHydrated) return null;
  if (!externalPlugins) return <Navigate to={routes.identity} replace />;
  if (!name) return <Navigate to={routes.plugins} replace />;

  const handleInstall = () =>
    installMutation.mutate({
      path: { assistant_id: assistantId },
      body: { name },
    });
  const confirmRemove = () => {
    setConfirmingRemove(false);
    removeMutation.mutate({ path: { assistant_id: assistantId, name } });
  };
  const runUpgrade = () =>
    upgradeMutation.mutate({
      path: { assistant_id: assistantId, name },
      body: {},
    });
  const handleUpgrade = () => {
    if (hasLocalEdits(drift)) {
      setConfirmingUpgrade(true);
      return;
    }
    runUpgrade();
  };
  const confirmUpgrade = () => {
    setConfirmingUpgrade(false);
    runUpgrade();
  };
  const handleToggleEnabled = () => {
    const mutation = detailQuery.data?.disabled
      ? enableMutation
      : disableMutation;
    mutation.mutate({ path: { assistant_id: assistantId, name } });
  };

  const plugin = detailQuery.data ?? null;
  const actionError =
    installMutation.isError ||
    removeMutation.isError ||
    upgradeMutation.isError ||
    enableMutation.isError ||
    disableMutation.isError;

  return (
    <div
      style={{
        fontFamily: "'DM Sans', system-ui, sans-serif",
        color: C.t1,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        height: "100%",
        padding: "0 0 24px",
      }}
    >
      <Link
        to={routes.plugins}
        aria-label="Back to plugins"
        style={{
          fontSize: 13,
          color: C.t2,
          textDecoration: "none",
          marginBottom: 12,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        ‹ Plugins
      </Link>

      {detailQuery.isLoading ? (
        <Centered>
          <Loader2 className="size-6 animate-spin" color={C.t3} />
        </Centered>
      ) : detailQuery.isError || !plugin ? (
        <EmptyState />
      ) : (
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          <Hero
            plugin={plugin}
            drift={drift}
            installing={installMutation.isPending}
            removing={removeMutation.isPending}
            upgrading={upgradeMutation.isPending}
            toggling={enableMutation.isPending || disableMutation.isPending}
            onInstall={handleInstall}
            onUpgrade={handleUpgrade}
            onToggleEnabled={handleToggleEnabled}
            onRemove={() => setConfirmingRemove(true)}
          />

          {actionError ? (
            <div
              role="alert"
              style={{
                fontSize: 13,
                color: C.dangerText,
                background:
                  "color-mix(in srgb, var(--mv1-danger) 8%, transparent)",
                borderRadius: 10,
                padding: "10px 14px",
                margin: "14px 0",
              }}
            >
              {installMutation.isError
                ? "Failed to install plugin. Please try again."
                : removeMutation.isError
                  ? "Failed to uninstall plugin. Please try again."
                  : upgradeMutation.isError
                    ? "Failed to upgrade plugin. Please try again."
                    : "Failed to change this plugin's enabled state. Please try again."}
            </div>
          ) : null}

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 320px",
              gap: 20,
              marginTop: 18,
              alignItems: "start",
            }}
          >
            {/* README */}
            <div
              style={{
                border: `1px solid ${C.line}`,
                borderRadius: 14,
                background: C.card,
                padding: "20px 22px",
                minWidth: 0,
              }}
            >
              {plugin.readme ? (
                <FileMarkdown content={plugin.readme} />
              ) : (
                <p style={{ fontSize: 13, color: C.t2 }}>
                  This plugin doesn&apos;t ship a README.
                </p>
              )}
            </div>

            {/* Side column */}
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <ConsentPanel plugin={plugin} />
              <SurfacesPanel plugin={plugin} />
              <AppPreviewPanel plugin={plugin} />
              <ProvenancePanel plugin={plugin} drift={drift} />
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmingRemove}
        title="Uninstall plugin"
        message={`Remove "${plugin?.name ?? name}" from this assistant?`}
        confirmLabel="Uninstall"
        destructive
        onConfirm={confirmRemove}
        onCancel={() => setConfirmingRemove(false)}
      />
      <ConfirmDialog
        open={confirmingUpgrade}
        title="Upgrade plugin"
        message={`"${plugin?.name ?? name}" has local edits that will be overwritten by the upgrade. Continue?`}
        confirmLabel="Upgrade anyway"
        destructive
        onConfirm={confirmUpgrade}
        onCancel={() => setConfirmingUpgrade(false)}
      />
    </div>
  );
}

/* ─────────────────────────────────── Hero ────────────────────────────────── */

function Hero({
  plugin,
  drift,
  installing,
  removing,
  upgrading,
  toggling,
  onInstall,
  onUpgrade,
  onToggleEnabled,
  onRemove,
}: {
  plugin: PluginsByNameGetResponse;
  drift: PluginDrift | undefined;
  installing: boolean;
  removing: boolean;
  upgrading: boolean;
  toggling: boolean;
  onInstall: () => void;
  onUpgrade: () => void;
  onToggleEnabled: () => void;
  onRemove: () => void;
}) {
  const curated = isCurated(plugin.reviewStatus);
  const updateAvailable = drift?.status === "update-available";
  return (
    <div
      style={{
        position: "relative",
        overflow: "hidden",
        background: C.ink,
        borderRadius: 16,
        padding: "22px 24px",
        display: "flex",
        alignItems: "center",
        gap: 18,
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(340px 160px at 90% 50%,rgba(127,119,221,.22),transparent 70%)",
        }}
      />
      <span
        aria-hidden
        style={{
          position: "relative",
          width: 52,
          height: 52,
          borderRadius: 14,
          background: "rgba(167,159,240,.22)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 26,
          flexShrink: 0,
        }}
      >
        🧩
      </span>
      <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          <span
            style={{ fontFamily: SERIF, fontSize: 26, letterSpacing: "-.3px" }}
          >
            {plugin.name}
          </span>
          <span
            style={{
              fontFamily: MONO,
              fontSize: 10,
              letterSpacing: ".05em",
              textTransform: "uppercase",
              color: curated ? "#BFD0FF" : "rgba(255,255,255,.6)",
              background: curated
                ? "rgba(127,163,242,.24)"
                : "rgba(255,255,255,.1)",
              borderRadius: 5,
              padding: "3px 8px",
            }}
          >
            {curationBadge(plugin.reviewStatus)}
          </span>
          {plugin.version ? (
            <span style={{ fontSize: 13, color: "rgba(255,255,255,.65)" }}>
              v{plugin.version}
            </span>
          ) : null}
          {plugin.installed ? (
            <span
              style={{
                fontSize: 12,
                color: plugin.disabled ? "rgba(255,255,255,.6)" : C.violetWash,
              }}
            >
              {plugin.disabled ? "◦ Installed · disabled" : "✓ Enabled"}
            </span>
          ) : null}
          {updateAvailable ? (
            <span
              style={{
                fontFamily: MONO,
                fontSize: 10,
                letterSpacing: ".05em",
                textTransform: "uppercase",
                color: "#DAD5FF",
                background: "rgba(127,119,221,.3)",
                borderRadius: 5,
                padding: "3px 8px",
              }}
            >
              Update available
            </span>
          ) : null}
        </div>
        {plugin.description ? (
          <div
            style={{
              fontSize: 13.5,
              color: "rgba(255,255,255,.72)",
              marginTop: 5,
              lineHeight: 1.5,
              maxWidth: 620,
            }}
          >
            {plugin.description}
          </div>
        ) : null}
      </div>

      {/* Actions */}
      <div
        style={{
          position: "relative",
          flexShrink: 0,
          display: "flex",
          gap: 8,
        }}
      >
        {plugin.installed ? (
          <>
            {updateAvailable ? (
              <HeroButton onClick={onUpgrade} disabled={upgrading}>
                {upgrading ? "Upgrading…" : "Upgrade"}
              </HeroButton>
            ) : null}
            {/* Enabled ⟷ Disabled sits BEFORE Uninstall: disabling is the
                reversible way to stop a plugin, so it should be the easier
                reach of the two. */}
            <HeroButton
              variant={plugin.disabled ? "primary" : "secondary"}
              onClick={onToggleEnabled}
              disabled={toggling}
            >
              {toggling ? "Saving…" : plugin.disabled ? "Enable" : "Disable"}
            </HeroButton>
            <HeroButton variant="danger" onClick={onRemove} disabled={removing}>
              {removing ? "Uninstalling…" : "Uninstall"}
            </HeroButton>
          </>
        ) : (
          <HeroButton onClick={onInstall} disabled={installing}>
            {installing ? "Installing…" : "Install"}
          </HeroButton>
        )}
      </div>
    </div>
  );
}

function HeroButton({
  children,
  onClick,
  disabled,
  variant = "primary",
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  /** `secondary` is the low-emphasis outline used by the reversible actions. */
  variant?: "primary" | "secondary" | "danger";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        fontSize: 12.5,
        fontWeight: 500,
        fontFamily: "inherit",
        color: "#fff",
        background: variant === "primary" ? C.violet : "transparent",
        border:
          variant === "primary" ? "none" : "1px solid rgba(255,255,255,.35)",
        borderRadius: 9,
        padding: "9px 16px",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.6 : 1,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </button>
  );
}

/* ─────────────────────────────── Side panels ─────────────────────────────── */

function Panel({
  title,
  children,
  note,
}: {
  title: string;
  children: React.ReactNode;
  note?: string;
}) {
  return (
    <div
      style={{
        border: `1px solid ${C.line}`,
        borderRadius: 14,
        background: C.card,
        padding: "15px 16px",
      }}
    >
      <div
        style={{
          fontFamily: MONO,
          fontSize: 10.5,
          letterSpacing: ".1em",
          textTransform: "uppercase",
          color: C.t3,
          marginBottom: 11,
        }}
      >
        {title}
      </div>
      {children}
      {note ? (
        <div
          style={{
            fontFamily: MONO,
            fontSize: 9.5,
            letterSpacing: ".08em",
            textTransform: "uppercase",
            color: C.t3,
            marginTop: 11,
          }}
        >
          {note}
        </div>
      ) : null}
    </div>
  );
}

function ConsentPanel({ plugin }: { plugin: PluginsByNameGetResponse }) {
  const consent = curationConsentLine(plugin.reviewStatus);
  const ok = consent.tone === "ok";
  return (
    <Panel title="What it can reach">
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 9,
          fontSize: 13,
          color: ok ? C.t1 : C.amber,
          lineHeight: 1.5,
        }}
      >
        <span
          aria-hidden
          style={{
            color: ok ? C.green : C.amber,
            fontWeight: ok ? 400 : 700,
            marginTop: 1,
          }}
        >
          {consent.glyph}
        </span>
        <span>
          {consent.text} A plugin can add tools, hooks, and app surfaces that
          run inside Cue; anything sensitive still asks before it acts, and you
          can disable it at any time without uninstalling.
        </span>
      </div>
    </Panel>
  );
}

function SurfacesPanel({ plugin }: { plugin: PluginsByNameGetResponse }) {
  // `surfaces` is real registry data (which of hooks/tools/skills/routes/apps
  // the entry contributes). What is still NOT exposed is the per-capability
  // manifest — which connectors or files a plugin reaches — so that stays
  // flagged rather than fabricated.
  const surfaces = plugin.surfaces ?? [];
  if (surfaces.length === 0) {
    return (
      <Panel title="Declared surfaces">
        <div style={{ fontSize: 13, color: C.t2, lineHeight: 1.5 }}>
          This entry doesn&apos;t declare any surfaces in the registry. The
          README below documents what it contributes.
        </div>
      </Panel>
    );
  }
  return (
    <Panel
      title="Declared surfaces"
      note="Per-capability detail · needs backend"
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {surfaces.map((s) => (
          <span
            key={s}
            style={{
              fontFamily: MONO,
              fontSize: 11,
              color: C.t2,
              background: C.bg,
              borderRadius: 6,
              padding: "3px 9px",
            }}
          >
            {s}
          </span>
        ))}
      </div>
      <div
        style={{
          fontSize: 12.5,
          color: C.t2,
          lineHeight: 1.5,
          marginTop: 10,
        }}
      >
        Which specific connectors or files it reaches isn&apos;t exposed by the
        detail endpoint — the README below is the source of truth for that.
      </div>
    </Panel>
  );
}

function AppPreviewPanel({ plugin }: { plugin: PluginsByNameGetResponse }) {
  // The download is install-gated on purpose: the artifact is a native client
  // that only makes sense once the plugin it belongs to is actually on the
  // machine, and offering a binary for a plugin the user hasn't accepted yet
  // would hand them an executable ahead of the consent step.
  const artifact = plugin.installed ? plugin.artifact : null;
  if (artifact) {
    return (
      <Panel title="App preview">
        <div style={{ fontSize: 13, color: C.t2, lineHeight: 1.5 }}>
          Ships a prebuilt client — it appears after install and a restart.
        </div>
        <a
          href={artifact.url}
          download
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            marginTop: 10,
            fontSize: 12.5,
            color: C.blueText,
            textDecoration: "none",
            fontWeight: 500,
          }}
        >
          {artifact.label ?? "Download client"} ↓
        </a>
      </Panel>
    );
  }
  return (
    <Panel title="App preview" note="Needs backend · no preview endpoint">
      <div style={{ fontSize: 13, color: C.t2, lineHeight: 1.5 }}>
        {plugin.artifact
          ? "This plugin ships a prebuilt client. Install it first — the client becomes available once the plugin is on your assistant."
          : "Any surfaces this plugin adds load after install and a restart. A live in-page preview isn't available yet."}
      </div>
    </Panel>
  );
}

function ProvenancePanel({
  plugin,
  drift,
}: {
  plugin: PluginsByNameGetResponse;
  drift: PluginDrift | undefined;
}) {
  const repo = plugin.source?.kind === "github" ? plugin.source.repo : null;
  const repoHref = repo ? `https://github.com/${repo}` : null;
  const pinned = plugin.source?.ref ? shortSha(plugin.source.ref) : null;

  const localCommit = drift?.local?.commit ?? null;
  const localAt = fmtDate(drift?.local?.committedAt);
  const remoteCommit = drift?.remote?.commit ?? null;
  const remoteAt = fmtDate(drift?.remote?.committedAt);
  const updateAvailable = drift?.status === "update-available";

  return (
    <Panel title="Source & version">
      <dl style={{ display: "grid", gap: 9, margin: 0 }}>
        {repo ? (
          <Row label="Source">
            {repoHref ? (
              <a
                href={repoHref}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: C.blueText, textDecoration: "none" }}
              >
                {repo} ↗
              </a>
            ) : (
              repo
            )}
          </Row>
        ) : null}
        {plugin.homepage ? (
          <Row label="Homepage">
            <a
              href={plugin.homepage}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: C.blue, textDecoration: "none" }}
            >
              {plugin.homepage} ↗
            </a>
          </Row>
        ) : null}
        {plugin.license ? <Row label="License">{plugin.license}</Row> : null}
        {plugin.version ? <Row label="Version">v{plugin.version}</Row> : null}
        {pinned ? (
          <Row label="Pinned">
            <span style={{ fontFamily: MONO }}>{pinned}</span>
          </Row>
        ) : null}
      </dl>

      {/* Version history — real installed vs marketplace commits. */}
      {drift ? (
        <div
          style={{
            marginTop: 13,
            paddingTop: 12,
            borderTop: `1px solid ${C.line}`,
          }}
        >
          <div
            style={{
              fontFamily: MONO,
              fontSize: 9.5,
              letterSpacing: ".08em",
              textTransform: "uppercase",
              color: C.t3,
              marginBottom: 8,
            }}
          >
            Version history
          </div>
          {localCommit ? (
            <HistoryRow
              dot={C.green}
              label={`Installed · ${shortSha(localCommit)}`}
              meta={localAt ?? "current"}
            />
          ) : null}
          {updateAvailable && remoteCommit ? (
            <HistoryRow
              dot={C.violet}
              label={`Available · ${shortSha(remoteCommit)}`}
              meta={remoteAt ?? "marketplace pin"}
            />
          ) : !updateAvailable && plugin.installed ? (
            <div style={{ fontSize: 12, color: C.t2 }}>
              Up to date with the marketplace pin.
            </div>
          ) : null}
        </div>
      ) : null}
    </Panel>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "72px 1fr",
        gap: 10,
        alignItems: "baseline",
      }}
    >
      <dt style={{ fontSize: 12, color: C.t3 }}>{label}</dt>
      <dd
        style={{
          margin: 0,
          fontSize: 12.5,
          color: C.t2,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {children}
      </dd>
    </div>
  );
}

function HistoryRow({
  dot,
  label,
  meta,
}: {
  dot: string;
  label: string;
  meta: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 9,
        padding: "3px 0",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: dot,
          flexShrink: 0,
        }}
      />
      <span style={{ fontSize: 12.5, color: C.t1, fontFamily: MONO }}>
        {label}
      </span>
      <span style={{ fontSize: 11, color: C.t3, marginLeft: "auto" }}>
        {meta}
      </span>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "48px 0",
      }}
    >
      {children}
    </div>
  );
}

function EmptyState() {
  return (
    <div
      style={{
        border: `1px solid ${C.line}`,
        borderRadius: 14,
        background: C.card,
        padding: "48px 24px",
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: 26, marginBottom: 8 }} aria-hidden>
        ⚠
      </div>
      <div style={{ fontSize: 16, fontWeight: 600, color: C.t1 }}>
        We couldn&apos;t load this plugin
      </div>
      <p style={{ fontSize: 13, color: C.t2, marginTop: 4 }}>
        It may not exist, or your assistant may be on an older build.
      </p>
    </div>
  );
}
