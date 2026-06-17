/**
 * Agents — faithful translation of `surfaces/Agents.dc.html`.
 *
 * "Let Cue work with other agents": an ink hero with the agent-network
 * constellation, the Enable-A2A card, the paired-agents grid (scoped/trusted),
 * and the create-invite card. Presentational — the A2A protocol, agent card,
 * and invite routes exist on the daemon and will be wired in.
 */

const C = {
  ink: "#1A2230",
  blue: "#3D6EE8",
  blueS: "#2B53C4",
  blueW: "#DBE4FB",
  violet: "#7F77DD",
  violetS: "#534AB7",
  violetW: "#EEEDFB",
  line: "#E5E9F0",
  line2: "#D7DDE7",
  t1: "#1A2230",
  t2: "#5A6672",
  t3: "#8D99A5",
  green: "#277E41",
} as const;
const mono = "'DM Mono', ui-monospace, monospace";

const KEYFRAMES = `
@keyframes cueDash{to{stroke-dashoffset:-14}}
@keyframes cuePulse{0%{transform:scale(1);opacity:.65}100%{transform:scale(1.45);opacity:0}}
@media (prefers-reduced-motion: reduce){.cue-anim *{animation:none !important}}
`;

const LINES = [
  { x: 230, y: 52, stroke: C.blue, o: 0.7, dash: 1.1 },
  { x: 356, y: 96, stroke: C.violet, o: 0.6, dash: 1.3 },
  { x: 372, y: 196, stroke: C.t3, o: 0.35, dash: 0 },
  { x: 118, y: 92, stroke: C.violet, o: 0.5, dash: 1.5 },
  { x: 104, y: 206, stroke: C.t3, o: 0.3, dash: 0 },
];

function AgentNode({
  x,
  y,
  initials,
  label,
  bg,
  fg,
  dashed,
}: {
  x: number;
  y: number;
  initials: string;
  label: string;
  bg: string;
  fg: string;
  dashed?: boolean;
}) {
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        transform: "translate(-50%,-50%)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 5,
      }}
    >
      <span
        style={{
          width: dashed ? 36 : 40,
          height: dashed ? 36 : 40,
          borderRadius: 12,
          background: bg,
          color: fg,
          border: dashed ? "1.5px dashed rgba(255,255,255,.3)" : undefined,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: initials.length > 1 ? 13 : 15,
          fontWeight: initials.length > 1 ? 600 : 400,
        }}
      >
        {initials}
      </span>
      <span style={{ fontFamily: mono, fontSize: 8.5, color: dashed ? "#6B788C" : "#9DB4E6" }}>
        {label}
      </span>
    </div>
  );
}

function PairedCard({
  initials,
  bg,
  fg,
  name,
  paired,
  scope,
  scopeColor,
  scopeBg,
  detail,
}: {
  initials: string;
  bg: string;
  fg: string;
  name: string;
  paired: string;
  scope: string;
  scopeColor: string;
  scopeBg: string;
  detail: string;
}) {
  return (
    <div style={{ border: `1px solid ${C.line}`, borderRadius: 14, padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span
          style={{
            width: 40,
            height: 40,
            borderRadius: 11,
            background: bg,
            color: fg,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: initials.length > 1 ? 13 : 16,
            fontWeight: 600,
            flexShrink: 0,
          }}
        >
          {initials}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{name}</div>
          <div style={{ fontSize: 11.5, color: C.t2 }}>{paired}</div>
        </div>
        <span
          style={{
            fontFamily: mono,
            fontSize: 10,
            background: scopeBg,
            color: scopeColor,
            padding: "3px 8px",
            borderRadius: 6,
          }}
        >
          {scope}
        </span>
      </div>
      <div style={{ fontSize: 12, color: C.t2, marginTop: 10 }}>{detail}</div>
    </div>
  );
}

export function AgentsPage() {
  return (
    <div style={{ padding: "0 0 28px", fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <style dangerouslySetInnerHTML={{ __html: KEYFRAMES }} />

      {/* HERO with network */}
      <div
        style={{
          position: "relative",
          background: C.ink,
          borderRadius: 18,
          overflow: "hidden",
          display: "grid",
          gridTemplateColumns: "1fr 460px",
          alignItems: "center",
          minHeight: 280,
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "radial-gradient(440px 280px at 80% 50%,rgba(127,119,221,.22),transparent 70%)",
          }}
        />
        <div style={{ padding: "34px 36px", position: "relative" }}>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              background: "rgba(61,110,232,.18)",
              color: "#9DB4E6",
              borderRadius: 999,
              padding: "5px 12px",
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            ⧉ Agent Network
          </span>
          <div
            style={{
              fontSize: 32,
              fontWeight: 600,
              letterSpacing: "-1px",
              color: "#fff",
              marginTop: 14,
              lineHeight: 1.08,
            }}
          >
            Let Cue work
            <br />
            with other agents.
          </div>
          <p style={{ fontSize: 14.5, color: "#AEB7C7", marginTop: 12, maxWidth: 400 }}>
            Cue speaks the open agent-to-agent (A2A) protocol. Let trusted agents
            send tasks to yours — and pair with them using scoped, one-time
            invites.
          </p>
        </div>
        <div className="cue-anim" style={{ position: "relative", height: 280 }}>
          <svg
            width="460"
            height="280"
            viewBox="0 0 460 280"
            style={{ position: "absolute", inset: 0 }}
          >
            {LINES.map((l, i) => (
              <line
                key={i}
                x1="230"
                y1="140"
                x2={l.x}
                y2={l.y}
                stroke={l.stroke}
                strokeWidth="1.5"
                strokeDasharray="3 4"
                opacity={l.o}
                style={l.dash ? { animation: `cueDash ${l.dash}s linear infinite` } : undefined}
              />
            ))}
          </svg>
          <div
            style={{
              position: "absolute",
              left: 230,
              top: 140,
              transform: "translate(-50%,-50%)",
              width: 64,
              height: 64,
              borderRadius: 18,
              background: "#0F1620",
              border: "1px solid rgba(255,255,255,.12)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 2,
            }}
          >
            <span
              style={{
                position: "absolute",
                inset: 0,
                borderRadius: 18,
                border: "2px solid rgba(61,110,232,.6)",
                animation: "cuePulse 2.4s ease-out infinite",
              }}
            />
            <span style={{ fontSize: 36, fontWeight: 600, color: "#EEF2F7", position: "relative", lineHeight: 1 }}>
              C
              <span
                style={{
                  position: "absolute",
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: C.blue,
                  right: 9,
                  bottom: 13,
                }}
              />
            </span>
          </div>
          <AgentNode x={230} y={52} initials="DR" label="Dana" bg={C.blueW} fg={C.blueS} />
          <AgentNode x={356} y={96} initials="◆" label="Vendor" bg={C.violetW} fg={C.violetS} />
          <AgentNode x={118} y={92} initials="SC" label="Sam" bg={C.violetW} fg={C.violetS} />
          <AgentNode x={372} y={196} initials="?" label="pending" bg="rgba(255,255,255,.06)" fg="#7E8BA3" dashed />
          <AgentNode x={104} y={206} initials="?" label="unknown" bg="rgba(255,255,255,.06)" fg="#7E8BA3" dashed />
        </div>
      </div>

      {/* Enable A2A */}
      <div
        style={{
          border: `1.5px solid ${C.ink}`,
          borderRadius: 14,
          padding: "18px 20px",
          display: "flex",
          alignItems: "center",
          gap: 16,
          marginTop: 18,
        }}
      >
        <span style={{ width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, color: C.violet, flexShrink: 0 }}>
          ✦
        </span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Enable A2A endpoint</div>
          <div style={{ fontSize: 13, color: C.t2, marginTop: 2 }}>
            Exposes your agent at{" "}
            <span style={{ fontFamily: mono, fontSize: 12, background: "#F4F6F9", padding: "1px 6px", borderRadius: 5 }}>
              /a2a/message:send
            </span>{" "}
            so paired agents can reach it.
          </div>
        </div>
        <span style={{ width: 46, height: 26, borderRadius: 999, background: C.blue, position: "relative", flexShrink: 0 }}>
          <span style={{ position: "absolute", width: 22, height: 22, borderRadius: "50%", background: "#fff", top: 2, right: 2, boxShadow: "0 1px 3px rgba(0,0,0,.2)" }} />
        </span>
      </div>

      {/* Paired agents */}
      <div
        style={{
          fontFamily: mono,
          fontSize: 10.5,
          letterSpacing: ".1em",
          textTransform: "uppercase",
          color: C.t3,
          margin: "26px 0 12px",
        }}
      >
        Paired agents · 2
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <PairedCard
          initials="DR"
          bg={C.blueW}
          fg={C.blueS}
          name="Dana's assistant"
          paired="paired Jun 12"
          scope="SCOPED"
          scopeColor={C.blueS}
          scopeBg={C.blueW}
          detail="Can discuss the Acme renewal only · 4 messages exchanged"
        />
        <PairedCard
          initials="◆"
          bg={C.violetW}
          fg={C.violetS}
          name="Vendor booking agent"
          paired="paired Jun 9"
          scope="TRUSTED"
          scopeColor={C.green}
          scopeBg="#E2F0E7"
          detail="Can place reservations on your behalf · always asks first"
        />
      </div>

      {/* Create invite */}
      <div
        style={{
          border: `1px dashed ${C.line2}`,
          borderRadius: 14,
          padding: 16,
          display: "flex",
          alignItems: "center",
          gap: 14,
          marginTop: 12,
        }}
      >
        <span style={{ width: 40, height: 40, borderRadius: 11, background: "#F4F6F9", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, color: C.t2, flexShrink: 0 }}>
          +
        </span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Create a one-time invite</div>
          <div style={{ fontSize: 12, color: C.t2 }}>
            Generate a scoped pairing link for an agent you trust
          </div>
        </div>
        <button
          type="button"
          style={{ fontSize: 12.5, background: C.blue, color: "#fff", border: "none", borderRadius: 9, padding: "9px 16px", cursor: "pointer" }}
        >
          New invite
        </button>
      </div>
    </div>
  );
}
