/**
 * Channels & Agents — the unified "reach + pairing" overview.
 *
 * Composes two existing surfaces into one tab, deliberately reusing their
 * component bodies unchanged:
 *  - `ChannelsPage` — the "One you, every channel" reach overview (active /
 *    available channel status, hero stats, deep-links to per-channel setup).
 *  - `AgentsPage` — the A2A section (Enable-A2A toggle, paired-agents grid,
 *    one-time invite flow).
 *
 * Per-channel SETUP (token entry, connect/disconnect, the A2A invite dialog)
 * still lives in the Connections workbench at `/assistant/contacts`; both
 * sections deep-link there for the actual wiring. This page is the single
 * place where reachability and agent pairing are surfaced together.
 *
 * On MOBILE (the "You" tab of the native shell) this page renders a dedicated
 * sectioned dark screen (`YouMobilePage`) that matches the mobile design book's
 * "You" surface — a Channels card, a Memory/Settings/Connect list. It reuses
 * the SAME live daemon data hooks and the SAME deep-link navigation as the
 * desktop `ChannelsPage`, so per-channel connect/disconnect + status keep
 * working through the existing `/assistant/contacts` setup flow (no credential
 * fields, OAuth/system only). Desktop rendering is untouched.
 */

import { useMemo } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";

import {
  channelsAvailableGetOptions,
  channelsReadinessGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { AgentsPage } from "@/domains/intelligence/agents-page";
import { ChannelsPage } from "@/domains/intelligence/channels-page";
import { routes } from "@/utils/routes";

const sectionLabelStyle = {
  fontFamily: "'DM Mono', ui-monospace, monospace",
  fontSize: 10.5,
  letterSpacing: ".1em",
  textTransform: "uppercase" as const,
  color: "#9AA6B2",
  margin: "8px 0 16px",
};

export function ChannelsAgentsPage() {
  const isMobile = useIsMobile();

  // MOBILE "You" tab — dedicated sectioned screen built to the mobile design
  // book. Same data + actions as desktop, restyled for touch. Desktop path
  // below is left exactly as it was.
  if (isMobile) {
    return <YouMobilePage />;
  }

  return (
    <div style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <ChannelsPage />

      {/* Agents (A2A) section — its own labelled block beneath the channel
          reach overview. The AgentsPage body carries its own hero, so a thin
          divider + eyebrow is enough to set the two apart. */}
      <div
        style={{
          borderTop: "1px solid #E5E9F0",
          marginTop: 8,
          paddingTop: 28,
        }}
      >
        <div style={sectionLabelStyle}>Agent network</div>
        <AgentsPage />
      </div>
    </div>
  );
}

/* ───────────────────────── mobile "You" screen ───────────────────────── */

// Mobile design-book tokens — the theme-aware `--mv1-*` palette (defined in
// `index.css`). Dark/velvet themes resolve to the exact dark-v1 hexes from
// the design book (§1); the light theme falls back to the semantic tokens so
// this screen follows the active theme instead of rendering a hardcoded dark
// panel on a light page.
const M = {
  ink: "var(--mv1-ink)",
  inkDeep: "var(--mv1-ink-deep)",
  inkBottom: "var(--mv1-ink-bottom)",
  surface: "var(--mv1-surface)",
  blue: "var(--mv1-blue)",
  blueText: "var(--mv1-blue-eyebrow)",
  green: "#3FB871",
  t1: "var(--mv1-t1)",
  t2: "var(--mv1-t2)",
  t3: "var(--mv1-t3)",
  line: "var(--mv1-line)",
} as const;
const M_MONO = "'DM Mono', ui-monospace, monospace";
const M_SANS = "'DM Sans', system-ui, sans-serif";

/** Channel id union from the daemon catalog (mirrors `channels-page.tsx`). */
type ChannelId =
  | "telegram"
  | "phone"
  | "vellum"
  | "whatsapp"
  | "slack"
  | "email"
  | "platform"
  | "a2a";

/** One entry from `channelsAvailableGet` → `channels`. */
interface AvailableChannel {
  id: ChannelId;
  label: string;
  subtitle: string;
  icon: string;
  supportsVerification: boolean;
}

/** One entry from `channelsReadinessGet` → `snapshots`. */
interface ReadinessSnapshot {
  channel: string;
  ready: boolean;
  setupStatus?: string | null;
  stale?: boolean;
  channelHandle?: string | null;
}

/** A catalog channel merged with its readiness snapshot. */
interface MergedChannel extends AvailableChannel {
  ready: boolean;
  channelHandle: string | null;
}

/** Per-channel icon tile chrome, keyed by channel id. Brand tiles (Slack,
 * Telegram, WhatsApp, email) keep their brand colors in both themes; neutral
 * tiles use the theme-aware chip color (dark app-icon chip in both themes). */
const M_ICON: Record<ChannelId, { bg: string; fg: string }> = {
  phone: { bg: "var(--mv1-chip)", fg: "#86A9F2" },
  email: { bg: "#FDECEA", fg: "#EA4335" },
  slack: { bg: "#4A154B", fg: "#fff" },
  telegram: { bg: "#E7F3FB", fg: "#229ED9" },
  whatsapp: { bg: "#0B2C1A", fg: "#25D366" },
  vellum: { bg: "var(--mv1-chip)", fg: "#fff" },
  platform: { bg: "var(--mv1-chip)", fg: "#EEF2F7" },
  a2a: { bg: "var(--mv1-chip)", fg: "#8A97AC" },
};
function mIconStyle(id: ChannelId): { bg: string; fg: string } {
  return M_ICON[id] ?? { bg: "var(--mv1-chip)", fg: "#8A97AC" };
}

/** A status dot — green when the channel is connected, dim otherwise. */
function StatusDot({ connected }: { connected: boolean }) {
  return (
    <span
      aria-hidden
      style={{
        width: 8,
        height: 8,
        borderRadius: "50%",
        flexShrink: 0,
        background: connected ? M.green : "transparent",
        border: connected ? "none" : `1.5px solid ${M.t3}`,
      }}
    />
  );
}

/** A single tappable channel row inside the Channels card. */
function ChannelRow({
  channel,
  isLast,
  onPress,
}: {
  channel: MergedChannel;
  isLast: boolean;
  onPress: () => void;
}) {
  const tile = mIconStyle(channel.id);
  const desc = channel.ready
    ? (channel.channelHandle ?? channel.subtitle)
    : channel.subtitle;
  return (
    <button
      type="button"
      onClick={onPress}
      aria-label={
        channel.ready
          ? `Configure ${channel.label}`
          : `Connect ${channel.label}`
      }
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 11,
        padding: "12px 14px",
        minHeight: 44,
        textAlign: "left",
        background: "transparent",
        border: "none",
        borderBottom: isLast ? "none" : `1px solid ${M.line}`,
        cursor: "pointer",
        fontFamily: M_SANS,
        color: M.t1,
      }}
    >
      <span
        style={{
          width: 30,
          height: 30,
          borderRadius: 8,
          background: tile.bg,
          color: tile.fg,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 14,
          flexShrink: 0,
        }}
      >
        {channel.icon}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: "block",
            fontSize: 15,
            fontWeight: 600,
            color: M.t1,
          }}
        >
          {channel.label}
        </span>
        <span
          style={{
            display: "block",
            fontSize: 11.5,
            color: M.t2,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {desc}
        </span>
      </span>
      {channel.ready ? (
        <StatusDot connected />
      ) : (
        <span
          style={{
            fontSize: 11.5,
            fontWeight: 600,
            color: M.blueText,
            flexShrink: 0,
          }}
        >
          Connect
        </span>
      )}
    </button>
  );
}

/** A Memory/Settings-style list row with a chevron. */
function ConfigRow({
  glyph,
  title,
  meta,
  isLast,
  onPress,
}: {
  glyph: string;
  title: string;
  meta?: string;
  isLast: boolean;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPress}
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 11,
        padding: "13px 14px",
        minHeight: 44,
        textAlign: "left",
        background: "transparent",
        border: "none",
        borderBottom: isLast ? "none" : `1px solid ${M.line}`,
        cursor: "pointer",
        fontFamily: M_SANS,
        color: M.t1,
      }}
    >
      <span style={{ fontSize: 15, width: 18, textAlign: "center" }}>
        {glyph}
      </span>
      <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600 }}>
        {title}
        {meta && (
          <span style={{ color: M.t2, fontWeight: 400 }}> · {meta}</span>
        )}
      </span>
      <span style={{ color: M.t3, fontSize: 16 }}>›</span>
    </button>
  );
}

const cardStyle = {
  background: M.surface,
  border: `1px solid ${M.line}`,
  borderRadius: 14,
  overflow: "hidden" as const,
};
const eyebrowStyle = {
  fontFamily: M_MONO,
  fontSize: 9,
  letterSpacing: ".1em",
  color: M.t2,
  margin: "0 0 9px",
  textTransform: "uppercase" as const,
};

function YouMobilePage() {
  const assistantId = useActiveAssistantId();
  const navigate = useNavigate();

  // Deep-link to the contacts/setup surface — identical to desktop
  // `ChannelsPage`. With a channel id, contacts pre-selects the assistant pane
  // and expands that channel's connect/disconnect controls. The real wiring
  // (OAuth/system only) lives there; this screen never reimplements it.
  const goToChannelSetup = (channelId?: ChannelId) =>
    void navigate(
      channelId
        ? `${routes.contacts.root}?channel=${encodeURIComponent(channelId)}`
        : routes.contacts.root,
    );

  const availableQuery = useQuery({
    ...channelsAvailableGetOptions({ path: { assistant_id: assistantId } }),
    select: (data) => data.channels as AvailableChannel[],
  });
  const readinessQuery = useQuery({
    ...channelsReadinessGetOptions({ path: { assistant_id: assistantId } }),
    select: (data) => data.snapshots as ReadinessSnapshot[],
  });

  // Merge catalog + readiness exactly as the desktop page does: a channel is
  // "connected" iff its readiness snapshot reports `ready === true`.
  const channels = useMemo<MergedChannel[]>(() => {
    const available = availableQuery.data ?? [];
    const snapshots = readinessQuery.data ?? [];
    const byChannel = new Map<string, ReadinessSnapshot>();
    for (const snap of snapshots) byChannel.set(snap.channel, snap);

    return available.map((channel) => {
      const snap = byChannel.get(channel.id);
      return {
        ...channel,
        ready: snap?.ready === true,
        channelHandle: snap?.channelHandle ?? null,
      };
    });
  }, [availableQuery.data, readinessQuery.data]);

  const isLoading = availableQuery.isLoading || readinessQuery.isLoading;

  return (
    <div
      style={{
        fontFamily: M_SANS,
        color: M.t1,
        minHeight: "100%",
        background: `linear-gradient(180deg, ${M.ink} 0%, ${M.inkDeep} 78%, ${M.inkBottom} 100%)`,
        // No safe-area top padding here: this screen renders below the app
        // header inside the About-Assistant layout, which already clears the
        // notch. Adding it again produced a phantom gap above the hero.
        paddingTop: 0,
        paddingBottom:
          "calc(28px + var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)))",
        paddingLeft:
          "calc(20px + var(--safe-area-inset-left, env(safe-area-inset-left, 0px)))",
        paddingRight:
          "calc(20px + var(--safe-area-inset-right, env(safe-area-inset-right, 0px)))",
      }}
    >
      {/* HERO HEADER — "Reach Cue anywhere / Verify once…" */}
      <div style={{ padding: "20px 0 22px" }}>
        <div
          style={{
            fontSize: 24,
            fontWeight: 600,
            letterSpacing: "-.5px",
            color: M.t1,
          }}
        >
          Reach Cue anywhere
        </div>
        <div
          style={{
            fontSize: 14,
            color: M.t2,
            marginTop: 8,
            lineHeight: 1.5,
            maxWidth: 280,
          }}
        >
          Verify once. It knows you everywhere you message from.
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
        {/* CHANNELS — the hero section. Each row preserves real status +
            connect/configure via the existing setup flow. */}
        <section>
          <div style={eyebrowStyle}>Channels · reach cue anywhere</div>
          <div style={cardStyle}>
            {isLoading ? (
              <div
                style={{
                  padding: "22px 14px",
                  fontSize: 13,
                  color: M.t2,
                }}
              >
                Loading channels…
              </div>
            ) : channels.length === 0 ? (
              <button
                type="button"
                onClick={() => goToChannelSetup()}
                style={{
                  width: "100%",
                  padding: "18px 14px",
                  minHeight: 44,
                  textAlign: "left",
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  fontFamily: M_SANS,
                  fontSize: 13.5,
                  color: M.t2,
                }}
              >
                No channels yet — tap to connect your first one.
              </button>
            ) : (
              channels.map((channel, i) => (
                <ChannelRow
                  key={channel.id}
                  channel={channel}
                  isLast={i === channels.length - 1}
                  onPress={() => goToChannelSetup(channel.id)}
                />
              ))
            )}
          </div>
        </section>

        {/* MEMORY & CONFIG — links into the existing Memory + Settings
            routes. No credential fields; settings owns the AI-model picker,
            notifications and integrations. */}
        <section>
          <div style={eyebrowStyle}>Memory & config</div>
          <div style={cardStyle}>
            <ConfigRow
              glyph="✦"
              title="Memory"
              meta="view & edit what Cue remembers"
              isLast={false}
              onPress={() => void navigate(routes.memory)}
            />
            <ConfigRow
              glyph="⌥"
              title="AI model"
              meta="choose the model Cue thinks with"
              isLast={false}
              onPress={() => void navigate(routes.settings.ai)}
            />
            <ConfigRow
              glyph="◔"
              title="Notifications"
              isLast={false}
              onPress={() => void navigate(routes.settings.notifications)}
            />
            <ConfigRow
              glyph="◇"
              title="Integrations"
              isLast={false}
              onPress={() => void navigate(routes.settings.integrations)}
            />
            <ConfigRow
              glyph="⚙"
              title="Settings"
              meta="account & identity"
              isLast
              onPress={() => void navigate(routes.settings.general)}
            />
          </div>
        </section>
      </div>
    </div>
  );
}
