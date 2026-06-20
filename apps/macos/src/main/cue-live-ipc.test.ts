import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { CueLiveGoal } from "@vellumai/ipc-contract";

// cue-live-ipc transitively imports electron (via ./ipc, ./settings,
// ./cue-voice-keys) and ./logger; stub both so the module loads in bun:test.
// The CRUD helpers under test never touch electron — they operate purely on the
// injected store seam — so empty stubs are enough.
const electronMock = {
  app: {
    getPath: () => "/tmp",
    getAppPath: () => "/repo/apps/macos",
    get isPackaged() {
      return false;
    },
    on: () => undefined,
  },
  BrowserWindow: {
    fromWebContents: () => null,
    getAllWindows: () => [],
  },
  ipcMain: {
    handle: mock(() => undefined),
    on: mock(() => undefined),
    removeAllListeners: mock(() => undefined),
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
};

mock.module("electron", () => ({ ...electronMock, default: electronMock }));

mock.module("./logger", () => ({
  default: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
  },
}));

const { listGoals, saveGoal, deleteGoal } = await import("./cue-live-ipc");
import type { CueLiveGoalsStore } from "./cue-live-ipc";

/** In-memory fake of the cueLiveGoals persistence seam. */
const makeStore = (initial: CueLiveGoal[] = []): CueLiveGoalsStore => {
  let goals = [...initial];
  return {
    read: () => goals,
    write: (next) => {
      goals = next;
    },
  };
};

describe("cue-live goals CRUD", () => {
  let store: CueLiveGoalsStore;

  beforeEach(() => {
    store = makeStore();
  });

  test("listGoals returns the persisted list", () => {
    const seeded = makeStore([
      { id: "a", label: "A", goal: "do a", takeControl: false },
    ]);
    expect(listGoals(seeded)).toEqual([
      { id: "a", label: "A", goal: "do a", takeControl: false },
    ]);
  });

  test("saveGoal adds a new goal and assigns an id", () => {
    const list = saveGoal(store, {
      label: "Triage inbox",
      goal: "Open mail and triage",
      takeControl: true,
    });
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBeTruthy();
    expect(list[0]).toMatchObject({
      label: "Triage inbox",
      goal: "Open mail and triage",
      takeControl: true,
    });
    // Persisted to the store.
    expect(listGoals(store)).toEqual(list);
  });

  test("saveGoal upserts in place when id matches an existing goal", () => {
    const first = saveGoal(store, {
      label: "Triage",
      goal: "v1",
      takeControl: false,
    });
    const id = first[0]!.id;

    const updated = saveGoal(store, {
      id,
      label: "Triage inbox",
      goal: "v2",
      takeControl: true,
    });

    expect(updated).toHaveLength(1);
    expect(updated[0]).toEqual({
      id,
      label: "Triage inbox",
      goal: "v2",
      takeControl: true,
    });
  });

  test("saveGoal preserves order and other entries on upsert", () => {
    const a = saveGoal(store, { label: "A", goal: "a", takeControl: false });
    const b = saveGoal(store, { label: "B", goal: "b", takeControl: false });
    const idA = a[0]!.id;
    const idB = b[1]!.id;

    const after = saveGoal(store, {
      id: idA,
      label: "A2",
      goal: "a2",
      takeControl: true,
    });

    expect(after.map((g) => g.id)).toEqual([idA, idB]);
    expect(after[0]).toMatchObject({ label: "A2", goal: "a2" });
    expect(after[1]).toMatchObject({ label: "B", goal: "b" });
  });

  test("deleteGoal removes by id and returns the remaining list", () => {
    const a = saveGoal(store, { label: "A", goal: "a", takeControl: false });
    saveGoal(store, { label: "B", goal: "b", takeControl: false });
    const idA = a[0]!.id;

    const after = deleteGoal(store, idA);
    expect(after).toHaveLength(1);
    expect(after.find((g) => g.id === idA)).toBeUndefined();
    expect(listGoals(store)).toEqual(after);
  });

  test("deleteGoal on an unknown id is a no-op", () => {
    saveGoal(store, { label: "A", goal: "a", takeControl: false });
    const after = deleteGoal(store, "nope");
    expect(after).toHaveLength(1);
  });
});
