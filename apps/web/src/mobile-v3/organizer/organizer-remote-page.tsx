/**
 * Desktop-organizer remote — mobile-v3 frames 71 & 72 (parity+).
 *
 * The organize run executes on the paired Mac (the desktop-organizer skill is a
 * shell script driven through host_bash). This screen is the phone's REMOTE of
 * that run — the same "runs on your Mac, phone is the remote" pattern as Cue
 * Live's viewer (`cue-live-remote-viewer.tsx`):
 *
 *   frame 71 — approve the plan: the categorized inventory Cue scanned, with
 *              destinations + counts, move-never-delete into Cue Archive/<date>,
 *              protected paths excluded, per-category include/exclude, and an
 *              honest "RUNNING ON YOUR MAC · <machine>" attribution.
 *   frame 72 — live mirror + done: "MOVED 40 OF 68" progress, then "Tidied N ·
 *              Undo". It never claims the phone did the work; execution and
 *              undo both happen on the Mac ("See on Mac").
 *
 * HONESTY — what's real vs. pending a daemon emission:
 *   • The connected Mac + its name (attribution, "See on Mac") is REAL, read
 *     from `GET organizer/session`'s `targets` (host_bash-capable hub clients).
 *   • The plan card + live progress are driven by the same read's `session`,
 *     which stays inactive until the skill reports its plan/progress back into
 *     the daemon (see `routes/organizer-session.ts`). Until that wire-in lands
 *     this screen honestly shows the "no organize run" state rather than a faked
 *     mirror. Every render below is data-bound, so it lights up the moment the
 *     emission exists.
 */
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { organizerSessionGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import type { OrganizerSessionGetResponse } from "@/generated/daemon/types.gen";
import { AuroraBackdrop, GlassCard, StateChip } from "@/mobile-v3";
import {
  cardBody,
  cardTitle,
  microLabel,
  mv3Mono,
  primaryBtn,
  rise,
  secondaryBtn,
} from "@/mobile-v3/mv3-kit";
import { routes } from "@/utils/routes";

const POLL_MS = 5_000;

type Session = OrganizerSessionGetResponse["session"];
type Target = OrganizerSessionGetResponse["targets"][number];
type Category = NonNullable<Session["plan"]>["categories"][number];

function relativeTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Mono eyebrow: "RUNNING ON YOUR MAC · MacBook Pro". */
function MacEyebrow({ machine, verb }: { machine: string; verb: string }) {
  return (
    <div
      style={{
        ...microLabel,
        color: "var(--mv3-muted)",
        display: "flex",
        alignItems: "center",
        gap: 6,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: "var(--mv3-green)",
          display: "inline-block",
        }}
      />
      {verb} ON YOUR MAC · {machine}
    </div>
  );
}

function BackRow({ label }: { label: string }) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => navigate(routes.hq)}
      style={{
        ...microLabel,
        background: "none",
        border: "none",
        color: "var(--mv3-muted)",
        cursor: "pointer",
        padding: "2px 0",
        marginBottom: 14,
        display: "flex",
        alignItems: "center",
        gap: 4,
      }}
    >
      ‹ {label}
    </button>
  );
}

/* ── frame 71 — plan card ──────────────────────────────────────────────── */

function PlanCategoryRow({
  category,
  included,
  onToggle,
}: {
  category: Category;
  included: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={included}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 11,
        width: "100%",
        background: "none",
        border: "none",
        borderTop: "1px solid var(--mv3-card-border)",
        padding: "11px 0",
        cursor: "pointer",
        textAlign: "left",
        opacity: included ? 1 : 0.5,
      }}
    >
      <span
        aria-hidden
        style={{ fontSize: 18, width: 22, textAlign: "center" }}
      >
        {category.icon}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{ fontSize: 14, fontWeight: 600, color: "var(--mv3-text)" }}
        >
          {category.label}
        </span>
        <span
          style={{
            display: "block",
            ...microLabel,
            fontSize: 9.5,
            color: "var(--mv3-muted)",
            marginTop: 2,
          }}
        >
          → {category.destination} · {category.count}
        </span>
      </span>
      <span
        aria-hidden
        style={{
          width: 20,
          height: 20,
          borderRadius: 6,
          border: `1.5px solid ${included ? "var(--mv3-green)" : "var(--mv3-card-border)"}`,
          background: included ? "var(--mv3-green)" : "transparent",
          color: "#0A0C12",
          fontSize: 13,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        {included ? "✓" : ""}
      </span>
    </button>
  );
}

function PlanCard({ session, machine }: { session: Session; machine: string }) {
  const plan = session.plan!;
  const [excluded, setExcluded] = useState<Set<string>>(
    () => new Set(plan.categories.filter((c) => !c.included).map((c) => c.key)),
  );

  const includedCategories = plan.categories.filter(
    (c) => !excluded.has(c.key),
  );
  const moveCount = includedCategories.reduce((n, c) => n + c.count, 0);

  return (
    <GlassCard radius={22} style={{ ...rise(0.1) }}>
      <MacEyebrow machine={machine} verb="RUNNING" />
      <div style={{ ...cardTitle, marginTop: 10 }}>Clean up my Desktop</div>
      <div style={cardBody}>
        Cue scanned {plan.scannedCount} items · here&rsquo;s the plan
      </div>

      <div style={{ marginTop: 12 }}>
        {plan.categories.map((c) => (
          <PlanCategoryRow
            key={c.key}
            category={c}
            included={!excluded.has(c.key)}
            onToggle={() =>
              setExcluded((prev) => {
                const next = new Set(prev);
                if (next.has(c.key)) next.delete(c.key);
                else next.add(c.key);
                return next;
              })
            }
          />
        ))}
      </div>

      <div
        style={{
          ...microLabel,
          fontSize: 9.5,
          color: "var(--mv3-muted)",
          borderTop: "1px solid var(--mv3-card-border)",
          paddingTop: 11,
          marginTop: 2,
        }}
      >
        Move, never delete · {plan.protectedNote}
      </div>

      <button
        type="button"
        disabled={moveCount === 0}
        style={{
          ...primaryBtn,
          width: "100%",
          marginTop: 12,
          opacity: moveCount === 0 ? 0.5 : 1,
        }}
      >
        Approve — move {moveCount} items
      </button>
      <div
        style={{
          fontSize: 11,
          color: "var(--mv3-muted)",
          textAlign: "center",
          marginTop: 8,
          lineHeight: 1.4,
        }}
      >
        or tap any category to include/exclude · runs on your Mac
      </div>
    </GlassCard>
  );
}

/* ── frame 72 — live mirror + done ─────────────────────────────────────── */

function ProgressRow({
  label,
  moved,
  total,
  done,
}: {
  label: string;
  moved: number;
  total: number;
  done: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 9,
        fontSize: 13,
        padding: "7px 0",
        color: done ? "var(--mv3-text)" : "var(--mv3-muted)",
      }}
    >
      <span
        aria-hidden
        style={{ color: done ? "var(--mv3-green)" : "var(--mv3-micro)" }}
      >
        {done ? "✓" : "…"}
      </span>
      <span style={{ flex: 1 }}>{label}</span>
      <span
        style={{ fontFamily: mv3Mono, fontSize: 10, color: "var(--mv3-muted)" }}
      >
        {done ? `${total} moved` : `${moved} of ${total}…`}
      </span>
    </div>
  );
}

function LiveMirror({
  session,
  machine,
}: {
  session: Session;
  machine: string;
}) {
  const p = session.progress!;
  return (
    <GlassCard radius={22} style={{ ...rise(0.1) }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <StateChip
          state="running"
          label={`TIDYING ON YOUR MAC · MOVED ${p.movedCount} OF ${p.totalCount}`}
          size="sm"
        />
      </div>
      <div style={{ marginTop: 12 }}>
        {p.perCategory.map((c) => (
          <ProgressRow
            key={c.key}
            label={c.label}
            moved={c.moved}
            total={c.total}
            done={c.done}
          />
        ))}
      </div>
      <div
        style={{
          fontSize: 11,
          color: "var(--mv3-muted)",
          marginTop: 8,
          lineHeight: 1.4,
        }}
      >
        Mirroring {machine} · nothing is deleted — items move into Cue Archive.
      </div>
    </GlassCard>
  );
}

function DoneCard({ session, machine }: { session: Session; machine: string }) {
  const d = session.done!;
  return (
    <GlassCard tint="violet" radius={22} style={{ ...rise(0.1) }}>
      <StateChip state="done" label="TIDIED" size="sm" />
      <div style={{ ...cardTitle, marginTop: 9 }}>
        Tidied {d.movedTotal} items
      </div>
      <div style={cardBody}>
        into {d.archivePath} · on your Mac · nothing deleted
      </div>
      <div style={{ display: "flex", gap: 9, marginTop: 13 }}>
        <button
          type="button"
          disabled={!d.undoAvailable}
          title={
            d.undoAvailable
              ? "Undo runs the archive's cue-undo.sh on your Mac"
              : "No undo script was recorded for this run"
          }
          style={{
            ...secondaryBtn,
            flex: 1,
            opacity: d.undoAvailable ? 1 : 0.5,
          }}
        >
          Undo all
        </button>
        <button type="button" style={{ ...secondaryBtn, flex: 1 }}>
          See on Mac
        </button>
      </div>
      <div
        style={{
          fontSize: 10.5,
          color: "var(--mv3-muted)",
          marginTop: 9,
          lineHeight: 1.4,
        }}
      >
        {machine} did the work — undo and the archive both live on the Mac.
      </div>
    </GlassCard>
  );
}

/* ── empty / idle ──────────────────────────────────────────────────────── */

function IdleCard({ target }: { target: Target | null }) {
  const lastSeen = relativeTime(target?.lastSeenAt);
  return (
    <GlassCard
      radius={22}
      style={{ textAlign: "center", padding: "30px 20px" }}
    >
      <div style={{ ...cardTitle, marginTop: 0 }}>No cleanup running</div>
      <div style={{ ...cardBody, marginTop: 6 }}>
        {target
          ? `Ask Cue to tidy a folder — it runs on ${target.machineName ?? "your Mac"} and this becomes the remote.`
          : "Connect your Mac, then ask Cue to tidy a folder — this screen becomes the live remote."}
      </div>
      {target ? (
        <div
          style={{
            ...microLabel,
            fontSize: 9.5,
            color: "var(--mv3-muted)",
            marginTop: 12,
          }}
        >
          {target.machineName ?? "Mac"} · online
          {lastSeen ? ` · ${lastSeen}` : ""}
        </div>
      ) : null}
    </GlassCard>
  );
}

/* ── page ──────────────────────────────────────────────────────────────── */

export function OrganizerRemotePage() {
  const assistantId = useActiveAssistantId();
  const { data, isLoading, isError } = useQuery({
    ...organizerSessionGetOptions({
      path: { assistant_id: assistantId ?? "" },
    }),
    enabled: !!assistantId,
    refetchInterval: POLL_MS,
  });

  const session = data?.session ?? null;
  const target = useMemo(() => data?.targets?.[0] ?? null, [data]);
  const machine = session?.machineName ?? target?.machineName ?? "your Mac";

  let body: React.ReactNode;
  if (isLoading) {
    body = (
      <div
        style={{
          ...microLabel,
          textAlign: "center",
          color: "var(--mv3-muted)",
          padding: "40px 0",
        }}
      >
        checking your Mac…
      </div>
    );
  } else if (isError) {
    body = (
      <GlassCard
        radius={22}
        style={{ textAlign: "center", padding: "28px 20px" }}
      >
        <div style={cardBody}>
          Can&rsquo;t reach your Cue instance right now — it may be offline or
          need an update.
        </div>
      </GlassCard>
    );
  } else if (session?.done && !session.active) {
    body = <DoneCard session={session} machine={machine} />;
  } else if (session?.active && session.progress) {
    body = <LiveMirror session={session} machine={machine} />;
  } else if (session?.active && session.plan) {
    body = <PlanCard session={session} machine={machine} />;
  } else {
    body = <IdleCard target={target} />;
  }

  return (
    <div style={{ position: "relative", minHeight: "100dvh" }}>
      <AuroraBackdrop />
      <div
        style={{
          position: "relative",
          padding: "16px 16px 90px",
          maxWidth: 560,
          margin: "0 auto",
        }}
      >
        <BackRow label="Today" />
        {body}
      </div>
    </div>
  );
}
