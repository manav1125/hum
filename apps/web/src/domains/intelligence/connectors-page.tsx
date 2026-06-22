import { Loader2, Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

import type { ConnectorStatus } from "@vellumai/ipc-contract";

import {
  connectConnector,
  connectorsAvailable,
  listConnectors,
} from "@/runtime/connectors";
import { routes } from "@/utils/routes";

/**
 * Connectors — design-matched to surfaces/Connectors.dc.html while staying
 * wired to real Composio connector data. An editorial dark progress hero ("the
 * more Cue connects, the more it can do for you"), a tip banner, a search +
 * filter row, Connected rows (CONNECTED pill + Manage → ConnectorDetail), a
 * single-column Available list with Enable buttons, and the MCP-servers footer.
 *
 * The dark nav + intelligence tab bar are provided by IntelligenceLayout — not
 * rebuilt here.
 */

const C = {
  ink: "#1A2230",
  blue: "#3D6EE8",
  bg: "#F4F6F9",
  sunken: "#EEF1F6",
  line: "#E5E9F0",
  line2: "#D7DDE7",
  t1: "#1A2230",
  t2: "#5A6672",
  t3: "#9AA6B2",
  green: "#277E41",
  violet: "#7F77DD",
  violetS: "#534AB7",
} as const;
const mono = "'DM Mono', ui-monospace, monospace";
const serif = "'Instrument Serif', Georgia, serif";

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
  onConnect,
  onManage,
}: {
  connector: ConnectorStatus;
  busy: boolean;
  onConnect: () => void;
  onManage: () => void;
}) {
  const desc = CATEGORY_DESC[connector.category] ?? connector.category;
  return (
    <div
      style={{
        border: `1px solid ${C.line}`,
        borderRadius: 13,
        padding: "13px 16px",
        display: "flex",
        alignItems: "center",
        gap: 14,
        background: "#fff",
      }}
    >
      <span
        style={{
          width: 40,
          height: 40,
          borderRadius: 11,
          background: connector.connected ? C.ink : C.sunken,
          color: connector.connected ? "#fff" : C.t2,
          border: connector.connected ? undefined : "1px solid #EDEFF3",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 18,
          fontWeight: 600,
          flexShrink: 0,
        }}
      >
        {connector.name.charAt(0).toUpperCase()}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14.5, fontWeight: 600 }}>{connector.name}</div>
        <div style={{ fontSize: 12.5, color: C.t2 }}>{desc}</div>
      </div>
      {connector.connected ? (
        <>
          <span
            style={{
              fontFamily: mono,
              fontSize: 10,
              background: "#E2F0E7",
              color: C.green,
              padding: "3px 9px",
              borderRadius: 6,
              marginRight: 6,
            }}
          >
            CONNECTED
          </span>
          <button
            type="button"
            onClick={onManage}
            style={{
              fontSize: 12.5,
              border: `1px solid ${C.line2}`,
              background: "#fff",
              borderRadius: 9,
              padding: "8px 14px",
              cursor: "pointer",
              color: C.t1,
            }}
          >
            Manage
          </button>
        </>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={onConnect}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 13,
            background: C.ink,
            color: "#fff",
            border: "none",
            borderRadius: 9,
            padding: "8px 18px",
            cursor: busy ? "default" : "pointer",
          }}
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
          Enable
        </button>
      )}
    </div>
  );
}

export function ConnectorsPage() {
  const navigate = useNavigate();
  const [available, setAvailable] = useState<boolean | null>(null);
  const [connectors, setConnectors] = useState<ConnectorStatus[]>([]);
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [tipDismissed, setTipDismissed] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    setConnectors(await listConnectors());
  }, []);

  useEffect(() => {
    void (async () => {
      const ok = await connectorsAvailable();
      setAvailable(ok);
      if (ok) await refresh();
    })();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [refresh]);

  const handleConnect = async (slug: string) => {
    setBusySlug(slug);
    setNote(null);
    const url = await connectConnector(slug);
    setBusySlug(null);
    if (!url) {
      setNote("Couldn't start the connection — try again.");
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
    setNote("A login tab opened — authorize, then this list updates automatically.");
    if (pollRef.current) clearInterval(pollRef.current);
    let ticks = 0;
    pollRef.current = setInterval(() => {
      ticks += 1;
      void refresh();
      if (ticks > 40 && pollRef.current) clearInterval(pollRef.current);
    }, 3000);
  };

  if (available === null) return null;
  if (!available) {
    return (
      <div style={{ fontFamily: "'DM Sans', system-ui, sans-serif", padding: "8px 0" }}>
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
          Connectors are a macOS desktop feature and aren&apos;t set up on this install yet.
        </div>
      </div>
    );
  }

  const q = query.trim().toLowerCase();
  const categories = Array.from(
    new Set(connectors.map((c) => c.category).filter(Boolean)),
  ).sort();
  const matches = (c: ConnectorStatus) =>
    (category === "all" || c.category === category) &&
    (q === "" || c.name.toLowerCase().includes(q) || c.category.toLowerCase().includes(q));

  const connected = connectors.filter((c) => c.connected && matches(c));
  const availableConnectors = connectors.filter((c) => !c.connected && matches(c));
  const total = connectors.length || 12;
  const connectedTotal = connectors.filter((c) => c.connected).length;
  const availTotal = connectors.length - connectedTotal;
  const pct = total > 0 ? Math.round((connectedTotal / total) * 100) : 0;

  return (
    <div style={{ fontFamily: "'DM Sans', system-ui, sans-serif", padding: "0 0 28px", color: C.t1 }}>
      {/* progress hero */}
      <div
        style={{
          position: "relative",
          overflow: "hidden",
          background: C.ink,
          borderRadius: 16,
          padding: "20px 24px",
          display: "flex",
          alignItems: "center",
          gap: 22,
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
              fontSize: 24,
              color: "#fff",
              letterSpacing: "-.2px",
              lineHeight: 1.2,
            }}
          >
            The more Cue connects, the more it can{" "}
            <span style={{ fontStyle: "italic", color: "#9DB4E6" }}>do for you.</span>
          </div>
          <div style={{ fontSize: 13, color: "#AEB7C7", marginTop: 5 }}>
            You&apos;ve connected {connectedTotal} of {total}. Each one unlocks new things Cue can
            handle on its own.
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginTop: 14,
              maxWidth: 360,
            }}
          >
            <span
              style={{
                flex: 1,
                height: 7,
                borderRadius: 4,
                background: "rgba(255,255,255,.12)",
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
            <span style={{ fontFamily: mono, fontSize: 11, color: "#9DB4E6" }}>{pct}%</span>
          </div>
        </div>
        <div
          style={{
            position: "relative",
            display: "flex",
            flexDirection: "column",
            gap: 7,
            flexShrink: 0,
          }}
        >
          <button
            type="button"
            onClick={() => navigate(routes.library.root)}
            style={{
              fontSize: 12.5,
              background: C.blue,
              color: "#fff",
              border: "none",
              borderRadius: 9,
              padding: "9px 16px",
              textAlign: "center",
              cursor: "pointer",
            }}
          >
            Browse catalog
          </button>
          <span style={{ fontFamily: mono, fontSize: 10.5, color: "#7E8BA3", textAlign: "center" }}>
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
          <span style={{ color: C.violet }}>✦</span> Tip: you can enable a connector by mentioning
          it in chat.
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

      {/* search + filter */}
      <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
        <div
          style={{
            flex: 1,
            border: `1px solid ${C.line2}`,
            borderRadius: 11,
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
            background: "#fff",
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
                onConnect={() => void handleConnect(c.slug)}
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
            {availableConnectors.map((c) => (
              <ConnectorRow
                key={c.slug}
                connector={c}
                busy={busySlug === c.slug}
                onConnect={() => void handleConnect(c.slug)}
                onManage={() => navigate(routes.connector(c.slug))}
              />
            ))}
          </div>
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
            onClick={() =>
              connectors.length === 0
                ? navigate(routes.library.root)
                : (setQuery(""), setCategory("all"))
            }
            style={{
              marginTop: 16,
              fontSize: 12.5,
              background: C.blue,
              color: "#fff",
              border: "none",
              borderRadius: 9,
              padding: "9px 16px",
              cursor: "pointer",
            }}
          >
            {connectors.length === 0 ? "Browse catalog" : "Clear filters"}
          </button>
        </div>
      )}

      {/* MCP servers */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "26px 0 11px" }}>
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
            background: "#EEEDFB",
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
        onClick={() => navigate(routes.assistant)}
        title="Opens chat — ask Cue to add an MCP server"
        style={{
          width: "100%",
          border: `1px dashed ${C.line2}`,
          borderRadius: 13,
          background: C.bg,
          padding: 14,
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
