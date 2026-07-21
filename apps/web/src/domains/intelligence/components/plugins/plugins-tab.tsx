/**
 * PluginsTab — the Plugins marketplace surface.
 *
 * MOBILE (spec frame 66): the mobile-v3 Plugins page (Explore / Installed +
 * the frame-67 detail sheet + frame-68 untrusted install). Branched in a thin
 * wrapper so the desktop body's hooks never change count across a breakpoint
 * flip.
 *
 * DESKTOP (spec W1, cue-web-parityplus.html): the serif-HQ marketplace — an
 * editorial hero, a left rail (curation filters + the "Submit a plugin" PR
 * path), registry search, and cards that carry the SOURCE REPO and an
 * official/community badge, linking to the W2 detail page.
 *
 * Honesty (the HTTP plugin surface is thinner than the design imagined):
 *  · `GET /v1/plugins/search` returns only name / path / source / description —
 *    no review-status, surface-type, or install-count. So the curation rail
 *    filters on the one axis derivable from `source.repo` (first-party
 *    `vellum-ai/*` = official vs community); surface-type and install-count
 *    filters are deliberately ABSENT rather than faked.
 *  · "Submit a plugin" is a doc-link PR path — the registry has no submit
 *    endpoint yet (NEEDS BACKEND), flagged on-frame.
 */
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";

import { isOfficialRepo } from "@/mobile-v3/you/plugin-detail-sheet";
import {
  pluginsGetOptions,
  pluginsSearchGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type {
  PluginsGetResponse,
  PluginsSearchGetResponse,
} from "@/generated/daemon/types.gen";
import { usePluginDrift } from "@/domains/intelligence/use-plugin-drift";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { Mv3PluginsPage } from "@/mobile-v3/you/plugins-page";
import { routes } from "@/utils/routes";

interface PluginsTabProps {
  assistantId: string;
}

type SearchMatch = PluginsSearchGetResponse["matches"][number];
type InstalledPlugin = PluginsGetResponse["plugins"][number];
type Curation = "all" | "official" | "community";

const CATALOG_STALE_MS = 5 * 60 * 1000;

/** Theme-aware serif-HQ palette (same `--mv1-*` layer the Skills grid uses). */
const C = {
  ink: "var(--mv1-ink)",
  blue: "var(--mv1-blue)",
  bg: "var(--mv1-canvas)",
  card: "var(--mv1-card)",
  line: "var(--mv1-line)",
  line2: "var(--mv1-line-strong)",
  t1: "var(--mv1-t1)",
  t2: "var(--mv1-t2)",
  t3: "var(--mv1-t3)",
  violet: "var(--mv1-violet)",
  violetWash: "var(--mv1-violet-strong)",
} as const;
const SERIF = "'Instrument Serif', Georgia, serif";
const MONO = "'DM Mono', ui-monospace, monospace";
const SUBMIT_DOCS_URL =
  "https://github.com/vellum-ai/vellum-assistant/tree/main/plugins";

function matches(query: string, ...fields: (string | null | undefined)[]) {
  if (!query) return true;
  return fields.some((f) => f?.toLowerCase().includes(query));
}

export function PluginsTab({ assistantId }: PluginsTabProps) {
  const isMobile = useIsMobile();
  if (isMobile) {
    return <Mv3PluginsPage assistantId={assistantId} />;
  }
  return <PluginsMarketplaceDesktop assistantId={assistantId} />;
}

function PluginsMarketplaceDesktop({ assistantId }: PluginsTabProps) {
  const [searchValue, setSearchValue] = useState("");
  const [curation, setCuration] = useState<Curation>("all");
  const query = searchValue.trim().toLowerCase();

  const installedQuery = useQuery({
    ...pluginsGetOptions({ path: { assistant_id: assistantId }, query: {} }),
    enabled: Boolean(assistantId),
    staleTime: CATALOG_STALE_MS,
  });
  const catalogQuery = useQuery({
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

  const allMatches = useMemo<SearchMatch[]>(
    () => catalogQuery.data?.matches ?? [],
    [catalogQuery.data?.matches],
  );
  const officialCount = allMatches.filter((m) =>
    isOfficialRepo(m.source.repo),
  ).length;
  const communityCount = allMatches.length - officialCount;

  const catalogMatches = useMemo<SearchMatch[]>(() => {
    return allMatches.filter((m) => {
      if (installedNames.has(m.name)) return false;
      if (!matches(query, m.name, m.description, m.source.repo)) return false;
      if (curation === "all") return true;
      const official = isOfficialRepo(m.source.repo);
      return curation === "official" ? official : !official;
    });
  }, [allMatches, installedNames, query, curation]);

  const visibleInstalled = useMemo(
    () => installed.filter((p) => matches(query, p.name, p.description)),
    [installed, query],
  );

  const registryTotal = allMatches.length;
  const isSearching =
    (catalogQuery.isFetching && !catalogQuery.isLoading) ||
    (installedQuery.isFetching && !installedQuery.isLoading);

  return (
    <div
      style={{
        fontFamily: "'DM Sans', system-ui, sans-serif",
        color: C.t1,
        padding: "0 0 24px",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        height: "100%",
      }}
    >
      {/* ── Editorial hero ───────────────────────────────────────────── */}
      <div
        style={{
          position: "relative",
          overflow: "hidden",
          background: C.ink,
          borderRadius: 16,
          padding: "20px 24px",
          marginBottom: 16,
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "radial-gradient(340px 160px at 90% 50%,rgba(127,119,221,.26),transparent 70%)",
          }}
        />
        <div style={{ position: "relative" }}>
          <div
            style={{
              fontFamily: SERIF,
              fontSize: 24,
              color: C.t1,
              letterSpacing: "-.2px",
              lineHeight: 1.2,
            }}
          >
            The plugin registry —{" "}
            <span style={{ fontStyle: "italic", color: C.violetWash }}>
              pinned, reviewed, reversible
            </span>
            .
          </div>
          <div style={{ fontSize: 13, color: C.t2, marginTop: 5 }}>
            Every reviewed plugin is pinned to a commit and can be uninstalled
            anytime. Plugins add tools, hooks, and app surfaces to your
            assistant.
          </div>
        </div>
      </div>

      {/* ── Rail + cards ─────────────────────────────────────────────── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "240px 1fr",
          gap: 18,
          flex: 1,
          minHeight: 0,
        }}
      >
        <div style={{ overflowY: "auto" }}>
          <CurationRail
            curation={curation}
            onSelect={setCuration}
            total={registryTotal}
            official={officialCount}
            community={communityCount}
          />
          <SubmitPluginCard />
        </div>

        <div style={{ minWidth: 0, overflowY: "auto", paddingRight: 4 }}>
          {/* Search */}
          <div
            style={{
              border: `1px solid ${C.line2}`,
              borderRadius: 11,
              padding: "0 14px",
              display: "flex",
              alignItems: "center",
              gap: 9,
              marginBottom: 16,
            }}
          >
            <span aria-hidden style={{ fontSize: 13, color: C.t3 }}>
              🔍
            </span>
            <input
              type="search"
              value={searchValue}
              onChange={(e) => setSearchValue(e.target.value)}
              placeholder={
                registryTotal > 0
                  ? `Search ${registryTotal} plugins`
                  : "Search plugins"
              }
              aria-label="Search plugins"
              style={{
                flex: 1,
                border: "none",
                outline: "none",
                background: "transparent",
                fontSize: 14,
                color: C.t1,
                padding: "11px 0",
                fontFamily: "inherit",
              }}
            />
            {isSearching && (
              <Loader2 className="size-4 animate-spin" color={C.t3} />
            )}
          </div>

          {/* Installed */}
          {visibleInstalled.length > 0 ? (
            <>
              <SectionLabel>Installed</SectionLabel>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                  marginBottom: 22,
                }}
              >
                {visibleInstalled.map((p) => (
                  <InstalledCard
                    key={p.id}
                    assistantId={assistantId}
                    plugin={p}
                  />
                ))}
              </div>
            </>
          ) : null}

          {/* Explore */}
          <SectionLabel>Explore the registry</SectionLabel>
          {catalogQuery.isLoading ? (
            <LoadingRows />
          ) : catalogQuery.isError ? (
            <EmptyCard
              title="Couldn't load the registry"
              body="Registry browsing is temporarily unavailable. Installed plugins are still listed above."
            />
          ) : catalogMatches.length === 0 ? (
            <EmptyCard
              title={query ? "No plugins match" : "Nothing to explore"}
              body={
                query
                  ? "Try a different search term or clear the curation filter."
                  : "No plugins in this filter."
              }
            />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {catalogMatches.map((m) => (
                <CatalogCard key={m.name} match={m} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────── Left rail ───────────────────────────────── */

function CurationRail({
  curation,
  onSelect,
  total,
  official,
  community,
}: {
  curation: Curation;
  onSelect: (c: Curation) => void;
  total: number;
  official: number;
  community: number;
}) {
  const items: { value: Curation; label: string; count: number }[] = [
    { value: "all", label: "All plugins", count: total },
    { value: "official", label: "Cue official", count: official },
    { value: "community", label: "Community", count: community },
  ];
  return (
    <div style={{ marginBottom: 18 }}>
      <SectionLabel>Curation</SectionLabel>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {items.map((it) => {
          const active = curation === it.value;
          return (
            <button
              key={it.value}
              type="button"
              onClick={() => onSelect(it.value)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                textAlign: "left",
                background: active ? C.bg : "transparent",
                border: "none",
                borderRadius: 9,
                padding: "9px 12px",
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 13.5,
                color: active ? C.t1 : C.t2,
                fontWeight: active ? 600 : 400,
              }}
            >
              <span style={{ flex: 1, minWidth: 0 }}>{it.label}</span>
              <span style={{ fontSize: 12, color: C.t3 }}>{it.count}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SubmitPluginCard() {
  return (
    <div
      style={{
        border: `1px solid ${C.line}`,
        borderRadius: 12,
        background: C.card,
        padding: "14px 15px",
      }}
    >
      <div
        style={{
          fontFamily: SERIF,
          fontSize: 16,
          color: C.t1,
          letterSpacing: "-.1px",
        }}
      >
        Submit a plugin
      </div>
      <div
        style={{ fontSize: 12.5, color: C.t2, marginTop: 4, lineHeight: 1.5 }}
      >
        Community plugins are added by pull request against the registry — the
        license and manifest are verified and the entry is pinned to a commit.
      </div>
      <a
        href={SUBMIT_DOCS_URL}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          marginTop: 11,
          fontSize: 12.5,
          color: C.blue,
          textDecoration: "none",
          fontWeight: 500,
        }}
      >
        Open the PR guide ↗
      </a>
      <div
        style={{
          fontFamily: MONO,
          fontSize: 9.5,
          letterSpacing: ".08em",
          textTransform: "uppercase",
          color: C.t3,
          marginTop: 9,
        }}
      >
        Needs backend · no submit endpoint yet
      </div>
    </div>
  );
}

/* ───────────────────────────────── Cards ─────────────────────────────────── */

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontFamily: MONO,
        fontSize: 11,
        letterSpacing: ".1em",
        textTransform: "uppercase",
        color: C.t3,
        marginBottom: 11,
      }}
    >
      {children}
    </div>
  );
}

function Badge({ official }: { official: boolean }) {
  return (
    <span
      style={{
        fontFamily: MONO,
        fontSize: 9.5,
        letterSpacing: ".05em",
        textTransform: "uppercase",
        color: official ? C.blue : C.t3,
        background: official
          ? "color-mix(in srgb, var(--mv1-blue) 12%, transparent)"
          : C.bg,
        borderRadius: 5,
        padding: "2px 7px",
        flexShrink: 0,
      }}
    >
      {official ? "Official" : "Community"}
    </span>
  );
}

function cardShell(): React.CSSProperties {
  return {
    display: "block",
    border: `1px solid ${C.line}`,
    borderRadius: 13,
    background: C.card,
    padding: "14px 16px",
    textDecoration: "none",
    color: "inherit",
  };
}

function PluginGlyph() {
  return (
    <span
      aria-hidden
      style={{
        width: 38,
        height: 38,
        borderRadius: 11,
        background: "color-mix(in srgb, var(--mv1-violet) 16%, transparent)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 18,
        flexShrink: 0,
      }}
    >
      🧩
    </span>
  );
}

function CatalogCard({ match }: { match: SearchMatch }) {
  const official = isOfficialRepo(match.source.repo);
  return (
    <Link to={routes.plugin(match.name)} title={match.path} style={cardShell()}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <PluginGlyph />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span style={{ fontSize: 15, fontWeight: 600, color: C.t1 }}>
              {match.name}
            </span>
            <Badge official={official} />
          </div>
          <div
            style={{
              fontFamily: MONO,
              fontSize: 11,
              color: C.t3,
              marginTop: 3,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {match.source.repo}
          </div>
        </div>
      </div>
      {match.description ? (
        <div
          style={{
            fontSize: 12.5,
            color: C.t2,
            marginTop: 10,
            lineHeight: 1.5,
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {match.description}
        </div>
      ) : null}
    </Link>
  );
}

function InstalledCard({
  assistantId,
  plugin,
}: {
  assistantId: string;
  plugin: InstalledPlugin;
}) {
  const drift = usePluginDrift({
    assistantId,
    name: plugin.name,
    enabled: true,
  });
  const updateAvailable = drift.data?.status === "update-available";
  const official = isOfficialRepo(
    drift.data?.remote?.repo ?? drift.data?.local?.source?.repo,
  );
  return (
    <Link to={routes.plugin(plugin.name)} style={cardShell()}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <PluginGlyph />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 15, fontWeight: 600, color: C.t1 }}>
              {plugin.name}
            </span>
            {drift.data ? <Badge official={official} /> : null}
            {plugin.version ? (
              <span style={{ fontSize: 12, color: C.t3 }}>
                v{plugin.version}
              </span>
            ) : null}
            {updateAvailable ? (
              <span
                style={{
                  fontFamily: MONO,
                  fontSize: 9.5,
                  letterSpacing: ".05em",
                  textTransform: "uppercase",
                  color: "var(--mv1-violet)",
                  background:
                    "color-mix(in srgb, var(--mv1-violet) 14%, transparent)",
                  borderRadius: 5,
                  padding: "2px 7px",
                }}
              >
                Update available
              </span>
            ) : null}
          </div>
          {plugin.description ? (
            <div
              style={{
                fontSize: 12.5,
                color: C.t2,
                marginTop: 3,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {plugin.description}
            </div>
          ) : null}
        </div>
        <span style={{ color: C.t3, fontSize: 18 }} aria-hidden>
          ›
        </span>
      </div>
    </Link>
  );
}

function LoadingRows() {
  return (
    <div
      style={{ display: "flex", flexDirection: "column", gap: 10 }}
      aria-hidden
    >
      {Array.from({ length: 4 }).map((_, i) => (
        <div
          key={i}
          style={{
            height: 72,
            borderRadius: 13,
            background:
              "linear-gradient(90deg,#EEF1F6 0%,#E2E7EF 50%,#EEF1F6 100%)",
            backgroundSize: "340px 100%",
            animation: "cueShimmer 1.3s linear infinite",
          }}
        />
      ))}
    </div>
  );
}

function EmptyCard({ title, body }: { title: string; body: string }) {
  return (
    <div
      style={{
        border: `1px solid ${C.line}`,
        borderRadius: 13,
        background: C.card,
        padding: "40px 24px",
        textAlign: "center",
      }}
    >
      <div
        style={{ fontSize: 24, marginBottom: 8, color: C.violet }}
        aria-hidden
      >
        🧩
      </div>
      <div style={{ fontSize: 15, fontWeight: 600, color: C.t1 }}>{title}</div>
      <p
        style={{
          fontSize: 13,
          color: C.t2,
          marginTop: 4,
          maxWidth: 360,
          marginInline: "auto",
        }}
      >
        {body}
      </p>
    </div>
  );
}
