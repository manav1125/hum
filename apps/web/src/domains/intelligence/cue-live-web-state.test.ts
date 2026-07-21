import { describe, expect, it } from "vitest";

import {
  deriveCueLiveWebState,
  relativeSince,
} from "@/domains/intelligence/cue-live-web-state";
import type {
  CueliveSessionGetResponse,
  OrganizerSessionGetResponse,
} from "@/generated/daemon/types.gen";

type Target = OrganizerSessionGetResponse["targets"][number];

function target(overrides: Partial<Target> = {}): Target {
  return {
    clientId: "c1",
    machineName: "Manav's MacBook Pro",
    interfaceId: "macos",
    connectedAt: null,
    lastSeenAt: null,
    online: true,
    ...overrides,
  } as Target;
}

function organizer(
  overrides: Partial<OrganizerSessionGetResponse> = {},
): OrganizerSessionGetResponse {
  return {
    session: {
      active: false,
      machineName: null,
      lastSeenAt: null,
      sessionStartedAt: null,
      plan: null,
      progress: null,
      done: null,
    },
    targets: [],
    ...overrides,
  } as OrganizerSessionGetResponse;
}

function cueLive(
  overrides: Partial<CueliveSessionGetResponse> = {},
): CueliveSessionGetResponse {
  return {
    active: false,
    paused: false,
    stopPending: false,
    lastSeenAt: null,
    sessionStartedAt: null,
    watching: null,
    goal: null,
    observations: [],
    ...overrides,
  } as CueliveSessionGetResponse;
}

describe("deriveCueLiveWebState", () => {
  it("reports loading only while nothing has answered", () => {
    expect(
      deriveCueLiveWebState({
        organizer: undefined,
        cueLive: undefined,
        isLoading: true,
        isError: false,
      }),
    ).toEqual({ kind: "loading" });
  });

  it("reports unreachable when both queries failed", () => {
    expect(
      deriveCueLiveWebState({
        organizer: undefined,
        cueLive: undefined,
        isLoading: false,
        isError: true,
      }),
    ).toEqual({ kind: "unreachable" });
  });

  it("is unpaired when no Mac has ever checked in", () => {
    expect(
      deriveCueLiveWebState({
        organizer: organizer(),
        cueLive: cueLive(),
        isLoading: false,
        isError: false,
      }),
    ).toEqual({ kind: "unpaired" });
  });

  it("is idle when a host-capable Mac is connected but no session runs", () => {
    const state = deriveCueLiveWebState({
      organizer: organizer({ targets: [target()] }),
      cueLive: cueLive(),
      isLoading: false,
      isError: false,
    });
    expect(state).toEqual({
      kind: "idle",
      machineName: "Manav's MacBook Pro",
    });
  });

  it("prefers the organizer session's machine name when it has one", () => {
    const state = deriveCueLiveWebState({
      organizer: organizer({
        targets: [target({ machineName: "target-name" })],
        session: {
          active: false,
          machineName: "session-name",
          lastSeenAt: null,
          sessionStartedAt: null,
          plan: null,
          progress: null,
          done: null,
        },
      } as Partial<OrganizerSessionGetResponse>),
      cueLive: cueLive(),
      isLoading: false,
      isError: false,
    });
    expect(state).toMatchObject({ kind: "idle", machineName: "session-name" });
  });

  it("is offline (with the newest last-seen) when a known Mac isn't connected", () => {
    const older = "2026-07-20T10:00:00.000Z";
    const newer = "2026-07-21T10:00:00.000Z";
    const state = deriveCueLiveWebState({
      organizer: organizer({
        targets: [],
        session: {
          active: false,
          machineName: "Manav's MacBook Pro",
          lastSeenAt: older,
          sessionStartedAt: null,
          plan: null,
          progress: null,
          done: null,
        },
      } as Partial<OrganizerSessionGetResponse>),
      cueLive: cueLive({ lastSeenAt: newer }),
      isLoading: false,
      isError: false,
    });
    expect(state).toEqual({
      kind: "offline",
      machineName: "Manav's MacBook Pro",
      lastSeenAt: newer,
    });
  });

  it("ignores targets explicitly flagged offline", () => {
    const state = deriveCueLiveWebState({
      organizer: organizer({ targets: [target({ online: false })] }),
      cueLive: cueLive({ lastSeenAt: "2026-07-21T10:00:00.000Z" }),
      isLoading: false,
      isError: false,
    });
    expect(state.kind).toBe("offline");
  });

  it("hands over to the live viewer whenever a session is active", () => {
    expect(
      deriveCueLiveWebState({
        organizer: organizer(),
        cueLive: cueLive({ active: true }),
        isLoading: true,
        isError: true,
      }),
    ).toEqual({ kind: "live" });
  });
});

describe("relativeSince", () => {
  it("returns null without a timestamp", () => {
    expect(relativeSince(null)).toBeNull();
  });

  it("renders minutes, hours and days", () => {
    const now = Date.now();
    expect(relativeSince(new Date(now - 5 * 60_000).toISOString())).toBe(
      "5 min ago",
    );
    expect(relativeSince(new Date(now - 3 * 3_600_000).toISOString())).toBe(
      "3h ago",
    );
    expect(relativeSince(new Date(now - 2 * 86_400_000).toISOString())).toBe(
      "2d ago",
    );
  });
});
