/** People dossier (design v0.3 §04). Faithful design surface; per-person rollup from contacts + memory + meeting capture is the Phase-3 wiring. */

const C = {
  ink: "#1A2230",
  blue: "#3D6EE8",
  blueS: "#2B53C4",
  blueW: "#DBE4FB",
  violet: "#7F77DD",
  violetS: "#534AB7",
  bg: "#F4F6F9",
  surface: "#FFFFFF",
  line: "#E5E9F0",
  line2: "#D7DDE7",
  t1: "#1A2230",
  t2: "#5A6672",
  t3: "#8D99A5",
  green: "#277E41",
  amber: "#F1B21E",
} as const;
const mono = "'DM Mono', ui-monospace, monospace";

type BadgeVariant = "blue" | "neutral" | "amber";

const badgeStyle: Record<BadgeVariant, { background: string; color: string }> = {
  blue: { background: C.blueW, color: C.blueS },
  neutral: { background: "#EEEDFB", color: C.violetS },
  amber: { background: "#FCF3DD", color: "#8C7225" },
};

function SrcBadge({ label, variant }: { label: string; variant: BadgeVariant }) {
  return (
    <span
      style={{
        fontFamily: mono,
        fontSize: 10.5,
        padding: "1px 6px",
        borderRadius: 5,
        ...badgeStyle[variant],
      }}
    >
      {label}
    </span>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        background: C.surface,
        border: `1px solid ${C.line}`,
        borderRadius: 13,
        padding: "13px 15px",
      }}
    >
      <div style={{ fontSize: 13.5, fontWeight: 500 }}>{title}</div>
      <div style={{ fontSize: 12, color: C.t2, marginTop: 3 }}>{children}</div>
    </div>
  );
}

function TimelineItem({
  time,
  title,
  badge,
  badgeVariant,
  sub,
}: {
  time: string;
  title: string;
  badge: string;
  badgeVariant: BadgeVariant;
  sub: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        padding: "11px 0",
        borderBottom: `1px solid ${C.line}`,
      }}
    >
      <span style={{ width: 46, flexShrink: 0, fontFamily: mono, fontSize: 11, color: C.t3 }}>{time}</span>
      <div>
        <div style={{ fontSize: 12.5, fontWeight: 500, display: "flex", alignItems: "center", gap: 7 }}>
          {title}
          <SrcBadge label={badge} variant={badgeVariant} />
        </div>
        <div style={{ fontSize: 12.5, color: C.t2 }}>{sub}</div>
      </div>
    </div>
  );
}

export function PeoplePage() {
  return (
    <div
      style={{
        fontFamily: "'DM Sans', system-ui, sans-serif",
        background: C.bg,
        color: C.t1,
        minHeight: "100%",
        overflowY: "auto",
      }}
    >
      <div style={{ maxWidth: 960, margin: "0 auto", padding: 24 }}>
        {/* page header */}
        <div style={{ marginBottom: 20 }}>
          <div
            style={{
              fontFamily: mono,
              fontSize: 10.5,
              letterSpacing: ".1em",
              textTransform: "uppercase",
              color: C.blueS,
              marginBottom: 6,
            }}
          >
            People
          </div>
          <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: "-.4px" }}>Relationship memory</div>
        </div>

        {/* dossier grid */}
        <div
          data-people-grid
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1.1fr) minmax(0, 1fr)",
            gap: 22,
          }}
        >
          {/* left column */}
          <div>
            {/* person header */}
            <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 14 }}>
              <div
                style={{
                  width: 46,
                  height: 46,
                  borderRadius: "50%",
                  background: C.blueW,
                  color: C.blueS,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontWeight: 500,
                  fontSize: 15,
                  flexShrink: 0,
                }}
              >
                DR
              </div>
              <div>
                <div style={{ fontSize: 17, fontWeight: 500 }}>Dana Reyes</div>
                <div style={{ fontSize: 12, color: C.t2 }}>VP Ops, Acme · decision-maker on the renewal</div>
              </div>
            </div>

            <div style={{ marginBottom: 10 }}>
              <Card title="How you know her">
                Intro&apos;d by Sam in March · 6 meetings · usually warm, direct, time-poor
              </Card>
            </div>

            <Card title="Open commitments">
              <span style={{ marginTop: 5, display: "block" }}>
                ☐ You → send Q3 forecast
                <br />
                ☐ You → intro her to Legal
                <br />
                ☐ She → confirm renewal date
              </span>
            </Card>
          </div>

          {/* right column */}
          <div>
            <div style={{ fontFamily: mono, fontSize: 11, color: C.t3, marginBottom: 8 }}>Recent interactions</div>

            <TimelineItem
              time="Jun 12"
              title="Quarterly sync"
              badge="meeting"
              badgeVariant="blue"
              sub="Pricing holds; wants forecast first"
            />
            <TimelineItem
              time="Jun 9"
              title="Email thread"
              badge="gmail"
              badgeVariant="neutral"
              sub="Asked about implementation timeline"
            />
            <TimelineItem
              time="May 28"
              title="Call"
              badge="phone"
              badgeVariant="amber"
              sub="Flagged budget approval needed by Q3"
            />

            <div
              style={{
                marginTop: 14,
                background: "#fff",
                border: `1px solid ${C.line}`,
                borderLeft: `3px solid ${C.violet}`,
                borderRadius: "0 12px 12px 0",
                padding: "11px 14px",
                fontSize: 13,
                color: C.t2,
              }}
            >
              Before any Dana touchpoint, Cue surfaces this automatically — so you walk in already caught up.
            </div>
          </div>
        </div>
      </div>

      <style>{`@media (max-width: 860px) {
        [data-people-grid] { grid-template-columns: 1fr !important; }
      }`}</style>
    </div>
  );
}
