import { ChevronDown, ChevronRight, Loader2, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

import type { ConnectorStatus, ConnectorTool } from "@vellumai/ipc-contract";

import {
  connectConnector,
  connectorsAvailable,
  disconnectConnector,
  listConnectorTools,
  listConnectors,
  setConnectorTool,
  toolTogglesSupported,
} from "@/runtime/connectors";

/**
 * Connectors — design-matched (surfaces/Connectors.dc.html) while staying wired
 * to real Composio connector data. A progress header ("the more Cue connects,
 * the more it can do"), Connected rows with per-tool management, and Available
 * rows. Calm working-surface styling per the design's "moment vs working"
 * principle.
 */

const C = {
  ink: "#1A2230",
  blue: "#3D6EE8",
  blueS: "#2B53C4",
  line: "#E5E9F0",
  line2: "#D7DDE7",
  sunken: "#EEF1F6",
  t1: "#1A2230",
  t2: "#5A6672",
  t3: "#8D99A5",
  green: "#277E41",
} as const;
const mono = "'DM Mono', ui-monospace, monospace";

const CATEGORY_DESC: Record<string, string> = {
  email: "Email and threads",
  calendar: "Events and scheduling",
  files: "Files and documents",
  docs: "Docs and notes",
  messaging: "Channels and messages",
  dev: "Repositories and issues",
  database: "Tables and records",
  crm: "Contacts and deals",
};

const sectionLabel = {
  fontFamily: mono,
  fontSize: 10.5,
  letterSpacing: ".1em",
  textTransform: "uppercase" as const,
  color: C.t3,
  margin: "22px 0 12px",
};

function ToolToggle({ on }: { on: boolean }) {
  return (
    <span
      style={{
        position: "relative",
        display: "inline-flex",
        width: 36,
        height: 20,
        borderRadius: 999,
        background: on ? C.blue : "#C4CCDA",
        flexShrink: 0,
        transition: "background .15s",
      }}
    >
      <span
        style={{
          position: "absolute",
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: "#fff",
          top: 2,
          left: on ? 18 : 2,
          transition: "left .15s",
        }}
      />
    </span>
  );
}

function ToolList({ slug }: { slug: string }) {
  const [tools, setTools] = useState<ConnectorTool[] | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    void (async () => setTools(await listConnectorTools(slug)))();
  }, [slug]);

  const toggle = async (tool: ConnectorTool) => {
    setPending(tool.slug);
    setTools(await setConnectorTool(slug, tool.slug, !tool.enabled));
    setPending(null);
  };

  if (tools === null) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 16px", fontSize: 12, color: C.t2 }}>
        <Loader2 className="size-3.5 animate-spin" /> Loading tools…
      </div>
    );
  }
  if (tools.length === 0) {
    return <div style={{ padding: "12px 16px", fontSize: 12, color: C.t2 }}>No tools available.</div>;
  }
  const onCount = tools.filter((t) => t.enabled).length;
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "8px 16px 2px", fontSize: 11.5, color: C.t2 }}>
        {onCount} of {tools.length} tools enabled — changes apply instantly.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1 }}>
        {tools.map((t) => (
          <button
            key={t.slug}
            type="button"
            disabled={pending === t.slug}
            onClick={() => void toggle(t)}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              padding: "8px 16px",
              background: "transparent",
              border: "none",
              textAlign: "left",
              cursor: "pointer",
            }}
          >
            <span style={{ fontSize: 13, color: C.t1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {t.name}
            </span>
            {pending === t.slug ? (
              <Loader2 className="size-4 animate-spin" color={C.t3} />
            ) : (
              <ToolToggle on={t.enabled} />
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

function ConnectorRow({
  connector,
  busy,
  onConnect,
  onDisconnect,
}: {
  connector: ConnectorStatus;
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const canExpand = connector.connected && toolTogglesSupported();
  const desc = CATEGORY_DESC[connector.category] ?? connector.category;

  return (
    <div style={{ border: `1px solid ${C.line}`, borderRadius: 14, overflow: "hidden", background: "#fff" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 13, padding: 16 }}>
        <span
          style={{
            width: 40,
            height: 40,
            borderRadius: 11,
            background: connector.connected ? C.ink : C.sunken,
            color: connector.connected ? "#fff" : C.t2,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 15,
            fontWeight: 600,
            flexShrink: 0,
          }}
        >
          {connector.name.charAt(0).toUpperCase()}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{connector.name}</div>
          <div style={{ fontSize: 12, color: C.t2 }}>{desc}</div>
        </div>
        {connector.connected ? (
          <>
            <span
              style={{
                fontFamily: mono,
                fontSize: 10,
                color: C.green,
                background: "#E2F0E7",
                padding: "3px 9px",
                borderRadius: 7,
              }}
            >
              CONNECTED
            </span>
            {canExpand ? (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12.5, border: `1px solid ${C.line2}`, background: "#fff", borderRadius: 9, padding: "7px 12px", cursor: "pointer", color: C.t1 }}
              >
                Manage{expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
              </button>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={onDisconnect}
                style={{ fontSize: 12.5, border: `1px solid ${C.line2}`, background: "#fff", borderRadius: 9, padding: "7px 12px", cursor: "pointer", color: C.t2 }}
              >
                Disconnect
              </button>
            )}
          </>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={onConnect}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, border: `1px solid ${C.line2}`, background: "#fff", borderRadius: 9, padding: "7px 16px", cursor: "pointer", color: C.t1, fontWeight: 500 }}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            Enable
          </button>
        )}
      </div>
      {canExpand && expanded && (
        <div style={{ borderTop: `1px solid ${C.line}`, background: "#FAFBFD", paddingBottom: 8 }}>
          <ToolList slug={connector.slug} />
        </div>
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

  const handleDisconnect = async (slug: string) => {
    setBusySlug(slug);
    setConnectors(await disconnectConnector(slug));
    setBusySlug(null);
  };

  if (available === null) return null;
  if (!available) {
    return (
      <div style={{ fontFamily: "'DM Sans', system-ui, sans-serif", padding: "8px 0" }}>
        <div style={{ border: `1px solid ${C.line}`, borderRadius: 14, background: C.sunken, padding: 20, fontSize: 13, color: C.t2 }}>
          Connectors are a macOS desktop feature and aren&apos;t set up on this install yet.
        </div>
      </div>
    );
  }

  const connected = connectors.filter((c) => c.connected);
  const availableConnectors = connectors.filter((c) => !c.connected);
  const total = connectors.length || 12;
  const pct = total > 0 ? Math.round((connected.length / total) * 100) : 0;

  return (
    <div style={{ fontFamily: "'DM Sans', system-ui, sans-serif", padding: "0 0 28px", color: C.t1 }}>
      {/* progress header */}
      <div
        style={{
          border: `1px solid ${C.line}`,
          borderRadius: 16,
          padding: "22px 24px",
          background: "linear-gradient(180deg,#FAFBFF,#fff)",
        }}
      >
        <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: "-.4px" }}>
          The more Cue connects, the more it can do for you.
        </div>
        <div style={{ fontSize: 13.5, color: C.t2, marginTop: 6 }}>
          You&apos;ve connected {connected.length} of {total}. Each one unlocks new things Cue can handle on its own.
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 14 }}>
          <span style={{ flex: 1, height: 8, borderRadius: 5, background: C.sunken, overflow: "hidden" }}>
            <span style={{ display: "block", width: `${pct}%`, height: "100%", background: C.blue, borderRadius: 5 }} />
          </span>
          <span style={{ fontFamily: mono, fontSize: 12, color: C.t2 }}>{pct}%</span>
        </div>
      </div>

      {note && (
        <div style={{ marginTop: 12, border: `1px solid ${C.line}`, borderRadius: 10, background: C.sunken, padding: "9px 12px", fontSize: 12, color: C.t2 }}>
          {note}
        </div>
      )}

      {connected.length > 0 && (
        <>
          <div style={sectionLabel}>Connected · {connected.length}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {connected.map((c) => (
              <ConnectorRow
                key={c.slug}
                connector={c}
                busy={busySlug === c.slug}
                onConnect={() => void handleConnect(c.slug)}
                onDisconnect={() => void handleDisconnect(c.slug)}
              />
            ))}
          </div>
        </>
      )}

      {availableConnectors.length > 0 && (
        <>
          <div style={sectionLabel}>Available</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            {availableConnectors.map((c) => (
              <ConnectorRow
                key={c.slug}
                connector={c}
                busy={busySlug === c.slug}
                onConnect={() => void handleConnect(c.slug)}
                onDisconnect={() => void handleDisconnect(c.slug)}
              />
            ))}
          </div>
        </>
      )}

      <div style={sectionLabel}>MCP servers · model context protocol</div>
      <button
        type="button"
        onClick={() => navigate("/assistant/")}
        title="Ask Cue in chat to add an MCP server"
        style={{
          width: "100%",
          border: `1px dashed ${C.line2}`,
          borderRadius: 14,
          background: "#fff",
          padding: 16,
          display: "flex",
          alignItems: "center",
          gap: 12,
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span style={{ width: 40, height: 40, borderRadius: 11, background: C.sunken, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <Plus className="size-4" color={C.t2} />
        </span>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Add an MCP server</div>
          <div style={{ fontSize: 12, color: C.t2 }}>Connect any Model Context Protocol server (stdio or http)</div>
        </div>
      </button>
    </div>
  );
}
