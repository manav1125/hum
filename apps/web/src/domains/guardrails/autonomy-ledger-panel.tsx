/**
 * WHAT CUE DID — the autonomy-ledger band on the Guardrails page.
 *
 * The existing "THE LEDGER" band is a *value* ledger: completed background
 * runs, what they cost, and what the owner can reverse. This band is the
 * *consequence* ledger, and it exists because of a specific failure: a
 * background run emailed an external partner with no approval, and the owner
 * only found out days later when the partner replied — there was nowhere to
 * look.
 *
 * It answers one question, in the owner's own words: **what did Cue actually
 * do on my behalf while I wasn't watching?** Every consequential action Cue
 * attempted — external send, call, money, publish, delete, purchase, a shell
 * reaching the network, a browser Send button, a file written on the Mac —
 * with whether anyone was in the room and who approved it.
 *
 * Honesty rules, matching the rest of the surface: an action with
 * `approvedVia: "auto"` is labelled "nobody asked", never dressed up; parked
 * and denied rows are shown alongside executed ones, because "Cue tried and
 * was stopped" is exactly as important as "Cue did it"; and the panel never
 * renders a number the daemon didn't measure.
 */

import { Loader2 } from "lucide-react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { ledgerAutonomyGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import type { LedgerAutonomyGetResponse } from "@/generated/daemon/types.gen";

type LedgerPayload = LedgerAutonomyGetResponse;
type LedgerEntry = LedgerPayload["entries"][number];

/** Local mirror of the page's `--mv1-*` token map (no cross-domain imports). */
const C = {
  surface: "var(--mv1-card)",
  sunken: "var(--mv1-sunken)",
  line: "var(--mv1-line)",
  t1: "var(--mv1-t1)",
  t2: "var(--mv1-t2)",
  t3: "var(--mv1-t3)",
  green: "var(--mv1-green)",
  amber: "var(--mv1-amber)",
  amberText: "var(--mv1-amber-text)",
  danger: "var(--mv1-danger)",
} as const;
const mono = "'DM Mono', ui-monospace, monospace";

/** One glyph per consequence class — a scannable left rail. */
const CLASS_GLYPH: Record<string, string> = {
  send: "✉",
  contact: "☎",
  money: "$",
  publish: "▲",
  delete: "␥",
  purchase: "⛁",
  host_file: "▤",
  network_egress: "⇗",
  browser_submit: "⏎",
  schedule_script: "◷",
  external_runner: "⚙",
  other: "•",
};

const OUTCOME_STYLE: Record<string, { label: string; color: string }> = {
  executed: { label: "DONE", color: C.green },
  parked: { label: "PARKED", color: C.amberText },
  denied: { label: "BLOCKED", color: C.danger },
  failed: { label: "FAILED", color: C.t3 },
};

/**
 * How the action was authorised, in plain words. `auto` is the one that
 * matters — it means the action reached the outside world without a human
 * ever being asked.
 */
const APPROVAL_LABEL: Record<string, string> = {
  inline_card: "you approved it",
  trust_rule: "a standing rule cleared it",
  scoped_grant: "a one-time grant cleared it",
  auto: "nobody was asked",
};

/**
 * Absolute local timestamp rather than a relative age: this is an audit
 * record, "Jul 28, 14:32" is what you cross-reference against a partner's
 * reply — and it keeps the row a pure function of its data.
 */
function stamp(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function approvalNote(entry: LedgerEntry): string | null {
  if (entry.outcome !== "executed") return null;
  return APPROVAL_LABEL[entry.approvedVia ?? "auto"] ?? null;
}

export function AutonomyLedgerBand({
  assistantId,
  days,
  isMobile,
}: {
  assistantId: string;
  days: number;
  isMobile: boolean;
}) {
  const [unattendedOnly, setUnattendedOnly] = useState(false);

  const query = useQuery(
    ledgerAutonomyGetOptions({
      path: { assistant_id: assistantId },
      query: {
        days,
        limit: 25,
        ...(unattendedOnly ? { unattendedOnly: "true" } : {}),
      },
    }),
  );

  if (query.isLoading) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 12.5,
          color: C.t3,
          padding: "12px 2px",
        }}
      >
        <Loader2 className="size-3.5 animate-spin" /> Reading the ledger…
      </div>
    );
  }

  if (query.isError || !query.data) {
    return (
      <div style={{ fontSize: 12.5, color: C.t2, padding: "10px 2px" }}>
        Couldn&rsquo;t read the ledger just now. Nothing was lost — it&rsquo;s
        written as each action happens.
      </div>
    );
  }

  const { entries, summary } = query.data;

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <Headline summary={summary} isMobile={isMobile} />

      <div
        style={{
          display: "flex",
          gap: 6,
          padding: "0 2px 10px",
          alignItems: "center",
        }}
      >
        <FilterChip
          active={!unattendedOnly}
          label="Everything"
          onClick={() => setUnattendedOnly(false)}
        />
        <FilterChip
          active={unattendedOnly}
          label="While you were away"
          onClick={() => setUnattendedOnly(true)}
        />
      </div>

      {entries.length === 0 ? (
        <div style={{ fontSize: 12.5, color: C.t3, padding: "8px 2px" }}>
          {unattendedOnly
            ? "Nothing consequential happened while you were away."
            : "Cue hasn’t taken a consequential action in this window. Reading, drafting and internal work aren’t listed here — only things that reach outside or can’t be undone."}
        </div>
      ) : (
        entries.map((entry, i) => (
          <EntryRow
            key={entry.id}
            entry={entry}
            last={i === entries.length - 1}
          />
        ))
      )}
    </div>
  );
}

function Headline({
  summary,
  isMobile,
}: {
  summary: LedgerPayload["summary"];
  isMobile: boolean;
}) {
  const alarming = summary.executedWithoutApproval > 0;
  return (
    <div
      style={{
        background: C.sunken,
        border: `1px solid ${C.line}`,
        borderLeft: `3px solid ${alarming ? C.amber : C.line}`,
        borderRadius: "0 10px 10px 0",
        padding: "10px 13px",
        marginBottom: 12,
        fontSize: isMobile ? 12 : 12.5,
        color: C.t2,
        lineHeight: 1.55,
      }}
    >
      <span style={{ fontFamily: mono, color: C.t1 }}>
        {summary.total} consequential {summary.total === 1 ? "action" : "actions"}
      </span>
      {" · "}
      {summary.executed} done · {summary.parked} parked · {summary.denied}{" "}
      blocked
      {summary.total > 0 && (
        <>
          <br />
          <span style={{ color: alarming ? C.amber : C.t3 }}>
            {summary.executedUnattended} ran while you were away
            {summary.executedWithoutApproval > 0
              ? ` — ${summary.executedWithoutApproval} with nobody asked`
              : " — all of them approved"}
            .
          </span>
        </>
      )}
    </div>
  );
}

function FilterChip({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        fontFamily: mono,
        fontSize: 10.5,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        padding: "4px 9px",
        borderRadius: 999,
        border: `1px solid ${active ? "transparent" : C.line}`,
        background: active ? C.t1 : "transparent",
        color: active ? C.surface : C.t3,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

function EntryRow({ entry, last }: { entry: LedgerEntry; last: boolean }) {
  const outcome = OUTCOME_STYLE[entry.outcome] ?? OUTCOME_STYLE.failed;
  const note = approvalNote(entry);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
        padding: "11px 14px",
        borderBottom: last ? "none" : `1px solid ${C.line}`,
      }}
    >
      <span
        aria-hidden
        style={{
          fontSize: 13,
          lineHeight: "18px",
          color: C.t3,
          width: 16,
          textAlign: "center",
          flexShrink: 0,
        }}
      >
        {CLASS_GLYPH[entry.actionClass] ?? CLASS_GLYPH.other}
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 13, color: C.t1, lineHeight: 1.45 }}>
          {entry.summary}
        </div>
        <div
          style={{
            fontFamily: mono,
            fontSize: 10.5,
            color: C.t3,
            marginTop: 3,
            wordBreak: "break-word",
          }}
        >
          {stamp(entry.at)} · {entry.toolName}
          {entry.agent ? ` · ${entry.agent}` : ""}
          {note ? ` · ${note}` : ""}
        </div>
        {entry.reason && entry.outcome !== "parked" && (
          <div style={{ fontSize: 11.5, color: C.t3, marginTop: 3 }}>
            {entry.reason}
          </div>
        )}
      </div>
      <span
        style={{
          fontFamily: mono,
          fontSize: 9.5,
          letterSpacing: "0.06em",
          color: outcome.color,
          border: `1px solid ${outcome.color}`,
          borderRadius: 4,
          padding: "2px 5px",
          flexShrink: 0,
          whiteSpace: "nowrap",
        }}
      >
        {outcome.label}
      </span>
    </div>
  );
}
