import { useQuery } from "@tanstack/react-query";
import {
  Bell,
  CalendarClock,
  Mail,
  Mic,
  ShieldCheck,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { useNavigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { requestComposerFocus } from "@/domains/chat/composer-focus";
import { createDraftConversationId } from "@/domains/chat/utils/conversation-selection";
import { useHomeFeedQuery } from "@/domains/home/hooks/use-home-feed-query";
import { selectNextMove, selectNoticed } from "@/domains/home/utils";
import { homeImpactGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { useConversationStore } from "@/stores/conversation-store";
import { useViewerStore } from "@/stores/viewer-store";
import { routes } from "@/utils/routes";
import type { FeedItem } from "@vellumai/assistant-api";

/**
 * Home — faithful translation of `surfaces/Home.dc.html`.
 *
 * The app already supplies the dark sidebar, so this renders the design's MAIN
 * column + DAY RAIL on the cool canvas: an aperture-avatar lead with the
 * editorial "one move" line, an ink "drafted for you" next-move card, a queue
 * of things that also need you (urgency-coloured rails), a "while you slept"
 * recap strip linking to Impact, and a right rail with the day timeline + open
 * commitments. Wired to the real home-feed + impact data; degrades gracefully
 * when the board is light.
 */

// Exact design tokens (mirrors the inline palette in Home.dc.html).
const C = {
  ink: "#1A2230",
  blue: "#3D6EE8",
  blueS: "#2B53C4",
  blue9: "#9DB4E6",
  bg: "#F4F6F9",
  sunken: "#EEF1F6",
  line: "#E5E9F0",
  line2: "#D7DDE7",
  t1: "#1A2230",
  t2: "#5A6672",
  t3: "#8D99A5",
  green: "#277E41",
  amber: "#C98A1B",
  danger: "#DA491A",
  white: "#FFFFFF",
} as const;

const mono = "'DM Mono', ui-monospace, monospace";
const serif = "'Instrument Serif', Georgia, serif";

const KEYFRAMES = `
@keyframes cueLook{0%,100%{transform:rotate(40deg)}50%{transform:rotate(64deg)}}
@keyframes cueBlink{0%,90%,100%{opacity:1}94%{opacity:.15}}
@keyframes cuePing{0%{transform:scale(1);opacity:.7}100%{transform:scale(1.5);opacity:0}}
@media (prefers-reduced-motion: reduce){.cue-anim *{animation:none !important}}
`;

function ApertureAvatar() {
  return (
    <span
      className="cue-anim"
      style={{
        position: "relative",
        width: 34,
        height: 34,
        borderRadius: 10,
        background: C.ink,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      <span
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: 10,
          border: "1.5px solid rgba(61,110,232,.5)",
          animation: "cuePing 2.8s ease-out infinite",
        }}
      />
      <span
        style={{
          width: 20,
          height: 20,
          borderRadius: "50%",
          boxShadow: "0 0 0 4px #EEF2F7 inset",
          WebkitMask:
            "radial-gradient(circle,transparent 56%,#000 57%)",
          mask: "radial-gradient(circle,transparent 56%,#000 57%)",
          transform: "rotate(40deg)",
          animation: "cueLook 6s ease-in-out infinite",
          position: "relative",
          display: "block",
        }}
      >
        <span
          style={{
            position: "absolute",
            borderRadius: "50%",
            background: C.blue,
            width: "26%",
            height: "26%",
            top: "8%",
            left: "8%",
            animation: "cueBlink 4s infinite",
            display: "block",
          }}
        />
      </span>
    </span>
  );
}

function urgencyColor(item: FeedItem): string {
  if (item.urgency === "critical" || item.urgency === "high") return C.danger;
  if (item.urgency === "medium") return C.amber;
  return C.line2;
}

// Per-category glyph + wash for the "Also needs you" queue chips, mirroring the
// 34px icon tiles in Home.dc.html. The wash tints (danger/violet/amber/blue) are
// the design's exact chip backgrounds; the strong colour drives the glyph.
const QUEUE_CHIP_STYLE: Record<
  string,
  { icon: LucideIcon; wash: string; ink: string }
> = {
  email: { icon: Mail, wash: "#FDE7E2", ink: C.danger },
  scheduling: { icon: CalendarClock, wash: "#FBF0DA", ink: C.amber },
  security: { icon: ShieldCheck, wash: "#EEEDFB", ink: C.blueS },
  background: { icon: Sparkles, wash: "#EEEDFB", ink: "#534AB7" },
  system: { icon: Bell, wash: C.sunken, ink: C.t2 },
};

function queueChipStyle(item: FeedItem) {
  return QUEUE_CHIP_STYLE[item.category ?? "system"] ?? QUEUE_CHIP_STYLE.system;
}

export function HomeElevatedRoute() {
  const navigate = useNavigate();
  const assistantId = useActiveAssistantId();
  const feedQuery = useHomeFeedQuery(assistantId);
  const impactQuery = useQuery({
    ...homeImpactGetOptions({
      path: { assistant_id: assistantId ?? "" },
      query: { rangeDays: 7 },
    }),
    enabled: !!assistantId,
  });

  const items = feedQuery.data?.items ?? [];
  const boardItems = items.filter((i) => i.id.startsWith("action-board:"));
  const nextMove = selectNextMove(boardItems);
  const commitments = selectNoticed(boardItems, nextMove?.id ?? undefined, 3);
  // Clean time-based greeting matching the design template ("Good morning. …"),
  // rather than the daemon's verbose personalized line which doesn't compose
  // with the "your one move" sentence.
  const hour = new Date().getHours();
  const greeting =
    hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const handled = impactQuery.data?.taskCount ?? 0;
  const hoursSaved = impactQuery.data?.hoursSaved ?? 0;
  const recent = impactQuery.data?.recent ?? [];

  const now = new Date();
  const day = now
    .toLocaleDateString(undefined, { weekday: "long" })
    .toUpperCase();
  const time = now.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });

  const seedChat = (prompt: string) => {
    useViewerStore.getState().setMainView("chat");
    const id = createDraftConversationId();
    useConversationStore.getState().setActiveConversationId(id);
    navigate(`${routes.conversation(id)}?prompt=${encodeURIComponent(prompt)}`);
    requestComposerFocus();
  };
  const action = (item: FeedItem) => item.actions?.[0] ?? null;

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        background: C.bg,
        color: C.t1,
        fontFamily: "'DM Sans', system-ui, sans-serif",
        display: "grid",
        gridTemplateColumns: "minmax(0,1fr) 300px",
        overflow: "hidden",
      }}
    >
      <style dangerouslySetInnerHTML={{ __html: KEYFRAMES }} />

      {/* MAIN COLUMN */}
      <div style={{ overflowY: "auto" }}>
        <div style={{ maxWidth: 760, margin: "0 auto", padding: "0 8px" }}>
          {/* LEAD */}
          <div style={{ padding: "26px 20px 22px", borderBottom: `1px solid ${C.line}` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <ApertureAvatar />
              <span
                style={{
                  fontFamily: mono,
                  fontSize: 11,
                  color: C.t3,
                  letterSpacing: ".04em",
                }}
              >
                {day} · {time} · {handled} HANDLED THIS WEEK
              </span>
              {/*
                Meeting entry point. Meeting was demoted from the nav rail per
                the clean-rail design; this surfaces it as an in-context action
                (record → transcribe → recap) on Home. Route /assistant/meeting
                stays live.
              */}
              <button
                type="button"
                onClick={() => navigate(routes.meeting)}
                style={{
                  marginLeft: "auto",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  background: C.white,
                  border: `1px solid ${C.line2}`,
                  borderRadius: 9,
                  padding: "6px 12px",
                  fontSize: 12,
                  fontWeight: 500,
                  color: C.t1,
                  cursor: "pointer",
                }}
              >
                <Mic width={14} height={14} color={C.blueS} />
                Take into a meeting
              </button>
            </div>
            <div
              style={{
                fontFamily: serif,
                fontSize: 30,
                letterSpacing: "-.3px",
                lineHeight: 1.16,
                marginTop: 13,
                maxWidth: 580,
              }}
            >
              {nextMove ? (
                <>
                  {greeting}. Your one move right now is the{" "}
                  <span style={{ fontStyle: "italic", color: C.blueS }}>
                    {nextMove.title}.
                  </span>
                </>
              ) : (
                <>{greeting}. You&apos;re all caught up — nothing needs you right now.</>
              )}
            </div>

            {/* INK DRAFTED CARD */}
            {nextMove && (
              <div
                style={{
                  background: C.ink,
                  color: C.white,
                  borderRadius: 14,
                  padding: "16px 18px",
                  marginTop: 16,
                  display: "flex",
                  alignItems: "center",
                  gap: 16,
                  boxShadow: "0 18px 36px -22px rgba(26,34,48,.6)",
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontFamily: mono,
                      fontSize: 10,
                      color: C.blue9,
                      letterSpacing: ".04em",
                    }}
                  >
                    {nextMove.category === "email"
                      ? "DRAFTED FOR YOU"
                      : (nextMove.urgency ?? "next move").toUpperCase()}
                  </div>
                  <div style={{ fontSize: 16, fontWeight: 500, marginTop: 4 }}>
                    {nextMove.title}
                  </div>
                  <div style={{ fontSize: 12.5, color: C.blue9, marginTop: 3 }}>
                    {nextMove.summary}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 7, flexShrink: 0 }}>
                  {action(nextMove) && (
                    <button
                      type="button"
                      onClick={() => seedChat(action(nextMove)!.prompt)}
                      style={{
                        fontSize: 12.5,
                        background: C.blue,
                        color: C.white,
                        border: "none",
                        borderRadius: 9,
                        padding: "9px 16px",
                        cursor: "pointer",
                      }}
                    >
                      {action(nextMove)!.label}
                    </button>
                  )}
                  {nextMove.conversationId && (
                    <button
                      type="button"
                      onClick={() =>
                        navigate(routes.conversation(nextMove.conversationId!))
                      }
                      style={{
                        fontSize: 12.5,
                        background: "rgba(255,255,255,.1)",
                        color: C.white,
                        border: "none",
                        borderRadius: 9,
                        padding: "9px 14px",
                        cursor: "pointer",
                      }}
                    >
                      Open
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* QUEUE */}
          {commitments.length > 0 && (
            <>
              <div
                style={{
                  padding: "18px 20px 8px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                }}
              >
                <div
                  style={{
                    fontSize: 11,
                    fontFamily: mono,
                    letterSpacing: ".1em",
                    textTransform: "uppercase",
                    color: C.t3,
                  }}
                >
                  Also needs you · {commitments.length}
                </div>
                {/*
                  Next moves was demoted from the nav rail — the full unified
                  queue lives at /assistant/next-moves and is reachable from
                  here, where its items already surface as Home's feed.
                */}
                <button
                  type="button"
                  onClick={() => navigate(routes.nextMoves)}
                  style={{
                    background: "none",
                    border: "none",
                    padding: 0,
                    fontSize: 12,
                    fontWeight: 500,
                    color: C.blueS,
                    cursor: "pointer",
                  }}
                >
                  See all moves ›
                </button>
              </div>
              <div style={{ padding: "0 20px 8px", display: "flex", flexDirection: "column" }}>
                {commitments.map((item, i) => (
                  <div
                    key={item.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 13,
                      padding: "13px 0",
                      borderBottom:
                        i < commitments.length - 1 ? `1px solid ${C.line}` : "none",
                    }}
                  >
                    <span
                      style={{
                        width: 3,
                        height: 34,
                        borderRadius: 3,
                        background: urgencyColor(item),
                        flexShrink: 0,
                      }}
                    />
                    {(() => {
                      const chip = queueChipStyle(item);
                      const ChipIcon = chip.icon;
                      return (
                        <span
                          aria-hidden="true"
                          style={{
                            width: 34,
                            height: 34,
                            borderRadius: 9,
                            background: chip.wash,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            flexShrink: 0,
                          }}
                        >
                          <ChipIcon width={16} height={16} color={chip.ink} />
                        </span>
                      );
                    })()}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 500 }}>
                        {item.title}
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          color: C.t2,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {item.summary}
                      </div>
                    </div>
                    {action(item) && (
                      <button
                        type="button"
                        onClick={() => seedChat(action(item)!.prompt)}
                        style={{
                          fontSize: 12,
                          border: `1px solid ${C.line2}`,
                          background: C.white,
                          borderRadius: 8,
                          padding: "7px 13px",
                          cursor: "pointer",
                          flexShrink: 0,
                          color: C.t1,
                        }}
                      >
                        {action(item)!.label}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}

          {/* RECAP STRIP */}
          <button
            type="button"
            onClick={() => navigate(routes.impact)}
            style={{
              margin: "6px 20px 24px",
              width: "calc(100% - 40px)",
              background: C.sunken,
              border: "none",
              borderRadius: 13,
              padding: "13px 16px",
              display: "flex",
              alignItems: "center",
              gap: 14,
              flexWrap: "wrap",
              cursor: "pointer",
              textAlign: "left",
            }}
          >
            <span
              style={{
                fontFamily: mono,
                fontSize: 10,
                color: C.t3,
                letterSpacing: ".1em",
                whiteSpace: "nowrap",
              }}
            >
              WHILE YOU SLEPT
            </span>
            <span style={{ fontSize: 13, color: C.t2, whiteSpace: "nowrap" }}>
              {handled > 0
                ? `${handled} ${handled === 1 ? "task" : "tasks"} handled for you`
                : "Cue is watching your inbox & calendar"}
            </span>
            <span
              style={{
                marginLeft: "auto",
                display: "inline-flex",
                alignItems: "center",
                gap: 7,
                whiteSpace: "nowrap",
              }}
            >
              {hoursSaved > 0 && (
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    background: "#E9F5EE",
                    border: "1px solid #BFE3CD",
                    borderRadius: 8,
                    padding: "5px 11px",
                  }}
                >
                  <span
                    style={{
                      fontSize: 14,
                      fontWeight: 600,
                      color: C.green,
                      letterSpacing: "-.3px",
                    }}
                  >
                    ≈{hoursSaved} hrs
                  </span>
                  <span style={{ fontSize: 12, color: "#3E7A55" }}>
                    saved this week
                  </span>
                </span>
              )}
              <span style={{ fontSize: 12, color: C.blueS, fontWeight: 500 }}>
                Full recap ›
              </span>
            </span>
          </button>
        </div>
      </div>

      {/* DAY RAIL */}
      <aside
        style={{
          background: C.bg,
          borderLeft: `1px solid ${C.line}`,
          padding: "20px 18px",
          display: "flex",
          flexDirection: "column",
          gap: 0,
          overflowY: "auto",
        }}
      >
        <div
          style={{
            fontFamily: mono,
            fontSize: 10,
            letterSpacing: ".1em",
            textTransform: "uppercase",
            color: C.t3,
            marginBottom: 16,
          }}
        >
          Recently · by Cue
        </div>
        {recent.length > 0 ? (
          <div style={{ position: "relative", paddingLeft: 18, flex: 1 }}>
            <span
              style={{
                position: "absolute",
                left: 4,
                top: 4,
                bottom: 10,
                width: 2,
                background: C.line,
              }}
            />
            {recent.slice(0, 6).map((r, i) => (
              <div key={i} style={{ position: "relative", marginBottom: 16 }}>
                <span
                  style={{
                    position: "absolute",
                    left: -18,
                    top: 3,
                    width: 10,
                    height: 10,
                    borderRadius: "50%",
                    background: C.green,
                    boxShadow: `0 0 0 3px ${C.bg}`,
                  }}
                />
                <div style={{ fontSize: 12.5, fontWeight: 500 }}>{r.detail}</div>
                <div style={{ fontSize: 11, color: C.t2 }}>by Cue</div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 12.5, color: C.t2, flex: 1 }}>
            As Cue handles things on your behalf, they show up here.
          </div>
        )}

        {commitments.length > 0 && (
          <div style={{ borderTop: `1px solid ${C.line}`, paddingTop: 14, marginTop: 8 }}>
            <div
              style={{
                fontFamily: mono,
                fontSize: 10,
                letterSpacing: ".1em",
                textTransform: "uppercase",
                color: C.t3,
                marginBottom: 10,
              }}
            >
              Open commitments
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {commitments.map((item) => (
                <div
                  key={item.id}
                  style={{
                    background: C.white,
                    border: `1px solid ${C.line}`,
                    borderRadius: 11,
                    padding: "10px 12px",
                  }}
                >
                  <div
                    style={{
                      fontSize: 12.5,
                      fontWeight: 500,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {item.title}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: C.t2,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {item.summary}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}
