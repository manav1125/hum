/**
 * Halo's slot on Today — and, as with the ritual slot, the cases where it
 * renders nothing at all.
 *
 * The design puts the Halo card in two homes (Today and You) because it
 * answers a question somebody asks all day without opening anything: **is it
 * on, and does Cue have what it heard?** But that only earns space on Today
 * when there is a Halo to report on. Most people signed into Cue do not own
 * one, and a permanently empty "Halo" row in front of them is the exact thing
 * `use-ritual-slot` refuses to build.
 *
 * So the rule is the same: **render only when there is something true to
 * say.** That means either the daemon has heard something (a device has
 * synced at least once) or the native surfaces are actually present on this
 * device. Anything else returns `null` and nothing sits on Today.
 */
import { useQuery } from "@tanstack/react-query";

import { haloStatusGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { isHaloAvailable } from "@/lib/halo/halo-bridge";

/** The three shapes the sync line is allowed to take. Nothing else. */
export type HaloSyncState = "unknown" | "up_to_date" | "behind";

export interface HaloSlotFace {
  state: HaloSyncState;
  /**
   * Seconds behind the room. **Null when nothing has arrived** — the surface
   * renders that as a state, never as a zero it invented.
   */
  behindSeconds: number | null;
  /** The card's line, phrased once so every surface says the same thing. */
  line: string;
  /** True when tapping can actually open the native Day. */
  canOpen: boolean;
}

interface HaloStatusShape {
  sync?: { state?: string; behindSeconds?: number | null };
  coveredThrough?: number | null;
}

/** "3 min", "2 hours" — rounded up, because understating staleness is the
 * one direction this number must never fail in. */
export function phraseLag(seconds: number): string {
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

/** The card's sentence. Exactly three shapes, and never a fourth. */
export function haloLine(
  state: HaloSyncState,
  behindSeconds: number | null,
): string {
  if (state === "unknown" || behindSeconds === null) return "nothing yet";
  if (state === "up_to_date") return "up to date";
  return `synced to ${phraseLag(behindSeconds)} ago`;
}

/**
 * Decide whether Halo has earned its row, from the daemon's answer.
 *
 * Exported because this is the whole judgement: a device that has never sent
 * anything and no native surfaces to open means Halo is not part of this
 * person's Cue, and Today should look exactly as it did before Halo existed.
 */
export function faceFromStatus(
  status: HaloStatusShape | undefined,
  nativeAvailable: boolean,
): HaloSlotFace | null {
  const hasHeardSomething = status?.coveredThrough != null;
  if (!hasHeardSomething && !nativeAvailable) return null;

  const raw = status?.sync?.state;
  const state: HaloSyncState =
    raw === "up_to_date"
      ? "up_to_date"
      : raw === "behind"
        ? "behind"
        : "unknown";
  const behindSeconds = status?.sync?.behindSeconds ?? null;

  return {
    state,
    behindSeconds,
    line: haloLine(state, behindSeconds),
    canOpen: nativeAvailable,
  };
}

/**
 * @param assistantId the SPA reaches the daemon through the platform gateway,
 * which addresses every route as `/v1/assistants/{id}/…`. The native plugin
 * talks to the daemon directly and needs no such prefix — the two paths to the
 * same data differ, and only this one is routed.
 */
export function useHaloSlot(
  assistantId: string | undefined,
): HaloSlotFace | null {
  const native = isHaloAvailable();

  const { data } = useQuery({
    ...haloStatusGetOptions({ path: { assistant_id: assistantId ?? "" } }),
    enabled: Boolean(assistantId),
    // The lag is the point of the row, so it has to move. Sixty seconds is
    // the resolution the phrasing rounds to anyway — polling faster would
    // change nothing on screen and cost a request a second.
    refetchInterval: 60_000,
    // A failure is not an empty Halo; it is an unknown one, and the row
    // simply keeps its last honest answer rather than flashing "nothing yet".
    staleTime: 30_000,
    retry: false,
  });

  return faceFromStatus(data as HaloStatusShape | undefined, native);
}
