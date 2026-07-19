import { Loader2, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { ConnectorAppLogo } from "@/components/connector-app-logo";
import {
  connectorappsConnectPostMutation,
  connectorappsGetOptions,
  connectorappsGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { ConnectorappsGetResponses } from "@/generated/daemon/types.gen";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { Mv3ConnectionsPage } from "@/mobile-v3/you/connections-page";
import { connectorsAvailable } from "@/runtime/connectors";
import { routes } from "@/utils/routes";
import { haptic } from "@/utils/haptics";

/**
 * Tools & Apps (Connectors) — design-matched to surfaces/Connectors.dc.html,
 * wired to the daemon's Composio connector-apps catalog. An editorial dark
 * progress hero ("the more Cue connects, the more it can do for you"), a tip
 * banner, a search + filter row, Connected rows (CONNECTED pill + Manage →
 * ConnectorDetail on desktop installs), a single-column Available list with
 * Enable buttons, and the MCP-servers footer.
 *
 * DATA SOURCE: `GET /v1/connector-apps` — the SAME daemon route (and the same
 * `connected` filter) the command-center Integrations tile and the onboarding
 * connect grid use, so the connected count here always matches the tile.
 * (This page previously read the Electron-local `window.vellum.connectors`
 * IPC, whose catalog + Composio identity belonged to the local install — a
 * different universe than the daemon the tile queried, so the two counts
 * disagreed.) The Electron IPC remains only as the gate for the per-tool
 * Manage surface, which is desktop-specific.
 *
 * THEME + MOBILE: colours come from the theme-aware `--mv1-*` token layer
 * (`index.css`) instead of a hardcoded light palette, so the page follows the
 * active theme like every other screen (it used to render light-on-dark in the
 * dark app shell). On narrow viewports (`useIsMobile`) the hero stacks the
 * headline above a full-width action row, the native `<select>` is swapped for
 * a horizontal-scroll category chip rail, search goes full-width, and connector
 * rows adopt 44px tap targets with press/haptic feedback — matching the "You"
 * (`channels-agents-page`) and Memory mobile screens.
 *
 * The dark nav + intelligence tab bar are provided by IntelligenceLayout — not
 * rebuilt here.
 */

type ConnectorApp = ConnectorappsGetResponses[200]["apps"][number];

/**
 * Theme-aware palette — every slot maps to a `--mv1-*` custom property so the
 * page resolves to the dark-v1 book hexes under dark/velvet and to the semantic
 * light tokens in light (see `index.css`). `heroBg`/`chip` deliberately map to
 * different vars than `t1`: the hero panel + Enable/logo chips want a dark-ish
 * "ink" surface, while `t1` is the primary text colour (both were the same
 * literal `#1A2230` in the old light-only palette).
 */
const C = {
  heroBg: "var(--mv1-ink)",
  heroAccent: "var(--mv1-blue-eyebrow)",
  chip: "var(--mv1-chip)",
  blue: "var(--mv1-blue)",
  card: "var(--mv1-card)",
  bg: "var(--mv1-sunken)",
  sunken: "var(--mv1-sunken)",
  line: "var(--mv1-line)",
  line2: "var(--mv1-line-strong)",
  t1: "var(--mv1-t1)",
  t2: "var(--mv1-t2)",
  t3: "var(--mv1-t3)",
  green: "var(--mv1-green)",
  greenWash: "var(--mv1-green-wash)",
  violet: "var(--mv1-violet)",
  violetS: "var(--mv1-violet-strong)",
} as const;
const mono = "'DM Mono', ui-monospace, monospace";
const serif = "'Instrument Serif', Georgia, serif";

/** Friendlier blurbs for the classic category ids; raw category otherwise. */
const CATEGORY_DESC: Record<string, string> = {
  email: "Email and threads",
  calendar: "Events and scheduling",
  files: "Files and documents",
  docs: "Pages and databases",
  messaging: "Channels and direct messages",
  dev: "Repositories and issues",
  database: "Tables and records",
  crm: "CRM contacts and deals",
  tasks: "Tasks and projects",
  social: "Posts and direct messages",
};

/** The full Composio catalog is ~500 apps — cap the Available list and point
 *  at search instead of rendering a five-hundred-row scroll. */
const AVAILABLE_CAP = 60;

/** Keep refetching for 2 minutes after a connect starts so the finished
 *  OAuth flips the row to CONNECTED without a manual refresh. */
const CONNECT_POLL_MS = 3_000;
const CONNECT_POLL_WINDOW_MS = 120_000;

const sectionLabel = {
  fontFamily: mono,
  fontSize: 10.5,
  letterSpacing: ".1em",
  textTransform: "uppercase" as const,
  color: C.t3,
  margin: "24px 0 11px",
};

function ConnectorRow({
  connector,
  busy,
  connectable,
  manageable,
  mobile,
  onConnect,
  onManage,
  coachAnchor,
}: {
  connector: ConnectorApp;
  busy: boolean;
  connectable: boolean;
  manageable: boolean;
  mobile?: boolean;
  onConnect: () => void;
  onManage: () => void;
  coachAnchor?: string;
}) {
  const desc = CATEGORY_DESC[connector.category] ?? connector.category;
  return (
    <div
      data-slot="connector-row"
      data-coach={coachAnchor}
      style={{
        border: `1px solid ${C.line}`,
        borderRadius: 13,
        padding: mobile ? "12px 14px" : "13px 16px",
        display: "flex",
        alignItems: "center",
        gap: mobile ? 12 : 14,
        background: C.card,
        minHeight: mobile ? 60 : undefined,
      }}
    >
      <ConnectorAppLogo
        name={connector.name}
        logoUrl={connector.logoUrl}
        size={40}
        imgSize={24}
        chipStyle={{
          background: connector.connected ? C.chip : C.sunken,
          color: connector.connected ? "#fff" : C.t2,
          border: connector.connected ? undefined : `1px solid ${C.line}`,
          fontSize: 18,
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14.5, fontWeight: 600, color: C.t1 }}>
          {connector.name}
        </div>
        <div
          style={{
            fontSize: 12.5,
            color: C.t2,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {desc}
        </div>
      </div>
      {connector.connected ? (
        <>
          <span
            style={{
              fontFamily: mono,
              fontSize: 10,
              background: C.greenWash,
              color: C.green,
              padding: "3px 9px",
              borderRadius: 6,
              marginRight: 6,
            }}
          >
            CONNECTED
          </span>
          {manageable && (
            <button
              type="button"
              className="cue-pressable"
              onClick={onManage}
              style={{
                fontSize: 12.5,
                border: `1px solid ${C.line2}`,
                background: C.card,
                borderRadius: 9,
                padding: mobile ? "10px 14px" : "8px 14px",
                minHeight: mobile ? 40 : undefined,
                cursor: "pointer",
                color: C.t1,
              }}
            >
              Manage
            </button>
          )}
        </>
      ) : (
        <button
          type="button"
          className="cue-pressable"
          disabled={busy || !connectable}
          onClick={onConnect}
          title={
            connectable
              ? `Connect ${connector.name}`
              : "Easy connect isn't configured on this instance yet"
          }
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            fontSize: 13,
            background: C.chip,
            color: "#fff",
            border: "none",
            borderRadius: 9,
            padding: mobile ? "11px 20px" : "8px 18px",
            minHeight: mobile ? 44 : undefined,
            opacity: connectable ? 1 : 0.5,
            cursor: busy || !connectable ? "default" : "pointer",
          }}
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
          Enable
        </button>
      )}
    </div>
  );
}

/** Horizontal-scroll category chip rail — the touch-friendly replacement for
 *  the desktop native `<select>` on narrow viewports. */
function CategoryChips({
  categories,
  active,
  onSelect,
}: {
  categories: string[];
  active: string;
  onSelect: (value: string) => void;
}) {
  const chips = ["all", ...categories];
  return (
    <div
      role="group"
      aria-label="Filter connectors by category"
      style={{
        display: "flex",
        gap: 8,
        marginTop: 10,
        overflowX: "auto",
        WebkitOverflowScrolling: "touch",
        scrollbarWidth: "none",
        paddingBottom: 2,
      }}
    >
      {chips.map((cat) => {
        const isActive = active === cat;
        return (
          <button
            key={cat}
            type="button"
            className="cue-pressable"
            aria-pressed={isActive}
            onClick={() => {
              haptic.light();
              onSelect(cat);
            }}
            style={{
              flexShrink: 0,
              fontSize: 13,
              fontWeight: 600,
              fontFamily: "inherit",
              background: isActive ? C.chip : C.card,
              color: isActive ? "#fff" : C.t2,
              border: `1px solid ${isActive ? C.chip : C.line2}`,
              borderRadius: 999,
              padding: "9px 15px",
              minHeight: 38,
              whiteSpace: "nowrap",
              cursor: "pointer",
            }}
          >
            {cat === "all" ? "All" : (CATEGORY_DESC[cat] ?? cat)}
          </button>
        );
      })}
    </div>
  );
}

export function ConnectorsPage() {
  // MOBILE — the mobile-v3 Connections screen (spec frame 11). Branch in a
  // thin wrapper so the desktop body's hooks never change count across a
  // breakpoint flip. Desktop keeps the progress-hero layout untouched.
  const isMobile = useIsMobile();
  if (isMobile) {
    return <Mv3ConnectionsPage />;
  }
  return <ConnectorsPageDesktop />;
}

function ConnectorsPageDesktop() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const assistantId = useActiveAssistantId();
  const queryClient = useQueryClient();

  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [tipDismissed, setTipDismissed] = useState(false);
  const [pollUntil, setPollUntil] = useState(0);
  // Per-tool Manage is an Electron desktop surface — gate the button only.
  const [manageable, setManageable] = useState(false);

  useEffect(() => {
    void connectorsAvailable().then(setManageable);
  }, []);

  const appsQuery = useQuery({
    ...connectorappsGetOptions({
      path: { assistant_id: assistantId },
      // Filter client-side so typing doesn't refetch per keystroke.
      query: {},
    }),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    refetchInterval: () => (Date.now() < pollUntil ? CONNECT_POLL_MS : false),
  });

  const connectMutation = useMutation({
    ...connectorappsConnectPostMutation(),
    onSettled: () => {
      setBusySlug(null);
      void queryClient.invalidateQueries({
        queryKey: connectorappsGetQueryKey({
          path: { assistant_id: assistantId },
          query: {},
        }),
      });
    },
  });

  const handleConnect = (slug: string) => {
    haptic.light();
    setBusySlug(slug);
    setNote(null);
    connectMutation.mutate(
      { path: { assistant_id: assistantId }, body: { slug } },
      {
        onSuccess: (data) => {
          const url = (data as { redirectUrl?: string }).redirectUrl;
          if (!url) {
            setNote("Couldn't start the connection — try again.");
            return;
          }
          window.open(url, "_blank", "noopener,noreferrer");
          setNote(
            "A login tab opened — authorize, then this list updates automatically.",
          );
          setPollUntil(Date.now() + CONNECT_POLL_WINDOW_MS);
        },
        onError: () => setNote("Couldn't start the connection — try again."),
      },
    );
  };

  const connectors = appsQuery.data?.apps ?? [];
  const connectable = appsQuery.data?.configured === true;

  const q = query.trim().toLowerCase();
  const categories = Array.from(
    new Set(connectors.map((c) => c.category).filter(Boolean)),
  ).sort();
  const matches = (c: ConnectorApp) =>
    (category === "all" || c.category === category) &&
    (q === "" ||
      c.name.toLowerCase().includes(q) ||
      c.slug.toLowerCase().includes(q) ||
      c.category.toLowerCase().includes(q));

  const connected = connectors.filter((c) => c.connected && matches(c));
  const availableMatches = connectors.filter((c) => !c.connected && matches(c));
  const availableConnectors = availableMatches.slice(0, AVAILABLE_CAP);
  const availableOverflow = availableMatches.length - availableConnectors.length;
  const total = connectors.length;
  const connectedTotal = connectors.filter((c) => c.connected).length;
  const availTotal = total - connectedTotal;
  const pct = total > 0 ? Math.round((connectedTotal / total) * 100) : 0;

  if (appsQuery.isLoading) {
    return (
      <div
        style={{
          fontFamily: "'DM Sans', system-ui, sans-serif",
          padding: "8px 0",
          fontSize: 13,
          color: C.t3,
        }}
      >
        Loading connectable apps…
      </div>
    );
  }

  if (appsQuery.isError) {
    return (
      <div
        style={{
          fontFamily: "'DM Sans', system-ui, sans-serif",
          padding: "8px 0",
        }}
      >
        <div
          style={{
            border: `1px solid ${C.line}`,
            borderRadius: 14,
            background: C.sunken,
            padding: 20,
            fontSize: 13,
            color: C.t2,
          }}
        >
          Couldn&apos;t load the app catalog — the assistant may be
          unreachable.{" "}
          <button
            type="button"
            onClick={() => void appsQuery.refetch()}
            style={{
              border: "none",
              background: "transparent",
              color: C.blue,
              cursor: "pointer",
              fontSize: 13,
              padding: 0,
              textDecoration: "underline",
            }}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        fontFamily: "'DM Sans', system-ui, sans-serif",
        padding: "0 0 28px",
        color: C.t1,
      }}
    >
      {/* progress hero — side-by-side on desktop, stacked on mobile so the
          serif headline never squeezes against a fixed button column. */}
      <div
        style={{
          position: "relative",
          overflow: "hidden",
          background: C.heroBg,
          border: `1px solid ${C.line}`,
          borderRadius: 16,
          padding: isMobile ? "20px" : "20px 24px",
          display: "flex",
          flexDirection: isMobile ? "column" : "row",
          alignItems: isMobile ? "stretch" : "center",
          gap: isMobile ? 16 : 22,
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "radial-gradient(340px 160px at 90% 50%,rgba(61,110,232,.26),transparent 70%)",
          }}
        />
        <div style={{ position: "relative", flex: 1 }}>
          <div
            style={{
              fontFamily: serif,
              fontSize: isMobile ? 26 : 24,
              color: C.t1,
              letterSpacing: "-.2px",
              lineHeight: 1.2,
            }}
          >
            The more Cue connects, the more it can{" "}
            <span style={{ fontStyle: "italic", color: C.heroAccent }}>
              do for you.
            </span>
          </div>
          <div style={{ fontSize: 13, color: C.t2, marginTop: 5 }}>
            You&apos;ve connected{" "}
            <span data-slot="connectors-connected-total">
              {connectedTotal}
            </span>{" "}
            of {total}. Each one unlocks new things Cue can handle on its own.
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginTop: 14,
              maxWidth: isMobile ? undefined : 360,
            }}
          >
            <span
              style={{
                flex: 1,
                height: 7,
                borderRadius: 4,
                background: C.sunken,
                overflow: "hidden",
              }}
            >
              <span
                style={{
                  display: "block",
                  width: `${pct}%`,
                  height: "100%",
                  background: C.blue,
                  borderRadius: 4,
                }}
              />
            </span>
            <span style={{ fontFamily: mono, fontSize: 11, color: C.heroAccent }}>
              {pct}%
            </span>
          </div>
        </div>
        <div
          style={{
            position: "relative",
            display: "flex",
            flexDirection: isMobile ? "row" : "column",
            alignItems: "center",
            justifyContent: isMobile ? "space-between" : undefined,
            gap: isMobile ? 12 : 7,
            flexShrink: 0,
          }}
        >
          <button
            type="button"
            className="cue-pressable"
            onClick={() => {
              haptic.light();
              navigate(routes.library.root);
            }}
            style={{
              fontSize: 12.5,
              fontWeight: 600,
              background: C.blue,
              color: "#fff",
              border: "none",
              borderRadius: 9,
              padding: isMobile ? "12px 18px" : "9px 16px",
              minHeight: isMobile ? 44 : undefined,
              flex: isMobile ? 1 : undefined,
              textAlign: "center",
              cursor: "pointer",
            }}
          >
            Browse catalog
          </button>
          <span
            style={{
              fontFamily: mono,
              fontSize: 10.5,
              color: C.t3,
              textAlign: "center",
              whiteSpace: "nowrap",
            }}
          >
            +{availTotal} available
          </span>
        </div>
      </div>

      {/* tip banner */}
      {!tipDismissed && (
        <div
          style={{
            marginTop: 14,
            background: C.bg,
            borderRadius: 12,
            padding: "13px 16px",
            display: "flex",
            alignItems: "center",
            gap: 11,
            fontSize: 13.5,
            color: C.t2,
          }}
        >
          <span style={{ color: C.violet }}>✦</span> Tip: you can enable a
          connector by mentioning it in chat.
          <button
            type="button"
            onClick={() => setTipDismissed(true)}
            aria-label="Dismiss tip"
            style={{
              marginLeft: "auto",
              color: C.t3,
              background: "transparent",
              border: "none",
              cursor: "pointer",
              fontSize: 13.5,
            }}
          >
            ✕
          </button>
        </div>
      )}

      {/* search + filter — inline search+select on desktop; on mobile the
          search goes full-width and the category filter becomes a scrollable
          chip rail (a native <select> crowds the 390px row). */}
      {isMobile ? (
        <>
          <div
            style={{
              marginTop: 14,
              border: `1px solid ${C.line2}`,
              borderRadius: 11,
              background: C.card,
              padding: "0 14px",
              display: "flex",
              alignItems: "center",
              gap: 9,
            }}
          >
            <Search className="size-4" color={C.t3} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search connectors"
              style={{
                flex: 1,
                border: "none",
                outline: "none",
                background: "transparent",
                fontSize: 16,
                color: C.t1,
                padding: "13px 0",
                minHeight: 44,
                fontFamily: "inherit",
              }}
            />
          </div>
          <CategoryChips
            categories={categories}
            active={category}
            onSelect={setCategory}
          />
        </>
      ) : (
        <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
          <div
            style={{
              flex: 1,
              border: `1px solid ${C.line2}`,
              borderRadius: 11,
              background: C.card,
              padding: "0 14px",
              display: "flex",
              alignItems: "center",
              gap: 9,
            }}
          >
            <Search className="size-4" color={C.t3} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search connectors"
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
          </div>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            aria-label="Filter connectors by category"
            style={{
              border: `1px solid ${C.line2}`,
              borderRadius: 11,
              padding: "11px 16px",
              fontSize: 13.5,
              color: C.t2,
              background: C.card,
              fontFamily: "inherit",
              cursor: "pointer",
            }}
          >
            <option value="all">All categories</option>
            {categories.map((cat) => (
              <option key={cat} value={cat}>
                {CATEGORY_DESC[cat] ?? cat}
              </option>
            ))}
          </select>
        </div>
      )}

      {note && (
        <div
          style={{
            marginTop: 12,
            border: `1px solid ${C.line}`,
            borderRadius: 10,
            background: C.sunken,
            padding: "9px 12px",
            fontSize: 12,
            color: C.t2,
          }}
        >
          {note}
        </div>
      )}

      {connected.length > 0 && (
        <>
          <div style={sectionLabel}>Connected · {connectedTotal}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {connected.map((c) => (
              <ConnectorRow
                key={c.slug}
                connector={c}
                busy={busySlug === c.slug}
                connectable={connectable}
                manageable={manageable}
                mobile={isMobile}
                onConnect={() => handleConnect(c.slug)}
                onManage={() => navigate(routes.connector(c.slug))}
              />
            ))}
          </div>
        </>
      )}

      {availableConnectors.length > 0 && (
        <>
          <div style={sectionLabel}>Available</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {availableConnectors.map((c, i) => (
              <ConnectorRow
                key={c.slug}
                connector={c}
                busy={busySlug === c.slug}
                connectable={connectable}
                manageable={manageable}
                mobile={isMobile}
                coachAnchor={i === 0 ? "connectors-add" : undefined}
                onConnect={() => handleConnect(c.slug)}
                onManage={() => navigate(routes.connector(c.slug))}
              />
            ))}
          </div>
          {availableOverflow > 0 && (
            <div
              style={{
                fontFamily: mono,
                fontSize: 10.5,
                color: C.t3,
                marginTop: 10,
              }}
            >
              {availableOverflow} more — search to narrow it down.
            </div>
          )}
        </>
      )}

      {connected.length === 0 && availableConnectors.length === 0 && (
        <div
          style={{
            marginTop: 16,
            border: `1px solid ${C.line}`,
            borderRadius: 14,
            background: C.sunken,
            padding: "36px 24px",
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 500, color: C.t1 }}>
            {connectors.length === 0
              ? "Connect your first tool"
              : "No connectors match that search"}
          </div>
          <div
            style={{
              fontSize: 13,
              color: C.t2,
              marginTop: 6,
              maxWidth: 380,
              marginInline: "auto",
              lineHeight: 1.5,
            }}
          >
            {connectors.length === 0
              ? "Hook up Gmail, Slack, Notion and more so Cue can act for you across them."
              : "Try a different name or category, or browse the full catalog."}
          </div>
          <button
            type="button"
            className="cue-pressable"
            onClick={() =>
              connectors.length === 0
                ? navigate(routes.library.root)
                : (setQuery(""), setCategory("all"))
            }
            style={{
              marginTop: 16,
              fontSize: 12.5,
              fontWeight: 600,
              background: C.blue,
              color: "#fff",
              border: "none",
              borderRadius: 9,
              padding: isMobile ? "12px 20px" : "9px 16px",
              minHeight: isMobile ? 44 : undefined,
              cursor: "pointer",
            }}
          >
            {connectors.length === 0 ? "Browse catalog" : "Clear filters"}
          </button>
        </div>
      )}

      {/* MCP servers */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          margin: "26px 0 11px",
        }}
      >
        <span
          style={{
            fontFamily: mono,
            fontSize: 10.5,
            letterSpacing: ".1em",
            textTransform: "uppercase",
            color: C.t3,
          }}
        >
          MCP servers
        </span>
        <span
          style={{
            fontFamily: mono,
            fontSize: 10,
            background: C.sunken,
            color: C.violetS,
            padding: "2px 7px",
            borderRadius: 5,
          }}
        >
          model context protocol
        </span>
      </div>
      <button
        type="button"
        className="cue-pressable"
        onClick={() => {
          haptic.light();
          navigate(routes.assistant);
        }}
        title="Opens chat — ask Cue to add an MCP server"
        style={{
          width: "100%",
          border: `1px dashed ${C.line2}`,
          borderRadius: 13,
          background: C.bg,
          padding: 14,
          minHeight: isMobile ? 52 : undefined,
          display: "flex",
          alignItems: "center",
          gap: 10,
          cursor: "pointer",
          textAlign: "left",
          color: C.t2,
          fontSize: 13,
        }}
      >
        <span style={{ color: C.violet }}>✦</span> Ask Cue in chat to add an MCP
        server
        <span
          style={{
            marginLeft: "auto",
            fontFamily: mono,
            fontSize: 10,
            color: C.t3,
          }}
        >
          opens chat →
        </span>
      </button>
    </div>
  );
}
