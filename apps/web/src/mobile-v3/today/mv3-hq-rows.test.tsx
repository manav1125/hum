/**
 * The two rows C1 brings to the phone, and the two ways they could lie.
 *
 * **`⌗` must not widen.** `low_confidence` is the only verdict that means Cue
 * read the message and could not name an action. `failed` means the model never
 * answered — a timeout, a parse failure, an unreachable provider — so during an
 * outage EVERY arrival is `failed`. A `⌗` bucket that swallowed those would
 * empty the deck at the exact moment Cue is least able to explain itself, which
 * is a content judgement standing in for an outage. The mobile rows import the
 * desktop predicate rather than restating it; this pins that they still agree.
 *
 * **Going quiet must not invent.** Design's row reads *"Sarah Chen is going
 * quiet · asked twice, 11 days · a16z"*. The person, the day count and the
 * state are real. **"asked twice" is not stored anywhere the web can read** —
 * `lastChasedAt` is a scalar with no counter, work-item events carry no
 * `chased` kind, and the `followups` table that does count asks has no HTTP
 * route. Neither is "a16z": contacts have no company field. So the row says
 * neither, and this file is what stops a later edit from adding them back as
 * plausible-looking strings.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import { isUnComprehended, UNREADABLE_STATUS } from "@/pages/hq/uncomprehended";
import type { WaitingItem } from "@/pages/hq/hq-k1-modules";

import {
  goingQuiet,
  Mv3GoingQuietRows,
  Mv3UnreadableRow,
  quietSentence,
  QUIET_ROW_CAP,
  UNREADABLE_LINE,
} from "./mv3-hq-rows";

afterEach(cleanup);

function waiting(overrides: Partial<WaitingItem> = {}): WaitingItem {
  return {
    id: "w1",
    person: "Sarah Chen",
    what: "the term sheet",
    days: 11,
    state: "going_cold",
    ...overrides,
  };
}

function draw(node: React.ReactElement) {
  return render(<MemoryRouter>{node}</MemoryRouter>);
}

describe("⌗ — the predicate the phone shares with desktop", () => {
  test("only low_confidence earns ⌗", () => {
    expect(UNREADABLE_STATUS).toBe("low_confidence");
    expect(isUnComprehended("low_confidence")).toBe(true);
  });

  test("`failed` is NOT ⌗ — hiding on it would empty the deck in an outage", () => {
    // The whole reason the predicate is a whitelist of one.
    expect(isUnComprehended("failed")).toBe(false);
    expect(isUnComprehended("skipped")).toBe(false);
    expect(isUnComprehended("comprehended")).toBe(false);
    expect(isUnComprehended(null)).toBe(false);
    expect(isUnComprehended(undefined)).toBe(false);
  });

  test("the row quotes their subject verbatim and admits, in Cue's voice", () => {
    const { container } = draw(
      <Mv3UnreadableRow
        item={{
          workItemId: "wi-1",
          arrivalId: "a-1",
          subject: "CIPA: 2026 Annual Return Due",
          snippet: null,
          senderName: "CIPA",
          senderAddress: null,
          channel: "watcher:gmail",
          receivedAt: 0,
          item: { id: "wi-1", status: "pending" } as never,
        }}
      />,
    );
    const subject = container.querySelector(
      '[data-slot="mv3-unreadable-subject"]',
    );
    expect(subject?.textContent).toBe("“CIPA: 2026 Annual Return Due”");
    // Italic, because these are their words and not Cue's reading of them.
    expect((subject as HTMLElement).style.fontStyle).toBe("italic");
    expect(container.textContent).toContain(UNREADABLE_LINE);
  });

  test("the badge is neutral — amber belongs to `?` and `‖`", () => {
    const { container } = draw(
      <Mv3UnreadableRow
        item={{
          workItemId: "wi-1",
          arrivalId: "a-1",
          subject: "x",
          snippet: null,
          senderName: null,
          senderAddress: null,
          channel: "watcher:gmail",
          receivedAt: 0,
          item: { id: "wi-1", status: "pending" } as never,
        }}
      />,
    );
    const badge = container.querySelector('[role="img"]') as HTMLElement;
    expect(badge.textContent).toBe("⌗");
    expect(badge.style.background).not.toContain("amber");
    expect(badge.style.color).not.toContain("amber");
  });
});

describe("going quiet", () => {
  test("only the two states with a cost surface as rows", () => {
    const rows = goingQuiet([
      waiting({ id: "a", state: "on_time" }),
      waiting({ id: "b", state: "going_cold" }),
      waiting({ id: "c", state: "chased" }),
      waiting({ id: "d", state: "system" }),
    ]);
    // `on_time` wants to be forgotten; `system` wants nothing at all.
    expect(rows.map((r) => r.id)).toEqual(["b", "c"]);
  });

  test("the rows are capped — the deck never grows", () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      waiting({ id: `w${i}`, state: "going_cold" }),
    );
    expect(goingQuiet(many)).toHaveLength(QUIET_ROW_CAP);
  });

  test("names who and how long, and NEVER how many times", () => {
    const cold = quietSentence(waiting());
    expect(cold.headline).toBe("Sarah Chen is going quiet");
    expect(cold.detail).toBe("the term sheet · 11 days since I chased");
    // The fragments the data cannot support.
    const all = `${cold.headline} ${cold.detail}`;
    expect(all).not.toContain("twice");
    expect(all).not.toContain("asked");
  });

  test("an already-chased person reads differently from a cold one", () => {
    // Same amber-adjacent row, different next move: chased wants escalation,
    // going cold wants a nudge. Collapsing them would flatten that.
    expect(quietSentence(waiting({ state: "chased", days: 1 }))).toEqual({
      headline: "Sarah Chen hasn't come back",
      detail: "the term sheet · chased 1 day ago",
    });
  });

  test("nothing going quiet renders nothing — the waiting line says it", () => {
    const { container } = draw(
      <Mv3GoingQuietRows waiting={[waiting({ state: "on_time" })]} />,
    );
    expect(
      container.querySelector('[data-slot="mv3-going-quiet"]'),
    ).toBeNull();
  });

  test("a failed read speaks — a person dropping off silently is the bug", () => {
    draw(
      <Mv3GoingQuietRows
        waiting={[]}
        unavailable={{ reason: "Couldn't load what you're waiting on" }}
      />,
    );
    expect(
      screen.getByText("Couldn't load what you're waiting on"),
    ).toBeTruthy();
  });

  test("the state carries a glyph, not just the tint", () => {
    const { container } = draw(<Mv3GoingQuietRows waiting={[waiting()]} />);
    expect(container.textContent).toContain("◷");
  });
});
