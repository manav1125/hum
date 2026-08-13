/**
 * Tests for `SkillRevisionList`, the query-free half of the revision history.
 *
 * Mounted via `@testing-library/react` (happy-dom — see
 * `apps/web/test-setup.ts`). Fixture revisions stand in for the daemon
 * response so the rendering rules can be pinned without a query cache:
 * newest-first rows with +/- counts, a diff that only appears once its row is
 * expanded, added/removed line styling, and the compaction caveat.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { SkillRevisionList } from "@/domains/intelligence/components/skills/skill-revision-history.js";
import type { SkillRevision } from "@/domains/intelligence/skills/use-skill-history.js";

afterEach(() => {
  cleanup();
});

const DIFF = `diff --git a/skills/triage/SKILL.md b/skills/triage/SKILL.md
index 1a2b3c4..5d6e7f8 100644
--- a/skills/triage/SKILL.md
+++ b/skills/triage/SKILL.md
@@ -1,2 +1,2 @@
 # Triage
-Group the failures by file.
+Group the failures by owning team.
`;

function makeRevision(overrides: Partial<SkillRevision> = {}): SkillRevision {
  return {
    id: "abc1234",
    changedAt: "2026-08-10T12:00:00Z",
    files: ["SKILL.md"],
    diff: DIFF,
    ...overrides,
  };
}

describe("SkillRevisionList", () => {
  test("renders one collapsed row per revision with +/- counts", () => {
    render(
      <SkillRevisionList
        skillId="triage"
        revisions={[
          makeRevision(),
          makeRevision({ id: "def5678", files: ["scripts/run.py"] }),
        ]}
        truncatedByCompaction={false}
      />,
    );

    const rows = screen.getAllByRole("button", { expanded: false });
    expect(rows).toHaveLength(2);
    // Counts from the parsed diff, visible without expanding.
    expect(screen.getAllByText("+1")).toHaveLength(2);
    expect(screen.getAllByText("−1")).toHaveLength(2);
    // The diff body is not mounted while collapsed.
    expect(screen.queryByText(/owning team/)).toBeNull();
  });

  test("expanding a row reveals the per-file diff with add/del rows", () => {
    render(
      <SkillRevisionList
        skillId="triage"
        revisions={[makeRevision()]}
        truncatedByCompaction={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { expanded: false }));

    expect(screen.getByRole("button", { expanded: true })).toBeTruthy();
    // File header uses the skill-relative path, not the repo path.
    expect(screen.getByText("SKILL.md", { selector: "p" })).toBeTruthy();
    const added = screen.getByText("Group the failures by owning team.");
    const removed = screen.getByText("Group the failures by file.");
    expect(added).toBeTruthy();
    expect(removed).toBeTruthy();
    // Added and removed lines are visually distinct (background carries it).
    const addRow = added.parentElement as HTMLElement;
    const delRow = removed.parentElement as HTMLElement;
    expect(addRow.style.backgroundColor).not.toBe("");
    expect(delRow.style.backgroundColor).not.toBe("");
    expect(addRow.style.backgroundColor).not.toBe(
      delRow.style.backgroundColor,
    );
  });

  test("shows the compaction caveat only when history was squashed", () => {
    const { rerender } = render(
      <SkillRevisionList
        skillId="triage"
        revisions={[makeRevision()]}
        truncatedByCompaction={true}
      />,
    );
    expect(screen.getByText(/periodically compacted/)).toBeTruthy();

    rerender(
      <SkillRevisionList
        skillId="triage"
        revisions={[makeRevision()]}
        truncatedByCompaction={false}
      />,
    );
    expect(screen.queryByText(/periodically compacted/)).toBeNull();
  });

  test("an empty list renders the no-changes note", () => {
    render(
      <SkillRevisionList
        skillId="triage"
        revisions={[]}
        truncatedByCompaction={false}
      />,
    );

    expect(screen.getByText("No changes recorded yet.")).toBeTruthy();
  });
});
