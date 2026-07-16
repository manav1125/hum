/**
 * First-run explainer — three calm cards that teach the work loop the first
 * time you land on HQ, then never again. "It picks things up → It does the
 * work → You sign off." Shown once per browser profile (localStorage-gated),
 * dismissible, and deliberately short — three cards, not a wall of text.
 * Design: autonomy-states v2 (first-run).
 */
import { StateBadge } from "@vellumai/design-library";
import { useState } from "react";

import { C, mono, serif } from "./hq-kit";

const STORAGE_KEY = "cue:hq:firstrun:v1";

/** True once per profile — whether to show the first-run explainer. */
export function useHqFirstRun(): { show: boolean; dismiss: () => void } {
  const [show, setShow] = useState(() => {
    try {
      return globalThis.localStorage?.getItem(STORAGE_KEY) == null;
    } catch {
      return false;
    }
  });
  const dismiss = () => {
    setShow(false);
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, "1");
    } catch {
      // Private-mode storage failures just mean it may show again.
    }
  };
  return { show, dismiss };
}

const STEPS: Array<{
  state: "capture" | "running" | "review";
  n: string;
  title: string;
  body: string;
}> = [
  {
    state: "capture",
    n: "1 / 3",
    title: "It picks things up.",
    body: "Cue reads your channels and quietly captures the commitments — you'll see them arrive in Inbound, with who asked and where.",
  },
  {
    state: "running",
    n: "2 / 3",
    title: "It does the work.",
    body: "A named agent runs it in the background. Anything consequential pauses for your OK — it never sends on your behalf without asking.",
  },
  {
    state: "review",
    n: "3 / 3",
    title: "You sign off.",
    body: "Finished work waits in Review. Approve it, or send it back with a note. Nothing closes until you say so.",
  },
];

export function HqFirstRun({ onDismiss }: { onDismiss: () => void }) {
  return (
    <section
      aria-label="How the work loop works"
      style={{
        marginTop: 16,
        border: `1px solid ${C.line}`,
        borderRadius: 14,
        background: C.surface,
        padding: "16px 18px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div style={{ fontFamily: serif, fontSize: 20, color: C.ink }}>
          Here's how Cue works.
        </div>
        <div
          style={{
            fontFamily: mono,
            fontSize: 10.5,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: C.t3,
          }}
        >
          Shown once
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 12,
          marginTop: 14,
        }}
      >
        {STEPS.map((s) => (
          <div
            key={s.n}
            style={{
              border: `1px solid ${C.line}`,
              borderRadius: 12,
              padding: "12px 13px",
              background: C.sunken,
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <StateBadge state={s.state} size="sm" showLabel={false} />
              <span style={{ fontFamily: mono, fontSize: 9.5, color: C.t3 }}>
                STEP {s.n}
              </span>
            </div>
            <div style={{ fontSize: 14, fontWeight: 600, color: C.ink }}>
              {s.title}
            </div>
            <div style={{ fontSize: 12.5, color: C.t2, lineHeight: 1.45 }}>
              {s.body}
            </div>
          </div>
        ))}
      </div>

      <div
        style={{ marginTop: 14, display: "flex", justifyContent: "flex-end" }}
      >
        <button
          type="button"
          onClick={onDismiss}
          style={{
            fontSize: 12.5,
            fontWeight: 600,
            background: C.blue,
            color: "#fff",
            border: "none",
            borderRadius: 9,
            padding: "8px 15px",
            cursor: "pointer",
          }}
        >
          Got it — show my board
        </button>
      </div>
    </section>
  );
}
