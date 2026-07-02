/**
 * Due-date chip — a calm mono label ("due in 2h" / "due tomorrow"), flipping
 * to the danger wash when the deadline has passed and the item is still live.
 */

import { useState } from "react";

import { C, mono } from "./theme";

const LIVE_STATUSES = new Set(["queued", "pending", "running", "awaiting_review"]);

function dueLabel(dueAt: number, now: number): string {
  const diff = dueAt - now;
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60_000);
  const hours = Math.round(abs / 3_600_000);
  const days = Math.round(abs / 86_400_000);
  const span =
    mins < 60 ? `${Math.max(1, mins)}m` : hours < 48 ? `${hours}h` : `${days}d`;
  return diff >= 0 ? `due in ${span}` : `overdue ${span}`;
}

export function DueChip({
  dueAt,
  status,
}: {
  dueAt: number | null;
  status: string;
}) {
  // Lazily-initialized so the reference time is stable across re-renders
  // (the react purity rule forbids Date.now() during render).
  const [now] = useState(() => Date.now());
  if (dueAt == null) return null;
  const overdue = dueAt < now && LIVE_STATUSES.has(status);
  return (
    <span
      style={{
        fontFamily: mono,
        fontSize: 10.5,
        letterSpacing: "0.03em",
        whiteSpace: "nowrap",
        padding: "2px 7px",
        borderRadius: 6,
        color: overdue ? C.danger : C.t3,
        background: overdue
          ? `color-mix(in srgb, ${C.danger} 12%, transparent)`
          : "transparent",
        border: overdue ? "none" : `1px solid ${C.line}`,
      }}
    >
      {dueLabel(dueAt, now)}
    </span>
  );
}
