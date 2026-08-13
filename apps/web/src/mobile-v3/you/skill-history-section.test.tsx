/**
 * Mv3SkillHistory — the mobile revision-history disclosure.
 *
 * The three properties that make it safe to put inside a phone sheet:
 *  · it opens CLOSED (reference material, not the sheet's subject);
 *  · a diff scrolls inside its own well and cannot widen the sheet;
 *  · a failed read says so instead of reading as "never changed".
 *
 * The fixture diff is the real shape the daemon returns — verified against
 * `GET /v1/skills/daily-briefing/history` on prod, which answers with one
 * revision touching `SKILL.md` and `scripts/setup.ts`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";

import type { SkillRevision } from "@/domains/intelligence/skills/use-skill-history";

import {
  Mv3SkillHistoryCard,
  revisionCountLabel,
  revisionFilesLabel,
} from "./skill-history-section";

afterEach(cleanup);

const LONG_LINE = `+${"x".repeat(300)}`;

const revision: SkillRevision = {
  id: "5fbc2e29",
  changedAt: "2026-07-22T08:55:31Z",
  files: ["SKILL.md", "scripts/setup.ts"],
  diff: [
    "diff --git a/skills/daily-briefing/SKILL.md b/skills/daily-briefing/SKILL.md",
    "index 00000000..3d047731",
    "--- a/skills/daily-briefing/SKILL.md",
    "+++ b/skills/daily-briefing/SKILL.md",
    "@@ -1,2 +1,3 @@",
    " ---",
    "-name: daily-brief",
    "+name: daily-briefing",
    LONG_LINE,
  ].join("\n"),
};

const older: SkillRevision = {
  id: "aa11bb22",
  changedAt: "2026-06-02T10:00:00Z",
  files: ["SKILL.md"],
  diff: "",
};

function renderCard(props?: Partial<Parameters<typeof Mv3SkillHistoryCard>[0]>) {
  return render(
    createElement(Mv3SkillHistoryCard, {
      skillId: "daily-briefing",
      revisions: [revision, older],
      truncatedByCompaction: false,
      ...props,
    }),
  );
}

describe("revision row labels", () => {
  test("a multi-file revision is spelled as a count, not path soup", () => {
    expect(revisionFilesLabel(["SKILL.md"])).toBe("SKILL.md");
    expect(revisionFilesLabel(["SKILL.md", "scripts/setup.ts"])).toBe(
      "SKILL.md +1 more",
    );
    expect(revisionFilesLabel(["a", "b", "c"])).toBe("a +2 more");
    expect(revisionFilesLabel([])).toBe("");
  });

  test("the count pluralises", () => {
    expect(revisionCountLabel(1)).toBe("1 change");
    expect(revisionCountLabel(3)).toBe("3 changes");
  });
});

describe("Mv3SkillHistory disclosure", () => {
  test("opens collapsed — the summary is the only thing on screen", () => {
    renderCard();
    expect(screen.getByText("History")).toBeTruthy();
    expect(screen.getByText("2 changes")).toBeTruthy();
    expect(screen.getByText(/^Last changed /)).toBeTruthy();
    // No revision rows until asked for.
    expect(screen.queryByText("SKILL.md +1 more")).toBeNull();

    const toggle = screen.getByRole("button", { expanded: false });
    fireEvent.click(toggle);
    expect(screen.getByText("SKILL.md +1 more")).toBeTruthy();
    expect(screen.getByText("+2")).toBeTruthy();
    expect(screen.getByText("−1")).toBeTruthy();
  });

  test("a revision opens onto its diff, and only when tapped", () => {
    const { container } = renderCard();
    fireEvent.click(screen.getAllByRole("button")[0]);
    expect(container.querySelector('[data-slot="mv3-diff-well"]')).toBeNull();

    fireEvent.click(screen.getByText("SKILL.md +1 more"));
    expect(screen.getByText("name: daily-briefing")).toBeTruthy();
    expect(container.querySelector('[data-slot="mv3-diff-well"]')).toBeTruthy();
  });

  test("the diff scrolls itself and cannot pan the sheet behind it", () => {
    const { container } = renderCard();
    fireEvent.click(screen.getAllByRole("button")[0]);
    fireEvent.click(screen.getByText("SKILL.md +1 more"));

    const well = container.querySelector<HTMLElement>(
      '[data-slot="mv3-diff-well"]',
    );
    expect(well).toBeTruthy();
    // The long line lives in here, not in the sheet's layout.
    expect(well!.style.overflowX).toBe("auto");
    expect(well!.style.maxWidth).toBe("100%");
    // Reaching the end of the diff must not chain the scroll outward.
    expect(well!.style.overscrollBehaviorX).toBe("contain");

    // Every ancestor up to the section root must be squeezable, or the
    // intrinsic width of the diff would widen the sheet instead of
    // overflowing inside the well.
    const root = container.querySelector<HTMLElement>(
      '[data-slot="mv3-skill-history"]',
    )!;
    for (let node = well!.parentElement; node && node !== root; ) {
      expect(["0", "0px"], `min-width missing on ${node.outerHTML.slice(0, 80)}`)
        .toContain(node.style.minWidth);
      node = node.parentElement;
    }
    expect(root.style.overflow).toBe("hidden");
  });

  test("a revision with no parseable diff says so rather than showing nothing", () => {
    renderCard();
    fireEvent.click(screen.getAllByRole("button")[0]);
    fireEvent.click(screen.getByText("SKILL.md"));
    expect(screen.getByText("No preview available for this change.")).toBeTruthy();
  });

  test("compaction is disclosed, so the list is never read as complete", () => {
    renderCard({ truncatedByCompaction: true });
    fireEvent.click(screen.getAllByRole("button")[0]);
    expect(screen.getByText(/older history is periodically compacted/i)).toBeTruthy();
  });

  test("a failed read is not silence — and does not open onto an empty list", () => {
    renderCard({ revisions: [], isError: true });
    expect(screen.getByText("Couldn't load")).toBeTruthy();
    const toggle = screen.getByRole("button");
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(toggle);
    expect(screen.queryByText("SKILL.md")).toBeNull();
  });
});
