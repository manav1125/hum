/**
 * Mission routes — sweepAt wire behavior:
 *   - createMission stamps the 08:00 default and accepts an explicit clock;
 *   - PATCH accepts/normalizes "H:mm", rejects malformed values, and null
 *     reverts to the clock-less legacy scheduling;
 *   - GET responses expose sweepAt.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "./helpers/mock-logger.js";

mock.module("../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { BadRequestError } from "../runtime/routes/errors.js";
import { ROUTES } from "../runtime/routes/missions-routes.js";

initializeDb();

function route(operationId: string) {
  const found = ROUTES.find((r) => r.operationId === operationId);
  if (!found) throw new Error(`No route with operationId ${operationId}`);
  return found;
}

function createViaRoute(body: Record<string, unknown>) {
  return route("createMission").handler({ body }) as {
    mission: { id: string; sweepAt: string | null };
  };
}

function patchViaRoute(id: string, body: Record<string, unknown>) {
  return route("updateMission").handler({ pathParams: { id }, body }) as {
    mission: { id: string; sweepAt: string | null };
  };
}

describe("missions routes — sweepAt", () => {
  beforeEach(() => {
    getDb().run("DELETE FROM missions");
  });

  test("create defaults sweepAt to 08:00 on the wire", () => {
    const { mission } = createViaRoute({ title: "M", outcome: "x" });
    expect(mission.sweepAt).toBe("08:00");
  });

  test("create accepts an explicit clock and normalizes the hour padding", () => {
    const { mission } = createViaRoute({
      title: "M",
      outcome: "x",
      cadence: "daily",
      sweepAt: "6:15",
    });
    expect(mission.sweepAt).toBe("06:15");
  });

  test("PATCH updates the clock and getMission exposes it", () => {
    const { mission } = createViaRoute({ title: "M", outcome: "x" });
    const patched = patchViaRoute(mission.id, { sweepAt: "21:30" });
    expect(patched.mission.sweepAt).toBe("21:30");

    const fetched = route("getMission").handler({
      pathParams: { id: mission.id },
    }) as { mission: { sweepAt: string | null } };
    expect(fetched.mission.sweepAt).toBe("21:30");
  });

  test("PATCH null reverts to clock-less legacy scheduling", () => {
    const { mission } = createViaRoute({ title: "M", outcome: "x" });
    const patched = patchViaRoute(mission.id, { sweepAt: null });
    expect(patched.mission.sweepAt).toBeNull();
  });

  test("rejects malformed clocks on create and PATCH", () => {
    expect(() =>
      createViaRoute({ title: "M", outcome: "x", sweepAt: "25:00" }),
    ).toThrow(BadRequestError);

    const { mission } = createViaRoute({ title: "M", outcome: "x" });
    for (const bad of ["8am", "08:5", "24:00", "08:60", ""]) {
      expect(() => patchViaRoute(mission.id, { sweepAt: bad })).toThrow(
        BadRequestError,
      );
    }
    // Malformed PATCH must not clobber the stored clock.
    const fetched = route("getMission").handler({
      pathParams: { id: mission.id },
    }) as { mission: { sweepAt: string | null } };
    expect(fetched.mission.sweepAt).toBe("08:00");
  });
});
