import { ApertureAvatar } from "@vellumai/design-library/components/aperture-avatar";

/** Meeting capture → recap (design v0.3 §01). Faithful design surface; live capture-session + STT extraction is the Phase-3 wiring. */

const C = {
  ink: "#1A2230",
  ink2: "#24303F",
  blue: "#3D6EE8",
  blueS: "#2B53C4",
  blueW: "#DBE4FB",
  violet: "#7F77DD",
  violetS: "#534AB7",
  bg: "#F4F6F9",
  surface: "#FFFFFF",
  sunken: "#EEF1F6",
  line: "#E5E9F0",
  line2: "#D7DDE7",
  t1: "#1A2230",
  t2: "#5A6672",
  t3: "#8D99A5",
  green: "#277E41",
} as const;
const mono = "'DM Mono', ui-monospace, monospace";

/* Scoped animations. Reduced-motion holds the dot solid and the bars at mid height. */
const ANIM_CSS = `
@keyframes mc-blink { 0%,100% { opacity: 1; } 50% { opacity: .25; } }
@keyframes mc-eq { 0%,100% { height: 6px; } 50% { height: 22px; } }
.mc-dot { animation: mc-blink 1s steps(1,end) infinite; }
.mc-bar { height: 14px; animation: mc-eq 900ms ease-in-out infinite; }
.mc-bar:nth-child(1) { animation-delay: 0ms; }
.mc-bar:nth-child(2) { animation-delay: 120ms; }
.mc-bar:nth-child(3) { animation-delay: 240ms; }
.mc-bar:nth-child(4) { animation-delay: 360ms; }
.mc-bar:nth-child(5) { animation-delay: 480ms; }
@media (prefers-reduced-motion: reduce) {
  .mc-dot { animation: none; }
  .mc-bar { animation: none; height: 14px; }
}
`;

const card = {
  background: C.surface,
  border: `1px solid ${C.line}`,
  borderRadius: 13,
  padding: "13px 15px",
} as const;
const cardTitle = { fontSize: 13.5, fontWeight: 500 } as const;
const cardBody = { fontSize: 12, color: C.t2, marginTop: 3 } as const;
const chipBase = {
  fontSize: 12,
  border: `1px solid ${C.line2}`,
  background: C.surface,
  borderRadius: 8,
  padding: "5px 10px",
  color: C.t1,
} as const;

function LiveCapture() {
  return (
    <div>
      <div
        style={{
          background: C.ink,
          borderRadius: 26,
          width: 300,
          margin: "0 auto",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* status bar */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "14px 16px 0",
            color: "#fff",
          }}
        >
          <span style={{ fontFamily: mono, fontSize: 13 }}>9:41</span>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              fontFamily: mono,
              fontSize: 11,
              color: "#fff",
              background: "rgba(226,75,74,.92)",
              padding: "3px 10px",
              borderRadius: 999,
            }}
          >
            <span
              className="mc-dot"
              style={{ width: 8, height: 8, borderRadius: "50%", background: "#fff" }}
            />
            rec 24:18
          </span>
        </div>

        {/* center column */}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            padding: 18,
            gap: 16,
            color: "#fff",
          }}
        >
          <ApertureAvatar state="listening" size={104} />

          {/* equalizer */}
          <div style={{ display: "flex", alignItems: "center", gap: 5, height: 26 }}>
            {[0, 1, 2, 3, 4].map((i) => (
              <span
                key={i}
                className="mc-bar"
                style={{ width: 4, borderRadius: 3, background: "#fff" }}
              />
            ))}
          </div>

          <div style={{ fontSize: 12, color: "#9DB4E6", textAlign: "center", lineHeight: 1.45 }}>
            Acme quarterly sync · 4 people
            <br />
            listening &amp; transcribing
          </div>

          {/* captured-live block */}
          <div
            style={{
              background: "rgba(255,255,255,.06)",
              borderRadius: 12,
              padding: "11px 13px",
              width: "100%",
            }}
          >
            <div style={{ fontFamily: mono, fontSize: 11, color: "#7E8BA3", marginBottom: 7 }}>
              Captured live →
            </div>
            <div
              style={{
                fontSize: 12.5,
                borderLeft: `3px solid ${C.blue}`,
                paddingLeft: 9,
                marginBottom: 8,
              }}
            >
              Action · you will share the Q3 forecast
            </div>
            <div style={{ fontSize: 12.5, borderLeft: `3px solid ${C.violet}`, paddingLeft: 9 }}>
              Decision · pricing holds through renewal
            </div>
          </div>
        </div>
      </div>

      <div
        style={{
          fontFamily: mono,
          fontSize: 11,
          color: C.t3,
          textAlign: "center",
          marginTop: 12,
        }}
      >
        Live · take it into the meeting (phone now, wearable later)
      </div>
    </div>
  );
}

function Recap() {
  return (
    <div
      style={{
        background: C.surface,
        border: `1px solid ${C.line}`,
        borderRadius: 14,
        padding: 18,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      {/* header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <ApertureAvatar size={28} />
        <div>
          <div style={{ fontWeight: 500 }}>Acme quarterly sync — recap</div>
          <div style={{ fontFamily: mono, fontSize: 11, color: C.t3 }}>
            26 min · 4 people · 09:00–09:26
          </div>
        </div>
      </div>

      {/* summary */}
      <div style={card}>
        <div style={cardTitle}>Summary</div>
        <div style={cardBody}>
          Renewal on track for Q3. Pricing stays. Dana wants the forecast before legal review. Warm
          tone; one open risk on timeline.
        </div>
      </div>

      {/* two-up */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div style={card}>
          <div style={cardTitle}>
            Action items{" "}
            <span
              style={{
                fontFamily: mono,
                fontSize: 10,
                padding: "1px 6px",
                borderRadius: 5,
                background: C.blueW,
                color: C.blueS,
              }}
            >
              3
            </span>
          </div>
          <div style={{ ...cardBody, marginTop: 6 }}>
            ☐ Share Q3 forecast — <b>you</b>
            <br />☐ Intro Dana ↔ Legal — <b>you</b>
            <br />☑ Send pricing one-pager — done
          </div>
        </div>
        <div style={card}>
          <div style={cardTitle}>People &amp; tone</div>
          <div style={{ ...cardBody, marginTop: 6 }}>
            Dana — decision-maker, positive
            <br />
            Sam — needs the deck
            <br />
            Risk flagged on timeline
          </div>
        </div>
      </div>

      {/* chips */}
      <div style={{ display: "flex", gap: 8 }}>
        <span style={{ ...chipBase, background: C.blue, borderColor: C.blue, color: "#fff" }}>
          Send follow-up draft
        </span>
        <span style={chipBase}>Add to tasks</span>
        <span style={chipBase}>Save to memory</span>
      </div>

      {/* note */}
      <div
        style={{
          background: "#fff",
          border: `1px solid ${C.line}`,
          borderLeft: `3px solid ${C.violet}`,
          borderRadius: "0 12px 12px 0",
          padding: "11px 14px",
          fontSize: 13,
          color: C.t2,
        }}
      >
        All of this writes into the 8-type memory with source = this meeting, so it surfaces before
        your next Acme touchpoint.
      </div>
    </div>
  );
}

export function MeetingCapturePage() {
  return (
    <div
      style={{
        fontFamily: "'DM Sans', system-ui, sans-serif",
        color: C.t1,
        maxWidth: 1040,
        margin: "0 auto",
        padding: 24,
      }}
    >
      <style>{ANIM_CSS}</style>

      {/* page header */}
      <div style={{ marginBottom: 22 }}>
        <div
          style={{
            fontFamily: mono,
            fontSize: 10.5,
            letterSpacing: ".1em",
            textTransform: "uppercase",
            color: C.blueS,
          }}
        >
          Meeting capture
        </div>
        <div style={{ fontSize: 24, fontWeight: 600, letterSpacing: "-.4px", marginTop: 6 }}>
          Capture → action items → memory
        </div>
        <div style={{ fontSize: 13.5, color: C.t2, marginTop: 6 }}>
          Cue listens in the room, extracts the decisions and to-dos live, then hands you a recap
          that writes itself into memory.
        </div>
      </div>

      {/* two-part responsive layout */}
      <div className="mc-grid">
        <div>
          <LiveCapture />
        </div>
        <div>
          <Recap />
        </div>
      </div>

      <style>{`
        .mc-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 24px;
          align-items: start;
        }
        @media (max-width: 900px) {
          .mc-grid { grid-template-columns: 1fr; }
        }
      `}</style>
    </div>
  );
}
