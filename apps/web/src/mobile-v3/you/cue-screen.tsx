/**
 * **The ⓶ screen** — v24 frame F2. Press the mark when you are already home.
 *
 * One scroll, one question: *"what is my Cue doing, and how is it set up?"*
 *
 *   working now      the agents actually running, with their own live lines
 *   People · Library the two surfaces that accumulate on their own
 *   config groups    from the shared Your Cue model — the ones that work on a
 *                    phone — then a door to all eighteen
 *
 * ## Why this replaced "You"
 *
 * The screen used to be called You and carried a leaf set that had drifted
 * from desktop's. Design's R2: *"'You' wasn't a deliberate voice choice — it
 * predates the door existing, and it's wrong twice: it's about Cue's setup,
 * and the phone's leaf set had drifted."* One name on both platforms, and the
 * leaves come from `your-cue-model.ts` rather than from a hand-kept list here.
 *
 * ## The autonomy dial is not gone, it moved
 *
 * The old You screen owned a three-position Observe/Assist/Autonomous dial.
 * F2 shows the posture as a **read** in the header and nothing else, so the
 * write lives where the finer control already did: Guardrails, which edits the
 * same six policies per category. The header's posture word links there — a
 * value you can see and not change, with no route to the thing that changes
 * it, is the shape this pack keeps calling out.
 *
 * ## Never a fake number
 *
 * Every count comes from `use-cue-counts.ts` and renders as nothing when it is
 * not known yet. "Working now" with nothing running says so in a sentence; a
 * failed read says *that* instead, because a failed fetch is an error state,
 * not an empty one.
 */
import { useNavigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { YOUR_CUE_GROUPS } from "@/components/nav/your-cue-model";
import { useHomeStateQuery } from "@/domains/home/hooks/use-home-state-query";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

import { CueRing } from "../cue-ring";
import { GlassCard } from "../glass-card";
import { microLabel, rise } from "../mv3-kit";
import { YouScreen } from "./you-kit";
import { useCueCounts, type CueCounts } from "./use-cue-counts";
import {
  CUE_SCREEN_GROUPS,
  LEAF_GLYPH,
  phoneLeafState,
} from "./your-cue-mobile";
import { dialModeOf, useAutonomyDial, useGuardrails, usd } from "./use-you-data";

/** "Autonomous · 2 working · $4.10 this week" — only the parts that are real. */
function postureLine(
  mode: string | null,
  working: number,
  spend: string | null,
): string {
  const parts: string[] = [];
  if (mode) parts.push(mode);
  if (working > 0) {
    parts.push(`${working} working`);
  }
  if (spend) parts.push(`${spend} this week`);
  return parts.join(" · ");
}

/** WORKING NOW — the live card. Never a spinner standing in for a fact. */
function WorkingNow({ counts }: { counts: CueCounts }) {
  const navigate = useNavigate();
  const rows = counts.working;

  return (
    <GlassCard padding="12px 14px" style={rise(0.1)}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {rows.length > 0 ? (
          <span
            aria-hidden
            style={{
              display: "flex",
              gap: 1.5,
              height: 10,
              alignItems: "center",
              flexShrink: 0,
            }}
          >
            <span
              style={{
                width: 2,
                height: "100%",
                background: "var(--mv3-accent)",
                borderRadius: 1,
                animation: "mv3Breathe 1.2s ease-in-out infinite",
              }}
            />
            <span
              style={{
                width: 2,
                height: "100%",
                background: "var(--mv3-accent)",
                borderRadius: 1,
                animation: "mv3Breathe 1.2s ease-in-out .3s infinite",
              }}
            />
          </span>
        ) : null}
        <span style={{ ...microLabel, color: "var(--mv3-micro)", flex: 1 }}>
          Working now
        </span>
        {rows.length > 0 ? (
          <span style={{ fontSize: 10, color: "var(--mv3-muted)" }}>
            {rows.length}
          </span>
        ) : null}
      </div>

      {counts.isError ? (
        // A failed read is an error state, not an empty one — and Cue reports
        // its own errors first person.
        <div
          style={{
            fontSize: 12,
            color: "var(--mv3-muted)",
            marginTop: 9,
            lineHeight: 1.5,
          }}
        >
          <span aria-hidden style={{ marginRight: 6 }}>
            ◼
          </span>
          I couldn&apos;t read what&apos;s running — pull down to try again.
        </div>
      ) : rows.length === 0 ? (
        <div
          style={{
            fontSize: 12,
            color: "var(--mv3-muted)",
            marginTop: 9,
            lineHeight: 1.5,
          }}
        >
          Nothing is running. Agents start when you approve a task or a rhythm
          fires.
        </div>
      ) : (
        rows.map((row) => (
          <button
            key={row.id}
            type="button"
            className="cue-pressable"
            data-slot="cue-screen-working-row"
            onClick={() => {
              haptic.light();
              navigate(routes.projects);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 9,
              width: "100%",
              minHeight: 44,
              marginTop: 7,
              padding: 0,
              background: "none",
              border: "none",
              textAlign: "left",
              cursor: "pointer",
              fontFamily: "inherit",
              color: "var(--mv3-text)",
            }}
          >
            <span
              aria-hidden
              style={{
                width: 18,
                height: 18,
                borderRadius: 6,
                background: "var(--mv3-violet-on-fill)",
                color: "#fff",
                fontSize: 8.5,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              ▲
            </span>
            <span
              style={{
                fontSize: 12,
                flex: 1,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {row.title}
              {row.note ? (
                <span style={{ color: "var(--mv3-muted)" }}> · {row.note}</span>
              ) : null}
            </span>
            <span
              style={{
                fontSize: 9.5,
                color: "var(--mv3-muted)",
                flexShrink: 0,
              }}
            >
              {row.assignee ?? "Cue"}
            </span>
          </button>
        ))
      )}
    </GlassCard>
  );
}

/** One of the two accumulating cards. */
function AccumulatingCard({
  glyph,
  label,
  meta,
  to,
  accent,
}: {
  glyph: string;
  label: string;
  meta: string | null;
  to: string;
  accent?: boolean;
}) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      className="cue-pressable"
      data-slot={`cue-screen-${label.toLowerCase()}`}
      onClick={() => {
        haptic.light();
        navigate(to);
      }}
      style={{
        flex: 1,
        minWidth: 0,
        textAlign: "left",
        background: "var(--mv3-card)",
        border: `1px solid ${accent ? "var(--mv3-teal)" : "var(--mv3-card-border)"}`,
        borderRadius: 16,
        padding: "12px 13px",
        minHeight: 78,
        cursor: "pointer",
        fontFamily: "inherit",
        color: "var(--mv3-text)",
      }}
    >
      <span aria-hidden style={{ fontSize: 15 }}>
        {glyph}
      </span>
      <span
        style={{
          fontSize: 12.5,
          fontWeight: 600,
          display: "block",
          marginTop: 7,
        }}
      >
        {label}
      </span>
      {meta ? (
        <span
          style={{
            fontSize: 10,
            color: "var(--mv3-muted)",
            display: "block",
            marginTop: 2,
          }}
        >
          {meta}
        </span>
      ) : null}
    </button>
  );
}

/** A config group, rendered as the frame's grouped card. */
function ConfigGroup({
  title,
  leaves,
  counts,
}: {
  title: string;
  leaves: readonly { key: string; label: string }[];
  counts: CueCounts;
}) {
  const navigate = useNavigate();
  const all = YOUR_CUE_GROUPS.flatMap((g) => g.leaves);

  return (
    <div>
      <div
        style={{
          ...microLabel,
          color: "var(--mv3-muted)",
          padding: "4px 6px 6px",
        }}
      >
        {title}
      </div>
      <div
        style={{
          background: "var(--mv3-card)",
          border: "1px solid var(--mv3-card-border)",
          borderRadius: 15,
          overflow: "hidden",
        }}
      >
        {leaves.map((entry, i) => {
          const leaf = all.find((l) => l.key === entry.key)!;
          const state = phoneLeafState(leaf);
          const isLast = i === leaves.length - 1;
          const meta =
            entry.key === "agents"
              ? counts.agents == null
                ? null
                : String(counts.agents)
              : entry.key === "skills"
                ? counts.skills == null
                  ? null
                  : String(counts.skills)
                : entry.key === "connectors"
                  ? counts.connectorsLive == null
                    ? null
                    : `${counts.connectorsLive} live`
                  : null;
          const base: React.CSSProperties = {
            width: "100%",
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "11px 13px",
            minHeight: 44,
            textAlign: "left",
            background: "transparent",
            border: "none",
            borderBottom: isLast ? "none" : "1px solid var(--mv3-line)",
            fontFamily: "inherit",
            color: "var(--mv3-text)",
          };

          if (state.state === "closed") {
            return (
              <div key={leaf.key} style={base} data-leaf={leaf.key}>
                <span aria-hidden style={{ fontSize: 11, width: 15 }}>
                  {LEAF_GLYPH[leaf.key] ?? "·"}
                </span>
                <span style={{ fontSize: 12, flex: 1 }}>{leaf.label}</span>
                <span
                  style={{
                    fontSize: 9.5,
                    color: "var(--mv3-muted)",
                    display: "flex",
                    gap: 4,
                  }}
                >
                  <span aria-hidden>⊘</span>
                  {state.badge}
                </span>
              </div>
            );
          }

          return (
            <button
              key={leaf.key}
              type="button"
              className="cue-pressable"
              data-leaf={leaf.key}
              aria-label={meta ? `${leaf.label} — ${meta}` : leaf.label}
              onClick={() => {
                haptic.light();
                navigate(state.to);
              }}
              style={{ ...base, cursor: "pointer" }}
            >
              <span aria-hidden style={{ fontSize: 11, width: 15 }}>
                {LEAF_GLYPH[leaf.key] ?? "·"}
              </span>
              <span style={{ fontSize: 12, flex: 1 }}>{leaf.label}</span>
              {meta ? (
                <span style={{ fontSize: 10, color: "var(--mv3-muted)" }}>
                  {meta}
                </span>
              ) : null}
              <span aria-hidden style={{ fontSize: 11, color: "var(--mv3-muted)" }}>
                ›
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function Mv3CueScreen() {
  const assistantId = useActiveAssistantId();
  const navigate = useNavigate();
  const counts = useCueCounts(assistantId);

  const { policies } = useAutonomyDial(assistantId);
  const mode = policies ? dialModeOf(policies) : null;
  const { data: guardrails } = useGuardrails(assistantId);
  const spend = usd(guardrails?.ledger.summary?.totalCents ?? null);

  const stateQuery = useHomeStateQuery(assistantId);
  const userName =
    (stateQuery.data as { userName?: string } | undefined)?.userName?.trim() ||
    null;

  const flagsHydrated = useAssistantFeatureFlagStore.use.hasHydrated();
  const externalPlugins = useAssistantFeatureFlagStore.use.externalPlugins();
  const marketplace = useAssistantFeatureFlagStore.use.marketplace();

  const groups = YOUR_CUE_GROUPS.filter((g) =>
    CUE_SCREEN_GROUPS.includes(g.key),
  ).map((group) => ({
    ...group,
    leaves: group.leaves.filter((leaf) => {
      if (!leaf.flag) return true;
      if (!flagsHydrated) return false;
      return leaf.flag === "externalPlugins" ? externalPlugins : marketplace;
    }),
  }));

  const totalLeaves = YOUR_CUE_GROUPS.flatMap((g) => g.leaves).filter((l) => {
    if (!l.flag) return true;
    if (!flagsHydrated) return false;
    return l.flag === "externalPlugins" ? externalPlugins : marketplace;
  }).length;

  const posture = postureLine(
    mode ? mode.charAt(0).toUpperCase() + mode.slice(1) : null,
    counts.working.length,
    spend,
  );

  return (
    <YouScreen
      tint="lavender"
      testId="mv3-cue-screen"
      header={
        <div
          style={{
            padding:
              "calc(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) + 12px) 18px 4px",
            flexShrink: 0,
            position: "relative",
            zIndex: 2,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
            <span
              aria-hidden
              style={{
                width: 44,
                height: 44,
                borderRadius: "50%",
                background: "var(--mv3-accent-on-fill)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <CueRing size={23} stroke="#fff" strokeWidth={48} dotRadius={36} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-.5px" }}
              >
                Your Cue
              </div>
              {posture ? (
                <button
                  type="button"
                  onClick={() => {
                    haptic.light();
                    navigate(routes.guardrails);
                  }}
                  style={{
                    fontSize: 11,
                    color: "var(--mv3-muted)",
                    marginTop: 2,
                    background: "none",
                    border: "none",
                    padding: 0,
                    textAlign: "left",
                    cursor: "pointer",
                    fontFamily: "inherit",
                  }}
                >
                  {posture} ›
                </button>
              ) : (
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--mv3-muted)",
                    marginTop: 2,
                  }}
                >
                  {userName ?? "Reading how Cue is set up…"}
                </div>
              )}
            </div>
          </div>
        </div>
      }
    >
      <WorkingNow counts={counts} />

      <div style={{ display: "flex", gap: 8 }}>
        <AccumulatingCard
          glyph="👤"
          label="People"
          meta={counts.people == null ? null : `${counts.people} known`}
          to={routes.people}
        />
        <AccumulatingCard
          glyph="▦"
          label="Library"
          // Library is Work's third view now, not its own destination (v23 R1).
          meta={counts.library == null ? null : `${counts.library} made`}
          to={routes.workView("library")}
          accent
        />
      </div>

      {groups.map((group) => (
        <ConfigGroup
          key={group.key}
          title={group.title}
          leaves={group.leaves}
          counts={counts}
        />
      ))}

      {/* The door to the rest. Design's F2 prints a flat "…are on desktop"
          line here; that sentence would be false for six of the nine, which
          have real phone screens — so the honest version is a door that says
          how many, and each row inside states its own case. */}
      <button
        type="button"
        className="cue-pressable"
        data-slot="cue-screen-all-leaves"
        onClick={() => {
          haptic.light();
          navigate(routes.yourCueAll);
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          width: "100%",
          minHeight: 48,
          padding: "13px 15px",
          background: "var(--mv3-card)",
          border: "1px solid var(--mv3-card-border)",
          borderRadius: 15,
          cursor: "pointer",
          fontFamily: "inherit",
          color: "var(--mv3-text)",
          textAlign: "left",
        }}
      >
        <span aria-hidden style={{ fontSize: 11, width: 15 }}>
          ⚙
        </span>
        <span style={{ fontSize: 12.5, flex: 1 }}>
          Everything else in Your Cue
        </span>
        <span style={{ fontSize: 10, color: "var(--mv3-muted)" }}>
          {flagsHydrated ? totalLeaves : ""}
        </span>
        <span aria-hidden style={{ fontSize: 11, color: "var(--mv3-muted)" }}>
          ›
        </span>
      </button>
    </YouScreen>
  );
}
