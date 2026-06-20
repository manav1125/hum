import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";

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
import { routes } from "@/utils/routes";

/**
 * ConnectorDetail — design-matched to surfaces/ConnectorDetail.dc.html, wired to
 * real Composio connector + per-tool data. Two states from the mock:
 *
 *  • Permissions — a per-tool permission matrix. The connector's real declared
 *    tools (slug/name/enabled, from the daemon allowlist) are split into
 *    read-only vs write/delete groups by their slug verb, with high-impact
 *    (delete/remove) tools flagged. The tri-state pills (allow · ask · never)
 *    render the trust-model default for each group; the live control is the
 *    real binary enable toggle (Composio's only per-tool primitive), which
 *    calls setConnectorTool and hot-reloads the MCP server.
 *
 *  • Connection issue — the disconnected/expired state. Reachable when the
 *    connector isn't connected (real `connected` flag); offers Reconnect (real
 *    OAuth flow) and Remove (real disconnect).
 *
 * The dark nav + intelligence tab bar are provided by IntelligenceLayout — not
 * rebuilt here. This is the inner detail pane only.
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
  t3: "#8D99A5",
  green: "#277E41",
  amber: "#C98A1B",
  danger: "#DA491A",
} as const;
const mono = "'DM Mono', ui-monospace, monospace";

type ToolKind = "read" | "write" | "high";

/** Read verbs (default "always allow") vs write/delete (default "ask"). */
const READ_VERBS = [
  "GET",
  "LIST",
  "SEARCH",
  "FETCH",
  "READ",
  "FIND",
  "RETRIEVE",
  "QUERY",
  "VIEW",
  "DOWNLOAD",
];
/** Destructive verbs — high impact, default "never". */
const HIGH_IMPACT_VERBS = ["DELETE", "REMOVE", "ARCHIVE", "TRASH", "PURGE"];

function classifyTool(tool: ConnectorTool): ToolKind {
  const slug = tool.slug.toUpperCase();
  if (HIGH_IMPACT_VERBS.some((v) => slug.includes(v))) return "high";
  if (READ_VERBS.some((v) => slug.includes(v))) return "read";
  return "write";
}

/** The derived per-tool policy, shown as a single static labeled tag (display
 *  only). It reflects the trust-model default for the tool's kind; the live
 *  per-tool control is the binary ENABLED/OFF toggle. Per-tool allow/ask/never
 *  isn't a real Composio primitive yet, so this must not read as selectable. */
function PolicyTag({ kind }: { kind: ToolKind }) {
  const style =
    kind === "read"
      ? { bg: "#E9F5EE", border: "#BFE3CD", color: C.green, glyph: "✓", label: "allow" }
      : kind === "high"
        ? { bg: "#FCEBEB", border: "#F0B9AC", color: C.danger, glyph: "⊘", label: "never" }
        : { bg: "#FBF0DA", border: "#ECD9A6", color: C.amber, glyph: "✋", label: "ask" };
  return (
    <span
      aria-label={`Default policy: ${style.label}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        background: style.bg,
        border: `1px solid ${style.border}`,
        borderRadius: 8,
        padding: "4px 9px",
        fontFamily: mono,
        fontSize: 10,
        color: style.color,
      }}
    >
      <span aria-hidden>{style.glyph}</span>
      {style.label}
    </span>
  );
}

function ToolRow({
  tool,
  kind,
  pending,
  onToggle,
  last,
}: {
  tool: ConnectorTool;
  kind: ToolKind;
  pending: boolean;
  onToggle: () => void;
  last: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "12px 16px",
        borderBottom: last ? undefined : "1px solid #F0F2F6",
      }}
    >
      <span style={{ flex: 1, fontSize: 13, color: C.t1 }}>
        {tool.name}
        {kind === "high" && (
          <span
            style={{
              fontFamily: mono,
              fontSize: 10,
              background: "#FCEBEB",
              color: C.danger,
              padding: "1px 6px",
              borderRadius: 5,
              marginLeft: 8,
            }}
          >
            high impact
          </span>
        )}
      </span>
      {/* Derived policy — display only, not a control. */}
      <PolicyTag kind={kind} />
      {/* The real live control: binary enable/disable toggle. */}
      <button
        type="button"
        disabled={pending}
        onClick={onToggle}
        aria-pressed={tool.enabled}
        title={tool.enabled ? "Enabled — click to disable" : "Disabled — click to enable"}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          minWidth: 52,
          background: "transparent",
          border: "none",
          padding: 0,
          cursor: pending ? "default" : "pointer",
        }}
      >
        {pending ? (
          <Loader2 className="size-4 animate-spin" color={C.t3} />
        ) : (
          <span
            style={{
              fontFamily: mono,
              fontSize: 10,
              color: tool.enabled ? C.green : C.t3,
            }}
          >
            {tool.enabled ? "ENABLED" : "OFF"}
          </span>
        )}
      </button>
    </div>
  );
}

function ToolGroup({
  title,
  badge,
  badgeBg,
  badgeColor,
  badgeBorder,
  count,
  tools,
  pending,
  onToggle,
}: {
  title: string;
  badge: string;
  badgeBg: string;
  badgeColor: string;
  badgeBorder: string;
  count: number;
  tools: { tool: ConnectorTool; kind: ToolKind }[];
  pending: string | null;
  onToggle: (slug: string, next: boolean) => void;
}) {
  if (tools.length === 0) return null;
  return (
    <div
      style={{
        marginTop: 18,
        border: `1px solid ${C.line}`,
        borderRadius: 13,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 16px",
          background: "#FBFBFD",
          borderBottom: `1px solid ${C.line}`,
        }}
      >
        <div
          style={{
            fontSize: 13.5,
            fontWeight: 600,
            display: "flex",
            alignItems: "center",
            gap: 9,
          }}
        >
          {title}
          <span
            style={{
              fontFamily: mono,
              fontSize: 10,
              background: C.sunken,
              color: C.t2,
              padding: "1px 7px",
              borderRadius: 5,
            }}
          >
            {count}
          </span>
        </div>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            fontSize: 12,
            background: badgeBg,
            color: badgeColor,
            border: `1px solid ${badgeBorder}`,
            borderRadius: 8,
            padding: "5px 11px",
          }}
        >
          {badge}
        </span>
      </div>
      {tools.map(({ tool, kind }, i) => (
        <ToolRow
          key={tool.slug}
          tool={tool}
          kind={kind}
          pending={pending === tool.slug}
          onToggle={() => onToggle(tool.slug, !tool.enabled)}
          last={i === tools.length - 1}
        />
      ))}
    </div>
  );
}

export function ConnectorDetailPage() {
  const { slug = "" } = useParams();
  const navigate = useNavigate();
  const [available, setAvailable] = useState<boolean | null>(null);
  const [connector, setConnector] = useState<ConnectorStatus | null>(null);
  const [tools, setTools] = useState<ConnectorTool[] | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const list = await listConnectors();
    setConnector(list.find((c) => c.slug === slug) ?? null);
  }, [slug]);

  useEffect(() => {
    void (async () => {
      const ok = await connectorsAvailable();
      setAvailable(ok);
      if (!ok) return;
      await load();
      if (toolTogglesSupported()) setTools(await listConnectorTools(slug));
      else setTools([]);
    })();
  }, [slug, load]);

  const grouped = useMemo(() => {
    const read: { tool: ConnectorTool; kind: ToolKind }[] = [];
    const write: { tool: ConnectorTool; kind: ToolKind }[] = [];
    for (const tool of tools ?? []) {
      const kind = classifyTool(tool);
      if (kind === "read") read.push({ tool, kind });
      else write.push({ tool, kind });
    }
    return { read, write };
  }, [tools]);

  const toggle = async (toolSlug: string, next: boolean) => {
    setPending(toolSlug);
    setTools(await setConnectorTool(slug, toolSlug, next));
    setPending(null);
  };

  const handleReconnect = async () => {
    setBusy(true);
    const url = await connectConnector(slug);
    setBusy(false);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  };

  const handleRemove = async () => {
    setBusy(true);
    await disconnectConnector(slug);
    setBusy(false);
    navigate(routes.connectors);
  };

  if (available === null) return null;

  if (!available || connector === null) {
    return (
      <div style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>
        <button
          type="button"
          onClick={() => navigate(routes.connectors)}
          style={backLinkStyle}
        >
          ← Connectors
        </button>
        <div
          style={{
            marginTop: 14,
            border: `1px solid ${C.line}`,
            borderRadius: 14,
            background: C.sunken,
            padding: 20,
            fontSize: 13,
            color: C.t2,
          }}
        >
          {available
            ? "That connector isn't in your catalog."
            : "Connectors are a macOS desktop feature and aren't set up on this install yet."}
        </div>
      </div>
    );
  }

  const initial = connector.name.charAt(0).toUpperCase();

  // Disconnected → connection-issue state (mock's second tab).
  if (!connector.connected) {
    return (
      <div style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>
        <button
          type="button"
          onClick={() => navigate(routes.connectors)}
          style={backLinkStyle}
        >
          ← Connectors
        </button>
        <div
          style={{
            marginTop: 14,
            border: `1px solid ${C.line}`,
            borderRadius: 14,
            background: "#fff",
            minHeight: 420,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            textAlign: "center",
            gap: 16,
            padding: 40,
          }}
        >
          <span
            style={{
              width: 64,
              height: 64,
              borderRadius: 16,
              background: C.ink,
              color: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 28,
              fontWeight: 600,
            }}
          >
            {initial}
          </span>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 9,
              fontSize: 18,
              fontWeight: 600,
              color: C.amber,
            }}
          >
            <span style={{ fontSize: 18 }}>⚠</span> Connection issue
          </div>
          <p style={{ fontSize: 14, color: C.t2, maxWidth: 360, margin: 0 }}>
            Cue isn't connected to{" "}
            <b style={{ color: C.t1 }}>{connector.name}</b>. Your data is safe
            and nothing was lost — reconnect to re-authenticate.
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleReconnect()}
              style={{
                fontSize: 13,
                background: C.ink,
                color: "#fff",
                border: "none",
                borderRadius: 9,
                padding: "10px 20px",
                cursor: busy ? "default" : "pointer",
              }}
            >
              Reconnect
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleRemove()}
              style={{
                fontSize: 13,
                border: `1px solid ${C.line2}`,
                background: "#fff",
                borderRadius: 9,
                padding: "10px 16px",
                cursor: busy ? "default" : "pointer",
                color: C.t1,
              }}
            >
              Remove
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Connected → permission matrix.
  return (
    <div style={{ fontFamily: "'DM Sans', system-ui, sans-serif", color: C.t1 }}>
      <button
        type="button"
        onClick={() => navigate(routes.connectors)}
        style={backLinkStyle}
      >
        ← Connectors
      </button>

      <div style={{ display: "flex", alignItems: "center", gap: 13, marginTop: 16 }}>
        <span
          style={{
            width: 40,
            height: 40,
            borderRadius: 11,
            background: C.ink,
            color: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 18,
            fontWeight: 600,
            flexShrink: 0,
          }}
        >
          {initial}
        </span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 19, fontWeight: 600, letterSpacing: "-.3px" }}>
            {connector.name}
          </div>
          <div style={{ fontSize: 12, color: C.t2 }}>Connected</div>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void handleRemove()}
          style={{
            fontSize: 12.5,
            border: `1px solid ${C.line2}`,
            background: "#fff",
            borderRadius: 9,
            padding: "8px 15px",
            cursor: busy ? "default" : "pointer",
            color: C.t1,
          }}
        >
          Disconnect
        </button>
      </div>

      <div style={{ marginTop: 22 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>Tool permissions</div>
        <div style={{ fontSize: 12.5, color: C.t2, marginTop: 2 }}>
          Choose which tools Cue is allowed to use.{" "}
          <b style={{ color: C.t1 }}>Stop always wins.</b>
        </div>
      </div>

      {tools === null ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "18px 0",
            fontSize: 13,
            color: C.t2,
          }}
        >
          <Loader2 className="size-4 animate-spin" /> Loading tools…
        </div>
      ) : tools.length === 0 ? (
        <div
          style={{
            marginTop: 18,
            border: `1px solid ${C.line}`,
            borderRadius: 13,
            background: C.sunken,
            padding: 16,
            fontSize: 13,
            color: C.t2,
          }}
        >
          Per-tool permissions aren&apos;t available on this install.
        </div>
      ) : (
        <>
          <ToolGroup
            title="Read-only tools"
            badge="Always allow"
            badgeBg="#E9F5EE"
            badgeColor={C.green}
            badgeBorder="#BFE3CD"
            count={grouped.read.length}
            tools={grouped.read}
            pending={pending}
            onToggle={(s, n) => void toggle(s, n)}
          />
          <ToolGroup
            title="Write / delete tools"
            badge="✋ Needs approval"
            badgeBg="#FBF0DA"
            badgeColor={C.amber}
            badgeBorder="#ECD9A6"
            count={grouped.write.length}
            tools={grouped.write}
            pending={pending}
            onToggle={(s, n) => void toggle(s, n)}
          />
          <div
            style={{
              marginTop: 14,
              fontFamily: mono,
              fontSize: 11,
              color: C.t3,
            }}
          >
            ✓ allow · ✋ ask each time · ⊘ never — policy derived from tool type ·
            per-tool allow/ask/never coming soon. The ENABLED/OFF toggle is live
            today.
          </div>
        </>
      )}
    </div>
  );
}

const backLinkStyle = {
  fontFamily: mono,
  fontSize: 12,
  color: C.t2,
  textDecoration: "none",
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  background: "#fff",
  border: `1px solid ${C.line}`,
  borderRadius: 999,
  padding: "7px 14px",
  cursor: "pointer",
} as const;
