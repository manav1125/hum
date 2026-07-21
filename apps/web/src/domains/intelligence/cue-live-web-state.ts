/**
 * Off-desktop Cue Live state derivation (design frame L1).
 *
 * The web app can never *hold* Screen Recording / Accessibility, so it is never
 * a permission gate. What it can honestly report is where the Mac is: never
 * paired, paired-but-not-connected, connected-and-idle, or a session running
 * right now. That distinction is the whole fix for "clicked run, nothing
 * happened" — each state gets a different next action.
 *
 * Sources, both already shipped:
 *  - `organizer/session` → `targets[]`, the host-capable Macs currently
 *    subscribed to the event hub (`listClientsByCapability("host_bash")`), plus
 *    `session.machineName` / `session.lastSeenAt` for the last run.
 *  - `cuelive/session` → `active` and `lastSeenAt` for the live overlay.
 *
 * Kept as a pure function so the state machine is unit-testable without a
 * daemon.
 */
import type {
  CueliveSessionGetResponse,
  OrganizerSessionGetResponse,
} from "@/generated/daemon/types.gen";

export type CueLiveWebState =
  /** Neither query has answered yet. */
  | { kind: "loading" }
  /** The daemon can't be reached — the explainer still renders. */
  | { kind: "unreachable" }
  /** A Cue Live session is running on the Mac right now. */
  | { kind: "live" }
  /** No host-capable Mac has ever checked in. */
  | { kind: "unpaired" }
  /** A Mac is known but is not connected right now. */
  | { kind: "offline"; machineName: string | null; lastSeenAt: string | null }
  /** A Mac is connected, but no Cue Live session is running. */
  | { kind: "idle"; machineName: string | null };

export interface CueLiveWebStateInput {
  organizer: OrganizerSessionGetResponse | undefined;
  cueLive: CueliveSessionGetResponse | undefined;
  isLoading: boolean;
  isError: boolean;
}

/** Newest of two ISO timestamps (either may be absent). */
function newerIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

export function deriveCueLiveWebState({
  organizer,
  cueLive,
  isLoading,
  isError,
}: CueLiveWebStateInput): CueLiveWebState {
  if (cueLive?.active) return { kind: "live" };
  if (isLoading && !organizer && !cueLive) return { kind: "loading" };
  if (isError && !organizer && !cueLive) return { kind: "unreachable" };

  const targets = organizer?.targets ?? [];
  // `targets` only ever contains currently-subscribed clients, so `online`
  // is true by construction; we still read the flag rather than assume it.
  const online = targets.filter((t) => t.online !== false);
  if (online.length > 0) {
    const session = organizer?.session ?? null;
    return {
      kind: "idle",
      machineName: session?.machineName ?? online[0]?.machineName ?? null,
    };
  }

  const machineName = organizer?.session?.machineName ?? null;
  const lastSeenAt = newerIso(
    organizer?.session?.lastSeenAt ?? null,
    cueLive?.lastSeenAt ?? null,
  );
  if (machineName || lastSeenAt) {
    return { kind: "offline", machineName, lastSeenAt };
  }
  return { kind: "unpaired" };
}

/** "3 min ago" / "2d ago" — null when there is no timestamp to render. */
export function relativeSince(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return null;
  if (ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
