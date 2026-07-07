/**
 * Skill Marketplace — Explore / Sources / Installed over GitHub-ingested
 * SKILL.md sources (WS1, Kortix execution brief §3).
 *
 * Visual language matches the HQ kit used by `projects-page.tsx`: serif
 * display hero under a mono microlabel, HQ card DNA (emoji tile · sans
 * title · mono source microlabel), mono chips. Every card attributes its
 * source (`owner/repo`), installs go through an explicit capability-consent
 * card, and updates are diff-then-confirm — never silent.
 *
 * Gated by the `marketplace` assistant feature flag: the Intelligence tab
 * only renders with the flag on, and this page redirects to Skills when a
 * deep-link lands with the flag off (same pattern as PluginsPage).
 */

import { Check, Download, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Navigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { C, mono, serif } from "@/domains/activity/theme";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { HqStyle, MicroLabel, Shimmer } from "@/pages/hq/hq-kit";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { routes } from "@/utils/routes";

import type {
  InstallResponse,
  InstalledSkill,
  MarketplaceItem,
  MarketplaceSource,
  UpdateCheck,
} from "./use-marketplace";
import {
  useAddSource,
  useApplyUpdate,
  useInstallSkill,
  useInstalled,
  useMarketplaceSources,
  useRemoveSource,
  useSourceItems,
  useUpdates,
} from "./use-marketplace";

type TabKey = "explore" | "sources" | "installed";

// ─── Shared micro-components ─────────────────────────────────────────────────

/** Mono all-caps chip, HQ voice. */
function Chip({
  label,
  active = false,
  color = C.t2,
  onClick,
}: {
  label: string;
  active?: boolean;
  color?: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        fontFamily: mono,
        fontSize: 9.5,
        letterSpacing: "0.05em",
        textTransform: "uppercase",
        color: active ? C.bg : color,
        background: active
          ? C.ink
          : `color-mix(in srgb, ${color} 10%, transparent)`,
        border: `1px solid ${active ? C.ink : C.line}`,
        borderRadius: 999,
        padding: "4px 10px",
        whiteSpace: "nowrap",
        cursor: onClick ? "pointer" : "default",
      }}
    >
      {label}
    </button>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontFamily: mono,
        fontSize: 9.5,
        letterSpacing: "0.09em",
        textTransform: "uppercase",
        color: C.t3,
        margin: "20px 0 10px",
      }}
    >
      {children}
    </div>
  );
}

// ─── Skill card ──────────────────────────────────────────────────────────────

function SkillCard({
  item,
  onInstall,
  installing,
}: {
  item: MarketplaceItem;
  onInstall: () => void;
  installing: boolean;
}) {
  const declared =
    item.capabilities.secrets.length +
      item.capabilities.connectors.length +
      item.capabilities.network.length +
      item.capabilities.writes.length >
    0;
  return (
    <div
      style={{
        padding: "14px 15px",
        border: `1px solid ${C.line}`,
        borderRadius: 14,
        background: C.surface,
        display: "flex",
        flexDirection: "column",
        gap: 9,
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 11 }}>
        <span
          aria-hidden
          style={{
            width: 34,
            height: 34,
            borderRadius: 9,
            display: "grid",
            placeItems: "center",
            fontSize: 16,
            background: C.sunken,
            flexShrink: 0,
          }}
        >
          {item.emoji ?? "🧩"}
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              fontSize: 13.5,
              fontWeight: 600,
              lineHeight: 1.25,
              color: C.t1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={item.displayName}
          >
            {item.displayName}
          </div>
          {/* Source attribution on every card (owner/repo). */}
          <div
            style={{
              fontFamily: mono,
              fontSize: 9,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: C.t3,
              marginTop: 3,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {item.source}
            {item.license ? ` · ${item.license}` : ""}
          </div>
        </div>
      </div>
      <div
        style={{
          fontSize: 12,
          lineHeight: 1.45,
          color: C.t2,
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
          minHeight: 34,
        }}
      >
        {item.description}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          paddingTop: 9,
          borderTop: `1px solid ${C.line}`,
        }}
      >
        <span
          style={{
            fontFamily: mono,
            fontSize: 9,
            letterSpacing: "0.05em",
            color: declared ? C.amber : C.t3,
          }}
        >
          {declared ? "DECLARES CAPABILITIES" : "NO DECLARED CAPABILITIES"}
        </span>
        {item.installed ? (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              fontFamily: mono,
              fontSize: 9.5,
              letterSpacing: "0.05em",
              color: C.green,
            }}
          >
            <Check size={11} /> INSTALLED
          </span>
        ) : (
          <button
            type="button"
            disabled={installing}
            onClick={onInstall}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 11.5,
              fontWeight: 500,
              padding: "5px 11px",
              borderRadius: 8,
              border: "none",
              background: C.ink,
              color: C.bg,
              cursor: installing ? "default" : "pointer",
              opacity: installing ? 0.6 : 1,
            }}
          >
            <Download size={12} />
            {installing ? "Preparing…" : "Install"}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Install consent modal ───────────────────────────────────────────────────

function capabilityRows(plan: InstallResponse): Array<[string, string[]]> {
  const c = plan.capabilities;
  return (
    [
      ["Secrets", c.secrets],
      ["Connectors", c.connectors],
      ["Network", c.network],
      ["Writes", c.writes],
    ] as Array<[string, string[]]>
  ).filter(([, values]) => values.length > 0);
}

function InstallConsentModal({
  plan,
  onCancel,
  onConfirm,
  confirming,
  error,
}: {
  plan: InstallResponse;
  onCancel: () => void;
  onConfirm: () => void;
  confirming: boolean;
  error: string | null;
}) {
  const declared = capabilityRows(plan);
  const files = plan.files ?? [];
  const skipped = plan.skipped ?? [];
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Confirm skill install"
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        background: "color-mix(in srgb, #000 42%, transparent)",
        display: "grid",
        placeItems: "center",
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(480px, 100%)",
          maxHeight: "82vh",
          overflowY: "auto",
          background: C.bg,
          border: `1px solid ${C.line}`,
          borderRadius: 16,
          padding: "20px 22px",
        }}
      >
        <MicroLabel>Install · capability consent</MicroLabel>
        <div
          style={{
            fontFamily: serif,
            fontSize: 24,
            lineHeight: 1.1,
            color: C.ink,
            marginTop: 6,
          }}
        >
          {plan.item?.displayName ?? plan.skillId}
        </div>
        <div
          style={{
            fontFamily: mono,
            fontSize: 9.5,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: C.t3,
            marginTop: 4,
          }}
        >
          {plan.item?.source}
          {plan.item?.license ? ` · ${plan.item.license}` : ""}
        </div>

        <div
          style={{
            marginTop: 14,
            padding: "10px 12px",
            borderRadius: 10,
            background: `color-mix(in srgb, ${declared.length > 0 ? C.amber : C.blue} 9%, transparent)`,
            fontSize: 12.5,
            lineHeight: 1.5,
            color: C.t1,
          }}
        >
          {plan.notice}
        </div>

        {declared.length > 0 ? (
          <div style={{ marginTop: 12, display: "grid", gap: 6 }}>
            {declared.map(([label, values]) => (
              <div key={label} style={{ display: "flex", gap: 8, fontSize: 12 }}>
                <span
                  style={{
                    fontFamily: mono,
                    fontSize: 9.5,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    color: C.amber,
                    minWidth: 82,
                    paddingTop: 1,
                  }}
                >
                  {label}
                </span>
                <span style={{ color: C.t2 }}>{values.join(", ")}</span>
              </div>
            ))}
          </div>
        ) : null}

        <SectionLabel>
          Files to install · {files.length}
        </SectionLabel>
        <div style={{ display: "grid", gap: 3 }}>
          {files.map((f) => (
            <div
              key={f.path}
              style={{ fontFamily: mono, fontSize: 11, color: C.t2 }}
            >
              {f.path}
            </div>
          ))}
        </div>

        {skipped.length > 0 ? (
          <>
            <SectionLabel>
              Skipped — not markdown/text · {skipped.length}
            </SectionLabel>
            <div style={{ display: "grid", gap: 3 }}>
              {skipped.map((f) => (
                <div
                  key={f.path}
                  style={{ fontFamily: mono, fontSize: 11, color: C.t3 }}
                  title={f.reason}
                >
                  {f.path}
                </div>
              ))}
            </div>
            <div style={{ fontSize: 11.5, color: C.t3, marginTop: 6 }}>
              Executable content is never installed from third-party sources.
            </div>
          </>
        ) : null}

        {error ? (
          <div style={{ fontSize: 12, color: C.danger, marginTop: 12 }}>
            {error}
          </div>
        ) : null}

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 18,
          }}
        >
          <button
            type="button"
            onClick={onCancel}
            style={{
              fontSize: 12,
              padding: "7px 13px",
              borderRadius: 9,
              border: `1px solid ${C.line}`,
              background: C.surface,
              color: C.t1,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={confirming}
            onClick={onConfirm}
            style={{
              fontSize: 12,
              fontWeight: 500,
              padding: "7px 14px",
              borderRadius: 9,
              border: "none",
              background: C.ink,
              color: C.bg,
              cursor: confirming ? "default" : "pointer",
              opacity: confirming ? 0.6 : 1,
            }}
          >
            {confirming ? "Installing…" : "Install skill"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Explore tab ─────────────────────────────────────────────────────────────

function ExploreTab({
  assistantId,
  sources,
}: {
  assistantId: string;
  sources: MarketplaceSource[];
}) {
  const isNarrow = useIsMobile();
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<string | null>(null);
  const perSource = useSourceItems(assistantId, sources);
  const install = useInstallSkill(assistantId);
  const [plan, setPlan] = useState<InstallResponse | null>(null);
  const [pendingItemId, setPendingItemId] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);

  const needle = query.trim().toLowerCase();
  const visible = perSource
    .filter((group) => !sourceFilter || group.source.address === sourceFilter)
    .map((group) => ({
      ...group,
      items: needle
        ? group.items.filter(
            (item) =>
              item.displayName.toLowerCase().includes(needle) ||
              item.description.toLowerCase().includes(needle) ||
              item.id.toLowerCase().includes(needle) ||
              item.source.toLowerCase().includes(needle),
          )
        : group.items,
    }));

  const startInstall = (item: MarketplaceItem) => {
    setPendingItemId(item.id);
    setInstallError(null);
    install.mutate(
      {
        path: { assistant_id: assistantId },
        body: { itemId: item.id },
      },
      {
        onSuccess: (data) => setPlan(data as InstallResponse),
        onError: (err) =>
          setInstallError(err instanceof Error ? err.message : String(err)),
        onSettled: () => setPendingItemId(null),
      },
    );
  };

  const confirmInstall = () => {
    if (!plan) return;
    setInstallError(null);
    install.mutate(
      {
        path: { assistant_id: assistantId },
        body: { itemId: plan.skillId, confirm: true },
      },
      {
        onSuccess: () => setPlan(null),
        onError: (err) =>
          setInstallError(err instanceof Error ? err.message : String(err)),
      },
    );
  };

  const grid = (items: MarketplaceItem[]) => (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: isNarrow
          ? "1fr"
          : "repeat(auto-fill, minmax(270px, 1fr))",
        gap: isNarrow ? 9 : 13,
      }}
    >
      {items.map((item) => (
        <SkillCard
          key={item.id}
          item={item}
          installing={pendingItemId === item.id}
          onInstall={() => startInstall(item)}
        />
      ))}
    </div>
  );

  return (
    <div>
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          flexWrap: "wrap",
          marginTop: 16,
        }}
      >
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search skills…"
          aria-label="Search skills"
          style={{
            flex: "1 1 220px",
            minWidth: 180,
            fontSize: 13,
            padding: "8px 12px",
            borderRadius: 10,
            border: `1px solid ${C.line}`,
            background: C.surface,
            color: C.t1,
            outline: "none",
          }}
        />
      </div>

      {/* Per-source filter chips — item counts land as each source resolves. */}
      <div
        style={{
          display: "flex",
          gap: 6,
          flexWrap: "wrap",
          marginTop: 10,
        }}
      >
        <Chip
          label="All sources"
          active={sourceFilter === null}
          onClick={() => setSourceFilter(null)}
        />
        {perSource.map(({ source, items, isLoading }) => (
          <Chip
            key={source.address}
            label={`${source.label ?? source.address}${
              isLoading ? " · …" : ` · ${items.length}`
            }`}
            active={sourceFilter === source.address}
            onClick={() =>
              setSourceFilter(
                sourceFilter === source.address ? null : source.address,
              )
            }
          />
        ))}
      </div>

      {installError && !plan ? (
        <div style={{ fontSize: 12, color: C.danger, marginTop: 12 }}>
          {installError}
        </div>
      ) : null}

      {visible.map((group) => (
        <section key={group.source.address}>
          <SectionLabel>
            {group.source.label ?? group.source.address}
            {group.source.address !== "cue-official"
              ? ` · github.com/${group.source.address}`
              : ""}
          </SectionLabel>
          {group.isLoading ? (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: isNarrow
                  ? "1fr"
                  : "repeat(auto-fill, minmax(270px, 1fr))",
                gap: 13,
              }}
            >
              <Shimmer height={118} radius={14} />
              <Shimmer height={118} radius={14} />
              <Shimmer height={118} radius={14} />
            </div>
          ) : group.isError ? (
            <div style={{ fontSize: 12.5, color: C.t3 }}>
              Couldn’t index this source just now — it stays cached for 24h
              once it loads.
            </div>
          ) : group.items.length === 0 ? (
            <div style={{ fontSize: 12.5, color: C.t3 }}>
              {needle
                ? "No skills match your search in this source."
                : "No SKILL.md files found in this source."}
            </div>
          ) : (
            grid(group.items)
          )}
        </section>
      ))}

      {plan ? (
        <InstallConsentModal
          plan={plan}
          onCancel={() => {
            setPlan(null);
            setInstallError(null);
          }}
          onConfirm={confirmInstall}
          confirming={install.isPending}
          error={installError}
        />
      ) : null}
    </div>
  );
}

// ─── Sources tab ─────────────────────────────────────────────────────────────

function SourcesTab({
  assistantId,
  sources,
  isLoading,
}: {
  assistantId: string;
  sources: MarketplaceSource[];
  isLoading: boolean;
}) {
  const addSource = useAddSource(assistantId);
  const removeSource = useRemoveSource(assistantId);
  const [address, setAddress] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null);

  const submit = () => {
    const trimmed = address.trim();
    if (!trimmed || addSource.isPending) return;
    setFeedback(null);
    addSource.mutate(
      {
        path: { assistant_id: assistantId },
        body: { address: trimmed },
      },
      {
        onSuccess: (data) => {
          setAddress("");
          const warning = (data as { warning?: string } | undefined)?.warning;
          setFeedback(warning ?? null);
        },
        onError: (err) =>
          setFeedback(err instanceof Error ? err.message : String(err)),
      },
    );
  };

  return (
    <div>
      <SectionLabel>Add a source</SectionLabel>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="owner/repo or github.com URL"
          aria-label="Source repository address"
          style={{
            flex: "1 1 260px",
            minWidth: 200,
            fontSize: 13,
            fontFamily: mono,
            padding: "8px 12px",
            borderRadius: 10,
            border: `1px solid ${C.line}`,
            background: C.surface,
            color: C.t1,
            outline: "none",
          }}
        />
        <button
          type="button"
          disabled={addSource.isPending || address.trim().length === 0}
          onClick={submit}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12,
            fontWeight: 500,
            padding: "8px 14px",
            borderRadius: 9,
            border: "none",
            background: C.ink,
            color: C.bg,
            cursor: addSource.isPending ? "default" : "pointer",
            opacity: addSource.isPending ? 0.6 : 1,
          }}
        >
          <Plus size={13} />
          {addSource.isPending ? "Verifying…" : "Add source"}
        </button>
      </div>
      <div style={{ fontSize: 11.5, color: C.t3, marginTop: 7 }}>
        Any public GitHub repo of SKILL.md files becomes a source. The repo is
        verified and its license recorded before it’s added.
      </div>
      {feedback ? (
        <div style={{ fontSize: 12, color: C.amber, marginTop: 8 }}>
          {feedback}
        </div>
      ) : null}

      <SectionLabel>Sources · {sources.length}</SectionLabel>
      {isLoading ? (
        <Shimmer height={54} radius={12} />
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {sources.map((source) => (
            <div
              key={source.address}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "11px 14px",
                border: `1px solid ${C.line}`,
                borderRadius: 12,
                background: C.surface,
                opacity: source.enabled ? 1 : 0.55,
              }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.t1 }}>
                  {source.label ?? source.address}
                </div>
                <div
                  style={{
                    fontFamily: mono,
                    fontSize: 10,
                    letterSpacing: "0.04em",
                    color: C.t3,
                    marginTop: 2,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {source.kind === "catalog"
                    ? "first-party catalog"
                    : `github.com/${source.address}`}
                  {source.license ? ` · ${source.license}` : ""}
                  {source.builtIn ? " · seeded" : ""}
                  {!source.enabled ? " · disabled" : ""}
                </div>
              </div>
              <button
                type="button"
                aria-label={`Remove source ${source.address}`}
                disabled={removeSource.isPending || !source.enabled}
                onClick={() =>
                  removeSource.mutate({
                    path: { assistant_id: assistantId },
                    query: { address: source.address },
                  })
                }
                title={
                  source.builtIn
                    ? "Seeded sources are disabled rather than deleted"
                    : "Remove source"
                }
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 8,
                  display: "grid",
                  placeItems: "center",
                  border: `1px solid ${C.line}`,
                  background: "transparent",
                  color: C.t3,
                  cursor: "pointer",
                }}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Installed tab ───────────────────────────────────────────────────────────

function InstalledRow({
  skill,
  update,
  onUpdate,
  updating,
}: {
  skill: InstalledSkill;
  update: UpdateCheck | undefined;
  onUpdate: () => void;
  updating: boolean;
}) {
  const hasUpdate = update ? !update.upToDate && !update.error : false;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "12px 14px",
        border: `1px solid ${hasUpdate ? C.amber : C.line}`,
        borderRadius: 12,
        background: C.surface,
      }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            minWidth: 0,
          }}
        >
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: C.t1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {skill.skillId}
          </span>
          {hasUpdate ? (
            <span
              style={{
                fontFamily: mono,
                fontSize: 9,
                letterSpacing: "0.06em",
                color: C.amber,
                background: `color-mix(in srgb, ${C.amber} 12%, transparent)`,
                borderRadius: 6,
                padding: "2px 7px",
                whiteSpace: "nowrap",
              }}
            >
              UPDATE · {update!.changes.length} FILE
              {update!.changes.length === 1 ? "" : "S"}
            </span>
          ) : null}
        </div>
        <div
          style={{
            fontFamily: mono,
            fontSize: 10,
            letterSpacing: "0.04em",
            color: C.t3,
            marginTop: 3,
          }}
        >
          {skill.source} · installed{" "}
          {new Date(skill.installedAt).toLocaleDateString()}
          {skill.undeclaredCapabilities ? " · no declared capabilities" : ""}
          {skill.skippedFiles?.length
            ? ` · ${skill.skippedFiles.length} file(s) skipped at install`
            : ""}
        </div>
        {hasUpdate ? (
          <div style={{ marginTop: 6, display: "grid", gap: 2 }}>
            {update!.changes.slice(0, 6).map((change) => (
              <div
                key={change.path}
                style={{ fontFamily: mono, fontSize: 10.5, color: C.t2 }}
              >
                <span
                  style={{
                    color:
                      change.status === "removed"
                        ? C.danger
                        : change.status === "added"
                          ? C.green
                          : C.amber,
                  }}
                >
                  {change.status}
                </span>{" "}
                {change.path}
              </div>
            ))}
          </div>
        ) : null}
      </div>
      {hasUpdate ? (
        <button
          type="button"
          disabled={updating}
          onClick={onUpdate}
          style={{
            fontSize: 11.5,
            fontWeight: 500,
            padding: "6px 12px",
            borderRadius: 8,
            border: "none",
            background: C.ink,
            color: C.bg,
            cursor: updating ? "default" : "pointer",
            opacity: updating ? 0.6 : 1,
            whiteSpace: "nowrap",
          }}
        >
          {updating ? "Updating…" : "Apply update"}
        </button>
      ) : (
        <span
          style={{
            fontFamily: mono,
            fontSize: 9.5,
            letterSpacing: "0.05em",
            color: update?.error ? C.t3 : C.green,
            whiteSpace: "nowrap",
          }}
          title={update?.error}
        >
          {update ? (update.error ? "CHECK FAILED" : "UP TO DATE") : ""}
        </span>
      )}
    </div>
  );
}

function InstalledTab({ assistantId }: { assistantId: string }) {
  const { installed, isLoading } = useInstalled(assistantId);
  const [checking, setChecking] = useState(false);
  const updates = useUpdates(assistantId, checking);
  const applyUpdate = useApplyUpdate(assistantId);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  const updateFor = (skillId: string) =>
    updates.updates.find((u) => u.skillId === skillId);

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          marginTop: 16,
        }}
      >
        <MicroLabel>
          Installed from sources · {installed.length}
        </MicroLabel>
        <button
          type="button"
          disabled={updates.isLoading}
          onClick={() => {
            setChecking(true);
            void updates.refetch();
          }}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 11.5,
            padding: "6px 11px",
            borderRadius: 8,
            border: `1px solid ${C.line}`,
            background: C.surface,
            color: C.t1,
            cursor: "pointer",
          }}
        >
          <RefreshCw size={12} />
          {updates.isLoading ? "Checking…" : "Check for updates"}
        </button>
      </div>

      <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
        {isLoading ? (
          <Shimmer height={60} radius={12} />
        ) : installed.length === 0 ? (
          <div style={{ fontSize: 12.5, color: C.t3 }}>
            Nothing installed from marketplace sources yet — Explore has
            thousands of skills one consent card away.
          </div>
        ) : (
          installed.map((skill) => (
            <InstalledRow
              key={skill.skillId}
              skill={skill}
              update={updateFor(skill.skillId)}
              updating={updatingId === skill.skillId}
              onUpdate={() => {
                setUpdatingId(skill.skillId);
                applyUpdate.mutate(
                  {
                    path: { assistant_id: assistantId },
                    body: { skillId: skill.skillId, confirm: true },
                  },
                  {
                    onSettled: () => {
                      setUpdatingId(null);
                      void updates.refetch();
                    },
                  },
                );
              }}
            />
          ))
        )}
      </div>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export function MarketplacePage() {
  const hasHydrated = useAssistantFeatureFlagStore.use.hasHydrated();
  const marketplace = useAssistantFeatureFlagStore.use.marketplace();
  const assistantId = useActiveAssistantId();
  const isNarrow = useIsMobile();
  const [tab, setTab] = useState<TabKey>("explore");

  const { sources, isLoading: sourcesLoading } =
    useMarketplaceSources(assistantId);
  const enabledCount = useMemo(
    () => sources.filter((s) => s.enabled).length,
    [sources],
  );

  // Wait for the first real /feature-flags response before deciding to
  // redirect (same rule as PluginsPage) — never bounce a user who has the
  // flag on during the defaults window.
  if (!hasHydrated) return null;
  if (!marketplace) return <Navigate to={routes.skills} replace />;

  const tabs: Array<{ key: TabKey; label: string }> = [
    { key: "explore", label: "Explore" },
    { key: "sources", label: "Sources" },
    { key: "installed", label: "Installed" },
  ];

  return (
    <div style={{ minHeight: "100%", background: C.bg }}>
      <HqStyle />
      <div style={{ maxWidth: 1000, margin: "0 auto" }}>
        {/* Serif hero under the mono microlabel — projects-page DNA. */}
        <div style={{ paddingTop: isNarrow ? 4 : 8 }}>
          <MicroLabel>
            Skill marketplace · {enabledCount} source
            {enabledCount === 1 ? "" : "s"}
          </MicroLabel>
          <div
            style={{
              fontFamily: serif,
              fontSize: isNarrow ? 27 : 34,
              lineHeight: 1.05,
              color: C.ink,
              marginTop: 6,
            }}
          >
            Marketplace
          </div>
          <div style={{ fontSize: 13, color: C.t2, marginTop: 8, maxWidth: 560 }}>
            Skills from public GitHub sources, installed with hash-pinned
            locking and capability consent. Markdown instructions only —
            executable content never installs from third parties.
          </div>
        </div>

        <div style={{ display: "flex", gap: 6, marginTop: 16 }}>
          {tabs.map(({ key, label }) => (
            <Chip
              key={key}
              label={label}
              active={tab === key}
              onClick={() => setTab(key)}
            />
          ))}
        </div>

        <div style={{ paddingBottom: 60 }}>
          {tab === "explore" ? (
            <ExploreTab assistantId={assistantId} sources={sources} />
          ) : tab === "sources" ? (
            <SourcesTab
              assistantId={assistantId}
              sources={sources}
              isLoading={sourcesLoading}
            />
          ) : (
            <InstalledTab assistantId={assistantId} />
          )}
        </div>
      </div>
    </div>
  );
}
