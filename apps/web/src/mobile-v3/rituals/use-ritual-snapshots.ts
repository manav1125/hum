/**
 * The kept briefs and weeklies — `GET /v1/assistants/{assistant_id}/rituals/snapshots`.
 *
 * The daemon route exists (assistant/src/runtime/routes/ritual-snapshot-routes.ts)
 * but is not yet in the generated SDK, so — exactly like
 * `mobile-v3/brief/use-morning-brief.ts` — this hook names the wire contract by
 * hand and calls the route through the already-configured, authed daemon
 * `client`. When codegen lands the types can be swapped with no call-site churn.
 *
 * `storeStartedAt` is why this returns a shape rather than an array. An empty
 * list on its own is ambiguous — it could mean the rituals never ran — so the
 * daemon also says how far back the log goes, and the archive turns that into
 * a sentence rather than a guess.
 */
import { useQuery } from "@tanstack/react-query";

import { client } from "@/generated/daemon/client.gen";

/* ------------------------------------------------------------------------- */
/* Wire contract (kept in lockstep with ritual-snapshot-routes.ts)           */
/* ------------------------------------------------------------------------- */

export type RitualKind = "brief" | "weekly";

/** A brief's figures. Present on `ritual: "brief"` rows. */
export interface BriefSnapshotFacts {
  done?: number;
  review?: number;
  needsYou?: number;
  dayEntries?: number;
  calendarAvailable?: boolean;
}

/** A weekly's figures. Present on `ritual: "weekly"` rows. */
export interface WeeklySnapshotFacts {
  moved?: number;
  slipped?: number;
}

export interface RitualSnapshot {
  id: string;
  ritual: RitualKind;
  /** "2026-08-17" for a brief, "2026-W33" for a weekly. */
  periodKey: string;
  periodStart: number;
  periodEnd: number;
  composedAt: number;
  /** The sentence as composed from the figures, on the day. */
  headline: string;
  facts: BriefSnapshotFacts & WeeklySnapshotFacts;
}

export interface RitualSnapshotArchive {
  snapshots: RitualSnapshot[];
  /** Epoch ms of the oldest kept row; null when nothing has been kept yet. */
  storeStartedAt: number | null;
}

/* ------------------------------------------------------------------------- */
/* Defensive narrowing — the daemon owns the shape; never trust it blindly.  */
/* ------------------------------------------------------------------------- */

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function normalizeFacts(
  raw: unknown,
): BriefSnapshotFacts & WeeklySnapshotFacts {
  if (!raw || typeof raw !== "object") return {};
  const o = raw as Record<string, unknown>;
  return {
    done: num(o.done),
    review: num(o.review),
    needsYou: num(o.needsYou),
    dayEntries: num(o.dayEntries),
    calendarAvailable:
      typeof o.calendarAvailable === "boolean"
        ? o.calendarAvailable
        : undefined,
    moved: num(o.moved),
    slipped: num(o.slipped),
  };
}

export function normalizeArchive(raw: unknown): RitualSnapshotArchive {
  if (!raw || typeof raw !== "object")
    return { snapshots: [], storeStartedAt: null };
  const o = raw as Record<string, unknown>;
  const rows = Array.isArray(o.snapshots) ? o.snapshots : [];
  const snapshots = rows.flatMap((entry): RitualSnapshot[] => {
    if (!entry || typeof entry !== "object") return [];
    const s = entry as Record<string, unknown>;
    const id = typeof s.id === "string" ? s.id : null;
    const ritual =
      s.ritual === "brief" || s.ritual === "weekly" ? s.ritual : null;
    const periodKey = typeof s.periodKey === "string" ? s.periodKey : null;
    const composedAt = num(s.composedAt);
    // A row missing any of these cannot be dated or attributed, and an
    // undatable row is exactly what this page refuses to render.
    if (!id || !ritual || !periodKey || composedAt === undefined) return [];
    return [
      {
        id,
        ritual,
        periodKey,
        periodStart: num(s.periodStart) ?? composedAt,
        periodEnd: num(s.periodEnd) ?? composedAt,
        composedAt,
        headline: typeof s.headline === "string" ? s.headline : "",
        facts: normalizeFacts(s.facts),
      },
    ];
  });
  return { snapshots, storeStartedAt: num(o.storeStartedAt) ?? null };
}

export function ritualSnapshotsQueryKey(
  assistantId: string,
): readonly unknown[] {
  return ["mv3", "ritual-snapshots", assistantId];
}

/**
 * Fetch the archive. While loading or on failure the archive reads as empty
 * with `loaded: false` — the page must be able to tell "nothing kept yet"
 * (a fact worth stating) apart from "we could not ask" (not worth stating).
 */
export function useRitualSnapshots(assistantId: string | null): {
  archive: RitualSnapshotArchive;
  loaded: boolean;
} {
  const query = useQuery({
    queryKey: ritualSnapshotsQueryKey(assistantId ?? ""),
    enabled: Boolean(assistantId),
    staleTime: 60_000,
    queryFn: async () => {
      const { data, response } = await client.get<
        Record<string, unknown>,
        unknown
      >({
        url: "/v1/assistants/{assistant_id}/rituals/snapshots",
        path: { assistant_id: assistantId ?? "" },
        throwOnError: false,
      });
      if (!response?.ok)
        throw new Error(`rituals/snapshots ${response?.status}`);
      return normalizeArchive(data);
    },
  });
  return {
    archive: query.data ?? { snapshots: [], storeStartedAt: null },
    loaded: query.isSuccess,
  };
}
