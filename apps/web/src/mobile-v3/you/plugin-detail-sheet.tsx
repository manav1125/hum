/**
 * PluginDetailSheet — the mobile plugin detail + install-confirm sheet
 * (spec frame 67), a sibling of `skill-detail-sheet.tsx` and built to the
 * same frame-57 grammar: a card tap opens the detail; "Get" opens the SAME
 * sheet with the confirm card focused — no naked installs.
 *
 * Honesty rules (the plugin backend is thinner than the design imagined —
 * `GET /v1/plugins/:name` returns description / homepage / license / version /
 * source / reviewStatus / surfaces / readme / artifact but NO per-capability
 * manifest):
 *
 *  · The "What it can reach" card derives STRICTLY from what the daemon
 *    actually returns. Since the per-capability manifest (which tools /
 *    connectors it touches) is not exposed over HTTP, we never invent a
 *    permission list. We render the two signals we CAN stand behind: the
 *    registry's real `reviewStatus` (see `@/lib/plugin-curation`) and the
 *    declared `surfaces` — using the SAME ✓ / ‖ vocabulary as the skill sheet
 *    and desktop W2.
 *  · The pinned commit + version render only from real fields.
 *  · The "an app will appear" note is shown from the real `artifact`
 *    descriptor (a prebuilt client the plugin ships) — the panel is NEVER
 *    mocked.
 *  · Install is confirmed before anything runs.
 *  · The installed state renders the full lifecycle — Enabled ⟷ Disabled via
 *    `POST /v1/plugins/:name/{enable,disable}`, then Remove.
 *
 * `PluginUntrustedInstallSheet` (frame 68) is the distinct red-edged warning
 * for a raw GitHub-URL install.
 */
import { useEffect, useRef } from "react";

import type { PluginsByNameGetResponse } from "@/generated/daemon/types.gen";
import {
  curationBadge,
  curationConsentLine,
  isCurated,
  type PluginReviewStatus,
  reviewStatusOf,
} from "@/lib/plugin-curation";
import { haptic } from "@/utils/haptics";

import { SheetShell } from "../sheet-shell";
import { microLabel, primaryBtn } from "../mv3-kit";

/* ─────────────────────────── Shared helpers ──────────────────────────────── */

/** First 7 chars of a commit SHA — git's default short form. */
export function shortSha(sha: string | null | undefined): string | null {
  return sha ? sha.slice(0, 7) : null;
}

export interface PluginDetailModel {
  name: string;
  /** Real curation posture from the registry entry. */
  reviewStatus: PluginReviewStatus;
  /** "v0.0.1 · MIT" — real fields only, null when none. */
  metaLine: string | null;
  description: string | null;
  /** "vellum-ai/level-up" — the source repo. */
  repo: string | null;
  /** Pinned commit short SHA, when known. */
  pinnedCommit: string | null;
  /** Declared plugin surfaces from the registry entry; `[]` when none. */
  surfaces: string[];
  /** Real prebuilt-client descriptor, when the plugin ships one. */
  artifactLabel: string | null;
  /** The installed copy carries a `.disabled` sentinel — the loader skips it. */
  disabled: boolean;
}

/** Detail response → sheet model. */
export function pluginDetailModel(
  detail: PluginsByNameGetResponse,
): PluginDetailModel {
  const repo = detail.source?.kind === "github" ? detail.source.repo : null;
  const meta = [
    detail.version ? `v${detail.version}` : null,
    detail.license ?? null,
  ].filter(Boolean);
  return {
    name: detail.name,
    reviewStatus: reviewStatusOf(detail.reviewStatus),
    metaLine: meta.length > 0 ? meta.join(" · ") : null,
    description: detail.description,
    repo,
    pinnedCommit: shortSha(detail.source?.ref ?? null),
    surfaces: detail.surfaces ?? [],
    artifactLabel: detail.artifact
      ? (detail.artifact.label ?? "a downloadable client")
      : null,
    disabled: detail.disabled ?? false,
  };
}

/** A tile that stands in for a plugin's icon (the HTTP list has no icon). */
function PluginTile({ size = 52 }: { size?: number }) {
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.29),
        background: "rgba(167,159,240,.2)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: Math.round(size * 0.46),
        flexShrink: 0,
      }}
    >
      🧩
    </span>
  );
}

/* ──────────────────────────── The detail sheet ───────────────────────────── */

export function PluginDetailSheet({
  open,
  model,
  loading,
  installed,
  confirming,
  installing,
  uninstalling = false,
  toggling = false,
  error,
  onGet,
  onConfirm,
  onUninstall,
  onToggleEnabled,
  onClose,
}: {
  open: boolean;
  model: PluginDetailModel | null;
  /** The detail read is in flight. */
  loading: boolean;
  /** Already installed — read-only detail, no Get/confirm. */
  installed: boolean;
  /** True once "Get" was pressed — the confirm card is revealed + focused. */
  confirming: boolean;
  installing: boolean;
  uninstalling?: boolean;
  /** An enable/disable toggle is in flight. */
  toggling?: boolean;
  error: string | null;
  onGet: () => void;
  onConfirm: () => void;
  /** Uninstall the installed copy — rendered only in the installed state. */
  onUninstall?: () => void;
  /** Flip the `.disabled` sentinel — rendered only in the installed state. */
  onToggleEnabled?: () => void;
  onClose: () => void;
}) {
  const confirmRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !confirming) return;
    const id = requestAnimationFrame(() => {
      confirmRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    });
    return () => cancelAnimationFrame(id);
  }, [open, confirming]);

  const label = model?.name ?? "Plugin";

  return (
    <SheetShell open={open} onClose={onClose} label={label}>
      {!model ? (
        <div
          style={{
            fontSize: 13.5,
            color: "var(--mv3-muted)",
            padding: "16px 4px",
          }}
        >
          {loading ? "Loading the plugin…" : "Couldn't load this plugin."}
        </div>
      ) : (
        <div style={{ padding: "0 2px 8px" }}>
          {/* Header — tile, name, badge + meta. */}
          <div style={{ display: "flex", alignItems: "center", gap: 13 }}>
            <PluginTile />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 20,
                  fontWeight: 700,
                  letterSpacing: "-.4px",
                }}
              >
                {model.name}
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  marginTop: 3,
                  flexWrap: "wrap",
                }}
              >
                <span
                  style={{
                    fontSize: 10,
                    color: isCurated(model.reviewStatus)
                      ? "var(--mv3-micro)"
                      : "var(--mv3-muted)",
                    background: isCurated(model.reviewStatus)
                      ? "rgba(61,110,232,.16)"
                      : "var(--mv3-btn2-bg)",
                    borderRadius: 6,
                    padding: "2px 8px",
                    flexShrink: 0,
                  }}
                >
                  {curationBadge(model.reviewStatus)}
                </span>
                {model.metaLine ? (
                  <span style={{ fontSize: 10.5, color: "var(--mv3-muted)" }}>
                    {model.metaLine}
                  </span>
                ) : null}
                {installed ? (
                  <span
                    style={{
                      ...microLabel,
                      fontSize: 9.5,
                      color: model.disabled
                        ? "var(--mv3-muted)"
                        : "var(--mv3-green)",
                    }}
                  >
                    {model.disabled ? "◦ Disabled" : "✓ Enabled"}
                  </span>
                ) : null}
              </div>
            </div>
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 10,
              marginTop: 14,
            }}
          >
            {model.description ? (
              <div
                style={{
                  fontSize: 13.5,
                  color: "var(--mv3-muted)",
                  lineHeight: 1.6,
                }}
              >
                {model.description}
              </div>
            ) : null}

            {/* What it can reach — the honest consent signals. The
                per-capability manifest is not exposed over HTTP, so we never
                fabricate a "reaches your email/files" list; we render the
                registry's real review posture plus its declared surfaces. */}
            <div
              style={{
                background: "var(--mv3-card)",
                border: "1px solid var(--mv3-card-border)",
                borderRadius: 18,
                padding: "13px 15px",
              }}
            >
              <div
                style={{
                  ...microLabel,
                  fontSize: 9.5,
                  color: "var(--mv3-muted)",
                  marginBottom: 9,
                }}
              >
                What it can reach
              </div>
              {(() => {
                const consent = curationConsentLine(model.reviewStatus);
                const ok = consent.tone === "ok";
                return (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 9,
                      fontSize: 12.5,
                      color: ok ? "var(--mv3-text)" : "var(--mv3-amber)",
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        color: ok ? "var(--mv3-green)" : "var(--mv3-amber)",
                        fontWeight: ok ? 400 : 700,
                      }}
                    >
                      {consent.glyph}
                    </span>
                    <span>
                      {consent.text}
                      {
                        " A plugin can add tools, hooks, and app surfaces that run inside Cue; anything sensitive still asks before it acts."
                      }
                    </span>
                  </div>
                );
              })()}
              {model.surfaces.length > 0 ? (
                <div
                  style={{
                    fontSize: 11.5,
                    color: "var(--mv3-muted)",
                    marginTop: 9,
                    lineHeight: 1.5,
                  }}
                >
                  Adds: {model.surfaces.join(", ")}.
                </div>
              ) : null}
            </div>

            {/* Source + pinned commit — real provenance only. */}
            {model.repo ? (
              <div
                style={{
                  background: "var(--mv3-card)",
                  border: "1px solid var(--mv3-card-border)",
                  borderRadius: 18,
                  padding: "13px 15px",
                  display: "flex",
                  alignItems: "center",
                  gap: 11,
                }}
              >
                <span aria-hidden style={{ fontSize: 14 }}>
                  🛠
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5 }}>source: {model.repo}</div>
                  {model.pinnedCommit ? (
                    <div
                      style={{
                        fontFamily: "var(--mv3-mono)",
                        fontSize: 10.5,
                        color: "var(--mv3-muted)",
                        marginTop: 2,
                      }}
                    >
                      pinned @ {model.pinnedCommit}
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}

            {/* "An app will appear" — from the real artifact, never mocked. */}
            {model.artifactLabel ? (
              <div
                style={{
                  fontSize: 11.5,
                  color: "var(--mv3-muted)",
                  lineHeight: 1.5,
                }}
              >
                Ships {model.artifactLabel} — it appears after install and a
                restart. Cue never runs plugin code before you install it.
              </div>
            ) : (
              <div
                style={{
                  fontSize: 11.5,
                  color: "var(--mv3-muted)",
                  lineHeight: 1.5,
                }}
              >
                Any surfaces this plugin adds load after install and a restart.
              </div>
            )}

            {/* Confirm card — revealed by "Get", never a naked install. */}
            {!installed && confirming ? (
              <div
                ref={confirmRef}
                style={{
                  background: "var(--mv3-card)",
                  border: "1px solid rgba(127,163,242,.45)",
                  borderRadius: 20,
                  padding: "14px 16px",
                  boxShadow: "0 24px 50px -22px rgba(61,110,232,.45)",
                }}
              >
                <div style={{ fontSize: 14, fontWeight: 600 }}>
                  Install this plugin?
                </div>
                <div
                  style={{
                    fontSize: 11.5,
                    color: "var(--mv3-muted)",
                    marginTop: 4,
                    lineHeight: 1.5,
                  }}
                >
                  {curationConsentLine(model.reviewStatus).text} You can disable
                  or uninstall it at any time.
                </div>
                {error ? (
                  <div
                    role="alert"
                    style={{ fontSize: 12, color: "#E5675B", marginTop: 8 }}
                  >
                    {error}
                  </div>
                ) : null}
                <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                  <button
                    type="button"
                    disabled={installing}
                    onClick={() => {
                      haptic.medium();
                      onConfirm();
                    }}
                    style={{
                      ...primaryBtn,
                      borderRadius: 12,
                      padding: 12,
                      minHeight: 46,
                      fontSize: 13.5,
                      opacity: installing ? 0.6 : 1,
                    }}
                  >
                    {installing ? "Installing…" : "Install"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      haptic.light();
                      onClose();
                    }}
                    style={{
                      background: "var(--mv3-btn2-bg)",
                      color: "var(--mv3-muted)",
                      border: "1px solid var(--mv3-btn2-border)",
                      borderRadius: 12,
                      padding: "12px 16px",
                      minHeight: 46,
                      fontSize: 13,
                      fontFamily: "inherit",
                      cursor: "pointer",
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}

            {/* Installed: the rest of the lifecycle — Enabled ⟷ Disabled,
                then Remove. Disabling keeps the code on disk and inert; it is
                the reversible alternative to uninstalling. */}
            {installed ? (
              <>
                {error ? (
                  <div role="alert" style={{ fontSize: 12, color: "#E5675B" }}>
                    {error}
                  </div>
                ) : null}
                {onToggleEnabled ? (
                  <>
                    <button
                      type="button"
                      disabled={toggling}
                      onClick={() => {
                        haptic.medium();
                        onToggleEnabled();
                      }}
                      style={
                        model.disabled
                          ? {
                              ...primaryBtn,
                              borderRadius: 12,
                              padding: 12,
                              minHeight: 46,
                              fontSize: 13.5,
                              opacity: toggling ? 0.6 : 1,
                            }
                          : {
                              background: "var(--mv3-btn2-bg)",
                              color: "var(--mv3-text)",
                              border: "1px solid var(--mv3-btn2-border)",
                              borderRadius: 12,
                              padding: 12,
                              minHeight: 46,
                              fontSize: 13.5,
                              fontFamily: "inherit",
                              cursor: "pointer",
                              width: "100%",
                              opacity: toggling ? 0.6 : 1,
                            }
                      }
                    >
                      {toggling
                        ? model.disabled
                          ? "Enabling…"
                          : "Disabling…"
                        : model.disabled
                          ? "Enable plugin"
                          : "Disable plugin"}
                    </button>
                    <div
                      style={{
                        fontSize: 11,
                        color: "var(--mv3-muted)",
                        lineHeight: 1.5,
                      }}
                    >
                      {model.disabled
                        ? "Disabled — its code stays on disk but never loads. Enabling takes effect after the assistant restarts."
                        : "Disabling keeps the plugin installed but stops its code from loading. It takes effect after the assistant restarts."}
                    </div>
                  </>
                ) : null}
                {onUninstall ? (
                  <div style={{ textAlign: "center", padding: "2px 0" }}>
                    <button
                      type="button"
                      disabled={uninstalling}
                      onClick={() => {
                        haptic.medium();
                        onUninstall();
                      }}
                      style={{
                        fontSize: 13,
                        color: "#E5675B",
                        background: "none",
                        border: "none",
                        padding: "10px 16px",
                        minHeight: 44,
                        cursor: "pointer",
                        fontFamily: "inherit",
                        opacity: uninstalling ? 0.6 : 1,
                      }}
                    >
                      {uninstalling ? "Uninstalling…" : "Uninstall plugin"}
                    </button>
                  </div>
                ) : null}
              </>
            ) : null}

            {/* Detail phase: the Get affordance (hidden once installed). */}
            {!installed && !confirming ? (
              <>
                {error ? (
                  <div role="alert" style={{ fontSize: 12, color: "#E5675B" }}>
                    {error}
                  </div>
                ) : null}
                <button
                  type="button"
                  onClick={() => {
                    haptic.medium();
                    onGet();
                  }}
                  style={{
                    ...primaryBtn,
                    borderRadius: 12,
                    padding: 12,
                    minHeight: 46,
                    fontSize: 13.5,
                  }}
                >
                  Get
                </button>
              </>
            ) : null}
          </div>
        </div>
      )}
    </SheetShell>
  );
}

/* ───────────────────── Untrusted install (frame 68) ──────────────────────── */

/** Parse an `owner/repo` slug out of a raw GitHub URL or `owner/repo` string. */
export function parseRepoSlug(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // github.com/owner/repo(/...)? or a bare owner/repo.
  const m = trimmed.match(
    /(?:github\.com\/)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?(?:\/|#|$)/,
  );
  if (!m) return null;
  const slug = m[1];
  // A bare `owner/repo` has exactly one slash and no scheme noise.
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug) ? slug : null;
}

/**
 * The distinct red-edged warning sheet for a raw GitHub-URL install
 * (frame 68). Names the repo, states Cue hasn't reviewed it, describes the
 * manifest reach, and carries the risk in the button label.
 *
 * Honesty: `POST /v1/plugins/install` resolves ONLY curated marketplace names
 * (a caller-supplied ref is rejected by design — see plugins-routes.ts), so a
 * truly-unreviewed URL cannot be installed over the web. We still attempt the
 * install by the repo basename (it succeeds when the repo IS a curated entry),
 * and surface the honest CLI fallback when the daemon declines.
 */
export function PluginUntrustedInstallSheet({
  open,
  value,
  onChange,
  repoSlug,
  installing,
  error,
  onConfirm,
  onClose,
}: {
  open: boolean;
  value: string;
  onChange: (v: string) => void;
  repoSlug: string | null;
  installing: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <SheetShell open={open} onClose={onClose} label="Install from GitHub">
      <div
        style={{
          border: "1.5px solid rgba(229,103,91,.55)",
          borderRadius: 20,
          padding: "16px 16px 4px",
          background:
            "linear-gradient(180deg, rgba(229,103,91,.10), transparent 40%)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span aria-hidden style={{ fontSize: 20 }}>
            ⚠️
          </span>
          <div style={{ fontSize: 17, fontWeight: 700, color: "#E5675B" }}>
            Unreviewed plugin
          </div>
        </div>

        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="github.com/owner/repo"
          aria-label="GitHub repo URL"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          style={{
            width: "100%",
            fontSize: 16,
            fontFamily: "var(--mv3-mono)",
            color: "var(--mv3-text)",
            background: "var(--mv3-btn2-bg)",
            border: "1px solid var(--mv3-btn2-border)",
            borderRadius: 11,
            padding: "11px 13px",
            minHeight: 44,
            outline: "none",
            marginTop: 13,
            boxSizing: "border-box",
          }}
        />

        <div
          style={{
            fontSize: 13,
            color: "var(--mv3-text)",
            marginTop: 12,
            lineHeight: 1.55,
          }}
        >
          You're about to install{" "}
          <span style={{ fontFamily: "var(--mv3-mono)", fontWeight: 600 }}>
            {repoSlug ?? "this repo"}
          </span>{" "}
          straight from GitHub. <strong>Cue hasn't reviewed this.</strong>
        </div>

        <div
          style={{
            fontSize: 12.5,
            color: "var(--mv3-muted)",
            marginTop: 10,
            lineHeight: 1.55,
          }}
        >
          Its manifest can register tools, hooks, routes, and app surfaces that
          run inside Cue with your assistant's reach. Only install it if you
          trust the author.
        </div>

        {error ? (
          <div
            role="alert"
            style={{
              fontSize: 12,
              color: "#E5675B",
              marginTop: 12,
              lineHeight: 1.5,
            }}
          >
            {error}
          </div>
        ) : null}

        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <button
            type="button"
            disabled={installing || !repoSlug}
            onClick={() => {
              haptic.medium();
              onConfirm();
            }}
            style={{
              flex: 1,
              background: "var(--mv3-fail-fill)",
              color: "var(--mv3-fail-on-fill)",
              border: "none",
              borderRadius: 12,
              padding: 12,
              minHeight: 46,
              fontSize: 13.5,
              fontWeight: 600,
              fontFamily: "inherit",
              cursor: "pointer",
              opacity: installing || !repoSlug ? 0.6 : 1,
            }}
          >
            {installing ? "Installing…" : "Install unreviewed plugin"}
          </button>
          <button
            type="button"
            onClick={() => {
              haptic.light();
              onClose();
            }}
            style={{
              background: "var(--mv3-btn2-bg)",
              color: "var(--mv3-muted)",
              border: "1px solid var(--mv3-btn2-border)",
              borderRadius: 12,
              padding: "12px 16px",
              minHeight: 46,
              fontSize: 13,
              fontFamily: "inherit",
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </SheetShell>
  );
}
