import { useState } from "react";

/**
 * Trust & consent console (design v0.3 §03). Faithful design surface; binding
 * capture toggles + the audit feed to security/permissions/approvals is the
 * Phase-3 wiring.
 */

const C = {
  ink: "#1A2230",
  blue: "#3D6EE8",
  blueS: "#2B53C4",
  blueW: "#DBE4FB",
  violet: "#7F77DD",
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

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onClick}
      style={{
        position: "relative",
        display: "inline-flex",
        width: 38,
        height: 22,
        borderRadius: 999,
        border: "none",
        padding: 0,
        cursor: "pointer",
        background: on ? C.blue : C.line2,
        flexShrink: 0,
        transition: "background .15s",
      }}
    >
      <span
        style={{
          position: "absolute",
          width: 18,
          height: 18,
          borderRadius: "50%",
          background: "#fff",
          top: 2,
          left: on ? 18 : 2,
          transition: "left .15s",
        }}
      />
    </button>
  );
}

function TrustRow({
  title,
  subtitle,
  on,
  onToggle,
}: {
  title: string;
  subtitle: string;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <div>
        <div style={{ fontSize: 14, fontWeight: 500, color: C.t1 }}>{title}</div>
        <div style={{ fontSize: 12, color: C.t2 }}>{subtitle}</div>
      </div>
      <Toggle on={on} onClick={onToggle} />
    </div>
  );
}

function SrcBadge({ label, bg, color }: { label: string; bg: string; color: string }) {
  return (
    <span
      style={{
        fontFamily: mono,
        fontSize: 10,
        padding: "1px 6px",
        borderRadius: 5,
        background: bg,
        color,
      }}
    >
      {label}
    </span>
  );
}

function ActorCard({
  title,
  badge,
  subtitle,
}: {
  title: string;
  badge: React.ReactNode;
  subtitle: string;
}) {
  return (
    <div
      style={{
        background: C.surface,
        border: `1px solid ${C.line}`,
        borderRadius: 13,
        padding: "13px 15px",
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 500, color: C.t1, display: "flex", alignItems: "center", gap: 8 }}>
        {title} {badge}
      </div>
      <div style={{ fontSize: 12, color: C.t2, marginTop: 2 }}>{subtitle}</div>
    </div>
  );
}

const panelChrome = {
  background: C.surface,
  border: `1px solid ${C.line}`,
  borderRadius: 14,
  padding: 18,
  display: "flex",
  flexDirection: "column" as const,
};

const panelTitle = {
  fontFamily: mono,
  fontSize: 10.5,
  letterSpacing: ".1em",
  textTransform: "uppercase" as const,
  color: C.t3,
  marginBottom: 14,
};

export function TrustConsolePage() {
  const [alwaysOnCapture, setAlwaysOnCapture] = useState(false);
  const [recordingIndicator, setRecordingIndicator] = useState(true);
  const [autoDeleteAudio, setAutoDeleteAudio] = useState(true);

  return (
    <div style={{ fontFamily: "'DM Sans', system-ui, sans-serif", color: C.t1 }}>
      <div style={{ maxWidth: 1040, margin: "0 auto", padding: 24 }}>
        {/* header */}
        <div
          style={{
            fontFamily: mono,
            fontSize: 11,
            letterSpacing: ".14em",
            textTransform: "uppercase",
            color: C.blueS,
          }}
        >
          Trust &amp; consent
        </div>
        <h1 style={{ fontSize: 26, fontWeight: 600, letterSpacing: "-.5px", margin: "6px 0 0" }}>
          Trust &amp; consent console
        </h1>

        {/* two panels */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 380px), 1fr))",
            gap: 18,
            marginTop: 22,
            alignItems: "start",
          }}
        >
          {/* Panel 1 — Trust & capture */}
          <div style={{ ...panelChrome, gap: 12 }}>
            <div style={panelTitle}>Trust &amp; capture</div>
            <TrustRow
              title="Always-on capture"
              subtitle="Mic listens in meetings you start"
              on={alwaysOnCapture}
              onToggle={() => setAlwaysOnCapture((v) => !v)}
            />
            <TrustRow
              title="Recording indicator"
              subtitle="Always show a visible light when listening"
              on={recordingIndicator}
              onToggle={() => setRecordingIndicator((v) => !v)}
            />
            <TrustRow
              title="Auto-delete raw audio"
              subtitle="Keep insights, drop the recording after 24h"
              on={autoDeleteAudio}
              onToggle={() => setAutoDeleteAudio((v) => !v)}
            />
            <div
              style={{
                background: "#fff",
                border: `1px solid ${C.line}`,
                borderLeft: `3px solid ${C.blue}`,
                borderRadius: "0 12px 12px 0",
                padding: "11px 14px",
                fontSize: 13,
                color: C.t2,
              }}
            >
              Consent-first by design. Capture is off until you turn it on, per meeting — the
              groundwork the wearable needs.
            </div>
          </div>

          {/* Panel 2 — Who can reach Cue · audit */}
          <div style={{ ...panelChrome, gap: 10 }}>
            <div style={panelTitle}>Who can reach Cue · audit</div>
            <ActorCard
              title="You — guardian"
              badge={<SrcBadge label="full" bg="#E2F0E7" color={C.green} />}
              subtitle="Every capability, every channel"
            />
            <ActorCard
              title="Dana — trusted"
              badge={<SrcBadge label="scoped" bg={C.blueW} color={C.blueS} />}
              subtitle="Can ask Cue about shared projects only"
            />
            <ActorCard
              title="Unknown actors"
              badge={<SrcBadge label="denied" bg="#EEEDFB" color="#534AB7" />}
              subtitle="No memory read, no tools — fail closed"
            />
            <div style={{ marginTop: 4 }}>
              <div
                style={{
                  fontFamily: mono,
                  fontSize: 10.5,
                  letterSpacing: ".1em",
                  textTransform: "uppercase",
                  color: C.t3,
                  marginBottom: 6,
                }}
              >
                Recent decisions
              </div>
              <div style={{ fontSize: 12.5, color: C.t2 }}>
                09:12 approved · book reservation
                <br />
                08:40 denied · unknown caller asked for calendar
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
