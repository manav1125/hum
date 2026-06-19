/** Next moves — the unified queue (design v0.3 §02). Faithful design surface; live aggregation of email/chat/tasks/approvals/calls is the Phase-3 wiring. */

const C = {
  ink: "#1A2230",
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
  amber: "#F1B21E",
  danger: "#DA491A",
} as const;
const mono = "'DM Mono', ui-monospace, monospace";

type Urgency = "hi" | "md" | "lo";

const urgencyColor: Record<Urgency, string> = {
  hi: C.danger,
  md: C.amber,
  lo: C.line2,
};

interface QueueRow {
  urgency: Urgency;
  glyph: string;
  tileBg: string;
  title: string;
  /** Optional inline source tag rendered after the title (e.g. "from meeting"). */
  srcTag?: string;
  subtitle: string;
  /** Trailing action. "done" renders a muted mono tag instead of a chip. */
  action: { kind: "primary" | "default" | "done"; label: string };
}

const ROWS: QueueRow[] = [
  {
    urgency: "hi",
    glyph: "✉",
    tileBg: C.blueW,
    title: "Reply to Dana — renewal blocker",
    subtitle: "She's waiting since Tue · Cue drafted a reply",
    action: { kind: "primary", label: "Review draft" },
  },
  {
    urgency: "hi",
    glyph: "☎",
    tileBg: "#FDE7E2",
    title: "Approve · Cue will call Bottega to book",
    subtitle: "Thu 7pm, 4 people · uses saved card",
    action: { kind: "primary", label: "Approve" },
  },
  {
    urgency: "md",
    glyph: "✦",
    tileBg: "#EEEDFB",
    title: "Share Q3 forecast",
    srcTag: "from meeting",
    subtitle: "Came up twice with Acme · owner: you",
    action: { kind: "default", label: "Do it" },
  },
  {
    urgency: "md",
    glyph: "⧖",
    tileBg: "#FCF3DD",
    title: 'You promised Sam the deck "by Friday"',
    subtitle: "Captured from Slack · it's Friday",
    action: { kind: "default", label: "Send deck" },
  },
  {
    urgency: "lo",
    glyph: "✓",
    tileBg: "#E2F0E7",
    title: "Standup notes filed · 3 follow-ups created",
    subtitle: "Cue handled it · 8:00am",
    action: { kind: "done", label: "done" },
  },
];

function HeaderChip({ label, filled }: { label: string; filled?: boolean }) {
  return (
    <span
      style={{
        fontSize: 12,
        border: `1px solid ${filled ? C.ink : C.line2}`,
        background: filled ? C.ink : C.surface,
        color: filled ? "#fff" : C.t1,
        borderRadius: 8,
        padding: "5px 10px",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
      }}
    >
      {label}
    </span>
  );
}

function ActionChip({ action }: { action: QueueRow["action"] }) {
  if (action.kind === "done") {
    return (
      <span style={{ fontFamily: mono, fontSize: 11.5, color: C.t3 }}>{action.label}</span>
    );
  }
  const primary = action.kind === "primary";
  return (
    <button
      type="button"
      style={{
        fontSize: 12.5,
        fontWeight: 500,
        border: `1px solid ${primary ? C.blue : C.line2}`,
        background: primary ? C.blue : C.surface,
        color: primary ? "#fff" : C.t1,
        borderRadius: 9,
        padding: "7px 14px",
        cursor: "pointer",
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
    >
      {action.label}
    </button>
  );
}

function QueueRowItem({ row }: { row: QueueRow }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 13,
        padding: "13px 16px",
        borderBottom: `1px solid ${C.line}`,
      }}
    >
      <span
        style={{
          alignSelf: "stretch",
          width: 3,
          borderRadius: 3,
          background: urgencyColor[row.urgency],
          flexShrink: 0,
        }}
      />
      <span
        style={{
          width: 30,
          height: 30,
          borderRadius: 8,
          background: row.tileBg,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 15,
          flexShrink: 0,
        }}
      >
        {row.glyph}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13.5,
            fontWeight: 500,
            color: C.t1,
            display: "flex",
            alignItems: "center",
            gap: 7,
            flexWrap: "wrap",
          }}
        >
          {row.title}
          {row.srcTag ? (
            <span
              style={{
                fontFamily: mono,
                fontSize: 10.5,
                padding: "1px 6px",
                borderRadius: 5,
                background: "#EEEDFB",
                color: C.violetS,
              }}
            >
              {row.srcTag}
            </span>
          ) : null}
        </div>
        <div style={{ fontSize: 12, color: C.t2, marginTop: 2 }}>{row.subtitle}</div>
      </div>
      <ActionChip action={row.action} />
    </div>
  );
}

export function NextMovesPage() {
  return (
    <div
      style={{
        fontFamily: "'DM Sans', system-ui, sans-serif",
        color: C.t1,
        height: "100%",
        overflowY: "auto",
      }}
    >
      <div style={{ maxWidth: 860, margin: "0 auto", padding: 24 }}>
        {/* eyebrow */}
        <div
          style={{
            fontFamily: mono,
            fontSize: 11.5,
            letterSpacing: ".14em",
            textTransform: "uppercase",
            color: C.blueS,
          }}
        >
          Next moves
        </div>

        {/* header row */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
            marginTop: 8,
          }}
        >
          <div style={{ fontSize: 16, fontWeight: 500 }}>
            12 things · Cue ranked them for you
          </div>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <HeaderChip label="Needs you · 4" filled />
            <HeaderChip label="Waiting · 5" />
            <HeaderChip label="Scheduled · 3" />
          </div>
        </div>

        {/* queue list */}
        <div
          style={{
            marginTop: 16,
            border: `1px solid ${C.line}`,
            borderRadius: 14,
            background: C.surface,
            overflow: "hidden",
          }}
        >
          {ROWS.map((row, i) => (
            <QueueRowItem key={i} row={row} />
          ))}
        </div>

        {/* left-accent note */}
        <div
          style={{
            background: "#fff",
            border: `1px solid ${C.line}`,
            borderLeft: `3px solid ${C.violet}`,
            borderRadius: "0 12px 12px 0",
            padding: "11px 14px",
            fontSize: 13,
            color: C.t2,
            marginTop: 16,
          }}
        >
          Why it&apos;s world-class: every other app makes you check 5 inboxes. Cue reads them all
          and gives you one ranked list of what actually needs you — the literal product promise,
          &ldquo;never miss your next move.&rdquo;
        </div>
      </div>
    </div>
  );
}
