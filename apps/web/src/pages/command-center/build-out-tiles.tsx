/**
 * Build-out tiles — the compact "grow your HQ" row on the command center.
 *
 * Five tiles with LIVE counts, each deep-linking to its surface:
 *   Integrations (connected Composio apps) · Scheduled tasks (non-cancelled
 *   schedules) · Skills (installed managed + marketplace) · Team/Channels
 *   (ready channels) · Marketplace (browse).
 *
 * Renders ONLY when HQ first-run setup is complete (`useSetupComplete()`) so
 * it never fights the setup meter for attention, and only when the
 * `onboarding-v2` assistant flag is ON. Every count query is best-effort —
 * a failed endpoint renders "—" rather than hiding the tile or throwing.
 */

import type { CSSProperties, ReactNode } from "react";

import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";

import { C, mono, serif } from "@/domains/activity/theme";
import {
  channelsReadinessGetOptions,
  connectorappsGetOptions,
  marketplaceInstalledGetOptions,
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
  const skills = useQuery({
    ...skillsGetOptions({ path, query: { kind: "installed" } }),
    staleTime: STALE_MS,
    retry: false,
  });
  // Marketplace flag OFF answers 404 — tolerated as zero, never an error UI.
  const marketplace = useQuery({
    ...marketplaceInstalledGetOptions({ path }),
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
  const scheduled = schedules.data
    ? schedules.data.schedules.filter((s) => s.status !== "cancelled").length
    : null;
  const installedSkills = skills.data
    ? (skills.data.skills?.length ?? 0) +
      (marketplace.data?.installed.length ?? 0)
    : null;
  const readyChannels = channels.data
    ? channels.data.snapshots.filter((s) => s.ready === true).length
    : null;

  return { integrations, scheduled, installedSkills, readyChannels };
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
      <Tile label="Skills" count={counts.installedSkills} to={routes.skills} />
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
    <Link to={to} style={tileStyle} data-slot="command-center-buildout-tile">
      <span style={countStyle}>
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
