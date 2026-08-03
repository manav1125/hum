/**
 * Mv3WeeklyPage — the phone's weekly review (design v24 frame **F3**).
 *
 * The same four beats as desktop, **paged not scrolled**: what moved · who
 * did what · what slipped · then a swipe up to the autonomy question. Pages
 * are a horizontal snap track, so a swipe is a real gesture and not a scroll
 * position, and the page dots say where you are without colour alone.
 *
 * ## What is real, and what F3 draws that isn't
 *
 * Real:
 *  · the rings              `missionsGet` → `rollup.counts.done / total`
 *  · Cue finished N         `actsSummaryGet({ days: 7 })` → `acts`
 *  · **acts you reversed**  `actsSummaryGet({ days: 7 })` → `reversed`
 *  · you cleared N          `workitemsGet` rows done with
 *                           `ranProvenance === "manual"` and `updatedAt` in
 *                           the window
 *  · model spend            `usageTotalsGet({ from, to })` →
 *                           `totalEstimatedCostUsd`
 *  · what slipped           `workitemsGet` — overdue `dueAt`, `waitingState`,
 *                           stale `lastActivityAt`
 *  · the autonomy page      `ledgerAutonomyGet({ days: 7 })` → `summary`
 *
 * Not real, and therefore not drawn:
 *
 *  · **"+$75K" under a ring.** `mission.metric` is a free-text label. There is
 *    no current value, no target and no delta anywhere in the API, so a ring
 *    shows the item ratio it can compute and its metric as the words it is.
 *    Per the invariant, a ring with no computable metric shows a glyph
 *    (`✓` / `!` / `◼`) rather than a number.
 *
 *  · **Tool spend.** `usageBreakdownGet` groups by actor/provider/model/
 *    conversation/call_site/profile/schedule/agent — there is no `tool` group
 *    and no tool-cost table. The line therefore says *model spend*, which is
 *    what the number is, not "model + tool".
 *
 *  · **The three leash decisions.** F3's swipe-up page is three autonomy
 *    changes Cue proposes. Nothing in the daemon proposes anything: a
 *    repo-wide search for a proposals route finds design docs and one code
 *    comment. Inventing three plausible proposals on a page whose whole job is
 *    to ask you to loosen the leash would be the worst possible place to
 *    fabricate. So the last page shows what the leash actually *did* this week
 *    from the autonomy ledger — including the two uncomfortable numbers, acts
 *    that ran unattended and acts nobody approved — and hands you to
 *    Guardrails to change it yourself.
 */

import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import {
  actsSummaryGetOptions,
  ledgerAutonomyGetOptions,
  missionsGetOptions,
  usageTotalsGetOptions,
  workitemsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

import { AuroraBackdrop } from "../aurora-backdrop";
import { GlassCard } from "../glass-card";
import { microLabel } from "../mv3-kit";

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
/** Nothing has touched it in this long → it slipped. */
const STALE_DAYS = 5;

const DONE_STATUSES = new Set(["done", "completed"]);
const CLOSED_STATUSES = new Set([
  "done",
  "completed",
  "cancelled",
  "archived",
]);

export function Mv3WeeklyPage() {
  const assistantId = useActiveAssistantId();
  const navigate = useNavigate();
  const [now] = useState(() => Date.now());
  const trackRef = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(0);

  const missions = useQuery({
    ...missionsGetOptions({ path: { assistant_id: assistantId } }),
    enabled: Boolean(assistantId),
  });
  const acts = useQuery({
    ...actsSummaryGetOptions({
      path: { assistant_id: assistantId },
      query: { days: 7 },
    }),
    enabled: Boolean(assistantId),
  });
  const work = useQuery({
    ...workitemsGetOptions({ path: { assistant_id: assistantId } }),
    enabled: Boolean(assistantId),
  });
  const usage = useQuery({
    ...usageTotalsGetOptions({
      path: { assistant_id: assistantId },
      query: { from: now - WEEK_MS, to: now },
    }),
    enabled: Boolean(assistantId),
  });
  const ledger = useQuery({
    ...ledgerAutonomyGetOptions({
      path: { assistant_id: assistantId },
      query: { days: 7 },
    }),
    enabled: Boolean(assistantId),
    retry: false,
  });

  const items = useMemo(() => work.data?.items ?? [], [work.data?.items]);

  /**
   * "You cleared N". Work items carry no `completedAt`, only `updatedAt`, and
   * `workitemsGet` takes no date range — so this is *done items whose row was
   * last touched inside the window*, which is an approximation and is labelled
   * as one on screen.
   */
  const youCleared = useMemo(
    () =>
      items.filter(
        (i) =>
          DONE_STATUSES.has(i.status) &&
          (i.updatedAt ?? 0) >= now - WEEK_MS &&
          (i.ranProvenance === "manual" || i.completedElsewhere === true),
      ).length,
    [items, now],
  );

  const cueFinished = acts.data?.acts ?? 0;
  const denominator = youCleared + cueFinished;
  const cueShare =
    denominator > 0 ? Math.round((cueFinished / denominator) * 100) : null;

  const slipped = useMemo(() => {
    const out: { id: string; text: string }[] = [];
    for (const i of items) {
      if (CLOSED_STATUSES.has(i.status)) continue;
      if (i.dueAt && i.dueAt < now) {
        out.push({
          id: i.id,
          text: `${i.title} — ${Math.floor((now - i.dueAt) / DAY_MS)}d past due`,
        });
        continue;
      }
      if (i.waitingState === "going_cold") {
        out.push({
          id: i.id,
          text: `${i.title} — waiting, and going cold`,
        });
        continue;
      }
      const idle = i.lastActivityAt ? now - i.lastActivityAt : 0;
      if (idle > STALE_DAYS * DAY_MS) {
        out.push({
          id: i.id,
          text: `${i.title} — nothing for ${Math.floor(idle / DAY_MS)} days`,
        });
      }
    }
    return out.slice(0, 5);
  }, [items, now]);

  const rings = useMemo(
    () =>
      (missions.data?.missions ?? [])
        .filter((m) => m.status === "active")
        .slice(0, 3),
    [missions.data?.missions],
  );

  function goto(next: number) {
    const el = trackRef.current;
    if (!el) return;
    haptic.light();
    el.scrollTo({ left: next * el.clientWidth, behavior: "smooth" });
    setPage(next);
  }

  const PAGES = 4;

  return (
    <div
      data-mv3
      data-slot="mv3-weekly"
      style={{
        position: "relative",
        height: "100%",
        minHeight: 0,
        overflow: "clip",
        display: "flex",
        flexDirection: "column",
        background: "var(--mv3-bg)",
        color: "var(--mv3-text)",
        fontFamily: "var(--mv3-font)",
      }}
    >
      <AuroraBackdrop
        style={{
          background:
            "radial-gradient(46% 22% at 50% 6%, rgba(79,199,199,.16), transparent 68%)",
        }}
      />

      <div
        style={{
          padding:
            "calc(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) + 10px) 18px 0",
          position: "relative",
          zIndex: 2,
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button
            type="button"
            onClick={() => {
              haptic.light();
              void navigate(routes.hq);
            }}
            style={{
              background: "none",
              border: "none",
              padding: "4px 0",
              fontFamily: "inherit",
              fontSize: 13,
              color: "var(--mv3-micro)",
              cursor: "pointer",
            }}
          >
            ‹ HQ
          </button>
        </div>
        <div style={{ ...microLabel, fontSize: 9.5, color: "var(--mv3-muted)", marginTop: 4 }}>
          WEEK TO {new Date(now).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
        </div>
        <div
          style={{
            fontSize: 25,
            fontWeight: 700,
            letterSpacing: "-0.6px",
            marginTop: 5,
          }}
        >
          Your week
        </div>
        <div style={{ fontSize: 11.5, color: "var(--mv3-muted)", marginTop: 3 }}>
          {PAGES} pages · swipe
        </div>
      </div>

      {/* ── The paged track ─────────────────────────────────────────── */}
      <div
        ref={trackRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          const p = Math.round(el.scrollLeft / Math.max(1, el.clientWidth));
          if (p !== page) setPage(p);
        }}
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          overflowX: "auto",
          overflowY: "hidden",
          scrollSnapType: "x mandatory",
          scrollbarWidth: "none",
          position: "relative",
          zIndex: 2,
          WebkitOverflowScrolling: "touch",
        }}
      >
        <Page>
          <Eyebrow tone="green">WHAT MOVED</Eyebrow>
          {missions.isError ? (
            <Fail>The missions read failed, so nothing here is known.</Fail>
          ) : missions.isLoading ? (
            <Muted>Reading…</Muted>
          ) : rings.length === 0 ? (
            <Muted>
              No active missions this week. Rings appear once something has a
              goal to move toward.
            </Muted>
          ) : (
            <div style={{ display: "flex", gap: 7, marginTop: 7 }}>
              {rings.map((m) => (
                <Ring
                  key={m.id}
                  title={m.title}
                  done={m.rollup.counts.done}
                  total={m.rollup.counts.total}
                  failed={m.rollup.counts.failed}
                  metric={m.metric}
                />
              ))}
            </div>
          )}
          <div style={{ fontSize: 9.5, color: "var(--mv3-muted)", marginTop: 9, lineHeight: 1.5 }}>
            A ring is items done over items total. Cue has no numeric target
            for a mission&rsquo;s metric, so the metric shows as the words you
            wrote — never as a delta it can&rsquo;t compute.
          </div>
        </Page>

        <Page>
          <Eyebrow>WHO DID WHAT</Eyebrow>
          {acts.isError ? (
            <Fail>The acts summary failed, so the split is unknown.</Fail>
          ) : (
            <GlassCard radius={15} style={{ marginTop: 7 }}>
              <Row label="You cleared" value={youCleared} big />
              <Row label="Cue finished alone" value={cueFinished} big />
              {cueShare !== null && (
                <ShareBar cuePercent={cueShare} />
              )}
              <Row
                label="Cue’s share"
                value={cueShare === null ? "—" : `${cueShare}%`}
              />
              <Row
                label="Model spend"
                value={
                  usage.isError
                    ? "unknown"
                    : usage.isLoading
                      ? "…"
                      : `$${(usage.data?.totalEstimatedCostUsd ?? 0).toFixed(2)}`
                }
              />
              {/* Design puts this on the first page "where it's
                  uncomfortable, not buried". It is a real field. */}
              <Row label="Acts you reversed" value={acts.data?.reversed ?? 0} />
            </GlassCard>
          )}
          <div style={{ fontSize: 9.5, color: "var(--mv3-muted)", marginTop: 9, lineHeight: 1.5 }}>
            Work items carry no completion date, so &ldquo;you cleared&rdquo;
            counts items finished by hand and last touched this week — close,
            not exact. Spend is model tokens only; tool cost isn&rsquo;t
            recorded anywhere.
          </div>
        </Page>

        <Page>
          <Eyebrow tone="amber">WHAT SLIPPED</Eyebrow>
          {work.isError ? (
            <Fail>Your work items didn&rsquo;t load, so this is unknown.</Fail>
          ) : work.isLoading ? (
            <Muted>Reading…</Muted>
          ) : slipped.length === 0 ? (
            <Muted>
              Nothing is overdue, cold or untouched for {STALE_DAYS} days.
              That&rsquo;s a real clear week, not a failed read.
            </Muted>
          ) : (
            <GlassCard tint="amber" radius={15} style={{ marginTop: 7 }}>
              {slipped.map((s) => (
                <div
                  key={s.id}
                  style={{
                    display: "flex",
                    gap: 8,
                    fontSize: 11,
                    lineHeight: 1.5,
                    padding: "3px 0",
                  }}
                >
                  <span aria-hidden style={{ color: "var(--mv3-amber-text)" }}>
                    ·
                  </span>
                  <span>{s.text}</span>
                </div>
              ))}
            </GlassCard>
          )}
        </Page>

        <Page>
          <Eyebrow tone="violet">THE LEASH, THIS WEEK</Eyebrow>
          {ledger.isError ? (
            <Fail>
              The autonomy ledger didn&rsquo;t load. What Cue did on its own is
              unknown — not nothing.
            </Fail>
          ) : ledger.isLoading ? (
            <Muted>Reading…</Muted>
          ) : (
            <>
              <GlassCard tint="violet" radius={15} style={{ marginTop: 7 }}>
                <Row
                  label="Consequential actions"
                  value={ledger.data?.summary.total ?? 0}
                  big
                />
                <Row label="Ran" value={ledger.data?.summary.executed ?? 0} />
                <Row
                  label="Ran with nobody watching"
                  value={ledger.data?.summary.executedUnattended ?? 0}
                />
                <Row
                  label="Ran with nobody asked"
                  value={ledger.data?.summary.executedWithoutApproval ?? 0}
                />
                <Row label="Parked" value={ledger.data?.summary.parked ?? 0} />
                <Row label="Denied" value={ledger.data?.summary.denied ?? 0} />
              </GlassCard>
              <div
                style={{
                  fontSize: 10.5,
                  color: "var(--mv3-muted)",
                  marginTop: 10,
                  lineHeight: 1.55,
                }}
              >
                Cue doesn&rsquo;t propose leash changes yet — nothing in it
                generates a recommendation, so this page shows what the leash
                actually did rather than three suggestions it made up.
              </div>
              <button
                type="button"
                onClick={() => {
                  haptic.medium();
                  void navigate(routes.guardrails);
                }}
                style={{
                  marginTop: 12,
                  width: "100%",
                  background: "var(--mv3-btn2-bg)",
                  border: "1px solid var(--mv3-btn2-border)",
                  borderRadius: 14,
                  padding: "12px 14px",
                  fontFamily: "inherit",
                  fontSize: 13.5,
                  color: "var(--mv3-text)",
                  cursor: "pointer",
                }}
              >
                Change the leash in Guardrails ›
              </button>
            </>
          )}
        </Page>
      </div>

      {/* ── Page dots — the label carries the state, not the fill ────── */}
      <div
        style={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          padding: "10px 0 calc(12px + env(safe-area-inset-bottom, 0px))",
          position: "relative",
          zIndex: 3,
        }}
      >
        <span style={{ fontSize: 10.5, color: "var(--mv3-muted)" }}>
          {page + 1} of {PAGES}
        </span>
        {Array.from({ length: PAGES }, (_, i) => (
          <button
            key={i}
            type="button"
            aria-label={`Page ${i + 1}`}
            aria-current={i === page}
            onClick={() => goto(i)}
            style={{
              width: i === page ? 18 : 6,
              height: 6,
              borderRadius: 99,
              border: "none",
              padding: 0,
              background:
                i === page ? "var(--mv3-text)" : "var(--mv3-track)",
              cursor: "pointer",
            }}
          />
        ))}
      </div>
    </div>
  );
}

// ── Pieces ──────────────────────────────────────────────────────────────────

function Page({ children }: { children: React.ReactNode }) {
  return (
    <section
      style={{
        flex: "0 0 100%",
        width: "100%",
        scrollSnapAlign: "start",
        overflowY: "auto",
        padding: "12px 16px 20px",
        WebkitOverflowScrolling: "touch",
      }}
    >
      {children}
    </section>
  );
}

/**
 * Item progress for a mission. Per the invariant, a ring with no computable
 * metric shows a glyph rather than a fabricated percentage: `◼` when the
 * mission has no items at all, `!` when something failed, `✓` at 100%.
 */
function Ring({
  title,
  done,
  total,
  failed,
  metric,
}: {
  title: string;
  done: number;
  total: number;
  failed: number;
  metric: string | null;
}) {
  const hasMetric = total > 0;
  const pct = hasMetric ? Math.round((done / total) * 100) : 0;
  const glyph = !hasMetric ? "◼" : failed > 0 ? "!" : pct >= 100 ? "✓" : null;
  const stroke =
    !hasMetric
      ? "var(--mv3-muted)"
      : failed > 0
        ? "var(--mv3-amber)"
        : pct >= 100
          ? "var(--mv3-green)"
          : "var(--mv3-accent)";
  const C = 2 * Math.PI * 12.5;

  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        background: "var(--mv3-card)",
        border: "1px solid var(--mv3-card-border)",
        borderRadius: 14,
        padding: "10px 11px",
        textAlign: "center",
      }}
    >
      <div style={{ position: "relative", width: 32, height: 32, margin: "0 auto" }}>
        <svg width="32" height="32" viewBox="0 0 32 32" aria-hidden>
          <circle
            cx="16"
            cy="16"
            r="12.5"
            fill="none"
            stroke="var(--mv3-track)"
            strokeWidth="4.5"
          />
          {hasMetric && (
            <circle
              cx="16"
              cy="16"
              r="12.5"
              fill="none"
              stroke={stroke}
              strokeWidth="4.5"
              strokeLinecap="round"
              strokeDasharray={C}
              strokeDashoffset={C * (1 - pct / 100)}
              transform="rotate(-90 16 16)"
            />
          )}
        </svg>
        <span
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: glyph ? 10 : 8,
            fontWeight: 700,
            color: glyph ? stroke : "var(--mv3-text)",
          }}
        >
          {glyph ?? `${pct}%`}
        </span>
      </div>
      <div
        style={{
          fontSize: 10,
          fontWeight: 600,
          marginTop: 6,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {title}
      </div>
      <div
        style={{
          fontSize: 9,
          color: "var(--mv3-muted)",
          marginTop: 1,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {hasMetric ? `${done}/${total} done` : "no items yet"}
      </div>
      {metric && (
        <div
          style={{
            fontSize: 9,
            color: "var(--mv3-muted)",
            marginTop: 1,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {metric}
        </div>
      )}
    </div>
  );
}

function ShareBar({ cuePercent }: { cuePercent: number }) {
  return (
    <div
      style={{
        height: 5,
        borderRadius: 99,
        background: "var(--mv3-track)",
        margin: "9px 0",
        overflow: "hidden",
        display: "flex",
      }}
      aria-hidden
    >
      <span
        style={{ width: `${100 - cuePercent}%`, background: "var(--mv3-muted)" }}
      />
      <span style={{ width: `${cuePercent}%`, background: "var(--mv3-green)" }} />
    </div>
  );
}

function Row({
  label,
  value,
  big,
}: {
  label: string;
  value: number | string;
  big?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 9,
        padding: "2px 0",
      }}
    >
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: big ? 11.5 : 10.5,
          color: big ? "var(--mv3-text)" : "var(--mv3-muted)",
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: big ? 14 : 11.5,
          fontWeight: big ? 700 : 600,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </span>
    </div>
  );
}

function Eyebrow({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "green" | "amber" | "violet";
}) {
  const color =
    tone === "green"
      ? "var(--mv3-green-text)"
      : tone === "amber"
        ? "var(--mv3-amber-text)"
        : tone === "violet"
          ? "var(--mv3-violet-text)"
          : "var(--mv3-muted)";
  return (
    <div style={{ ...microLabel, fontSize: 9, color }}>{children}</div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 12,
        color: "var(--mv3-muted)",
        lineHeight: 1.55,
        marginTop: 8,
      }}
    >
      {children}
    </div>
  );
}

function Fail({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 12,
        color: "var(--mv3-fail-text)",
        lineHeight: 1.55,
        marginTop: 8,
      }}
    >
      <span aria-hidden>⚠ </span>
      {children}
    </div>
  );
}
