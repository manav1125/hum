/**
 * Build-out tiles — the compact "grow your HQ" row on the command center.
 *
 * Five tiles with LIVE counts, each deep-linking to its surface. INVARIANT:
 * every count uses the SAME query + filter as the page its tile links to, so
 * tile and destination never disagree:
 *   Integrations — connected `connector-apps` (= Tools & Apps "connected N")
 *   Scheduled tasks — live schedules (= Schedules page recurring + upcoming,
 *     via the shared `countLiveSchedules`)
 *   Active skills — non-catalog skills (= Skills page "M are active")
 *   Team/Channels — catalog channels with a ready snapshot (= Channels page
 *     "N active" stat)
 *   Marketplace — browse (no count).
 *
 * Renders ONLY when HQ first-run setup is complete (`useSetupComplete()`) so
 * it never fights the setup meter for attention, and only when the
 * `onboarding-v2` assistant flag is ON. Every count query is best-effort —
 * a failed endpoint renders "—" rather than hiding the tile or throwing.
 */

import { useState, type CSSProperties, type ReactNode } from "react";

import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";

import { C, mono, serif } from "@/domains/activity/theme";
import { isAvailableSkill } from "@/domains/intelligence/skills/types";
import { countLiveSchedules } from "@/domains/settings/utils/schedule-formatters";
import {
  channelsAvailableGetOptions,
  channelsReadinessGetOptions,
  connectorappsGetOptions,
  schedulesGetOptions,
  skillsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import {
  useOnboardingV2Enabled,
  useSetupComplete,
} from "@/pages/hq-onboarding/setup-state";
import { routes } from "@/utils/routes";

const STALE_MS = 60_000;

function useBuildOutCounts(assistantId: string) {
  const path = { assistant_id: assistantId };

  // Same route + filter as the Tools & Apps page (connectors-page.tsx).
  const connectors = useQuery({
    ...connectorappsGetOptions({ path, query: {} }),
    staleTime: STALE_MS,
    retry: false,
  });
  const schedules = useQuery({
    ...schedulesGetOptions({ path }),
    staleTime: STALE_MS,
    retry: false,
  });
  // Same query as the Skills page hero (skills-tab.tsx, filter "all"):
  // installed + bundled + catalog, active = anything not catalog-only.
  const skills = useQuery({
    ...skillsGetOptions({ path, query: { include: "catalog" } }),
    staleTime: STALE_MS,
    retry: false,
  });
  const channelsCatalog = useQuery({
    ...channelsAvailableGetOptions({ path }),
    staleTime: STALE_MS,
    retry: false,
  });
  const channels = useQuery({
    ...channelsReadinessGetOptions({ path }),
    staleTime: STALE_MS,
    retry: false,
  });

  const integrations = connectors.data
    ? connectors.data.apps.filter((a) => a.connected).length
    : null;
  // = the Schedules page's visible (non-"Past one-time") rows. `now` is
  // sampled once at mount via a lazy initializer (the purity-safe way to read
  // the clock) — one-time liveness only turns over at minute granularity, so
  // a mount-time sample matches the destination page.
  const [now] = useState(() => Date.now());
  const scheduled = schedules.data
    ? countLiveSchedules(schedules.data.schedules, now)
    : null;
  // = the Skills page's "N are active right now" sub-line.
  const activeSkills = skills.data
    ? skills.data.skills.filter((s) => !isAvailableSkill(s)).length
    : null;
  // = the Channels page's "N active" stat: catalog channels merged with a
  // ready snapshot (a ready snapshot for a non-catalog channel doesn't count
  // there, so it must not count here either).
  const readyChannels =
    channels.data && channelsCatalog.data
      ? (() => {
          const ready = new Set(
            channels.data.snapshots
              .filter((s) => s.ready === true)
              .map((s) => s.channel),
          );
          return channelsCatalog.data.channels.filter((c) =>
            ready.has(c.id),
          ).length;
        })()
      : null;

  return { integrations, scheduled, activeSkills, readyChannels };
}

export function BuildOutTiles({ assistantId }: { assistantId: string }) {
  const enabled = useOnboardingV2Enabled();
  const setupComplete = useSetupComplete();
  if (!enabled || !setupComplete) return null;
  return <TilesRow assistantId={assistantId} />;
}

/** Split so the count queries only mount once the gates pass. */
function TilesRow({ assistantId }: { assistantId: string }) {
  const counts = useBuildOutCounts(assistantId);

  return (
    <div style={rowStyle} data-slot="command-center-buildout">
      <Tile
        label="Integrations"
        count={counts.integrations}
        to={routes.connectors}
      />
      <Tile
        label="Scheduled tasks"
        count={counts.scheduled}
        to={routes.settings.schedules}
      />
      <Tile
        label="Active skills"
        count={counts.activeSkills}
        to={routes.skills}
      />
      <Tile
        label="Team / Channels"
        count={counts.readyChannels}
        to={routes.channels}
      />
      <Tile label="Marketplace" count={null} to={routes.marketplace} browse />
    </div>
  );
}

function Tile({
  label,
  count,
  to,
  browse,
}: {
  label: string;
  count: number | null;
  to: string;
  browse?: boolean;
}) {
  return (
    <Link
      to={to}
      style={tileStyle}
      data-slot="command-center-buildout-tile"
      data-tile={label}
    >
      <span style={countStyle} data-slot="buildout-tile-count">
        {browse ? <BrowseGlyph /> : count === null ? "—" : count}
      </span>
      <span style={labelStyle}>
        {label} <span aria-hidden>›</span>
      </span>
    </Link>
  );
}

function BrowseGlyph(): ReactNode {
  return (
    <span aria-hidden style={{ fontSize: 18, lineHeight: 1 }}>
      ✦
    </span>
  );
}

// ---------------------------------------------------------------------------
// Styles — compact, calm, riding the theme tokens like the rest of the page.
// ---------------------------------------------------------------------------

const rowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
  gap: 10,
  marginBottom: 22,
};

const tileStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  border: `1px solid ${C.line}`,
  borderRadius: 12,
  background: C.surface,
  padding: "12px 14px",
  textDecoration: "none",
  minWidth: 0,
};

const countStyle: CSSProperties = {
  fontFamily: serif,
  fontSize: 22,
  lineHeight: 1,
  color: C.ink,
  letterSpacing: "-0.3px",
};

const labelStyle: CSSProperties = {
  fontFamily: mono,
  fontSize: 10.5,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: C.t3,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};
