import { beforeEach, describe, expect, test } from "bun:test";

import { ROUTES } from "../organizer-routes.js";
import type { OrganizerPlan, OrganizerProgress } from "../organizer-session.js";
import {
  getOrganizerView,
  recordOrganizerDone,
  recordOrganizerPlan,
  recordOrganizerProgress,
  resetOrganizerSessionForTest,
} from "../organizer-session.js";

const PLAN: OrganizerPlan = {
  root: "~/Desktop",
  scannedCount: 84,
  archiveBase: "Cue Archive/2026-07-21",
  protectedNote: "dotfiles & ~/Library excluded",
  categories: [
    {
      key: "screenshots",
      label: "Screenshots",
      icon: "🖼",
      count: 40,
      destination: "Cue Archive",
      included: true,
    },
    {
      key: "documents",
      label: "Documents",
      icon: "📄",
      count: 22,
      destination: "Cue Archive",
      included: true,
    },
  ],
};

const PROGRESS: OrganizerProgress = {
  movedCount: 40,
  totalCount: 62,
  currentCategory: "Documents",
  perCategory: [
    {
      key: "screenshots",
      label: "Screenshots",
      moved: 40,
      total: 40,
      done: true,
    },
    { key: "documents", label: "Documents", moved: 0, total: 22, done: false },
  ],
};

beforeEach(() => {
  resetOrganizerSessionForTest();
});

describe("desktop-organizer session tracker", () => {
  test("starts inactive with nothing recorded", () => {
    const view = getOrganizerView();
    expect(view.active).toBe(false);
    expect(view.plan).toBeNull();
    expect(view.progress).toBeNull();
    expect(view.done).toBeNull();
    expect(view.lastSeenAt).toBeNull();
  });

  test("a recorded plan marks the run active and names the Mac", () => {
    const t = Date.now();
    recordOrganizerPlan({ machineName: "MacBook Pro", plan: PLAN }, t);
    const view = getOrganizerView(t);
    expect(view.active).toBe(true);
    expect(view.machineName).toBe("MacBook Pro");
    expect(view.plan?.scannedCount).toBe(84);
    expect(view.plan?.categories).toHaveLength(2);
  });

  test("progress mirrors moved/total and the in-flight category", () => {
    const t = Date.now();
    recordOrganizerPlan({ machineName: "MacBook Pro", plan: PLAN }, t);
    recordOrganizerProgress({ progress: PROGRESS }, t + 1000);
    const view = getOrganizerView(t + 1000);
    expect(view.progress?.movedCount).toBe(40);
    expect(view.progress?.totalCount).toBe(62);
    expect(view.progress?.currentCategory).toBe("Documents");
  });

  test("done lingers past the active window so the undo card stays", () => {
    const t = Date.now();
    recordOrganizerPlan({ machineName: "MacBook Pro", plan: PLAN }, t);
    recordOrganizerDone(
      {
        done: {
          movedTotal: 68,
          archivePath: "Cue Archive/Jul-21",
          undoAvailable: true,
        },
      },
      t,
    );
    // Long after activity has gone quiet: not active, but the done tally holds.
    const view = getOrganizerView(t + 10 * 60_000);
    expect(view.active).toBe(false);
    expect(view.plan).toBeNull();
    expect(view.done?.movedTotal).toBe(68);
    expect(view.done?.undoAvailable).toBe(true);
  });

  test("the read route is registered with a safe (read) scope", () => {
    const def = ROUTES.find((r) => r.operationId === "organizer_session");
    expect(def).toBeDefined();
    expect(def?.method).toBe("GET");
    expect(def?.policy?.requiredScopes).toContain("chat.read");
  });
});
