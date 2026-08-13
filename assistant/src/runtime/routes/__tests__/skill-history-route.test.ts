/**
 * Tests for the `getSkillHistory` route's current-resource boundary.
 *
 * The service layer reads retained git history, which outlives the skill it
 * describes: a deleted skill's commits stay in the workspace repository
 * forever. The route is therefore the only place that can decide whether an id
 * still names something, and it must reach the same answer as the sibling
 * skill routes rather than serving history for a resource the rest of the API
 * reports as gone.
 *
 * Both collaborators are mocked, because what is under test is the ordering
 * between them: the existence check has to gate the history read, not run
 * alongside it.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const getSkillLocalDetailMock = mock(
  (
    _id: string,
  ): { ok: true } | { ok: false; error: string; status: 404 | 500 } =>
    ({ ok: true }) as { ok: true },
);
const getSkillHistoryMock = mock(async (_id: string, _opts?: unknown) => ({
  skillId: _id,
  revisions: [{ id: "abc1234", changedAt: "", files: ["SKILL.md"], diff: "" }],
  truncatedByCompaction: false,
}));

// Spread the real modules and override only the seams under test — an
// exhaustive factory would silently delete every other export for later
// files in a combined run (see assistant/CLAUDE.md).
const actualHandlers = await import("../../../daemon/handlers/skills.js");
mock.module("../../../daemon/handlers/skills.js", () => ({
  ...actualHandlers,
  getSkillLocalDetail: getSkillLocalDetailMock,
}));

const actualHistory = await import("../../../workspace/skill-history.js");
mock.module("../../../workspace/skill-history.js", () => ({
  ...actualHistory,
  getSkillHistory: getSkillHistoryMock,
}));

const { ROUTES } = await import("../skill-history-routes.js");

const handler = ROUTES.find(
  (r) => r.operationId === "getSkillHistory",
)!.handler;

beforeEach(() => {
  getSkillLocalDetailMock.mockClear();
  getSkillHistoryMock.mockClear();
  getSkillLocalDetailMock.mockImplementation(
    () => ({ ok: true }) as { ok: true },
  );
  getSkillHistoryMock.mockImplementation(async (_id: string) => ({
    skillId: _id,
    revisions: [
      { id: "abc1234", changedAt: "", files: ["SKILL.md"], diff: "" },
    ],
    truncatedByCompaction: false,
  }));
});

describe("getSkillHistory route", () => {
  test("returns history for a skill that currently exists", async () => {
    const result = (await handler({
      pathParams: { id: "release-triage" },
    })) as {
      revisions: unknown[];
    };

    expect(result.revisions).toHaveLength(1);
    expect(getSkillHistoryMock).toHaveBeenCalledTimes(1);
  });

  test("passes a parsed limit through to the service", async () => {
    await handler({
      pathParams: { id: "release-triage" },
      queryParams: { limit: "5" },
    });

    expect(getSkillHistoryMock).toHaveBeenCalledWith("release-triage", {
      limit: 5,
    });
  });

  test("404s for a deleted skill whose commits are still in the repository", async () => {
    // The skill is gone from the resolver, but git would still answer.
    getSkillLocalDetailMock.mockImplementation(() => ({
      ok: false,
      error: 'Skill "release-triage" not found.',
      status: 404,
    }));

    await expect(
      handler({ pathParams: { id: "release-triage" } }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  test("does not read history at all when the skill is gone", async () => {
    getSkillLocalDetailMock.mockImplementation(() => ({
      ok: false,
      error: "gone",
      status: 404,
    }));

    await Promise.resolve(
      handler({ pathParams: { id: "release-triage" } }),
    ).catch(() => {});

    // Ordering is the point: a check that ran after the read would still
    // reject, but would have spent the git traversal to do it.
    expect(getSkillHistoryMock).not.toHaveBeenCalled();
  });

  test("rejects a malformed id as the caller's error, not a server fault", async () => {
    getSkillHistoryMock.mockImplementation(() => {
      throw new Error("Invalid skill id: contains a path separator");
    });

    await expect(handler({ pathParams: { id: "bad" } })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  test("surfaces an unexpected service failure as a server error", async () => {
    getSkillHistoryMock.mockImplementation(() => {
      throw new Error("git exploded");
    });

    await expect(handler({ pathParams: { id: "ok" } })).rejects.toMatchObject({
      statusCode: 500,
    });
  });
});
