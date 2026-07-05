/**
 * §5 · The trust ceremony — the grant sheet.
 *
 * An agent earns its way into Needs-you by asking for more rope; the owner
 * grants it on evidence. This sheet shows the exact scope — VERB · CHANNEL ·
 * LIMIT — alongside the track record ("34 approved · 0 reversed", or
 * "measuring…" when the ledger is still empty), then offers three doors:
 *
 *   Grant this scope   → persists the standing permission (POST /confirm with
 *                        always_allow + pattern/scope) when mounted from a live
 *                        confirmation card; otherwise defers to onGrant.
 *   Keep asking        → dismiss, no change — the agent keeps requesting.
 *   Never — add a line → appends a never-line to the company profile.
 *
 * Presentational + self-wiring: pass a `requestId` (from the confirmation card)
 * and the sheet handles Grant itself; pass `onGrant` to fully own the write.
 * Export mounted by the caller over its confirmation cards.
 */

import { useState } from "react";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";

import { C, mono, serif } from "./hq-kit";
import { usePutCompanyProfile } from "./use-missions";
import { grantTrustScope, useActsEvidence } from "./use-trust-evidence";

export interface TrustGrantScope {
  /** The agent requesting more rope (also the acts-summary filter). */
  agent: string;
  /** One-line plain-English summary, e.g. "Send the weekly update, unattended." */
  summary: string;
  /** VERB row — "Send email — investor update only". */
  verb: string;
  /** CHANNEL row — "daily@cue.app → your cap table list". */
  channel: string;
  /** LIMIT row — "Mondays 8:00 · 1× / week · $0 spend". */
  limit: string;
  /** Live confirmation to resolve on Grant (persistent always_allow path). */
  requestId?: string;
  /** Allowlist pattern for the persistent decision. */
  pattern?: string;
  /** Scope for the persistent decision. */
  scope?: string;
  /** The never-line "Never" appends; defaults to a sentence from the verb. */
  neverLine?: string;
  /** Sample count behind the "See N samples ›" affordance. */
  sampleCount?: number;
}

export function TrustGrantSheet({
  scope,
  currentNeverLines = [],
  onGrant,
  onGranted,
  onKeepAsking,
  onNever,
  onSamples,
}: {
  scope: TrustGrantScope;
  /** Existing never-lines so "Never" appends without clobbering. */
  currentNeverLines?: string[];
  /** Override the built-in Grant write entirely. */
  onGrant?: () => void;
  /** Fired after a successful built-in grant (close the card). */
  onGranted?: () => void;
  onKeepAsking?: () => void;
  /** Fired after the never-line is written (or override the write). */
  onNever?: () => void;
  onSamples?: () => void;
}) {
  const assistantId = useActiveAssistantId();
  const { evidence, hasEvidence } = useActsEvidence(assistantId, scope.agent);
  const putProfile = usePutCompanyProfile(assistantId);

  const [pending, setPending] = useState<null | "grant" | "never">(null);
  const [error, setError] = useState<string | null>(null);

  const doGrant = async () => {
    setError(null);
    if (onGrant) {
      onGrant();
      return;
    }
    if (!scope.requestId) {
      // No live confirmation to resolve — nothing to persist here. Let the
      // caller close; a mount without requestId and without onGrant is a
      // preview.
      onGranted?.();
      return;
    }
    setPending("grant");
    const res = await grantTrustScope(assistantId, {
      requestId: scope.requestId,
      ...(scope.pattern ? { pattern: scope.pattern } : {}),
      ...(scope.scope ? { scope: scope.scope } : {}),
    });
    setPending(null);
    if (res.ok) onGranted?.();
    else setError(res.error);
  };

  const doNever = () => {
    setError(null);
    if (onNever) {
      onNever();
      return;
    }
    const line =
      scope.neverLine ??
      `Never ${scope.verb.replace(/\s+—.*/, "").toLowerCase()} unattended`;
    if (currentNeverLines.includes(line)) {
      // Already present — nothing to write; treat as done.
      return;
    }
    setPending("never");
    putProfile.mutate(
      {
        path: { assistant_id: assistantId },
        body: { neverLines: [...currentNeverLines, line] },
      },
      {
        onSuccess: () => {
          setPending(null);
        },
        onError: () => {
          setPending(null);
          setError("Couldn’t add the never-line — try again.");
        },
      },
    );
  };

  return (
    <div
      role="dialog"
      aria-label="Grant scope"
      style={{
        border: `1px solid ${C.line2}`,
        borderRadius: 16,
        overflow: "hidden",
        background: C.surface,
        boxShadow: "0 24px 60px -32px rgba(0,0,0,0.45)",
        maxWidth: 420,
      }}
    >
      <div style={{ padding: "16px 18px 4px" }}>
        <div
          style={{
            fontFamily: mono,
            fontSize: 9.5,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: C.t3,
          }}
        >
          Grant scope
        </div>
        <div
          style={{
            fontFamily: serif,
            fontSize: 19,
            lineHeight: 1.2,
            color: C.t1,
            marginTop: 5,
          }}
        >
          {scope.summary}
        </div>
      </div>

      {/* VERB · CHANNEL · LIMIT */}
      <div style={{ padding: "12px 18px" }}>
        <ScopeRow label="Verb" value={scope.verb} />
        <ScopeRow label="Channel" value={scope.channel} />
        <ScopeRow label="Limit" value={scope.limit} last />
      </div>

      {/* Evidence */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          padding: "12px 18px",
          background: C.sunken,
          borderTop: `1px solid ${C.line}`,
        }}
      >
        {hasEvidence && evidence ? (
          <>
            <Stat n={evidence.acts} label="approved" tint={C.green} />
            <Stat
              n={evidence.reversed}
              label="reversed"
              tint={evidence.reversed > 0 ? C.amber : C.t3}
            />
            {scope.sampleCount && scope.sampleCount > 0 && onSamples ? (
              <button
                type="button"
                onClick={onSamples}
                style={{
                  marginLeft: "auto",
                  background: "none",
                  border: "none",
                  padding: 0,
                  fontFamily: mono,
                  fontSize: 11,
                  color: C.blueS,
                  cursor: "pointer",
                }}
              >
                See {scope.sampleCount} samples ›
              </button>
            ) : null}
          </>
        ) : (
          <span
            style={{
              fontFamily: mono,
              fontSize: 11.5,
              color: C.t3,
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
            }}
          >
            <span aria-hidden style={{ color: C.blue }}>
              ◔
            </span>
            measuring… the track record fills in as {scope.agent} acts
          </span>
        )}
      </div>

      {error ? (
        <div
          role="alert"
          style={{
            padding: "8px 18px 0",
            fontSize: 11.5,
            color: C.danger,
          }}
        >
          {error}
        </div>
      ) : null}

      {/* Actions */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          padding: "14px 18px 16px",
          flexWrap: "wrap",
        }}
      >
        <button
          type="button"
          disabled={pending !== null}
          onClick={doGrant}
          style={{
            fontSize: 12.5,
            fontWeight: 600,
            padding: "9px 16px",
            borderRadius: 10,
            border: "none",
            background: C.ink,
            color: C.bg,
            cursor: pending ? "default" : "pointer",
            opacity: pending === "grant" ? 0.7 : 1,
          }}
        >
          {pending === "grant" ? "Granting…" : "Grant this scope"}
        </button>
        {onKeepAsking ? (
          <button
            type="button"
            disabled={pending !== null}
            onClick={onKeepAsking}
            style={ghostBtn}
          >
            Keep asking
          </button>
        ) : null}
        <button
          type="button"
          disabled={pending !== null}
          onClick={doNever}
          style={{
            ...ghostBtn,
            marginLeft: "auto",
            color: C.danger,
            border: "none",
          }}
        >
          {pending === "never" ? "Adding…" : "Never — add a line"}
        </button>
      </div>
    </div>
  );
}

const ghostBtn = {
  fontSize: 12.5,
  fontWeight: 500,
  padding: "9px 14px",
  borderRadius: 10,
  border: `1px solid ${C.line2}`,
  background: C.surface,
  color: C.t2,
  cursor: "pointer",
};

function ScopeRow({
  label,
  value,
  last = false,
}: {
  label: string;
  value: string;
  last?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
        padding: "8px 0",
        borderBottom: last ? "none" : `1px solid ${C.line}`,
      }}
    >
      <span
        style={{
          fontFamily: mono,
          fontSize: 9.5,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: C.t3,
          width: 58,
          flexShrink: 0,
          paddingTop: 2,
        }}
      >
        {label}
      </span>
      <span style={{ fontSize: 12.5, color: C.t1, lineHeight: 1.45 }}>
        {value}
      </span>
    </div>
  );
}

function Stat({ n, label, tint }: { n: number; label: string; tint: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "baseline", gap: 5 }}>
      <b style={{ fontFamily: serif, fontSize: 17, color: tint }}>{n}</b>
      <span style={{ fontFamily: mono, fontSize: 10.5, color: C.t3 }}>
        {label}
      </span>
    </span>
  );
}
