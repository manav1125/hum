/**
 * Shared "act" chrome for work surfaces — the mono kicker + serif headline
 * group header and its spacing block. Extracted from the command center so
 * the Projects and All-work pages share the exact same visual language
 * instead of forking it.
 */

import type { ReactNode } from "react";

import { C, mono, serif } from "./theme";

export function GroupHeader({
  kicker,
  title,
  hint,
  accent = C.t2,
  pinned = false,
}: {
  kicker: string;
  title: string;
  hint?: string;
  accent?: string;
  pinned?: boolean;
}) {
  return (
    <div
      style={{
        marginBottom: 14,
        paddingLeft: pinned ? 12 : 0,
        borderLeft: pinned ? `3px solid ${accent}` : undefined,
      }}
    >
      <div
        style={{
          fontFamily: mono,
          fontSize: 11,
          letterSpacing: "0.16em",
          textTransform: "uppercase",
          color: accent,
        }}
      >
        {kicker}
      </div>
      <div
        style={{
          fontFamily: serif,
          fontSize: 26,
          letterSpacing: "-0.4px",
          lineHeight: 1.1,
          color: C.ink,
          marginTop: 2,
        }}
      >
        {title}
      </div>
      {hint ? (
        <div style={{ fontSize: 12.5, color: C.t3, marginTop: 4 }}>{hint}</div>
      ) : null}
    </div>
  );
}

export function GroupBlock({ children }: { children: ReactNode }) {
  return <div style={{ marginBottom: 30 }}>{children}</div>;
}
