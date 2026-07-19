/**
 * Mv3YouPage — the mobile "You" tab (spec frame 9: trust HQ).
 *
 * Layout (frame-verbatim): avatar + name + instance host → the "HOW MUCH CUE
 * DOES ALONE" mode dial (Observe/Assist/Autonomous) → TRACK RECORD receipts →
 * native grouped rows (Memory / Connections / Skills / Agents / Brand kit) →
 * the quiet Notifications · Appearance · Sign out line.
 *
 * DATA (all real):
 *  · dial      — gateway autonomy policies (same store as Settings → Privacy);
 *                the three positions are exact postures, custom maps light none
 *  · receipts  — guardrailsGet 7d: acts/reversed + workspace model spend;
 *                standing-rule count = trust rules + checkpoints (all listed
 *                on the Rules screen — none hidden)
 *  · rows      — connectorapps connected count, agents registry count, active
 *                brand profile name; each row deep-links the existing route
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import {
  agentsGetOptions,
  connectorappsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { client } from "@/generated/daemon/client.gen";
import { useHomeStateQuery } from "@/domains/home/hooks/use-home-state-query";
import { useBrandProfiles } from "@/pages/brand-kit/use-brand-kit";
import { handleLogout } from "@/lib/auth/handle-logout";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

import { GlassCard } from "../glass-card";
import { microLabel, rise } from "../mv3-kit";
import {
  Eyebrow,
  NavRow,
  QuietLink,
  StatTile,
  YouScreen,
} from "./you-kit";
import {
  dialDescription,
  dialModeOf,
  useAutonomyDial,
  useGuardrails,
  useStandingRules,
  usd,
  type DialMode,
} from "./use-you-data";

/** The instance host line ("cue-manav.justcue.app"). */
function instanceHost(): string {
  const base = client.getConfig().baseUrl;
  if (base) {
    try {
      return new URL(base, window.location.origin).host;
    } catch {
      /* fall through */
    }
  }
  return window.location.host;
}

const DIAL_ITEMS: { mode: DialMode; label: string }[] = [
  { mode: "observe", label: "Observe" },
  { mode: "assist", label: "Assist" },
  { mode: "autonomous", label: "Autonomous" },
];

function ModeDial({ assistantId }: { assistantId: string }) {
  const { policies, isError, setMode } = useAutonomyDial(assistantId);
  const active = policies ? dialModeOf(policies) : null;

  return (
    <GlassCard padding="15px 16px" style={rise(0.1)}>
      <div style={{ ...microLabel, color: "var(--mv3-muted)" }}>
        How much Cue does alone
      </div>
      <div
        role="radiogroup"
        aria-label="How much Cue does alone"
        style={{
          display: "flex",
          gap: 4,
          background: "var(--mv3-track)",
          borderRadius: 14,
          padding: 4,
          marginTop: 11,
        }}
      >
        {DIAL_ITEMS.map(({ mode, label }) => {
          const isActive = active === mode;
          return (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={isActive}
              disabled={!policies}
              onClick={() => {
                if (isActive) return;
                haptic.medium();
                setMode.mutate(mode);
              }}
              style={{
                flex: 1,
                textAlign: "center",
                fontSize: 12.5,
                fontWeight: isActive ? 600 : 400,
                fontFamily: "inherit",
                color: isActive ? "#fff" : "var(--mv3-muted)",
                background: isActive
                  ? "linear-gradient(160deg, #4E7CEC, #3560CC)"
                  : "transparent",
                border: "none",
                borderRadius: 10,
                padding: "11px 0",
                minHeight: 40,
                cursor: policies ? "pointer" : "default",
                boxShadow: isActive
                  ? "0 8px 18px -8px rgba(61,110,232,.6)"
                  : "none",
              }}
            >
              {label}
            </button>
          );
        })}
      </div>
      <div
        style={{
          fontSize: 12,
          color: "var(--mv3-muted)",
          marginTop: 10,
          lineHeight: 1.5,
        }}
      >
        {isError
          ? "Couldn't load the autonomy setting — pull to retry."
          : policies
            ? active
              ? dialDescription(policies)
              : `Custom — ${dialDescription(policies)}`
            : "Loading what Cue may do alone…"}
      </div>
    </GlassCard>
  );
}

function TrackRecord({ assistantId }: { assistantId: string }) {
  const navigate = useNavigate();
  const { data } = useGuardrails(assistantId);
  const { rules } = useStandingRules(assistantId);

  const summary = data?.ledger.summary ?? null;
  const ruleCount =
    (data ? data.checkpoints.length : 0) + rules.length;

  return (
    <GlassCard padding="15px 16px" style={rise(0.25)}>
      <Eyebrow
        trailing={
          <QuietLink
            label="Rules ›"
            onPress={() => navigate(routes.guardrails)}
          />
        }
      >
        Track record
      </Eyebrow>
      <div style={{ display: "flex", gap: 20, marginTop: 12 }}>
        {summary ? (
          <StatTile
            value={String(summary.actCount)}
            label={`acts · ${summary.reversedCount} reversed`}
            onPress={() => navigate(`${routes.guardrails}?view=ledger`)}
          />
        ) : (
          <StatTile value="—" label="acts · measuring" />
        )}
        {summary && usd(summary.totalCents) ? (
          <StatTile
            value={usd(summary.totalCents)!}
            label="model spend · 7d"
          />
        ) : null}
        <StatTile
          value={data ? String(ruleCount) : "—"}
          label="standing rules"
          onPress={() => navigate(routes.guardrails)}
        />
      </div>
    </GlassCard>
  );
}

/** Quiet inline footer link (the "Notifications · Appearance · Sign out" line). */
function FooterLink({
  label,
  onPress,
}: {
  label: string;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        haptic.light();
        onPress();
      }}
      style={{
        fontSize: 12.5,
        color: "var(--mv3-faint)",
        background: "none",
        border: "none",
        padding: "8px 2px",
        minHeight: 44,
        cursor: "pointer",
        fontFamily: "inherit",
      }}
    >
      {label}
    </button>
  );
}

function Dot() {
  return (
    <span aria-hidden style={{ color: "var(--mv3-faint)", fontSize: 12.5 }}>
      ·
    </span>
  );
}

export function Mv3YouPage() {
  const assistantId = useActiveAssistantId();
  const navigate = useNavigate();

  const stateQuery = useHomeStateQuery(assistantId);
  const userName =
    (stateQuery.data as { userName?: string } | undefined)?.userName?.trim() ||
    null;
  const initial = (userName ?? "").charAt(0).toUpperCase() || "☺";
  const host = useMemo(() => instanceHost(), []);

  // Row metas — real counts only; a row with no data yet just omits its meta.
  const appsQuery = useQuery({
    ...connectorappsGetOptions({
      path: { assistant_id: assistantId },
      query: {},
    }),
    staleTime: 60_000,
  });
  const liveCount =
    appsQuery.data?.apps.filter((a) => a.connected).length ?? null;

  const agentsQuery = useQuery({
    ...agentsGetOptions({ path: { assistant_id: assistantId } }),
    staleTime: 30_000,
  });
  const staffCount = agentsQuery.data?.agents.length ?? null;

  const { active: activeBrand } = useBrandProfiles(assistantId);

  return (
    <YouScreen
      tint="lavender"
      testId="mv3-you"
      header={
        <div
          style={{
            // Topmost element on the root You screen — owns the status-bar
            // inset (no back row renders above it).
            padding:
              "calc(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) + 12px) 22px 12px",
            flexShrink: 0,
            position: "relative",
            zIndex: 2,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 13 }}>
            <span
              aria-hidden
              style={{
                width: 54,
                height: 54,
                borderRadius: "50%",
                background: "linear-gradient(160deg,#4E7CEC,#7F77DD)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 20,
                fontWeight: 700,
                color: "#fff",
                flexShrink: 0,
              }}
            >
              {initial}
            </span>
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: 24,
                  fontWeight: 700,
                  letterSpacing: "-.6px",
                }}
              >
                {userName ?? "You"}
              </div>
              <div
                style={{
                  fontFamily: "var(--mv3-mono)",
                  fontSize: 11,
                  color: "var(--mv3-muted)",
                  marginTop: 2,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {host}
              </div>
            </div>
          </div>
        </div>
      }
    >
      <ModeDial assistantId={assistantId} />
      <TrackRecord assistantId={assistantId} />

      {/* Native grouped rows. */}
      <GlassCard padding={0} style={{ overflow: "hidden", ...rise(0.4) }}>
        <NavRow
          icon={
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#7FA3F2"
              strokeWidth="1.8"
              aria-hidden
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" />
            </svg>
          }
          iconBg="rgba(61,110,232,.18)"
          label="Memory — what Cue knows"
          onPress={() => navigate(routes.memory)}
        />
        <NavRow
          icon={
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#4FC7C7"
              strokeWidth="1.8"
              aria-hidden
            >
              <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
              <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
            </svg>
          }
          iconBg="rgba(79,199,199,.15)"
          label="Connections"
          meta={liveCount != null && liveCount > 0 ? `${liveCount} live` : undefined}
          metaColor="var(--mv3-green)"
          onPress={() => navigate(routes.connectors)}
        />
        <NavRow
          icon={
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#A79FF0"
              strokeWidth="1.8"
              aria-hidden
            >
              <path d="M12 2l2.4 4.9L20 8l-4 3.9.9 5.4L12 14.8 7.1 17.3 8 11.9 4 8l5.6-1.1z" />
            </svg>
          }
          iconBg="rgba(167,159,240,.15)"
          label="Skills & marketplace"
          onPress={() => navigate(routes.skills)}
        />
        <NavRow
          icon={
            <span style={{ fontSize: 14, color: "#4FC7C7" }} aria-hidden>
              ◆
            </span>
          }
          iconBg="rgba(79,199,199,.15)"
          label="Agents"
          meta={staffCount != null && staffCount > 0 ? `${staffCount} on staff` : undefined}
          onPress={() => navigate(routes.hqAgents)}
        />
        <NavRow
          icon={
            <span
              aria-hidden
              style={{
                width: 14,
                height: 14,
                borderRadius: 4,
                background: "linear-gradient(135deg,#3D6EE8,#7F77DD)",
              }}
            />
          }
          iconBg="rgba(224,166,75,.15)"
          label="Brand kit"
          meta={activeBrand?.name || undefined}
          isLast
          onPress={() => navigate(routes.brandKit)}
        />
      </GlassCard>

      {/* Quiet settings line + reachability line (settings-leaf grant). */}
      <div
        style={{
          textAlign: "center",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          gap: 6,
          flexWrap: "wrap",
        }}
      >
        <FooterLink
          label="Notifications"
          onPress={() => navigate(routes.settings.notifications)}
        />
        <Dot />
        <FooterLink
          label="Appearance"
          onPress={() => navigate(routes.settings.general)}
        />
        <Dot />
        <FooterLink
          label="Sign out"
          onPress={() => void handleLogout(navigate)}
        />
      </div>
      <div
        style={{
          textAlign: "center",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          gap: 6,
          flexWrap: "wrap",
          marginTop: -8,
        }}
      >
        <FooterLink
          label="Identity"
          onPress={() => navigate(routes.identity)}
        />
        <Dot />
        <FooterLink
          label="Channels"
          onPress={() => navigate(routes.contacts.root)}
        />
        <Dot />
        <FooterLink
          label="Workspace"
          onPress={() => navigate(routes.workspace)}
        />
      </div>
    </YouScreen>
  );
}
