/**
 * Skill Marketplace — Explore / Sources / Installed over GitHub-ingested
 * SKILL.md sources (WS1, Kortix execution brief §3).
 *
 * Visual language: the "reviewed before they run" design book — a dark ink
 * hero with a serif headline + right-aligned live skill/source count,
 * underline tabs (count badge on Installed), pill source filters, and skill
 * cards that attribute their source (github-mark · owner/repo) and surface
 * capability chips (● connector/network · ▲ secret/elevated) before an
 * Install button. Every install still routes through the explicit
 * capability-consent modal; updates stay diff-then-confirm — never silent.
 *
 * Bound to live data throughout: hero counts, "Search N skills", the
 * Installed badge, and the INSTALLED card state all read the real daemon
 * responses — no hardcoded demo numbers.
 *
 * Gated by the `marketplace` assistant feature flag: the Intelligence tab
 * only renders with the flag on, and this page redirects to Skills when a
 * deep-link lands with the flag off (same pattern as PluginsPage).
 */

import { Check, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
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

/** GitHub mark (the octocat glyph the mock uses for source attribution). */
function GithubMark({
  size = 10,
  color = C.t3,
}: {
  size?: number;
  color?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={color}
      aria-hidden
      style={{ flexShrink: 0 }}
    >
      <path d="M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.3-3.4-1.3-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.6 2.4 1.1 3 .9.1-.7.4-1.1.6-1.4-2.2-.3-4.6-1.1-4.6-5a4 4 0 0 1 1-2.7c-.1-.3-.4-1.3.1-2.7 0 0 .8-.3 2.7 1a9.4 9.4 0 0 1 5 0c1.9-1.3 2.7-1 2.7-1 .5 1.4.2 2.4.1 2.7a4 4 0 0 1 1 2.7c0 3.9-2.3 4.7-4.6 5 .4.3.7 1 .7 2v2.9c0 .3.2.6.7.5A10 10 0 0 0 12 2Z" />
    </svg>
  );
}

/** Pill filter, HQ voice — active = dark ink fill (matches the mock chips). */
function Pill({
  label,
  active = false,
  onClick,
}: {
  label: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        fontFamily: "inherit",
        fontSize: 12,
        fontWeight: 500,
        color: active ? C.bg : C.t2,
        background: active ? C.ink : C.surface,
        border: `1px solid ${active ? C.ink : C.line}`,
        borderRadius: 999,
        padding: "5px 13px",
        whiteSpace: "nowrap",
        cursor: onClick ? "pointer" : "default",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
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
        fontSize: 10,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        color: C.t3,
        margin: "20px 0 10px",
      }}
    >
      {children}
    </div>
  );
}

// ─── Capability chips ────────────────────────────────────────────────────────

type Cap = { glyph: string; label: string; elevated: boolean };

/**
 * Derive the mock's capability chips from `item.capabilities`. Secrets are
 * marked with a ▲ (triangle → elevated/secret); connectors and network get a
 * ● (dot). Writes fold into the dot bucket too.
 */
function capChips(caps: MarketplaceItem["capabilities"]): Cap[] {
  const chips: Cap[] = [];
  for (const label of caps.connectors)
    chips.push({ glyph: "●", label, elevated: false });
  for (const label of caps.network)
    chips.push({ glyph: "●", label, elevated: false });
  for (const label of caps.writes)
    chips.push({ glyph: "●", label, elevated: false });
  for (const label of caps.secrets)
    chips.push({ glyph: "▲", label, elevated: true });
  return chips;
}

function CapChip({ cap }: { cap: Cap }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontFamily: mono,
        fontSize: 9.5,
        background: C.sunken,
        border: `1px solid ${C.line}`,
        color: cap.elevated ? C.amber : C.t2,
        padding: "3px 8px",
        borderRadius: 6,
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ color: cap.elevated ? C.amber : C.violet }}>
        {cap.glyph}
      </span>
      {cap.label}
    </span>
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
  const chips = capChips(item.capabilities);
  return (
    <div
      style={{
        padding: 15,
        border: `1px solid ${C.line}`,
        borderRadius: 14,
        background: C.surface,
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 11 }}>
        <span
          aria-hidden
          style={{
            width: 40,
            height: 40,
            borderRadius: 11,
            display: "grid",
            placeItems: "center",
            fontSize: 20,
            background: C.sunken,
            flexShrink: 0,
          }}
        >
          {item.emoji ?? "🧩"}
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              fontSize: 14.5,
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
          {/* Source attribution on every card (github-mark · owner/repo). */}
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              fontFamily: mono,
              fontSize: 10,
              color: C.t3,
              marginTop: 3,
              maxWidth: "100%",
              overflow: "hidden",
            }}
          >
            <GithubMark size={10} color={C.t3} />
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {item.source}
              {item.license ? ` · ${item.license}` : ""}
            </span>
          </div>
        </div>
      </div>

      <div
        style={{
          fontSize: 12.5,
          lineHeight: 1.5,
          color: C.t2,
          marginTop: 11,
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
          flex: 1,
        }}
      >
        {item.description}
      </div>

      {chips.length > 0 ? (
        <div
          style={{
            display: "flex",
            gap: 6,
            flexWrap: "wrap",
            marginTop: 12,
          }}
        >
          {chips.map((cap, i) => (
            <CapChip key={`${cap.label}-${i}`} cap={cap} />
          ))}
        </div>
      ) : null}

      {item.installed ? (
        <span
          style={{
            marginTop: 13,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            fontFamily: mono,
            fontSize: 11,
            letterSpacing: "0.06em",
            color: C.green,
            background: `color-mix(in srgb, ${C.green} 9%, transparent)`,
            border: `1px solid color-mix(in srgb, ${C.green} 28%, transparent)`,
            borderRadius: 10,
            padding: 9,
            width: "100%",
          }}
        >
          <Check size={13} /> INSTALLED
        </span>
      ) : (
        <button
          type="button"
          disabled={installing}
          onClick={onInstall}
          style={{
            marginTop: 13,
            fontFamily: "inherit",
            fontSize: 13,
            fontWeight: 500,
            color: C.bg,
            background: C.violetS,
            border: "none",
            borderRadius: 10,
            padding: 9,
            width: "100%",
            cursor: installing ? "default" : "pointer",
            opacity: installing ? 0.6 : 1,
          }}
        >
          {installing ? "Preparing…" : "Install"}
        </button>
      )}
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
        background: "rgba(20,28,40,.55)",
        backdropFilter: "blur(3px)",
        display: "grid",
        placeItems: "center",
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(440px, 100%)",
          maxHeight: "82vh",
          overflowY: "auto",
          background: C.bg,
          border: `1px solid ${C.line}`,
          borderRadius: 18,
          boxShadow: "0 40px 90px -30px rgba(0,0,0,.6)",
          padding: "22px 24px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span
            aria-hidden
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              display: "grid",
              placeItems: "center",
              fontSize: 22,
              background: C.sunken,
              flexShrink: 0,
            }}
          >
            {plan.item?.emoji ?? "🧩"}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: C.t1 }}>
              {plan.item?.displayName ?? plan.skillId}
            </div>
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                fontFamily: mono,
                fontSize: 10.5,
                color: C.t3,
                marginTop: 2,
              }}
            >
              <GithubMark size={10} color={C.t3} />
              {plan.item?.source}
              {plan.item?.license ? ` · ${plan.item.license}` : ""}
            </div>
          </div>
        </div>

        <div
          style={{
            marginTop: 16,
            padding: "12px 14px",
            borderRadius: 11,
            background: C.sunken,
            border: `1px solid ${C.line}`,
            fontSize: 12.5,
            lineHeight: 1.5,
            color: C.t2,
            display: "flex",
            gap: 9,
          }}
        >
          <span style={{ color: C.violet, flexShrink: 0 }}>✦</span>
          {plan.notice}
        </div>

        {declared.length > 0 ? (
          <>
            <div
              style={{
                fontFamily: mono,
                fontSize: 10,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                color: C.t3,
                margin: "18px 0 9px",
              }}
            >
              This skill can access
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {declared.map(([label, values]) => {
                const elevated = label === "Secrets";
                return (
                  <div
                    key={label}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      border: `1px solid ${C.line}`,
                      borderRadius: 10,
                      padding: "10px 12px",
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        width: 26,
                        height: 26,
                        borderRadius: 7,
                        display: "grid",
                        placeItems: "center",
                        fontSize: 12,
                        flexShrink: 0,
                        color: elevated ? C.amber : C.violet,
                        background: `color-mix(in srgb, ${elevated ? C.amber : C.violet} 12%, transparent)`,
                      }}
                    >
                      {elevated ? "▲" : "●"}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{ fontSize: 13, fontWeight: 500, color: C.t1 }}
                      >
                        {label}
                      </div>
                      <div style={{ fontSize: 11.5, color: C.t3 }}>
                        {values.join(", ")}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        ) : null}

        <SectionLabel>Files to install · {files.length}</SectionLabel>
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
          <div style={{ fontSize: 12, color: C.dangerText, marginTop: 12 }}>
            {error}
          </div>
        ) : null}

        <div style={{ display: "flex", gap: 9, marginTop: 20 }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              flex: 1,
              fontFamily: "inherit",
              fontSize: 13.5,
              fontWeight: 500,
              padding: 12,
              borderRadius: 11,
              border: `1px solid ${C.line}`,
              background: C.surface,
              color: C.t2,
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
              flex: 1.4,
              fontFamily: "inherit",
              fontSize: 13.5,
              fontWeight: 500,
              padding: 12,
              borderRadius: 11,
              border: "none",
              background: C.violetS,
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
  perSource,
  totalItems,
  onBrowseSources,
}: {
  assistantId: string;
  perSource: ReturnType<typeof useSourceItems>;
  totalItems: number;
  onBrowseSources: () => void;
}) {
  const isNarrow = useIsMobile();
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<string | null>(null);
  const install = useInstallSkill(assistantId);
  const [plan, setPlan] = useState<InstallResponse | null>(null);
  const [pendingItemId, setPendingItemId] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);

  const needle = query.trim().toLowerCase();
  const anyLoading = perSource.some((group) => group.isLoading);
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
        gap: isNarrow ? 9 : 12,
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
      {/* Search — placeholder counts the real indexed skills. */}
      <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            gap: 9,
            border: `1px solid ${C.line}`,
            borderRadius: 11,
            padding: "10px 14px",
            background: C.surface,
          }}
        >
          <Search size={15} color={C.t3} style={{ flexShrink: 0 }} />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${totalItems} skill${totalItems === 1 ? "" : "s"}`}
            aria-label="Search skills"
            style={{
              flex: 1,
              fontSize: 14,
              fontFamily: "inherit",
              border: "none",
              background: "transparent",
              color: C.t1,
              outline: "none",
              minWidth: 0,
            }}
          />
        </div>
      </div>

      {/* Per-source filter pills — counts land as each source resolves. */}
      <div
        style={{
          display: "flex",
          gap: 7,
          flexWrap: "wrap",
          marginTop: 12,
        }}
      >
        <Pill
          label="All"
          active={sourceFilter === null}
          onClick={() => setSourceFilter(null)}
        />
        {perSource.map(({ source, items, isLoading }) => (
          <Pill
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
        <div style={{ fontSize: 12, color: C.dangerText, marginTop: 12 }}>
          {installError}
        </div>
      ) : null}

      {/* First run: no sources resolved to any skills yet, nothing loading.
          Rather than a bare search box over blank space, invite the user to
          add a source — the real action that fills this tab. */}
      {!anyLoading && totalItems === 0 && !needle ? (
        <ExploreEmptyState onBrowseSources={onBrowseSources} />
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
                gap: 12,
              }}
            >
              <Shimmer height={150} radius={14} />
              <Shimmer height={150} radius={14} />
              <Shimmer height={150} radius={14} />
            </div>
          ) : group.isError ? (
            <div style={{ fontSize: 12.5, color: C.t3 }}>
              Couldn’t index this source just now — it stays cached for 24h once
              it loads.
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

/**
 * First-run empty state for Explore. Names the space, one calm line, one CTA
 * that jumps to the Sources tab — the real action that populates this tab.
 */
function ExploreEmptyState({
  onBrowseSources,
}: {
  onBrowseSources: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        textAlign: "center",
        gap: 14,
        padding: "56px 24px",
        border: `1px solid ${C.line}`,
        borderRadius: 14,
        background: C.surface,
        marginTop: 20,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 48,
          height: 48,
          borderRadius: 13,
          background: C.sunken,
          display: "grid",
          placeItems: "center",
          fontSize: 24,
        }}
      >
        🧩
      </span>
      <div
        style={{
          fontFamily: serif,
          fontSize: 22,
          letterSpacing: "-0.2px",
          color: C.t1,
        }}
      >
        Find skills worth running
      </div>
      <p
        style={{
          fontSize: 13,
          color: C.t2,
          lineHeight: 1.6,
          maxWidth: 380,
          margin: 0,
        }}
      >
        Skills come from GitHub sources you trust. Add one and Cue indexes it,
        then shows you exactly what each skill can touch before it runs.
      </p>
      <button
        type="button"
        onClick={onBrowseSources}
        style={{
          fontFamily: "inherit",
          fontSize: 13,
          fontWeight: 500,
          color: C.bg,
          background: C.ink,
          border: "none",
          borderRadius: 10,
          padding: "10px 18px",
          cursor: "pointer",
        }}
      >
        Add a source
      </button>
    </div>
  );
}

// ─── Sources tab ─────────────────────────────────────────────────────────────

function SourcesTab({
  assistantId,
  sources,
  isLoading,
  countFor,
}: {
  assistantId: string;
  sources: MarketplaceSource[];
  isLoading: boolean;
  countFor: (address: string) => number | null;
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
    <div style={{ marginTop: 16 }}>
      {/* Add-a-source banner — dashed card w/ github mark, per the mock. */}
      <div
        style={{
          border: `1px dashed ${C.line2}`,
          borderRadius: 13,
          padding: 16,
          display: "flex",
          alignItems: "center",
          gap: 13,
          flexWrap: "wrap",
          background: C.sunken,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 38,
            height: 38,
            borderRadius: 10,
            background: C.ink,
            display: "grid",
            placeItems: "center",
            flexShrink: 0,
          }}
        >
          <GithubMark size={20} color={C.bg} />
        </span>
        <div style={{ flex: "1 1 200px", minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: C.t1 }}>
            Add a GitHub source
          </div>
          <div style={{ fontSize: 12.5, color: C.t2 }}>
            Paste any public repo of skills — Cue indexes it and streams new
            capabilities in.
          </div>
        </div>
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="owner/repo"
          aria-label="Source repository address"
          style={{
            flex: "1 1 200px",
            minWidth: 180,
            fontSize: 12,
            fontFamily: mono,
            padding: "9px 13px",
            borderRadius: 10,
            border: `1px solid ${C.line}`,
            background: C.bg,
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
            fontFamily: "inherit",
            fontSize: 13,
            fontWeight: 500,
            padding: "10px 18px",
            borderRadius: 10,
            border: "none",
            background: C.ink,
            color: C.bg,
            cursor: addSource.isPending ? "default" : "pointer",
            opacity: addSource.isPending ? 0.6 : 1,
            flexShrink: 0,
          }}
        >
          <Plus size={13} />
          {addSource.isPending ? "Verifying…" : "Add source"}
        </button>
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
          {sources.map((source) => {
            const count = countFor(source.address);
            return (
              <div
                key={source.address}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "12px 15px",
                  border: `1px solid ${C.line}`,
                  borderRadius: 12,
                  background: C.surface,
                  opacity: source.enabled ? 1 : 0.55,
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 9,
                    background: C.sunken,
                    border: `1px solid ${C.line}`,
                    display: "grid",
                    placeItems: "center",
                    flexShrink: 0,
                  }}
                >
                  <GithubMark size={16} color={C.ink} />
                </span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div
                    style={{
                      fontSize: 13.5,
                      fontWeight: 600,
                      fontFamily: mono,
                      color: C.t1,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {source.label ?? source.address}
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      color: C.t2,
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
                    {!source.enabled ? " · disabled" : ""}
                  </div>
                </div>
                {count != null ? (
                  <span
                    style={{
                      fontFamily: mono,
                      fontSize: 11,
                      color: C.t3,
                      flexShrink: 0,
                    }}
                  >
                    {count} skill{count === 1 ? "" : "s"}
                  </span>
                ) : null}
                {source.builtIn ? (
                  <span
                    style={{
                      fontFamily: mono,
                      fontSize: 9.5,
                      color: C.blueS,
                      background: C.blueW,
                      padding: "3px 8px",
                      borderRadius: 6,
                      flexShrink: 0,
                    }}
                  >
                    OFFICIAL
                  </span>
                ) : null}
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
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    fontFamily: "inherit",
                    fontSize: 12,
                    padding: "7px 12px",
                    borderRadius: 8,
                    border: `1px solid color-mix(in srgb, ${C.danger} 26%, transparent)`,
                    background: C.surface,
                    color: C.danger,
                    cursor:
                      removeSource.isPending || !source.enabled
                        ? "default"
                        : "pointer",
                    opacity: !source.enabled ? 0.5 : 1,
                    flexShrink: 0,
                  }}
                >
                  <Trash2 size={12} />
                  Remove
                </button>
              </div>
            );
          })}
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
      <span
        aria-hidden
        style={{
          width: 9,
          height: 9,
          borderRadius: "50%",
          background: hasUpdate ? C.amber : C.green,
          flexShrink: 0,
        }}
      />
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
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                fontFamily: mono,
                fontSize: 9.5,
                color: C.amber,
                background: `color-mix(in srgb, ${C.amber} 12%, transparent)`,
                borderRadius: 6,
                padding: "3px 8px",
                whiteSpace: "nowrap",
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 5,
                  height: 5,
                  borderRadius: "50%",
                  background: C.amber,
                }}
              />
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
            fontFamily: "inherit",
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

function InstalledTab({
  assistantId,
  installed,
  isLoading,
}: {
  assistantId: string;
  installed: InstalledSkill[];
  isLoading: boolean;
}) {
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
        <MicroLabel>Installed from sources · {installed.length}</MicroLabel>
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
            fontFamily: "inherit",
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
  // Explore streams per source — lift it to the page so the hero count,
  // "Search N skills", and per-source counts all read the same live data.
  const perSource = useSourceItems(assistantId, sources);
  const { installed, isLoading: installedLoading } = useInstalled(assistantId);

  const enabledCount = useMemo(
    () => sources.filter((s) => s.enabled).length,
    [sources],
  );
  const totalItems = useMemo(
    () => perSource.reduce((sum, group) => sum + group.items.length, 0),
    [perSource],
  );
  const countFor = (address: string): number | null => {
    const group = perSource.find((g) => g.source.address === address);
    if (!group || group.isLoading) return null;
    return group.items.length;
  };

  // Wait for the first real /feature-flags response before deciding to
  // redirect (same rule as PluginsPage) — never bounce a user who has the
  // flag on during the defaults window.
  if (!hasHydrated) return null;
  if (!marketplace) return <Navigate to={routes.skills} replace />;

  const tabs: Array<{ key: TabKey; label: string; badge?: number }> = [
    { key: "explore", label: "Explore" },
    { key: "sources", label: "Sources" },
    { key: "installed", label: "Installed", badge: installed.length },
  ];

  return (
    <div style={{ minHeight: "100%", background: C.bg }}>
      <HqStyle />
      <div
        style={{
          maxWidth: 1000,
          margin: "0 auto",
          padding: isNarrow ? "8px 14px 60px" : "8px 0 60px",
        }}
      >
        {/* Dark ink hero: serif headline + right-aligned live skill/source count. */}
        <div
          style={{
            position: "relative",
            overflow: "hidden",
            background: C.ink,
            borderRadius: 16,
            padding: isNarrow ? "18px 18px" : "20px 24px",
            marginBottom: 16,
            display: "flex",
            alignItems: "center",
            gap: 22,
            flexWrap: isNarrow ? "wrap" : "nowrap",
          }}
        >
          <div
            aria-hidden
            style={{
              position: "absolute",
              inset: 0,
              background:
                "radial-gradient(340px 160px at 90% 50%, color-mix(in srgb, var(--mv1-violet) 42%, transparent), transparent 70%)",
            }}
          />
          <div style={{ position: "relative", flex: 1, minWidth: 220 }}>
            <div
              style={{
                fontFamily: serif,
                fontSize: isNarrow ? 22 : 24,
                // `C.ink` is `--mv1-t1` — the primary TEXT token, used here as
                // the hero's background. That inverts with the theme: in light
                // themes t1 is dark so a hardcoded "#fff" headline read fine,
                // but under the dark book t1 resolves light, the panel turns
                // white, and white-on-white measured 1.04:1 — "New skills,"
                // was invisible and the hero read as a lowercase fragment.
                // `C.bg` is the canvas, so it contrasts with `C.ink` by
                // construction in whichever direction the theme points.
                color: C.bg,
                letterSpacing: "-0.2px",
                lineHeight: 1.2,
              }}
            >
              New skills,{" "}
              <span style={{ fontStyle: "italic", color: "#B7B0F0" }}>
                reviewed before they run.
              </span>
            </div>
            <div style={{ fontSize: 13, color: "#AEB7C7", marginTop: 5 }}>
              Install capabilities from trusted GitHub sources. Cue shows you
              exactly what each one can touch — before it can act.
            </div>
          </div>
          <div
            style={{
              position: "relative",
              display: "flex",
              flexDirection: "column",
              gap: 7,
              flexShrink: 0,
              textAlign: "center",
            }}
          >
            <span
              style={{
                fontFamily: mono,
                fontSize: 22,
                // Same inversion as the headline above — this sits on the same
                // `C.ink` hero, so it needs the canvas colour, not a hardcoded
                // white that only survives one of the two themes.
                color: C.bg,
                fontWeight: 500,
              }}
            >
              {totalItems}
            </span>
            <span
              style={{
                fontFamily: mono,
                fontSize: 10.5,
                color: "#9DB4E6",
              }}
            >
              skills · {enabledCount} source{enabledCount === 1 ? "" : "s"}
            </span>
          </div>
        </div>

        {/* Underline tabs — count badge on Installed reads live data. */}
        <div
          style={{
            display: "flex",
            gap: 4,
            borderBottom: `1px solid ${C.line}`,
            marginBottom: 4,
          }}
        >
          {tabs.map(({ key, label, badge }) => {
            const active = tab === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                style={{
                  border: "none",
                  background: "none",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  fontSize: 13.5,
                  fontWeight: active ? 600 : 500,
                  color: active ? C.t1 : C.t3,
                  padding: "6px 4px 12px",
                  marginRight: 16,
                  borderBottom: `2px solid ${active ? C.ink : "transparent"}`,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 7,
                }}
              >
                {label}
                {badge != null ? (
                  <span
                    style={{
                      fontFamily: mono,
                      fontSize: 10,
                      background: C.sunken,
                      color: C.t2,
                      padding: "2px 6px",
                      borderRadius: 5,
                    }}
                  >
                    {badge}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>

        <div>
          {tab === "explore" ? (
            <ExploreTab
              assistantId={assistantId}
              perSource={perSource}
              totalItems={totalItems}
              onBrowseSources={() => setTab("sources")}
            />
          ) : tab === "sources" ? (
            <SourcesTab
              assistantId={assistantId}
              sources={sources}
              isLoading={sourcesLoading}
              countFor={countFor}
            />
          ) : (
            <InstalledTab
              assistantId={assistantId}
              installed={installed}
              isLoading={installedLoading}
            />
          )}
        </div>
      </div>
    </div>
  );
}
