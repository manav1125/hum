/**
 * Mv3WatchingPage — the phone's Watching screen (design v24 frame **F5**).
 *
 * Every source states what flowed through it and how much became work, and
 * **both honesty cards survive the small screen**: the no-op card ("ran 718×
 * and found nothing — that's a bug, not a quiet week") and
 * connected-but-not-watched.
 *
 * ## Every number here, and where it comes from
 *
 * | On screen | Source |
 * |---|---|
 * | source rows, health, last poll | `watchers/list` via `useWatchers()` — `health`, `lastPollAt`, `lastError`, `pollIntervalMs` |
 * | per-source in / filed / became work | `arrivalsGet` rows grouped by `channel` — a **sample**, see below |
 * | the 7-day totals | `arrivalsSummaryGet({ windowHours: 168 })` — `arrived` / `filed` / `kept` / `reversed` |
 * | the no-op card | `arrivalsComprehensionHealthGet` — `totalBatches` vs `totalComprehended`, `census.byStatus` |
 * | connected but not watched | set difference: connected `connectorappsGet` apps minus watcher providers |
 * | what Cue skips | `arrivalsSummaryGet.topFiledReasons` |
 *
 * ## Two things the frame implies that the data cannot give
 *
 * 1. **A per-source census.** `arrivalsGet` caps at 200 rows and takes no
 *    group-by. The owner's instance had 415 arrivals in the last week alone,
 *    so the per-source split is a sample of the most recent 200 and the header
 *    of that block says exactly that. The window totals are exact and are
 *    shown separately, against their own denominator — one number, one
 *    denominator, never a ratio computed across the two.
 *
 * 2. **A skip-rules list.** F5's "WHAT CUE SKIPS" reads like editable rules.
 *    The rules (`list_mail` / `precedence_bulk` / `auto_submitted`, the
 *    no-reply sender tokens) are module constants in the daemon with no API
 *    and no toggle. So this renders the *observed* filing reasons instead —
 *    what Cue actually skipped, in its own words, with counts — and links to
 *    the arrivals list rather than offering a settings screen that does not
 *    exist.
 */

import { useMemo } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import {
  arrivalsComprehensionHealthGetOptions,
  arrivalsGetOptions,
  arrivalsSummaryGetOptions,
  connectorappsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { ArrivalsComprehensionHealthGetResponse } from "@/generated/daemon/types.gen";
import {
  useWatcherProviders,
  useWatchers,
  type Watcher,
} from "@/mobile-v3/you/use-automations-data";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

import { GlassCard } from "../glass-card";
import { microLabel } from "../mv3-kit";
import { YouScreen } from "../you/you-kit";

const WEEK_HOURS = 168;
/** `arrivalsGet`'s hard cap. Naming it keeps the "sample" copy honest. */
const ARRIVALS_CAP = 200;

interface SourceTally {
  channel: string;
  label: string;
  total: number;
  filed: number;
  becameWork: number;
}

export function Mv3WatchingPage() {
  const assistantId = useActiveAssistantId();
  const navigate = useNavigate();

  const watchers = useWatchers();
  const providers = useWatcherProviders();

  const summary = useQuery({
    ...arrivalsSummaryGetOptions({
      path: { assistant_id: assistantId },
      query: { windowHours: WEEK_HOURS },
    }),
    enabled: Boolean(assistantId),
  });

  const recent = useQuery({
    ...arrivalsGetOptions({
      path: { assistant_id: assistantId },
      query: { windowHours: WEEK_HOURS, limit: ARRIVALS_CAP },
    }),
    enabled: Boolean(assistantId),
  });

  const comprehension = useQuery({
    ...arrivalsComprehensionHealthGetOptions({
      path: { assistant_id: assistantId },
    }),
    enabled: Boolean(assistantId),
    retry: false,
  });

  const apps = useQuery({
    ...connectorappsGetOptions({ path: { assistant_id: assistantId } }),
    enabled: Boolean(assistantId),
    retry: false,
  });

  /**
   * How many sampled arrivals were kept because the relevance judge did NOT
   * run — `decidedBy: 'fallback'` is documented as "the judge errored, timed
   * out or was off, so it was kept (fail-open)".
   *
   * This is on screen because it is the difference between "Cue read this and
   * decided you needed it" and "Cue never looked". On the owner's instance
   * 156 of 418 arrivals carry it against 14 real model verdicts, so a Watching
   * screen that showed only `kept` would be describing a judgement that mostly
   * did not happen.
   */
  const failOpen = useMemo(
    () =>
      (recent.data?.arrivals ?? []).filter((a) => a.decidedBy === "fallback")
        .length,
    [recent.data?.arrivals],
  );

  /** Per-channel tallies over the sampled arrivals. */
  const tallies = useMemo<SourceTally[]>(() => {
    const rows = recent.data?.arrivals ?? [];
    const byChannel = new Map<string, SourceTally>();
    for (const a of rows) {
      const key = a.channel || "unknown";
      let t = byChannel.get(key);
      if (!t) {
        t = {
          channel: key,
          label: channelLabel(key),
          total: 0,
          filed: 0,
          becameWork: 0,
        };
        byChannel.set(key, t);
      }
      t.total += 1;
      if (a.disposition === "filed") t.filed += 1;
      if (a.disposition === "surfaced" && a.workItemId) t.becameWork += 1;
    }
    return [...byChannel.values()].sort((a, b) => b.total - a.total);
  }, [recent.data?.arrivals]);

  /**
   * Connected integrations that no watcher reads. Only computed when BOTH
   * reads land — a failed connector read must not make this list look short.
   */
  const notWatched = useMemo<string[] | null>(() => {
    if (!apps.data || !watchers.data || !providers.data) return null;
    const covered = new Set<string>();
    for (const w of watchers.data) {
      if (!w.enabled) continue;
      covered.add(w.providerId.toLowerCase());
      covered.add(w.credentialService.toLowerCase());
      const p = providers.data.find((x) => x.id === w.providerId);
      if (p) covered.add(p.requiredCredentialService.toLowerCase());
    }
    return apps.data.apps
      .filter((a) => a.connected && !covered.has(a.slug.toLowerCase()))
      .map((a) => a.name);
  }, [apps.data, watchers.data, providers.data]);

  const sampled = recent.data?.arrivals.length ?? 0;
  const totalWatchers = watchers.data?.length ?? 0;
  const lastPoll = useMemo(() => {
    const times = (watchers.data ?? [])
      .map((w) => w.lastPollAt)
      .filter((v): v is number => typeof v === "number" && v > 0);
    return times.length > 0 ? Math.max(...times) : null;
  }, [watchers.data]);

  return (
    <YouScreen
      tint="teal"
      back={routes.yourCue}
      backLabel="Your Cue"
      title="Watching"
      testId="mv3-watching"
      sub={
        watchers.isError ? (
          <>Cue couldn&rsquo;t read its watchers.</>
        ) : watchers.isLoading ? (
          <>Reading your sources…</>
        ) : (
          <>
            {totalWatchers} {totalWatchers === 1 ? "source" : "sources"}
            {lastPoll ? ` · last checked ${ago(lastPoll)}` : " · never checked"}
          </>
        )
      }
    >
      {/* ── The sources ─────────────────────────────────────────────── */}
      {watchers.isError ? (
        <ErrorCard
          title="COULDN’T READ YOUR SOURCES"
          body="Cue couldn’t list its watchers, so this page can’t say what is being read. This is a failed request, not an empty list — nothing has been turned off."
          onRetry={() => void watchers.refetch()}
        />
      ) : watchers.isLoading ? (
        <Muted>Reading your sources…</Muted>
      ) : (watchers.data ?? []).length === 0 ? (
        <Muted>
          Nothing is being watched. Connect a source and Cue starts reading it
          — until then this page has nothing to report.
        </Muted>
      ) : (
        <GlassCard radius={15} padding={0}>
          {(watchers.data ?? []).map((w, i) => (
            <SourceRow
              key={w.id}
              watcher={w}
              tally={tallies.find((t) => matches(t.channel, w))}
              last={i === (watchers.data ?? []).length - 1}
            />
          ))}
        </GlassCard>
      )}

      {sampled > 0 && (
        <div style={{ fontSize: 9.5, color: "var(--mv3-muted)", marginTop: 7 }}>
          Per-source counts are over the most recent {sampled}{" "}
          {sampled === 1 ? "arrival" : "arrivals"} of the last 7 days
          {sampled >= ARRIVALS_CAP ? " — the cap, so older ones aren’t counted" : ""}
          .
        </div>
      )}

      {/* Fail-open is a working system's honest edge, not a failure card. */}
      {failOpen > 0 && (
        <GlassCard radius={14} style={{ marginTop: 9 }}>
          <div style={{ ...microLabel, fontSize: 9, color: "var(--mv3-muted)" }}>
            KEPT WITHOUT A JUDGEMENT
          </div>
          <Body>
            {failOpen} of those {sampled} reached you because the relevance
            judge didn&rsquo;t run — it errored, timed out, or was off, so Cue
            kept them rather than risk filing something that mattered.
          </Body>
          <Body tone="muted">
            That is the fail-open rule working. It also means those{" "}
            {failOpen} were never actually read.
          </Body>
        </GlassCard>
      )}

      {/* ── The exact window totals, against their own denominator ──── */}
      <Eyebrow>THE LAST 7 DAYS</Eyebrow>
      {summary.isError ? (
        <Note tone="fail">
          <span aria-hidden>⚠ </span>The arrivals summary didn&rsquo;t load, so
          these totals are unknown rather than zero.
        </Note>
      ) : summary.isLoading ? (
        <Muted>Counting…</Muted>
      ) : (
        <GlassCard radius={15} style={{ marginTop: 7 }}>
          <Line label="Arrived" value={summary.data?.arrived ?? 0} />
          <Line label="Filed away" value={summary.data?.filed ?? 0} />
          <Line label="Kept for you" value={summary.data?.kept ?? 0} />
          <Line
            label="You reversed"
            value={summary.data?.reversed ?? 0}
            hint="Cue filed it, you disagreed"
          />
        </GlassCard>
      )}

      {/* ── Honesty card 1 — the no-op ──────────────────────────────── */}
      <NoOpCard
        isLoading={comprehension.isLoading}
        isError={comprehension.isError}
        data={comprehension.data}
      />

      {/* ── Honesty card 2 — connected but not watched ──────────────── */}
      <GlassCard radius={14} style={{ marginTop: 9 }}>
        <div style={{ ...microLabel, fontSize: 9, color: "var(--mv3-muted)" }}>
          CONNECTED BUT NOT WATCHED
        </div>
        {apps.isError || watchers.isError ? (
          <Body tone="fail">
            <span aria-hidden>⚠ </span>Cue couldn&rsquo;t compare your
            connections against its watchers, so this is unknown — not empty.
          </Body>
        ) : notWatched === null ? (
          <Body tone="muted">Checking…</Body>
        ) : notWatched.length === 0 ? (
          <Body tone="muted">
            Everything you&rsquo;ve connected is being read.
          </Body>
        ) : (
          <>
            <Body>
              {joinNames(notWatched)}{" "}
              {notWatched.length === 1 ? "is" : "are"} linked but nothing&rsquo;s
              reading {notWatched.length === 1 ? "it" : "them"}.
            </Body>
            <button
              type="button"
              onClick={() => {
                haptic.light();
                void navigate(routes.automations);
              }}
              style={linkBtn}
            >
              Turn on watching ›
            </button>
          </>
        )}
      </GlassCard>

      {/* ── What Cue skipped — observed, not a rules list ───────────── */}
      <GlassCard radius={14} style={{ marginTop: 9 }}>
        <div style={{ ...microLabel, fontSize: 9, color: "var(--mv3-muted)" }}>
          WHAT CUE SKIPPED
        </div>
        {summary.isError ? (
          <Body tone="fail">
            <span aria-hidden>⚠ </span>Unknown — the summary didn&rsquo;t load.
          </Body>
        ) : (summary.data?.topFiledReasons ?? []).length === 0 ? (
          <Body tone="muted">
            Nothing was filed away this week — everything that arrived was kept
            for you.
          </Body>
        ) : (
          <>
            {(summary.data?.topFiledReasons ?? []).slice(0, 4).map((r) => (
              <div
                key={r.reason}
                style={{
                  display: "flex",
                  gap: 9,
                  fontSize: 11,
                  color: "var(--mv3-text)",
                  lineHeight: 1.5,
                  marginTop: 6,
                }}
              >
                <span style={{ flex: 1, minWidth: 0 }}>{r.reason}</span>
                <span
                  style={{
                    color: "var(--mv3-muted)",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {r.count}
                </span>
              </div>
            ))}
            <div style={{ fontSize: 9.5, color: "var(--mv3-muted)", marginTop: 8 }}>
              These are the reasons Cue actually gave, not a rule list — the
              filing rules themselves aren&rsquo;t editable yet.
            </div>
          </>
        )}
      </GlassCard>
    </YouScreen>
  );
}

// ── The no-op card ──────────────────────────────────────────────────────────

/**
 * Design wrote this card as an illustration and it turned out to be live: a
 * job that completes and learns nothing reports success every time. The card
 * fires on the daemon's own consecutive-unproductive counter *or* on the
 * lifetime ratio, and says which.
 */
function NoOpCard({
  isLoading,
  isError,
  data,
}: {
  isLoading: boolean;
  isError: boolean;
  data: ArrivalsComprehensionHealthGetResponse | undefined;
}) {
  // An unread health check is not evidence of a problem — stay silent.
  if (isLoading || isError || !data) return null;
  const h = data;

  const streaking =
    h.unproductiveWarnAt > 0 &&
    h.consecutiveUnproductiveBatches >= h.unproductiveWarnAt;
  const barren = h.totalBatches >= 20 && h.totalComprehended === 0;
  const failing = h.census.byStatus.failed > h.census.byStatus.comprehended;

  if (!streaking && !barren && !failing) return null;

  return (
    <GlassCard tint="amber" radius={15} style={{ marginTop: 9 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 9 }}>
        <span
          aria-hidden
          style={{
            width: 20,
            height: 20,
            borderRadius: 6,
            flexShrink: 0,
            background: "var(--mv3-amber-card-bg)",
            border: "1px solid var(--mv3-amber-card-border)",
            color: "var(--mv3-amber-text)",
            fontSize: 10,
            fontWeight: 700,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          !
        </span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11.5, fontWeight: 600 }}>
            {barren
              ? `Comprehension ran ${h.totalBatches}× and understood nothing`
              : failing
                ? `${h.census.byStatus.failed} of ${h.census.total} arrivals failed to be understood`
                : `${h.consecutiveUnproductiveBatches} runs in a row read nothing`}
          </div>
          <div
            style={{
              fontSize: 9.5,
              color: "var(--mv3-muted)",
              marginTop: 3,
              lineHeight: 1.5,
            }}
          >
            {barren || streaking
              ? "Each run completed and reported success with nothing to read. That's a bug, not a quiet week."
              : "A failed comprehension still counts as a completed run, so the job looks healthy from the outside."}
          </div>
          <div style={{ fontSize: 9.5, color: "var(--mv3-muted)", marginTop: 5 }}>
            {/* Two different denominators, so they are stated separately
                rather than divided into a ratio that means nothing. */}
            {h.totalBatches} {h.totalBatches === 1 ? "batch" : "batches"} run ·{" "}
            {h.totalComprehended} arrival
            {h.totalComprehended === 1 ? "" : "s"} understood
            {h.lastBatchAt ? ` · last run ${ago(h.lastBatchAt)}` : ""}
          </div>
        </div>
      </div>
    </GlassCard>
  );
}

// ── Pieces ──────────────────────────────────────────────────────────────────

function SourceRow({
  watcher,
  tally,
  last,
}: {
  watcher: Watcher;
  tally: SourceTally | undefined;
  last: boolean;
}) {
  const health = watcher.health;
  const dot =
    health === "ok"
      ? "var(--mv3-green)"
      : health === "reauth" || health === "not_connected"
        ? "var(--mv3-amber)"
        : "var(--mv3-muted)";
  const healthWord =
    health === "ok"
      ? "reading"
      : health === "reauth"
        ? "needs reconnecting"
        : health === "not_connected"
          ? "not connected"
          : "unknown";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "11px 13px",
        borderBottom: last ? "none" : "1px solid var(--mv3-line)",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600 }}>{watcher.name}</div>
        <div style={{ fontSize: 9.5, color: "var(--mv3-muted)", marginTop: 1 }}>
          {tally
            ? `${tally.total} in — ${tally.filed} filed, ${tally.becameWork} became work`
            : "nothing arrived in the sampled window"}
        </div>
        <div style={{ fontSize: 9.5, color: "var(--mv3-muted)", marginTop: 1 }}>
          {/* Never colour-only: the dot is a duplicate of this word. */}
          {watcher.enabled ? healthWord : "paused"}
          {watcher.lastPollAt ? ` · checked ${ago(watcher.lastPollAt)}` : ""}
        </div>
        {watcher.lastError && (
          <div
            style={{
              fontSize: 9.5,
              color: "var(--mv3-fail-text)",
              marginTop: 3,
              lineHeight: 1.45,
            }}
          >
            <span aria-hidden>⚠ </span>
            {watcher.lastError}
          </div>
        )}
      </div>
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          flexShrink: 0,
          background: watcher.enabled ? dot : "var(--mv3-muted)",
        }}
      />
    </div>
  );
}

function Line({
  label,
  value,
  hint,
}: {
  label: string;
  value: number;
  hint?: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 9,
        padding: "3px 0",
      }}
    >
      <span style={{ flex: 1, minWidth: 0, fontSize: 11.5 }}>
        {label}
        {hint && (
          <span style={{ color: "var(--mv3-muted)", fontSize: 9.5 }}>
            {" "}
            · {hint}
          </span>
        )}
      </span>
      <span
        style={{
          fontSize: 14,
          fontWeight: 700,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </span>
    </div>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        ...microLabel,
        fontSize: 9,
        color: "var(--mv3-muted)",
        marginTop: 14,
      }}
    >
      {children}
    </div>
  );
}

function Body({
  children,
  tone = "text",
}: {
  children: React.ReactNode;
  tone?: "text" | "muted" | "fail";
}) {
  return (
    <div
      style={{
        fontSize: 11,
        lineHeight: 1.5,
        marginTop: 6,
        color:
          tone === "fail"
            ? "var(--mv3-fail-text)"
            : tone === "muted"
              ? "var(--mv3-muted)"
              : "var(--mv3-text)",
      }}
    >
      {children}
    </div>
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

function Note({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "fail";
}) {
  return (
    <div
      style={{
        fontSize: 11,
        lineHeight: 1.5,
        marginTop: 7,
        color: tone === "fail" ? "var(--mv3-fail-text)" : "var(--mv3-muted)",
      }}
    >
      {children}
    </div>
  );
}

function ErrorCard({
  title,
  body,
  onRetry,
}: {
  title: string;
  body: string;
  onRetry: () => void;
}) {
  return (
    <GlassCard radius={15}>
      <div style={{ ...microLabel, fontSize: 9, color: "var(--mv3-fail-text)" }}>
        <span aria-hidden>⚠ </span>
        {title}
      </div>
      <div
        style={{
          fontSize: 12.5,
          color: "var(--mv3-text)",
          lineHeight: 1.5,
          marginTop: 6,
        }}
      >
        {body}
      </div>
      <button
        type="button"
        onClick={() => {
          haptic.light();
          onRetry();
        }}
        style={{ ...linkBtn, marginTop: 10 }}
      >
        Try again
      </button>
    </GlassCard>
  );
}

const linkBtn: React.CSSProperties = {
  background: "none",
  border: "none",
  padding: "7px 0 0",
  fontFamily: "inherit",
  fontSize: 10.5,
  color: "var(--mv3-micro)",
  cursor: "pointer",
};

/** `watcher:gmail` → `Gmail`. Never invents a name it doesn't have. */
function channelLabel(channel: string): string {
  const tail = channel.includes(":") ? channel.split(":").pop()! : channel;
  return tail
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Does an arrivals channel belong to this watcher? */
function matches(channel: string, w: Watcher): boolean {
  const tail = (
    channel.includes(":") ? channel.split(":").pop()! : channel
  ).toLowerCase();
  return (
    tail === w.providerId.toLowerCase() ||
    tail === w.credentialService.toLowerCase() ||
    w.name.toLowerCase().includes(tail)
  );
}

function joinNames(names: string[]): string {
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** "4 min ago" / "2h ago" / "3d ago". */
function ago(epoch: number): string {
  const ms = epoch > 1e12 ? epoch : epoch * 1000;
  const diff = Math.max(0, Date.now() - ms);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
