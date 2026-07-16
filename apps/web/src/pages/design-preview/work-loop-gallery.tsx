/**
 * Work-loop design-system gallery — a public, backend-free preview of the
 * autonomy work-loop primitives (state tokens, StateBadge, AgentChip,
 * WorkLoopCard) rendered with sample data. Used to visually verify the design
 * system in isolation; it is not part of the product IA. Route:
 * `/design-preview/work-loop`.
 */
import {
  AgentChip,
  StateBadge,
  WORK_STATE_META,
  WorkLoopCard,
  type WorkLoopState,
} from "@vellumai/design-library";
import { useState } from "react";

const STATES: WorkLoopState[] = [
  "capture",
  "running",
  "needsyou",
  "review",
  "done",
  "failure",
];

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section style={{ marginBottom: 40 }}>
      <h2
        style={{
          fontFamily: "var(--font-serif)",
          fontSize: 24,
          margin: "0 0 4px",
          color: "var(--content-emphasised)",
        }}
      >
        {title}
      </h2>
      {subtitle ? (
        <p
          style={{
            margin: "0 0 16px",
            color: "var(--content-secondary)",
            fontSize: 14,
          }}
        >
          {subtitle}
        </p>
      ) : null}
      {children}
    </section>
  );
}

export function WorkLoopGallery() {
  const [theme, setTheme] = useState<"light" | "dark">("light");

  return (
    <div
      data-theme={theme}
      style={{
        minHeight: "100vh",
        background: "var(--background)",
        color: "var(--content-default)",
        padding: 40,
        fontFamily: "var(--font-sans)",
      }}
    >
      <div style={{ maxWidth: 1180, margin: "0 auto" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 8,
          }}
        >
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              letterSpacing: 2,
              textTransform: "uppercase",
              color: "var(--content-tertiary)",
            }}
          >
            Autonomy work-loop · design system
          </div>
          <button
            type="button"
            onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
            style={{
              fontSize: 12,
              padding: "6px 12px",
              borderRadius: 8,
              border: "1px solid var(--border-base)",
              background: "var(--surface-lift)",
              color: "var(--content-default)",
              cursor: "pointer",
            }}
          >
            {theme === "light" ? "◑ Dark" : "◐ Light"}
          </button>
        </div>
        <h1
          style={{
            fontFamily: "var(--font-serif)",
            fontSize: 44,
            margin: "0 0 32px",
            color: "var(--content-emphasised)",
          }}
        >
          The whole loop, in components.
        </h1>

        <Section
          title="State taxonomy"
          subtitle="One vocabulary. Red is reserved for failure only."
        >
          <div style={{ display: "flex", flexWrap: "wrap", gap: 20 }}>
            {STATES.map((s) => (
              <div key={s} style={{ minWidth: 150 }}>
                <StateBadge state={s} />
                <div
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    color: "var(--content-tertiary)",
                    marginTop: 8,
                  }}
                >
                  {WORK_STATE_META[s].phrase}
                </div>
              </div>
            ))}
          </div>
        </Section>

        <Section
          title="Agent identity"
          subtitle="Color + glyph per agent. Never fake faces."
        >
          <div style={{ display: "flex", flexWrap: "wrap", gap: 20 }}>
            <AgentChip name="Ops" detail="while away" />
            <AgentChip name="Growth" detail="4 min" />
            <AgentChip name="Inbox" detail="auto" />
            <AgentChip name="Builder" detail="drafting" />
          </div>
        </Section>

        <Section
          title="The card, every state"
          subtitle="One component, parameterized by state."
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
              gap: 16,
            }}
          >
            <WorkLoopCard
              state="capture"
              title="Send signed NDA by Fri"
              source={
                <span>
                  <b style={{ color: "var(--content-default)" }}>Rachel</b> ·
                  Slack
                </span>
              }
              actions={[
                { label: "Confirm" },
                { label: "Dismiss", variant: "secondary" },
              ]}
            />
            <WorkLoopCard
              state="running"
              title="Competitor pricing table"
              agent={{ name: "Growth", detail: "4 min" }}
              progress="5 of 8 sources"
              why={
                <span>
                  Growth's plan: pull public pricing for 8 competitors,
                  normalise to per-seat, flag gaps vs ours.
                </span>
              }
            />
            <WorkLoopCard
              state="needsyou"
              title="NDA reply — drafted, not sent"
              progress="3 of 4 done"
              reason={
                <span>
                  Last step waited for your OK and timed out — so Cue stopped
                  instead of sending.
                </span>
              }
              actions={[{ label: "Approve & finish" }]}
            />
            <WorkLoopCard
              state="review"
              title="Acme one-pager"
              agent={{ name: "Ops", detail: "while away" }}
              actions={[
                { label: "Approve → done" },
                { label: "Redo with notes", variant: "secondary" },
              ]}
            />
            <WorkLoopCard
              state="done"
              title="Sent renewal quote"
              agent={{ name: "Ops", detail: "you approved" }}
            />
            <WorkLoopCard
              state="failure"
              title="Pull Q2 numbers from QuickBooks"
              agent={{ name: "Ops", detail: "stopped after 2 tries" }}
              reason={
                <span>
                  QuickBooks rejected the connection — the token expired.
                  Nothing was changed on their end.
                </span>
              }
              actions={[
                { label: "Reconnect & retry" },
                { label: "Tell Cue what happened", variant: "secondary" },
              ]}
            />
          </div>
        </Section>
      </div>
    </div>
  );
}

export default WorkLoopGallery;
