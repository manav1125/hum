/**
 * Channels — faithful translation of `surfaces/Channels.dc.html`.
 *
 * "One you, every channel": an ink hero with the live constellation (Cue at
 * the centre, channels orbiting), Active channel cards, and a Connect-more
 * grid. Presentational for now — the channel-verification + messaging adapters
 * exist on the daemon and will be wired in; this is the design surface.
 */

const C = {
  ink: "#1A2230",
  blue: "#3D6EE8",
  blueS: "#2B53C4",
  blueW: "#DBE4FB",
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

const NODES = [
  { x: 210, y: 44, bg: "#fff", fg: "#1A2230", icon: "🎙", o: 0.7, dash: 1 },
  { x: 318, y: 78, bg: "#fff", fg: "#1A2230", icon: "✉", o: 0.5, dash: 1.3 },
  { x: 338, y: 160, bg: "#4A154B", fg: "#fff", icon: "#", o: 0.5, dash: 1.1 },
  { x: 300, y: 200, bg: "#E7F3FB", fg: "#229ED9", icon: "✈", o: 0.4, dash: 1.4 },
  { x: 96, y: 86, bg: "#EAF0FE", fg: "#3D6EE8", icon: "☎", o: 0.5, dash: 1.2 },
  { x: 110, y: 176, bg: "#5865F2", fg: "#fff", icon: "◍", o: 0.4, dash: 1.5 },
];

function Stat({ n, label }: { n: string; label: string }) {
  return (
    <div>
      <div style={{ fontSize: 22, fontWeight: 600, color: "#fff" }}>{n}</div>
      <div style={{ fontFamily: mono, fontSize: 10.5, color: "#7E8BA3" }}>
        {label}
      </div>
    </div>
  );
}

function LiveDot({ pulse }: { pulse?: boolean }) {
  return (
    <span
      className="cue-anim"
      style={{
        position: "relative",
        width: 7,
        height: 7,
        borderRadius: "50%",
        background: C.green,
        display: "inline-block",
      }}
    >
      {pulse && (
        <span
          style={{
            position: "absolute",
            inset: -3,
            borderRadius: "50%",
            border: "1.5px solid rgba(39,126,65,.5)",
            animation: "cuePulse 2s ease-out infinite",
          }}
        />
      )}
    </span>
  );
}

function ActiveCard({
  icon,
  iconBg,
  iconFg,
  title,
  sub,
  full,
  verified,
}: {
  icon: string;
  iconBg: string;
  iconFg: string;
  title: string;
  sub: string;
  full?: boolean;
  verified?: boolean;
}) {
  return (
    <div
      style={{
        border: `1px solid ${C.line}`,
        borderRadius: 14,
        padding: 16,
        background: full ? "#fff" : "linear-gradient(180deg,#FAFBFF,#fff)",
        gridColumn: full ? "span 2" : undefined,
        display: "flex",
        alignItems: "center",
        gap: 13,
      }}
    >
      <span
        style={{
          width: 44,
          height: 44,
          borderRadius: 12,
          background: iconBg,
          color: iconFg,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 19,
          flexShrink: 0,
        }}
      >
        {icon}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14.5, fontWeight: 600 }}>{title}</div>
        <div style={{ fontSize: 12, color: C.t2 }}>{sub}</div>
      </div>
      {verified ? (
        <>
          <span
            style={{
              fontFamily: mono,
              fontSize: 10,
              background: C.blueW,
              color: C.blueS,
              padding: "4px 10px",
              borderRadius: 7,
            }}
          >
            VERIFIED ID
          </span>
          <span
            style={{
              width: 42,
              height: 24,
              borderRadius: 999,
              background: C.blue,
              position: "relative",
              flexShrink: 0,
            }}
          >
            <span
              style={{
                position: "absolute",
                width: 20,
                height: 20,
                borderRadius: "50%",
                background: "#fff",
                top: 2,
                right: 2,
              }}
            />
          </span>
        </>
      ) : (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontFamily: mono,
            fontSize: 10,
            color: C.green,
          }}
        >
          <LiveDot pulse />
          LIVE
        </span>
      )}
    </div>
  );
}

function ConnectCard({
  icon,
  iconBg,
  iconFg,
  title,
  sub,
}: {
  icon: string;
  iconBg: string;
  iconFg: string;
  title: string;
  sub: string;
}) {
  return (
    <div
      style={{
        border: `1px solid ${C.line}`,
        borderRadius: 14,
        padding: 16,
        textAlign: "center",
      }}
    >
      <span
        style={{
          width: 48,
          height: 48,
          borderRadius: 13,
          background: iconBg,
          color: iconFg,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 21,
          marginBottom: 11,
        }}
      >
        {icon}
      </span>
      <div style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>
      <div style={{ fontSize: 11.5, color: C.t2, margin: "3px 0 11px" }}>
        {sub}
      </div>
      <button
        type="button"
        style={{
          fontSize: 12.5,
          border: `1px solid ${C.line2}`,
          background: "#fff",
          borderRadius: 9,
          padding: "7px 18px",
          cursor: "pointer",
          color: C.t1,
        }}
      >
        Enable
      </button>
    </div>
  );
}

const label = {
  fontFamily: mono,
  fontSize: 10.5,
  letterSpacing: ".1em",
  textTransform: "uppercase" as const,
  color: C.t3,
  margin: "24px 0 12px",
};

export function ChannelsPage() {
  return (
    <div style={{ padding: "0 0 28px", fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <style dangerouslySetInnerHTML={{ __html: KEYFRAMES }} />

      {/* IMMERSIVE HERO */}
      <div
        style={{
          position: "relative",
          background: C.ink,
          borderRadius: 18,
          overflow: "hidden",
          display: "grid",
          gridTemplateColumns: "1fr 420px",
          alignItems: "center",
          minHeight: 240,
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "radial-gradient(420px 240px at 82% 50%,rgba(61,110,232,.22),transparent 70%)",
          }}
        />
        <div style={{ padding: "34px 36px", position: "relative" }}>
          <div
            style={{
              fontFamily: mono,
              fontSize: 11,
              letterSpacing: ".14em",
              textTransform: "uppercase",
              color: "#7FA0F0",
            }}
          >
            Channels · live
          </div>
          <div
            style={{
              fontSize: 32,
              fontWeight: 600,
              letterSpacing: "-1px",
              color: "#fff",
              marginTop: 10,
              lineHeight: 1.06,
            }}
          >
            One you,
            <br />
            every channel.
          </div>
          <p
            style={{
              fontSize: 14.5,
              color: "#AEB7C7",
              marginTop: 12,
              maxWidth: 380,
            }}
          >
            Connect a channel, verify once, and Cue recognizes you wherever you
            reach it — voice, email, chat, or a phone call. One memory behind
            them all.
          </p>
          <div style={{ display: "flex", gap: 18, marginTop: 18 }}>
            <Stat n="3" label="active" />
            <div style={{ width: 1, background: "rgba(255,255,255,.12)" }} />
            <Stat n="1" label="verified id" />
            <div style={{ width: 1, background: "rgba(255,255,255,.12)" }} />
            <Stat n="3" label="available" />
          </div>
        </div>

        {/* constellation */}
        <div className="cue-anim" style={{ position: "relative", height: 240 }}>
          <svg
            width="420"
            height="240"
            viewBox="0 0 420 240"
            style={{ position: "absolute", inset: 0 }}
          >
            {NODES.map((n, i) => (
              <line
                key={i}
                x1="210"
                y1="120"
                x2={n.x}
                y2={n.y}
                stroke={C.blue}
                strokeWidth="1.5"
                strokeDasharray="3 4"
                opacity={n.o}
                style={{ animation: `cueDash ${n.dash}s linear infinite` }}
              />
            ))}
          </svg>
          <div
            style={{
              position: "absolute",
              left: 210,
              top: 120,
              transform: "translate(-50%,-50%)",
              width: 62,
              height: 62,
              borderRadius: 17,
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
                borderRadius: 17,
                border: "2px solid rgba(61,110,232,.6)",
                animation: "cuePulse 2.4s ease-out infinite",
              }}
            />
            <span
              style={{
                fontSize: 34,
                fontWeight: 600,
                color: "#EEF2F7",
                position: "relative",
                lineHeight: 1,
              }}
            >
              C
              <span
                style={{
                  position: "absolute",
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: C.blue,
                  right: 9,
                  bottom: 12,
                }}
              />
            </span>
          </div>
          {NODES.map((n, i) => (
            <div
              key={i}
              style={{
                position: "absolute",
                left: n.x,
                top: n.y,
                transform: "translate(-50%,-50%)",
                width: 37,
                height: 37,
                borderRadius: 11,
                background: n.bg,
                color: n.fg,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 16,
                boxShadow: "0 6px 14px -6px rgba(0,0,0,.5)",
              }}
            >
              {n.icon}
            </div>
          ))}
        </div>
      </div>

      {/* ACTIVE */}
      <div style={label}>Active</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <ActiveCard
          icon="🎙"
          iconBg={C.ink}
          iconFg="#fff"
          title="Voice"
          sub="Hold-to-talk & hands-free, on device"
        />
        <ActiveCard
          icon="✉"
          iconBg="#FDECEA"
          iconFg="#1A2230"
          title="Email"
          sub="Triage, draft, and send on your behalf"
        />
        <ActiveCard
          icon="#"
          iconBg="#4A154B"
          iconFg="#fff"
          title="Slack"
          sub="DMs and mentions — verified as you across the workspace"
          full
          verified
        />
      </div>

      {/* CONNECT MORE */}
      <div style={label}>Connect more</div>
      <div
        style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}
      >
        <ConnectCard
          icon="✈"
          iconBg="#E7F3FB"
          iconFg="#229ED9"
          title="Telegram"
          sub="Message from your phone"
        />
        <ConnectCard
          icon="☎"
          iconBg="#EAF0FE"
          iconFg="#3D6EE8"
          title="Phone calling"
          sub="Place & take calls via Twilio"
        />
        <ConnectCard
          icon="◍"
          iconBg="#5865F2"
          iconFg="#fff"
          title="Discord"
          sub="Servers & direct messages"
        />
      </div>
    </div>
  );
}
