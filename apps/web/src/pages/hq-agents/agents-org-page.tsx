/**
 * Agents · the org — "Your company, staffed by agents." (Cue-HQ-Build v3 +
 * round-5 additions).
 *
 * The company view of who works for you: a You-node at the top, then a roster
 * of agent cards reporting up. Each card shows its charter, its autonomy tier
 * with a live ACTING / DRAFTING / WAITING pill (derived from REAL work items),
 * this week's spend against its cap, and its auditable acts line. The ⋯ menu
 * (round 5) renames, re-charters, changes tier, sets a spend cap, or pauses —
 * all editing the local charter config. A dashed "Hire an agent" card adds a
 * role. The tier chip opens the per-agent trust panel.
 *
 * Honesty rules (never fake): per-agent spend has no attribution store yet, so
 * a card with a cap shows "measuring…" (bar hidden) rather than a fabricated
 * split; the header "$N SPENT THIS WEEK" is the real workspace usage total;
 * track record renders "measuring…" until the acts-summary route answers.
 *
 * Backend still owed (see the handoff report): (1) an agent registry so
 * charters persist server-side and other surfaces can read them, and (2)
 * per-agent spend attribution so the per-card bars stop measuring.
 */

import { useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { C, mono, serif } from "@/domains/activity/theme";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { HqStyle, LiveBars, MicroLabel } from "@/pages/hq/hq-kit";
import { routes } from "@/utils/routes";

import {
  TIER_META,
  updateCharter,
  useCharters,
  type AgentCharter,
} from "./charters";
import { CharterEditor, HireModal } from "./agent-modals";
import { TrustPanel } from "./trust-panel";
import {
  actsForCharter,
  useAgentActs,
  useAgentWork,
  useWeekSpend,
  workForCharter,
  type AgentActs,
  type AgentWork,
} from "./use-agent-data";

/**
 * The role tile is DARK in both themes (the design uses a fixed ink glyph
 * tile). `C.ink` flips to white under dark, so use a theme-constant dark
 * chip instead — matching the You-node hero.
 */
const TILE_BG = "#1A2230";

/** Compact `$142` / `$1.2K` USD from a dollar amount. */
function fmtUsd(usd: number): string {
  if (usd >= 1000) {
    const k = usd / 1000;
    return `$${k >= 10 ? Math.round(k) : Math.round(k * 10) / 10}K`;
  }
  if (usd >= 10 || usd === 0) return `$${Math.round(usd)}`;
  return `$${usd.toFixed(2)}`;
}

/** Live-state pill copy + color from the honest work summary + pause. */
function statePill(
  charter: AgentCharter,
  work: AgentWork | null,
): { label: string; color: string; live: boolean; blink: boolean } {
  if (charter.paused)
    return { label: "⏸ WAITING", color: C.amber, live: false, blink: false };
  if (work?.running) {
    // Tier 1/2 draft; tier 3/4 act.
    const label = charter.tier >= 3 ? "ACTING" : "DRAFTING";
    return {
      label,
      color: charter.tier >= 3 ? C.green : C.blue,
      live: true,
      blink: true,
    };
  }
  if (work?.queued)
    return { label: "QUEUED", color: C.t3, live: false, blink: true };
  return { label: "IDLE", color: C.t3, live: false, blink: false };
}

// ---------------------------------------------------------------------------
// Roster card
// ---------------------------------------------------------------------------

function AgentCard({
  assistantId,
  charter,
  work,
  acts,
  measuringActs,
  onEdit,
  onOpenTrust,
}: {
  assistantId: string;
  charter: AgentCharter;
  work: AgentWork | null;
  acts: AgentActs | null;
  measuringActs: boolean;
  onEdit: () => void;
  onOpenTrust: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const meta = TIER_META[charter.tier];
  const pill = statePill(charter, work);
  const currentLine = charter.paused
    ? "Paused — no active work"
    : (work?.currentLine ?? "No live work right now");

  const menuItem = (
    glyph: string,
    label: string,
    onClick: () => void,
    tint?: string,
    highlight?: boolean,
  ) => (
    <button
      type="button"
      onClick={() => {
        setMenuOpen(false);
        onClick();
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 9,
        width: "100%",
        textAlign: "left",
        padding: "8px 9px",
        borderRadius: 8,
        border: "none",
        cursor: "pointer",
        fontSize: 12.5,
        background: highlight ? C.blueW : "transparent",
        color: tint ?? (highlight ? C.blueS : C.t1),
        fontWeight: highlight ? 500 : 400,
      }}
    >
      <span style={{ width: 16, textAlign: "center" }}>{glyph}</span>
      {label}
    </button>
  );

  return (
    <div
      style={{
        position: "relative",
        border: `1px solid ${C.line}`,
        borderRadius: 14,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        background: C.surface,
        opacity: charter.paused ? 0.85 : 1,
      }}
    >
      {/* Header row */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          style={{
            width: 38,
            height: 38,
            borderRadius: 11,
            background: TILE_BG,
            color: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 16,
            flexShrink: 0,
          }}
        >
          {charter.emoji}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: C.t1 }}>
            {charter.name}
          </div>
          <div style={{ fontSize: 11.5, color: C.t2 }}>
            {charter.domain || "—"}
          </div>
        </div>
        <button
          type="button"
          aria-label={`${charter.name} options`}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
          style={{
            width: 24,
            height: 24,
            borderRadius: 7,
            background: menuOpen ? C.blueW : "transparent",
            color: menuOpen ? C.blueS : C.t3,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 14,
            border: "none",
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          ⋯
        </button>
      </div>

      {/* ⋯ menu */}
      {menuOpen ? (
        <>
          <div
            onClick={() => setMenuOpen(false)}
            style={{ position: "fixed", inset: 0, zIndex: 4 }}
          />
          <div
            role="menu"
            style={{
              position: "absolute",
              top: 52,
              right: 12,
              zIndex: 5,
              width: 190,
              background: C.surface,
              border: `1px solid ${C.line2}`,
              borderRadius: 12,
              boxShadow: "0 24px 50px -20px rgba(20,28,44,.5)",
              padding: 6,
            }}
          >
            {menuItem("✎", "Rename agent", onEdit)}
            {menuItem("⌖", "Edit charter…", onEdit, undefined, true)}
            {menuItem("▲", "Change tier", onEdit)}
            {menuItem("$", "Set spend cap", onEdit)}
            <div style={{ height: 1, background: C.line, margin: "4px 6px" }} />
            {menuItem(
              charter.paused ? "▶" : "⏸",
              charter.paused ? "Resume agent" : "Pause agent",
              () =>
                updateCharter(assistantId, charter.id, {
                  paused: !charter.paused,
                }),
              C.amber,
            )}
          </div>
        </>
      ) : null}

      {/* Charter box */}
      <div
        style={{
          marginTop: 11,
          background: C.sunken,
          borderRadius: 9,
          padding: "8px 10px",
        }}
      >
        <div
          style={{
            fontFamily: mono,
            fontSize: 8.5,
            letterSpacing: "0.08em",
            color: C.t3,
          }}
        >
          CHARTER
        </div>
        <div
          style={{
            fontSize: 11.5,
            color: C.t1,
            lineHeight: 1.35,
            marginTop: 2,
          }}
        >
          {charter.charter || "No mandate set yet."}
        </div>
      </div>

      {/* Tier chip + live pill */}
      <div
        style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 11 }}
      >
        <button
          type="button"
          onClick={onOpenTrust}
          title="Open trust panel"
          style={{
            fontFamily: mono,
            fontSize: 10,
            background: C.blueW,
            color: C.blueS,
            borderRadius: 6,
            padding: "3px 8px",
            border: "none",
            cursor: "pointer",
          }}
        >
          {meta.chip}
        </button>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            fontFamily: mono,
            fontSize: 10,
            color: pill.color,
          }}
        >
          {pill.live ? (
            <LiveBars color={pill.color} />
          ) : pill.blink ? (
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: pill.color,
                animation: "hqBlink 1.5s infinite",
              }}
            />
          ) : null}
          {pill.label}
        </span>
      </div>

      {/* Current line */}
      <div
        style={{
          fontSize: 12,
          color: C.t2,
          marginTop: 11,
          lineHeight: 1.4,
        }}
      >
        {currentLine}
      </div>

      {/* Spend + acts footer */}
      <div style={{ marginTop: "auto", paddingTop: 13 }}>
        <SpendRow charter={charter} />
        <div
          style={{
            fontFamily: mono,
            fontSize: 9.5,
            color: C.t3,
            marginTop: 7,
          }}
        >
          {measuringActs || !acts
            ? "acts · measuring…"
            : `${acts.actions} acts · ${acts.reversed} reversed`}
        </div>
      </div>
    </div>
  );
}

/**
 * Per-agent spend — honest "measuring…" until attribution lands. When a cap is
 * set we still surface it ("of $N cap"); the bar shows only once real spend
 * can be attributed (never a fabricated fill).
 */
function SpendRow({ charter }: { charter: AgentCharter }) {
  // No per-agent attribution store exists yet → spend is unknown. We never
  // fabricate a split of the workspace total across agents.
  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 6,
        }}
      >
        <span style={{ fontFamily: mono, fontSize: 10, color: C.t2 }}>
          measuring…
        </span>
        <span style={{ fontFamily: mono, fontSize: 9.5, color: C.t3 }}>
          {charter.capUsd != null ? `of $${charter.capUsd} cap` : "no cap"}
        </span>
      </div>
      {/* Empty track — no fabricated fill until spend is attributable. */}
      <div
        style={{
          height: 5,
          borderRadius: 3,
          background: C.sunken,
          overflow: "hidden",
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hire card
// ---------------------------------------------------------------------------

function HireCard({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        border: `1.5px dashed ${C.line2}`,
        borderRadius: 14,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        background: C.sunken,
        cursor: "pointer",
        minHeight: 180,
      }}
    >
      <span
        style={{
          width: 38,
          height: 38,
          borderRadius: 11,
          background: C.surface,
          border: `1px solid ${C.line}`,
          color: C.blue,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 19,
        }}
      >
        ＋
      </span>
      <div
        style={{ fontSize: 13.5, fontWeight: 600, marginTop: 11, color: C.t1 }}
      >
        Hire an agent
      </div>
      <div
        style={{ fontSize: 11.5, color: C.t2, marginTop: 4, lineHeight: 1.4 }}
      >
        Add a role — Finance, Support, Recruiting…
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function AgentsOrgPage() {
  const assistantId = useActiveAssistantId();
  const navigate = useNavigate();
  const isNarrow = useIsMobile();
  const charters = useCharters(assistantId);
  const { byName: workByName } = useAgentWork(assistantId);
  const { byName: actsByName, measuring: measuringActs } = useAgentActs(
    assistantId,
    charters,
  );
  const weekSpend = useWeekSpend(assistantId);

  const [now] = useState(() => Date.now());
  const [editing, setEditing] = useState<AgentCharter | null>(null);
  const [trustFor, setTrustFor] = useState<AgentCharter | null>(null);
  const [hiring, setHiring] = useState(false);

  const activeCount = useMemo(
    () => charters.filter((c) => !c.paused).length,
    [charters],
  );

  const headerLine = useMemo(() => {
    const agents = `${charters.length} AGENT${charters.length === 1 ? "" : "S"} REPORTING`;
    const roles = "1 OPEN ROLE";
    const spend =
      weekSpend.usd == null
        ? weekSpend.isError
          ? "SPEND UNAVAILABLE"
          : "MEASURING SPEND…"
        : `${fmtUsd(weekSpend.usd)} SPENT THIS WEEK`;
    return `${agents} · ${roles} · ${spend}`;
  }, [charters.length, weekSpend.usd, weekSpend.isError]);

  return (
    <div style={{ height: "100%", overflowY: "auto", background: C.bg }}>
      <HqStyle />
      <div
        style={{
          maxWidth: 1200,
          margin: "0 auto",
          padding: isNarrow ? "20px 16px 60px" : "30px 26px 60px",
        }}
      >
        {/* Intro */}
        <div style={{ maxWidth: 740, marginBottom: 26 }}>
          <MicroLabel color={C.blueS} style={{ marginBottom: 10 }}>
            Agents · the org
          </MicroLabel>
          <h1
            style={{
              fontFamily: serif,
              fontSize: isNarrow ? 28 : 36,
              lineHeight: 1.05,
              margin: 0,
              color: C.ink,
            }}
          >
            Your company, staffed by agents.
          </h1>
          <p
            style={{
              fontSize: 15,
              color: C.t2,
              margin: "10px 0 0",
              lineHeight: 1.5,
            }}
          >
            You sit at the top; each agent reports up with its autonomy tier,
            its standing charter, this week&rsquo;s spend, and the work
            it&rsquo;s on. Rename, re-charter, or dial spend from the ⋯ menu —
            the org is yours to reshape. Hiring an agent is adding a role, not
            installing a tool.
          </p>
        </div>

        {/* You node */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            marginBottom: 8,
          }}
        >
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 11,
              background: "linear-gradient(150deg,#16202E,#0C121B)",
              color: "#fff",
              borderRadius: 14,
              padding: "13px 20px",
            }}
          >
            <span
              style={{
                width: 34,
                height: 34,
                borderRadius: 10,
                background: "rgba(255,255,255,.14)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 15,
              }}
            >
              ☺
            </span>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>You</div>
              <div
                style={{
                  fontFamily: mono,
                  fontSize: 10,
                  color: "rgba(255,255,255,.6)",
                }}
              >
                FOUNDER · SETS THE MISSIONS
              </div>
            </div>
          </div>
          <div style={{ width: 1, height: 26, background: C.line2 }} />
          <div
            style={{
              fontFamily: mono,
              fontSize: 10,
              letterSpacing: "0.1em",
              color: C.t3,
              marginBottom: 20,
              textAlign: "center",
            }}
          >
            {headerLine}
          </div>
        </div>

        {/* Roster */}
        <div
          data-slot="hq-stream"
          style={{
            display: "grid",
            gridTemplateColumns: isNarrow
              ? "1fr"
              : "repeat(auto-fill, minmax(240px, 1fr))",
            gap: 14,
          }}
        >
          {charters.map((c) => (
            <AgentCard
              key={c.id}
              assistantId={assistantId}
              charter={c}
              work={workForCharter(c, workByName)}
              acts={actsForCharter(c, actsByName)}
              measuringActs={measuringActs}
              onEdit={() => setEditing(c)}
              onOpenTrust={() => setTrustFor(c)}
            />
          ))}
          <HireCard onClick={() => setHiring(true)} />
        </div>

        <div
          style={{
            marginTop: 18,
            fontFamily: mono,
            fontSize: 10,
            color: C.t3,
            letterSpacing: "0.04em",
          }}
        >
          {activeCount} ACTIVE · CHARTERS SAVED LOCALLY — SERVER REGISTRY COMING
        </div>
      </div>

      {editing ? (
        <CharterEditor
          assistantId={assistantId}
          charter={editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {trustFor ? (
        <TrustPanel
          charter={trustFor}
          acts={actsForCharter(trustFor, actsByName)}
          measuring={measuringActs}
          now={now}
          onClose={() => setTrustFor(null)}
          onOpenPreferences={() => {
            setTrustFor(null);
            navigate(routes.trust);
          }}
        />
      ) : null}
      {hiring ? (
        <HireModal
          assistantId={assistantId}
          onClose={() => setHiring(false)}
          onHired={() => setHiring(false)}
        />
      ) : null}
    </div>
  );
}
