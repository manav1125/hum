import { useQuery } from "@tanstack/react-query";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { homeImpactGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { useNavigate } from "react-router";
import { routes } from "@/utils/routes";

/**
 * Impact — faithful translation of `surfaces/Impact.dc.html`.
 *
 * Full-bleed "your week with Cue": an ink hero (aperture avatar, the serif
 * "Cue gave you back N hours", and a per-day sparkline), a "where the time
 * went" category breakdown, the "a few things Cue handled" highlights + stat
 * tiles, and the value CTA. Wired to GET /v1/home/impact (real recorded data).
 */

/**
 * Theme-aware `--mv1-*` vars (src/index.css): light themes resolve to the
 * exact v0.3 hexes, dark/velvet swap to the dark-book equivalents.
 */
const C = {
  ink: "var(--mv1-t1)",
  blue: "var(--mv1-blue)",
  blueS: "var(--mv1-blue-strong)",
  blueW: "var(--mv1-blue-wash)",
  violet: "var(--mv1-violet)",
  bg: "var(--mv1-canvas)",
  surface: "var(--mv1-card)",
  sunken: "var(--mv1-sunken)",
  line: "var(--mv1-line)",
  t2: "var(--mv1-t2)",
  t3: "var(--mv1-t3)",
  green: "var(--mv1-green)",
  amber: "var(--mv1-amber)",
} as const;
/** The hero band + value CTA are deliberately ink navy in EVERY theme. */
const INK_HERO = "#1A2230";
const mono = "'DM Mono', ui-monospace, monospace";
const serif = "'Instrument Serif', Georgia, serif";

type CategoryMeta = {
  label: string;
  color: string;
  /** glyph + tile wash for the "things Cue handled" highlights */
  icon: string;
  wash: string;
};

const CATEGORY: Record<string, CategoryMeta> = {
  email: { label: "Email triage", color: C.blue, icon: "✉", wash: C.blueW },
  meetings: {
    label: "Meetings captured",
    color: C.violet,
    icon: "✦",
    wash: `color-mix(in srgb, ${C.violet} 14%, transparent)`,
  },
  scheduling: {
    label: "Scheduling",
    color: "#0E8C8C",
    icon: "◷",
    wash: "color-mix(in srgb, #0E8C8C 14%, transparent)",
  },
  calls: {
    label: "Calls & errands",
    color: C.amber,
    icon: "☎",
    wash: `color-mix(in srgb, ${C.amber} 14%, transparent)`,
  },
  research: {
    label: "Research",
    color: "#5A57C4",
    icon: "❖",
    wash: "color-mix(in srgb, #5A57C4 14%, transparent)",
  },
  other: { label: "Other", color: C.t3, icon: "•", wash: C.sunken },
};

function categoryMeta(category: string): CategoryMeta {
  return (
    CATEGORY[category] ?? {
      label: category,
      color: C.t3,
      icon: "•",
      wash: C.sunken,
    }
  );
}

const MONTHS = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
];

/** "JUN 10 – 16" — the real window ending today, spanning `rangeDays`. */
function rangeLabel(rangeDays: number): string {
  const end = new Date();
  const start = new Date(end);
  start.setDate(end.getDate() - Math.max(0, rangeDays - 1));
  const sm = MONTHS[start.getMonth()];
  const em = MONTHS[end.getMonth()];
  return sm === em
    ? `${sm} ${start.getDate()} – ${end.getDate()}`
    : `${sm} ${start.getDate()} – ${em} ${end.getDate()}`;
}

const KEYFRAMES = `
@keyframes cueLook{0%,100%{transform:rotate(40deg)}50%{transform:rotate(64deg)}}
@keyframes cueBlink{0%,90%,100%{opacity:1}94%{opacity:.15}}
@keyframes cuePing{0%{transform:scale(1);opacity:.7}100%{transform:scale(1.5);opacity:0}}
@media (prefers-reduced-motion: reduce){.cue-anim *{animation:none !important}}
`;

function Aperture() {
  return (
    <span
      className="cue-anim"
      style={{
        position: "relative",
        width: 36,
        height: 36,
        borderRadius: 11,
        background: "#0F1620",
        border: "1px solid rgba(255,255,255,.1)",
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
          borderRadius: 11,
          border: "1.5px solid rgba(61,110,232,.5)",
          animation: "cuePing 2.8s ease-out infinite",
        }}
      />
      <span
        style={{
          width: 21,
          height: 21,
          borderRadius: "50%",
          boxShadow: "0 0 0 3px #EEF2F7 inset",
          WebkitMask: "radial-gradient(circle,transparent 56%,#000 57%)",
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

export function ImpactPage() {
  const assistantId = useActiveAssistantId();
  const navigate = useNavigate();
  const { data } = useQuery({
    ...homeImpactGetOptions({
      path: { assistant_id: assistantId ?? "" },
      query: { rangeDays: 7 },
    }),
    enabled: !!assistantId,
  });

  const rangeDays = data?.rangeDays ?? 7;
  const hoursSaved = data?.hoursSaved ?? 0;
  const taskCount = data?.taskCount ?? 0;
  const byCategory = data?.byCategory ?? [];
  const byDay = data?.byDay ?? [0, 0, 0, 0, 0, 0, 0];
  const recent = data?.recent ?? [];
  const maxCat = Math.max(0.1, ...byCategory.map((c) => c.hours));
  const maxDay = Math.max(0.1, ...byDay);
  // Intra-week momentum: the last three days vs the first three of the 7-day
  // window. An honest trend from the data we have — NOT a true week-over-week
  // (that would need a 14-day series from the daemon), so it's labelled
  // "vs earlier this week", not "vs last week".
  const recentSum = byDay.slice(-3).reduce((a, b) => a + b, 0);
  const earlierSum = byDay.slice(0, 3).reduce((a, b) => a + b, 0);
  const trendPct =
    earlierSum > 0
      ? Math.round(((recentSum - earlierSum) / earlierSum) * 100)
      : recentSum > 0
        ? 100
        : 0;
  const dayLabels = ["M", "T", "W", "T", "F", "S", "S"];
  const todayIdx = (new Date().getDay() + 6) % 7;

  // Average time returned per task — a real, derived figure for the second
  // stat tile (the mock shows an approval %, which we have no source for).
  const minsPerTask =
    taskCount > 0 ? Math.round((hoursSaved * 60) / taskCount) : 0;

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: "auto",
        background: C.bg,
        color: C.ink,
        fontFamily: "'DM Sans', system-ui, sans-serif",
      }}
    >
      <style dangerouslySetInnerHTML={{ __html: KEYFRAMES }} />
      <div style={{ maxWidth: 1000, margin: "0 auto" }}>
        {/* HERO */}
        <div
          style={{
            position: "relative",
            overflow: "hidden",
            background: INK_HERO,
            color: "#fff",
            padding: "34px 36px 30px",
          }}
        >
          <div
            style={{
              position: "absolute",
              inset: 0,
              background:
                "radial-gradient(520px 280px at 86% 30%,rgba(61,110,232,.28),transparent 70%)",
            }}
          />
          <div
            style={{
              position: "relative",
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              gap: 24,
              flexWrap: "wrap",
            }}
          >
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
                <Aperture />
                <span
                  style={{
                    fontFamily: mono,
                    fontSize: 11,
                    color: "#7FA0F0",
                    letterSpacing: ".06em",
                  }}
                >
                  {rangeLabel(rangeDays)} · YOUR WEEK WITH CUE
                </span>
              </div>
              <div
                style={{
                  fontFamily: serif,
                  fontSize: 34,
                  letterSpacing: "-.4px",
                  marginTop: 16,
                  lineHeight: 1.12,
                }}
              >
                This week, Cue gave you back
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 12,
                  marginTop: 4,
                }}
              >
                <span
                  style={{
                    fontSize: 72,
                    fontWeight: 600,
                    letterSpacing: "-3px",
                    lineHeight: 1,
                  }}
                >
                  {hoursSaved}
                </span>
                <span
                  style={{
                    fontFamily: serif,
                    fontSize: 34,
                    fontStyle: "italic",
                    color: "#9DB4E6",
                  }}
                >
                  {hoursSaved === 1 ? "hour" : "hours"}
                </span>
              </div>
              <p
                style={{
                  fontSize: 14,
                  color: "#AEB7C7",
                  marginTop: 8,
                  maxWidth: 420,
                }}
              >
                Across{" "}
                <b style={{ color: "#fff" }}>
                  {taskCount} {taskCount === 1 ? "task" : "tasks"}
                </b>{" "}
                handled on your behalf
                {hoursSaved >= 8
                  ? " — more than a full workday returned to you."
                  : "."}
              </p>
            </div>

            {/* sparkline */}
            <div
              style={{
                flexShrink: 0,
                width: 230,
                background: "rgba(255,255,255,.05)",
                border: "1px solid rgba(255,255,255,.1)",
                borderRadius: 14,
                padding: 16,
              }}
            >
              <div
                style={{
                  fontFamily: mono,
                  fontSize: 10,
                  color: "#7FA0F0",
                  letterSpacing: ".08em",
                  marginBottom: 12,
                }}
              >
                HOURS SAVED / DAY
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-end",
                  gap: 7,
                  height: 80,
                }}
              >
                {byDay.map((h, i) => (
                  <div
                    key={i}
                    style={{
                      flex: 1,
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      gap: 5,
                    }}
                  >
                    <div
                      style={{
                        width: "100%",
                        height: `${Math.max(4, (h / maxDay) * 100)}%`,
                        background:
                          i === todayIdx ? C.blue : "rgba(61,110,232,.4)",
                        borderRadius: "4px 4px 0 0",
                      }}
                    />
                    <span
                      style={{
                        fontFamily: mono,
                        fontSize: 8.5,
                        color: "#7E8BA3",
                      }}
                    >
                      {dayLabels[i]}
                    </span>
                  </div>
                ))}
              </div>
              {trendPct !== 0 && (recentSum > 0 || earlierSum > 0) && (
                <div
                  style={{
                    marginTop: 12,
                    fontFamily: mono,
                    fontSize: 10,
                    letterSpacing: ".04em",
                    color: trendPct > 0 ? "#6FCF97" : "#E0B15E",
                  }}
                >
                  {trendPct > 0 ? "▲" : "▼"} {Math.abs(trendPct)}% vs earlier
                  this week
                </div>
              )}
            </div>
          </div>
        </div>

        <div
          style={{
            padding: "26px 36px",
            display: "flex",
            flexDirection: "column",
            gap: 26,
          }}
        >
          {/* where the time went */}
          {byCategory.length > 0 && (
            <div>
              <div
                style={{
                  fontFamily: mono,
                  fontSize: 10.5,
                  letterSpacing: ".1em",
                  textTransform: "uppercase",
                  color: C.t3,
                  marginBottom: 14,
                }}
              >
                Where the time went
              </div>
              <div
                style={{ display: "flex", flexDirection: "column", gap: 13 }}
              >
                {byCategory.map((c) => {
                  const meta = categoryMeta(c.category);
                  return (
                    <div
                      key={c.category}
                      style={{ display: "flex", alignItems: "center", gap: 14 }}
                    >
                      <span
                        style={{
                          width: 150,
                          fontSize: 13.5,
                          fontWeight: 500,
                          display: "flex",
                          alignItems: "center",
                          gap: 9,
                        }}
                      >
                        <span
                          style={{
                            width: 10,
                            height: 10,
                            borderRadius: 3,
                            background: meta.color,
                          }}
                        />
                        {meta.label}
                      </span>
                      <span
                        style={{
                          flex: 1,
                          height: 10,
                          borderRadius: 5,
                          background: C.sunken,
                          overflow: "hidden",
                        }}
                      >
                        <span
                          style={{
                            display: "block",
                            width: `${Math.max(3, (c.hours / maxCat) * 100)}%`,
                            height: "100%",
                            background: meta.color,
                            borderRadius: 5,
                          }}
                        />
                      </span>
                      <span
                        style={{
                          fontFamily: mono,
                          fontSize: 12,
                          color: C.t2,
                          width: 54,
                          textAlign: "right",
                        }}
                      >
                        {c.hours} hrs
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* highlights + stats */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1.4fr 1fr",
              gap: 18,
            }}
          >
            <div>
              <div
                style={{
                  fontFamily: mono,
                  fontSize: 10.5,
                  letterSpacing: ".1em",
                  textTransform: "uppercase",
                  color: C.t3,
                  marginBottom: 14,
                }}
              >
                A few things Cue handled
              </div>
              <div
                style={{ display: "flex", flexDirection: "column", gap: 10 }}
              >
                {recent.length > 0 ? (
                  recent.slice(0, 4).map((r, i) => {
                    const meta = categoryMeta(r.category);
                    return (
                      <div
                        key={i}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 13,
                          border: `1px solid ${C.line}`,
                          borderRadius: 12,
                          padding: "12px 14px",
                        }}
                      >
                        <span
                          style={{
                            width: 34,
                            height: 34,
                            borderRadius: 9,
                            background: meta.wash,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            flexShrink: 0,
                          }}
                        >
                          {meta.icon}
                        </span>
                        <div
                          style={{
                            fontSize: 13.5,
                            fontWeight: 500,
                            minWidth: 0,
                          }}
                        >
                          {r.detail}
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div style={{ fontSize: 13, color: C.t2 }}>
                    Nothing yet this week — as Cue handles things, they show up
                    here.
                  </div>
                )}
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div
                style={{
                  border: `1px solid ${C.line}`,
                  borderRadius: 13,
                  padding: 15,
                  background: `linear-gradient(180deg, color-mix(in srgb, ${C.blue} 4%, ${C.surface}), ${C.surface})`,
                }}
              >
                <div
                  style={{
                    fontSize: 30,
                    fontWeight: 600,
                    letterSpacing: "-1px",
                    color: C.blueS,
                  }}
                >
                  {taskCount}
                </div>
                <div style={{ fontSize: 12.5, color: C.t2, marginTop: 2 }}>
                  tasks handled on your behalf
                </div>
              </div>
              <div
                style={{
                  border: `1px solid ${C.line}`,
                  borderRadius: 13,
                  padding: 15,
                }}
              >
                <div
                  style={{
                    fontSize: 30,
                    fontWeight: 600,
                    letterSpacing: "-1px",
                    color: C.green,
                  }}
                >
                  {minsPerTask > 0 ? `${minsPerTask}m` : "—"}
                </div>
                <div style={{ fontSize: 12.5, color: C.t2, marginTop: 2 }}>
                  saved on average per task
                </div>
              </div>
            </div>
          </div>

          {/* value CTA */}
          <div
            style={{
              position: "relative",
              overflow: "hidden",
              background: INK_HERO,
              borderRadius: 16,
              padding: "20px 24px",
              display: "flex",
              alignItems: "center",
              gap: 20,
              flexWrap: "wrap",
            }}
          >
            <div
              style={{
                position: "absolute",
                inset: 0,
                background:
                  "radial-gradient(320px 140px at 88% 50%,rgba(127,119,221,.26),transparent 70%)",
              }}
            />
            <div style={{ position: "relative", flex: 1, minWidth: 240 }}>
              <div
                style={{
                  fontFamily: serif,
                  fontSize: 23,
                  color: "#fff",
                  letterSpacing: "-.2px",
                  lineHeight: 1.2,
                }}
              >
                Want next week to be even lighter?
              </div>
              <div style={{ fontSize: 13, color: "#AEB7C7", marginTop: 5 }}>
                Connect more of your tools and Cue can handle more on your
                behalf — every connection unlocks more it can take off your
                plate.
              </div>
            </div>
            <div
              style={{
                position: "relative",
                display: "flex",
                gap: 8,
                flexShrink: 0,
              }}
            >
              <button
                type="button"
                onClick={() => navigate(routes.connectors)}
                style={{
                  fontSize: 12.5,
                  background: C.blue,
                  color: "#fff",
                  border: "none",
                  borderRadius: 9,
                  padding: "10px 17px",
                  cursor: "pointer",
                }}
              >
                Connect more
              </button>
              <button
                type="button"
                onClick={() => navigate(routes.connectors)}
                style={{
                  fontSize: 12.5,
                  background: "rgba(255,255,255,.1)",
                  color: "#fff",
                  border: "none",
                  borderRadius: 9,
                  padding: "10px 15px",
                  cursor: "pointer",
                }}
              >
                See connectors
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
