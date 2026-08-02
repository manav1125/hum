/**
 * Tests for the background auto-filer: candidate selection, provenance
 * stamping, the confidence threshold, the user-decision guards (user-filed
 * and user-unfiled items are never touched), and the parked-stays-parked
 * invariant. The LLM scorer is injected so every test is deterministic.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { createTask } from "../tasks/task-store.js";
import { createProject } from "./project-store.js";
import {
  AUTO_FILE_USER_UNFILED,
  AUTO_FILED_BY_CUE,
  type AutoFileAssignment,
  buildAutoFilePrompt,
  classifyTitlesForPreview,
  getAutoFileHealth,
  MAX_CLASSIFY_PREVIEW_TITLES,
  MAX_ITEMS_PER_SWEEP,
  parseAutoFileResponse,
  resetAutoFilerForTests,
  runAutoFileTick,
  sweepUnfiledWorkItems,
  UNPRODUCTIVE_SWEEP_LIMIT,
} from "./work-item-auto-file.js";
import {
  createWorkItem,
  getWorkItem,
  updateWorkItem,
  type WorkItem,
} from "./work-item-store.js";

initializeDb();

beforeEach(() => {
  getDb().run("DELETE FROM work_items");
  getDb().run("DELETE FROM tasks");
  getDb().run("DELETE FROM projects");
});

function makeItem(
  title: string,
  opts: Partial<Parameters<typeof createWorkItem>[0]> = {},
): WorkItem {
  const task = createTask({ title, template: title });
  return createWorkItem({ taskId: task.id, title, ...opts });
}

describe("parseAutoFileResponse", () => {
  const itemIds = new Set(["i1", "i2"]);
  const projectIds = new Set(["p1", "p2"]);

  test("parses a clean JSON array and clamps confidence", () => {
    const parsed = parseAutoFileResponse(
      'Here you go: [{"id":"i1","projectId":"p1","confidence":1.7},{"id":"i2","projectId":null,"confidence":-2}]',
      itemIds,
      projectIds,
    );
    expect(parsed).toEqual([
      { id: "i1", projectId: "p1", confidence: 1 },
      { id: "i2", projectId: null, confidence: 0 },
    ]);
  });

  test("drops unknown item ids and treats hallucinated project ids as no-fit", () => {
    const parsed = parseAutoFileResponse(
      '[{"id":"ghost","projectId":"p1","confidence":0.9},{"id":"i1","projectId":"invented","confidence":0.9}]',
      itemIds,
      projectIds,
    );
    expect(parsed).toEqual([{ id: "i1", projectId: null, confidence: 0.9 }]);
  });

  test("returns null on prose with no array", () => {
    expect(parseAutoFileResponse("no json here", itemIds, projectIds)).toBe(
      null,
    );
  });
});

describe("buildAutoFilePrompt", () => {
  test("includes project briefs and item ids", () => {
    const project = createProject({
      title: "Q4 launch",
      context: "Ship the Q4 launch: emails, landing page, press.",
    });
    const item = makeItem("Draft the launch email");
    const prompt = buildAutoFilePrompt([item], [project]);
    expect(prompt).toContain(project.id);
    expect(prompt).toContain("Q4 launch");
    expect(prompt).toContain("Ship the Q4 launch");
    expect(prompt).toContain(item.id);
    expect(prompt).toContain("Draft the launch email");
  });
});

describe("sweepUnfiledWorkItems", () => {
  test("files a confident match with provenance, leaves low-confidence unfiled", async () => {
    const project = createProject({ title: "Q4 launch", context: "Launch." });
    const confident = makeItem("Draft the launch email");
    const unsure = makeItem("Buy milk");

    const scorer = async (): Promise<AutoFileAssignment[]> => [
      { id: confident.id, projectId: project.id, confidence: 0.92 },
      { id: unsure.id, projectId: project.id, confidence: 0.3 },
    ];

    const result = await sweepUnfiledWorkItems(scorer);
    expect(result.scanned).toBe(2);
    expect(result.filed).toBe(1);
    expect(result.belowThreshold).toBe(1);

    const filed = getWorkItem(confident.id)!;
    expect(filed.projectId).toBe(project.id);
    expect(filed.autoFiledBy).toBe(AUTO_FILED_BY_CUE);
    expect(filed.autoFileConfidence).toBe(0.92);

    const left = getWorkItem(unsure.id)!;
    expect(left.projectId).toBeNull();
    expect(left.autoFiledBy).toBeNull();
  });

  test("filing does NOT grant run permission — a parked item stays parked", async () => {
    const project = createProject({ title: "Ops" });
    const parked = makeItem("File my receipts", {
      autoRunEligibility: "parked",
    });

    const result = await sweepUnfiledWorkItems(async () => [
      { id: parked.id, projectId: project.id, confidence: 0.99 },
    ]);
    expect(result.filed).toBe(1);

    const after = getWorkItem(parked.id)!;
    expect(after.projectId).toBe(project.id);
    // The invariant this feature must never break.
    expect(after.autoRunEligibility).toBe("parked");
    expect(after.status).toBe("queued");
  });

  test("never considers user-filed or user-unfiled items", async () => {
    const project = createProject({ title: "Ops" });
    const other = createProject({ title: "Growth" });
    const userFiled = makeItem("Already filed", { projectId: other.id });
    const userUnfiled = makeItem("Deliberately unfiled");
    updateWorkItem(userUnfiled.id, { autoFiledBy: AUTO_FILE_USER_UNFILED });

    const seen: string[] = [];
    const result = await sweepUnfiledWorkItems(async (items) => {
      seen.push(...items.map((i) => i.id));
      return items.map((i) => ({
        id: i.id,
        projectId: project.id,
        confidence: 1,
      }));
    });

    // Neither candidate was even offered to the scorer; nothing changed.
    expect(seen).toHaveLength(0);
    expect(result.scanned).toBe(0);
    expect(getWorkItem(userFiled.id)!.projectId).toBe(other.id);
    expect(getWorkItem(userUnfiled.id)!.projectId).toBeNull();
  });

  test("skips entirely when there are no projects (no LLM call)", async () => {
    makeItem("Lonely task");
    let called = 0;
    const result = await sweepUnfiledWorkItems(async () => {
      called++;
      return [];
    });
    expect(called).toBe(0);
    expect(result.scanned).toBe(0);
  });

  test("caps a huge unfiled backlog at MAX_ITEMS_PER_SWEEP", async () => {
    createProject({ title: "Ops" });
    for (let i = 0; i < MAX_ITEMS_PER_SWEEP + 5; i++) {
      makeItem(`Task ${i}`);
    }
    let offered = 0;
    await sweepUnfiledWorkItems(async (items) => {
      offered = items.length;
      return [];
    });
    expect(offered).toBe(MAX_ITEMS_PER_SWEEP);
  });

  test("a mid-flight user filing wins over the sweep's stale assignment", async () => {
    const project = createProject({ title: "Ops" });
    const userPick = createProject({ title: "Personal" });
    const item = makeItem("Race me");

    const result = await sweepUnfiledWorkItems(async (items) => {
      // Simulate the user filing the item while the LLM call is in flight.
      updateWorkItem(items[0].id, { projectId: userPick.id });
      return [{ id: item.id, projectId: project.id, confidence: 0.95 }];
    });

    expect(result.filed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(getWorkItem(item.id)!.projectId).toBe(userPick.id);
    expect(getWorkItem(item.id)!.autoFiledBy).toBeNull();
  });

  test("a null scorer result (LLM failure) leaves everything unfiled", async () => {
    createProject({ title: "Ops" });
    const item = makeItem("Unscorable");
    const result = await sweepUnfiledWorkItems(async () => null);
    expect(result.filed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(getWorkItem(item.id)!.projectId).toBeNull();
  });
});

describe("below-confidence stamping", () => {
  test("stamps the best-guess confidence WITHOUT filing", async () => {
    const project = createProject({ title: "Ops" });
    const unsure = makeItem("Maybe ops?");

    const result = await sweepUnfiledWorkItems(async () => [
      { id: unsure.id, projectId: project.id, confidence: 0.45 },
    ]);
    expect(result.filed).toBe(0);
    expect(result.belowThreshold).toBe(1);
    expect(result.stamped).toBe(1);

    // The exact shape the web's isBelowConfidence feature-detects: confidence
    // set while project_id AND auto_filed_by stay null.
    const after = getWorkItem(unsure.id)!;
    expect(after.projectId).toBeNull();
    expect(after.autoFiledBy).toBeNull();
    expect(after.autoFileConfidence).toBe(0.45);
  });

  test("a scored no-fit (projectId null) is stamped too", async () => {
    createProject({ title: "Ops" });
    const noFit = makeItem("Buy milk");
    const result = await sweepUnfiledWorkItems(async () => [
      { id: noFit.id, projectId: null, confidence: 0 },
    ]);
    expect(result.stamped).toBe(1);
    expect(getWorkItem(noFit.id)!.autoFileConfidence).toBe(0);
    expect(getWorkItem(noFit.id)!.projectId).toBeNull();
  });

  test("an unscored item (scorer miss) is NOT stamped", async () => {
    createProject({ title: "Ops" });
    const missed = makeItem("Overlooked");
    const result = await sweepUnfiledWorkItems(async () => []);
    expect(result.skipped).toBe(1);
    expect(result.stamped).toBe(0);
    expect(getWorkItem(missed.id)!.autoFileConfidence).toBeNull();
  });

  test("a stamped unfiled item is not re-offered next sweep (no re-score churn)", async () => {
    const project = createProject({ title: "Ops" });
    const unsure = makeItem("Maybe ops?");
    await sweepUnfiledWorkItems(async () => [
      { id: unsure.id, projectId: project.id, confidence: 0.3 },
    ]);
    expect(getWorkItem(unsure.id)!.autoFileConfidence).toBe(0.3);

    const seen: string[] = [];
    const second = await sweepUnfiledWorkItems(async (items) => {
      seen.push(...items.map((i) => i.id));
      return [];
    });
    expect(seen).toHaveLength(0);
    expect(second.scanned).toBe(0);
  });

  test("editing the title clears the stamp and re-opens candidacy", async () => {
    const project = createProject({ title: "Ops" });
    const unsure = makeItem("Maybe ops?");
    await sweepUnfiledWorkItems(async () => [
      { id: unsure.id, projectId: project.id, confidence: 0.3 },
    ]);

    // A title edit invalidates the old judgment (store-level guard).
    updateWorkItem(unsure.id, { title: "Rotate the ops on-call schedule" });
    expect(getWorkItem(unsure.id)!.autoFileConfidence).toBeNull();

    const seen: string[] = [];
    await sweepUnfiledWorkItems(async (items) => {
      seen.push(...items.map((i) => i.id));
      return [];
    });
    expect(seen).toEqual([unsure.id]);
  });

  test("an auto-FILED item keeps its provenance confidence across a title edit", async () => {
    const project = createProject({ title: "Ops" });
    const filed = makeItem("Ops thing");
    await sweepUnfiledWorkItems(async () => [
      { id: filed.id, projectId: project.id, confidence: 0.9 },
    ]);
    updateWorkItem(filed.id, { title: "Ops thing, renamed" });
    const after = getWorkItem(filed.id)!;
    expect(after.autoFiledBy).toBe(AUTO_FILED_BY_CUE);
    expect(after.autoFileConfidence).toBe(0.9);
  });

  test("a mid-flight user filing wins over the stamp", async () => {
    const project = createProject({ title: "Ops" });
    const userPick = createProject({ title: "Personal" });
    const item = makeItem("Race me");

    const result = await sweepUnfiledWorkItems(async (items) => {
      updateWorkItem(items[0].id, { projectId: userPick.id });
      return [{ id: item.id, projectId: project.id, confidence: 0.2 }];
    });
    expect(result.stamped).toBe(0);
    const after = getWorkItem(item.id)!;
    expect(after.projectId).toBe(userPick.id);
    expect(after.autoFileConfidence).toBeNull();
  });
});

describe("classifyTitlesForPreview", () => {
  test("returns one suggestion per unique non-blank title, mapped from the scorer", async () => {
    const ops = createProject({ title: "Ops" });
    const growth = createProject({ title: "Growth" });

    const suggestions = await classifyTitlesForPreview(
      ["  Fix the pager  ", "", "Draft the launch tweet", "Fix the pager"],
      async (items, projects) => {
        expect(projects.map((p) => p.id).sort()).toEqual(
          [ops.id, growth.id].sort(),
        );
        return items.map((i, idx) => ({
          id: i.id,
          projectId: idx === 0 ? ops.id : growth.id,
          confidence: idx === 0 ? 0.9 : 0.5,
        }));
      },
    );
    // Blank dropped, duplicate collapsed, titles trimmed, order preserved.
    expect(suggestions).toEqual([
      { title: "Fix the pager", projectId: ops.id, confidence: 0.9 },
      {
        title: "Draft the launch tweet",
        projectId: growth.id,
        confidence: 0.5,
      },
    ]);
  });

  test("caps the batch at MAX_CLASSIFY_PREVIEW_TITLES", async () => {
    createProject({ title: "Ops" });
    const titles = Array.from(
      { length: MAX_CLASSIFY_PREVIEW_TITLES + 10 },
      (_, i) => `Task ${i}`,
    );
    let offered = 0;
    const suggestions = await classifyTitlesForPreview(
      titles,
      async (items) => {
        offered = items.length;
        return items.map((i) => ({ id: i.id, projectId: null, confidence: 0 }));
      },
    );
    expect(offered).toBe(MAX_CLASSIFY_PREVIEW_TITLES);
    expect(suggestions).toHaveLength(MAX_CLASSIFY_PREVIEW_TITLES);
  });

  test("scorer failure (null) degrades to an empty array", async () => {
    createProject({ title: "Ops" });
    expect(
      await classifyTitlesForPreview(["A task"], async () => null),
    ).toEqual([]);
  });

  test("a throwing scorer degrades to an empty array", async () => {
    createProject({ title: "Ops" });
    expect(
      await classifyTitlesForPreview(["A task"], async () => {
        throw new Error("boom");
      }),
    ).toEqual([]);
  });

  test("no projects → empty array without calling the scorer", async () => {
    let called = 0;
    const suggestions = await classifyTitlesForPreview(["A task"], async () => {
      called++;
      return [];
    });
    expect(called).toBe(0);
    expect(suggestions).toEqual([]);
  });

  test("a title the scorer skipped comes back as no-fit with confidence 0", async () => {
    createProject({ title: "Ops" });
    const suggestions = await classifyTitlesForPreview(
      ["Scored", "Skipped"],
      async (items) => [{ id: items[0].id, projectId: null, confidence: 0.1 }],
    );
    expect(suggestions).toEqual([
      { title: "Scored", projectId: null, confidence: 0.1 },
      { title: "Skipped", projectId: null, confidence: 0 },
    ]);
  });

  test("scores NOTHING into the database — no persistence, no side effects", async () => {
    const ops = createProject({ title: "Ops" });
    const existing = makeItem("Pre-existing unfiled");
    await classifyTitlesForPreview(["Pre-existing unfiled"], async (items) => [
      { id: items[0].id, projectId: ops.id, confidence: 0.99 },
    ]);
    // The real work item with the same title is untouched.
    const after = getWorkItem(existing.id)!;
    expect(after.projectId).toBeNull();
    expect(after.autoFiledBy).toBeNull();
    expect(after.autoFileConfidence).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The tick: single-flight, the stuck-sweep watchdog, and observable health
// ---------------------------------------------------------------------------

/**
 * Production regression suite for the failure that left 103 of 116 queued
 * items unfiled for twelve hours on a healthy daemon with a healthy LLM: the
 * sweep produced no output at all, so the only symptom was the pile itself.
 * Every test here asserts something that is legible from OUTSIDE the sweep.
 */
describe("auto-file tick", () => {
  const NEVER = () => new Promise<never>(() => {});

  beforeEach(() => {
    resetAutoFilerForTests();
  });

  test("a real backlog is reported whole, not just the slice one sweep can reach", async () => {
    createProject({ title: "Ops" });
    const backlog = MAX_ITEMS_PER_SWEEP * 5 + 12;
    for (let i = 0; i < backlog; i++) makeItem(`Gmail item ${i}`);

    await runAutoFileTick(async (items) =>
      items.map((i) => ({ id: i.id, projectId: null, confidence: 0.1 })),
    );

    const health = getAutoFileHealth();
    // The number the user is staring at, not the number this sweep touched.
    expect(health.lastResult!.candidates).toBe(backlog);
    expect(health.lastResult!.scanned).toBe(MAX_ITEMS_PER_SWEEP);
    expect(health.candidatesWaiting).toBe(backlog);
  });

  test("a sweep that never settles does not disable filing forever", async () => {
    createProject({ title: "Ops" });
    const item = makeItem("Stuck behind a hung scorer");

    // The exact production shape: the first sweep's scorer never resolves.
    const t0 = 1_000_000;
    void runAutoFileTick(NEVER, t0);
    await Promise.resolve();

    // Ticks inside the watchdog window are skipped — the old behaviour, and
    // correct on its own.
    await runAutoFileTick(NEVER, t0 + 60_000);
    expect(getAutoFileHealth().skippedTicks).toBe(1);
    expect(getWorkItem(item.id)!.projectId).toBeNull();

    // Past the watchdog window the latch is broken and filing resumes. Before
    // this, one hung call latched the filer off for the life of the process
    // and a restart just hung again.
    const project = createProject({ title: "Inbox" });
    await runAutoFileTick(
      async (items) =>
        items.map((i) => ({ id: i.id, projectId: project.id, confidence: 1 })),
      t0 + 10 * 60_000,
    );

    const health = getAutoFileHealth();
    expect(health.stuckReleases).toBe(1);
    expect(health.lastResult!.filed).toBe(1);
    expect(getWorkItem(item.id)!.projectId).toBe(project.id);
    expect(getWorkItem(item.id)!.autoFiledBy).toBe(AUTO_FILED_BY_CUE);
  });

  test("a wedged sweep that finally settles cannot unlatch a newer sweep", async () => {
    createProject({ title: "Ops" });
    makeItem("One");

    let releaseWedged: (v: AutoFileAssignment[] | null) => void = () => {};
    const wedged = new Promise<AutoFileAssignment[] | null>((resolve) => {
      releaseWedged = resolve;
    });

    const t0 = 2_000_000;
    void runAutoFileTick(() => wedged, t0);
    await Promise.resolve();

    // The watchdog starts a second sweep, which is itself slow.
    void runAutoFileTick(NEVER, t0 + 10 * 60_000);
    await Promise.resolve();
    expect(getAutoFileHealth().stuckReleases).toBe(1);

    // The abandoned first sweep settles late. It must not hand the latch away
    // from the sweep that now holds it.
    releaseWedged(null);
    await Promise.resolve();
    await Promise.resolve();

    await runAutoFileTick(NEVER, t0 + 11 * 60_000);
    expect(getAutoFileHealth().skippedTicks).toBe(1);
  });

  test("scanning candidates and filing none, repeatedly, is reported as broken", async () => {
    createProject({ title: "Ops" });
    for (let i = 0; i < 5; i++) makeItem(`Ambiguous ${i}`);

    // A scorer that judges every item but never clears the bar, and whose
    // verdicts are never persisted (no stamp) — so the same items come back
    // every sweep. Nothing throws; nothing moves.
    const noOpScorer = async () => [];

    for (let n = 1; n < UNPRODUCTIVE_SWEEP_LIMIT; n++) {
      await runAutoFileTick(noOpScorer, 3_000_000 + n * 300_000);
      expect(getAutoFileHealth().degraded).toBe(false);
    }
    await runAutoFileTick(
      noOpScorer,
      3_000_000 + UNPRODUCTIVE_SWEEP_LIMIT * 300_000,
    );

    const health = getAutoFileHealth();
    expect(health.unproductiveStreak).toBe(UNPRODUCTIVE_SWEEP_LIMIT);
    expect(health.degraded).toBe(true);
    expect(health.degradedReason).toContain("filed none");
    expect(health.lastResult!.outcome).toBe("no_match");
  });

  test("a productive sweep clears the broken state", async () => {
    const project = createProject({ title: "Ops" });
    for (let i = 0; i < 4; i++) makeItem(`Item ${i}`);
    for (let n = 0; n <= UNPRODUCTIVE_SWEEP_LIMIT; n++) {
      await runAutoFileTick(async () => [], 4_000_000 + n * 300_000);
    }
    expect(getAutoFileHealth().degraded).toBe(true);

    await runAutoFileTick(async (items) =>
      items.map((i) => ({ id: i.id, projectId: project.id, confidence: 1 })),
    );
    const health = getAutoFileHealth();
    expect(health.degraded).toBe(false);
    expect(health.unproductiveStreak).toBe(0);
    expect(health.lastResult!.outcome).toBe("progress");
  });

  test("every silent early return names itself", async () => {
    // Nothing queued at all: the honest idle state.
    await runAutoFileTick(async () => []);
    expect(getAutoFileHealth().lastResult!.outcome).toBe("no_candidates");
    expect(getAutoFileHealth().degraded).toBe(false);

    // Candidates with nowhere to put them is NOT the idle state, and the
    // difference used to be invisible.
    makeItem("Homeless");
    await runAutoFileTick(async () => []);
    const noProjects = getAutoFileHealth();
    expect(noProjects.lastResult!.outcome).toBe("no_projects");
    expect(noProjects.lastResult!.candidates).toBe(1);
    expect(noProjects.degraded).toBe(true);
    expect(noProjects.degradedReason).toContain("no active projects");

    // A scorer miss (failure or deadline) is distinct from both.
    createProject({ title: "Ops" });
    await runAutoFileTick(async () => null);
    expect(getAutoFileHealth().lastResult!.outcome).toBe("scorer_miss");
  });

  test("the tick records liveness even when there is nothing to do", async () => {
    await runAutoFileTick(async () => [], 5_000_000);
    const first = getAutoFileHealth();
    expect(first.ticks).toBe(1);
    expect(first.lastTickAt).toBe(5_000_000);

    await runAutoFileTick(async () => [], 5_300_000);
    // An idle filer and a dead filer look identical without this.
    expect(getAutoFileHealth().lastTickAt).toBe(5_300_000);
    expect(getAutoFileHealth().ticks).toBe(2);
  });
});
