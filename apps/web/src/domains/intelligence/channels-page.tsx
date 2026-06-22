/**
 * Channels — "One you, every channel" (design surface from
 * `surfaces/Channels.dc.html`), now wired to live daemon data.
 *
 * Data:
 *  - `channelsAvailableGet` → the channel catalog (label / subtitle / emoji icon
 *    per channel).
 *  - `channelsReadinessGet` → per-channel readiness snapshots; a channel is
 *    rendered as Active/LIVE when its snapshot `ready === true`, otherwise it
 *    falls into the "Connect more" grid.
 * The two are merged by channel id. Hero stats ("N active · M available") and
 * the verified-id count are computed from this data — nothing hardcoded.
 *
 * Actions: every control deep-links to the working channel-setup UI under
 * `/assistant/contacts?channel=<id>` (Set up / Manage), which pre-selects the
 * assistant pane and scrolls to / expands that channel's setup. This page does
 * not reimplement verification or contact wiring. v0.2 ink-hero styling is
 * preserved.
 */

import { Loader2 } from "lucide-react";
import { useMemo } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";

import {
  channelsAvailableGetOptions,
  channelsReadinessGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { routes } from "@/utils/routes";

const C = {
  ink: "#1A2230",
  blue: "#3D6EE8",
  blueS: "#2B53C4",
  blueW: "#DBE4FB",
  line: "#E5E9F0",
  line2: "#D7DDE7",
  t1: "#1A2230",
  t2: "#5A6672",
  t3: "#9AA6B2",
  green: "#277E41",
} as const;
const mono = "'DM Mono', ui-monospace, monospace";

const KEYFRAMES = `
@keyframes cueDash{to{stroke-dashoffset:-14}}
@keyframes cuePulse{0%{transform:scale(1);opacity:.65}100%{transform:scale(1.45);opacity:0}}
@media (prefers-reduced-motion: reduce){.cue-anim *{animation:none !important}}
`;

/** Channel id union from the daemon catalog. */
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

/** A catalog channel merged with its readiness snapshot (if any). */
interface MergedChannel extends AvailableChannel {
  ready: boolean;
  verified: boolean;
  channelHandle: string | null;
}

/** Per-channel icon chrome (background/foreground) keyed by channel id. */
const ICON_STYLE: Record<ChannelId, { bg: string; fg: string }> = {
  phone: { bg: "#EAF0FE", fg: "#3D6EE8" },
  email: { bg: "#FDECEA", fg: "#1A2230" },
  slack: { bg: "#4A154B", fg: "#fff" },
  telegram: { bg: "#E7F3FB", fg: "#229ED9" },
  whatsapp: { bg: "#E7F8EE", fg: "#25D366" },
  vellum: { bg: "#1A2230", fg: "#fff" },
  platform: { bg: "#EEF1F6", fg: "#1A2230" },
  a2a: { bg: "#EEF1F6", fg: "#5A6672" },
};

function iconStyle(id: ChannelId): { bg: string; fg: string } {
  return ICON_STYLE[id] ?? { bg: "#EEF1F6", fg: "#5A6672" };
}

// Constellation node positions (visual only — mapped onto active channels).
const NODE_POS = [
  { x: 210, y: 44 },
  { x: 318, y: 78 },
  { x: 338, y: 160 },
  { x: 300, y: 200 },
  { x: 96, y: 86 },
  { x: 110, y: 176 },
];
const NODE_DASH = [1, 1.3, 1.1, 1.4, 1.2, 1.5];
const NODE_OPACITY = [0.7, 0.5, 0.5, 0.4, 0.5, 0.4];

function Stat({ n, label }: { n: string; label: string }) {
  return (
    <div>
      <div style={{ fontSize: 22, fontWeight: 600, color: "#fff" }}>{n}</div>
      <div style={{ fontFamily: mono, fontSize: 10.5, color: "#7E8BA3" }}>
        {label}
      </div>
    </div>
  );
}

function LiveDot({ pulse }: { pulse?: boolean }) {
  return (
    <span
      className="cue-anim"
      style={{
        position: "relative",
        width: 7,
        height: 7,
        borderRadius: "50%",
        background: C.green,
        display: "inline-block",
      }}
    >
      {pulse && (
        <span
          style={{
            position: "absolute",
            inset: -3,
            borderRadius: "50%",
            border: "1.5px solid rgba(39,126,65,.5)",
            animation: "cuePulse 2s ease-out infinite",
          }}
        />
      )}
    </span>
  );
}

/**
 * Manage action — an honest button (not a fake on/off switch). Clicking it
 * deep-links to this channel's setup pane under `/assistant/contacts`, where the
 * real connect/disconnect controls live. A one-click disable here would be
 * destructive without confirmation, so we deliberately link out instead of
 * faking a toggle.
 */
function ManageButton({ onManage }: { onManage: () => void }) {
  return (
    <button
      type="button"
      onClick={onManage}
      aria-label="Manage channel"
      style={{
        flexShrink: 0,
        fontSize: 12.5,
        border: `1px solid ${C.line2}`,
        background: "#fff",
        borderRadius: 9,
        padding: "7px 16px",
        cursor: "pointer",
        color: C.t1,
        fontWeight: 600,
      }}
    >
      Manage
    </button>
  );
}

function ActiveCard({
  icon,
  iconBg,
  iconFg,
  title,
  sub,
  full,
  verified,
  pulse,
  onManage,
}: {
  icon: string;
  iconBg: string;
  iconFg: string;
  title: string;
  sub: string;
  full?: boolean;
  verified?: boolean;
  pulse?: boolean;
  onManage: () => void;
}) {
  const inner = (
    <>
      <span
        style={{
          width: 44,
          height: 44,
          borderRadius: 12,
          background: iconBg,
          color: iconFg,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: full ? 18 : 19,
          flexShrink: 0,
        }}
      >
        {icon}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14.5, fontWeight: 600 }}>{title}</div>
        <div style={{ fontSize: 12, color: C.t2 }}>{sub}</div>
      </div>
      {full ? (
        <>
          {verified && (
            <span
              style={{
                fontFamily: mono,
                fontSize: 10,
                background: C.blueW,
                color: C.blueS,
                padding: "4px 10px",
                borderRadius: 7,
              }}
            >
              VERIFIED ID
            </span>
          )}
          <ManageButton onManage={onManage} />
        </>
      ) : (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontFamily: mono,
            fontSize: 10,
            color: C.green,
          }}
        >
          <LiveDot pulse={pulse} />
          LIVE
        </span>
      )}
    </>
  );

  // Full-width card: flex at the root (matches mock). Half-width cards wrap
  // their content in an inner flex row over the gradient surface.
  if (full) {
    return (
      <div
        style={{
          border: `1px solid ${C.line}`,
          borderRadius: 14,
          padding: 16,
          gridColumn: "span 2",
          display: "flex",
          alignItems: "center",
          gap: 14,
        }}
      >
        {inner}
      </div>
    );
  }
  return (
    <div
      style={{
        border: `1px solid ${C.line}`,
        borderRadius: 14,
        padding: 16,
        background: "linear-gradient(180deg,#FAFBFF,#fff)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 13 }}>{inner}</div>
    </div>
  );
}

function ConnectCard({
  icon,
  iconBg,
  iconFg,
  title,
  sub,
  onSetup,
}: {
  icon: string;
  iconBg: string;
  iconFg: string;
  title: string;
  sub: string;
  onSetup: () => void;
}) {
  return (
    <div
      style={{
        border: `1px solid ${C.line}`,
        borderRadius: 14,
        padding: 16,
        textAlign: "center",
      }}
    >
      <span
        style={{
          width: 48,
          height: 48,
          borderRadius: 13,
          background: iconBg,
          color: iconFg,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 21,
          marginBottom: 11,
        }}
      >
        {icon}
      </span>
      <div style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>
      <div style={{ fontSize: 11.5, color: C.t2, margin: "3px 0 11px" }}>
        {sub}
      </div>
      <button
        type="button"
        onClick={onSetup}
        style={{
          display: "inline-block",
          fontSize: 12.5,
          border: `1px solid ${C.line2}`,
          background: "#fff",
          borderRadius: 9,
          padding: "7px 18px",
          cursor: "pointer",
          color: C.t1,
        }}
      >
        Enable
      </button>
    </div>
  );
}

const labelStyle = {
  fontFamily: mono,
  fontSize: 10.5,
  letterSpacing: ".1em",
  textTransform: "uppercase" as const,
  color: C.t3,
  margin: "24px 0 12px",
};

export function ChannelsPage() {
  const assistantId = useActiveAssistantId();
  const navigate = useNavigate();
  // Deep-link to the contacts surface. With a channel id, the contacts page
  // pre-selects the assistant pane and scrolls to / expands that channel's
  // setup row (see contacts-page.tsx's search-param handling).
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

  const merged = useMemo<MergedChannel[]>(() => {
    const available = availableQuery.data ?? [];
    const snapshots = readinessQuery.data ?? [];
    const byChannel = new Map<string, ReadinessSnapshot>();
    for (const snap of snapshots) byChannel.set(snap.channel, snap);

    return available.map((channel) => {
      const snap = byChannel.get(channel.id);
      const ready = snap?.ready === true;
      return {
        ...channel,
        ready,
        verified: ready && channel.supportsVerification,
        channelHandle: snap?.channelHandle ?? null,
      };
    });
  }, [availableQuery.data, readinessQuery.data]);

  const active = useMemo(() => merged.filter((c) => c.ready), [merged]);
  const connectMore = useMemo(() => merged.filter((c) => !c.ready), [merged]);
  const verifiedCount = useMemo(
    () => active.filter((c) => c.verified).length,
    [active],
  );

  const isLoading = availableQuery.isLoading || readinessQuery.isLoading;
  const isEmpty = !isLoading && merged.length === 0;

  if (isLoading) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          minHeight: 320,
          fontFamily: "'DM Sans', system-ui, sans-serif",
          color: C.t2,
        }}
      >
        <Loader2 size={22} color={C.blue} className="cue-spin" />
        <style
          dangerouslySetInnerHTML={{
            __html:
              "@keyframes cueSpin{to{transform:rotate(360deg)}}.cue-spin{animation:cueSpin 1s linear infinite}",
          }}
        />
        <div style={{ fontSize: 13.5 }}>Loading channels…</div>
      </div>
    );
  }

  return (
    <div
      style={{ padding: "0 0 28px", fontFamily: "'DM Sans', system-ui, sans-serif" }}
    >
      <style dangerouslySetInnerHTML={{ __html: KEYFRAMES }} />

      {/* IMMERSIVE HERO */}
      <div
        style={{
          position: "relative",
          background: C.ink,
          borderRadius: 18,
          overflow: "hidden",
          display: "grid",
          gridTemplateColumns: "1fr 420px",
          alignItems: "center",
          minHeight: 240,
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "radial-gradient(420px 240px at 82% 50%,rgba(61,110,232,.22),transparent 70%)",
          }}
        />
        <div style={{ padding: "34px 36px", position: "relative" }}>
          <div
            style={{
              fontFamily: mono,
              fontSize: 11,
              letterSpacing: ".14em",
              textTransform: "uppercase",
              color: "#7FA0F0",
            }}
          >
            Channels · live
          </div>
          <div
            style={{
              fontSize: 32,
              fontWeight: 600,
              letterSpacing: "-1px",
              color: "#fff",
              marginTop: 10,
              lineHeight: 1.06,
            }}
          >
            One you,
            <br />
            every channel.
          </div>
          <p
            style={{
              fontSize: 14.5,
              color: "#AEB7C7",
              marginTop: 12,
              maxWidth: 380,
            }}
          >
            Connect a channel, verify once, and Cue recognizes you wherever you
            reach it — voice, email, chat, or a phone call. One memory behind
            them all.
          </p>
          <div style={{ display: "flex", gap: 18, marginTop: 18 }}>
            <Stat n={String(active.length)} label="active" />
            <div style={{ width: 1, background: "rgba(255,255,255,.12)" }} />
            <Stat n={String(verifiedCount)} label="verified id" />
            <div style={{ width: 1, background: "rgba(255,255,255,.12)" }} />
            <Stat n={String(connectMore.length)} label="available" />
          </div>
        </div>

        {/* constellation — nodes mapped onto active channels */}
        <div className="cue-anim" style={{ position: "relative", height: 240 }}>
          <svg
            width="420"
            height="240"
            viewBox="0 0 420 240"
            style={{ position: "absolute", inset: 0 }}
          >
            {active.slice(0, NODE_POS.length).map((c, i) => {
              const pos = NODE_POS[i]!;
              return (
                <line
                  key={c.id}
                  x1="210"
                  y1="120"
                  x2={pos.x}
                  y2={pos.y}
                  stroke={C.blue}
                  strokeWidth="1.5"
                  strokeDasharray="3 4"
                  opacity={NODE_OPACITY[i]}
                  style={{ animation: `cueDash ${NODE_DASH[i]}s linear infinite` }}
                />
              );
            })}
          </svg>
          <div
            style={{
              position: "absolute",
              left: 210,
              top: 120,
              transform: "translate(-50%,-50%)",
              width: 62,
              height: 62,
              borderRadius: 17,
              background: "#0F1620",
              border: "1px solid rgba(255,255,255,.12)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 2,
            }}
          >
            <span
              style={{
                position: "absolute",
                inset: 0,
                borderRadius: 17,
                border: "2px solid rgba(61,110,232,.6)",
                animation: "cuePulse 2.4s ease-out infinite",
              }}
            />
            <span
              style={{
                fontSize: 34,
                fontWeight: 600,
                color: "#EEF2F7",
                position: "relative",
                lineHeight: 1,
              }}
            >
              C
              <span
                style={{
                  position: "absolute",
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: C.blue,
                  right: 9,
                  bottom: 12,
                }}
              />
            </span>
          </div>
          {active.slice(0, NODE_POS.length).map((c, i) => {
            const pos = NODE_POS[i]!;
            const style = iconStyle(c.id);
            return (
              <div
                key={c.id}
                title={c.label}
                style={{
                  position: "absolute",
                  left: pos.x,
                  top: pos.y,
                  transform: "translate(-50%,-50%)",
                  width: 37,
                  height: 37,
                  borderRadius: 11,
                  background: style.bg,
                  color: style.fg,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 16,
                  boxShadow: "0 6px 14px -6px rgba(0,0,0,.5)",
                }}
              >
                {c.icon}
              </div>
            );
          })}
        </div>
      </div>

      {isEmpty ? (
        /* EMPTY STATE */
        <div
          style={{
            border: `1px solid ${C.line}`,
            borderRadius: 14,
            padding: "40px 24px",
            textAlign: "center",
            marginTop: 24,
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 600, color: C.t1 }}>
            No channels yet
          </div>
          <div
            style={{
              fontSize: 13,
              color: C.t2,
              margin: "6px auto 16px",
              maxWidth: 360,
            }}
          >
            Connect your first channel so Cue can recognize you wherever you
            reach it.
          </div>
          <button
            type="button"
            onClick={() => goToChannelSetup()}
            style={{
              fontSize: 13,
              border: "none",
              background: C.blue,
              color: "#fff",
              borderRadius: 9,
              padding: "9px 20px",
              cursor: "pointer",
              fontWeight: 600,
            }}
          >
            Connect a channel
          </button>
        </div>
      ) : (
        <>
          {/* ACTIVE */}
          {active.length > 0 && (
            <>
              <div style={labelStyle}>Active</div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 12,
                }}
              >
                {active.map((c, i) => {
                  const style = iconStyle(c.id);
                  // Last card spans full width when the count is odd, matching
                  // the v0.2 layout.
                  const full = active.length % 2 === 1 && i === active.length - 1;
                  return (
                    <ActiveCard
                      key={c.id}
                      icon={c.icon}
                      iconBg={style.bg}
                      iconFg={style.fg}
                      title={c.label}
                      sub={c.channelHandle ?? c.subtitle}
                      full={full}
                      verified={c.verified}
                      pulse={i === 0}
                      onManage={() => goToChannelSetup(c.id)}
                    />
                  );
                })}
              </div>
            </>
          )}

          {/* CONNECT MORE */}
          {connectMore.length > 0 && (
            <>
              <div style={labelStyle}>Connect more</div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr 1fr",
                  gap: 12,
                }}
              >
                {connectMore.map((c) => {
                  const style = iconStyle(c.id);
                  return (
                    <ConnectCard
                      key={c.id}
                      icon={c.icon}
                      iconBg={style.bg}
                      iconFg={style.fg}
                      title={c.label}
                      sub={c.subtitle}
                      onSetup={() => goToChannelSetup(c.id)}
                    />
                  );
                })}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
