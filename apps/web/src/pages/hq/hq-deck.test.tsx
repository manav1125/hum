/**
 * Tests for the canonical HQ deck modules.
 *
 * These assert the design invariants from
 * `01-work-surfaces/canonical/cue-canonical.html`, not styling. Each one
 * encodes a rule the deck has broken before or would break silently:
 *
 *   · the deck never grows          — needs-you caps, volume moves the census
 *   · never a fake number           — a lane we cannot answer is absent, not 0
 *   · a no-op is not a success      — "nothing arrived" must name the reason
 *   · no colour-only state          — every state carries a glyph
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import {
  CensusBar,
  DeliveredBlock,
  EmptyState,
  PulseStrip,
} from "@/pages/hq/hq-deck";

afterEach(cleanup);

function wrap(ui: React.ReactNode) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe("DeliveredBlock", () => {
  test("renders nothing when nothing was delivered", () => {
    // An empty receipts block is a worse opening than no block at all.
    const { container } = wrap(<DeliveredBlock items={[]} />);
    expect(container.querySelector("[data-slot='hq-delivered']")).toBeNull();
  });

  test("shows delivered work with a glyph, not colour alone", () => {
    const { container } = wrap(
      <DeliveredBlock items={[{ id: "1", title: "Acme one-pager v2" }]} />,
    );
    expect(container.textContent).toContain("Acme one-pager v2");
    // ✓ carries the state for anyone who cannot see the green.
    expect(container.textContent).toContain("✓");
  });

  test("caps the list so the deck cannot grow with volume", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: String(i),
      title: `Item ${i}`,
    }));
    const { container } = wrap(<DeliveredBlock items={many} />);
    expect(container.textContent).toContain("Item 0");
    expect(container.textContent).not.toContain("Item 11");
  });
});

describe("CensusBar — never a fake number", () => {
  test("omits zero segments entirely rather than rendering '0 waiting'", () => {
    // A zero reads as "none", which is a claim. A lane the product cannot yet
    // answer must be absent from the sentence, not asserted as empty.
    const { container } = wrap(
      <CensusBar
        segments={[
          { label: "need you", value: 5 },
          { label: "handed off", value: 0 },
        ]}
      />,
    );
    expect(container.textContent).toContain("need you");
    expect(container.textContent).not.toContain("handed off");
  });

  test("renders nothing at all when every segment is empty", () => {
    const { container } = wrap(
      <CensusBar segments={[{ label: "need you", value: 0 }]} />,
    );
    expect(container.querySelector("[data-slot='hq-census']")).toBeNull();
  });

  test("joins the segments it can answer", () => {
    const { container } = wrap(
      <CensusBar
        segments={[
          { label: "need you", value: 6 },
          { label: "Cue is doing", value: 9 },
        ]}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("6");
    expect(text).toContain("need you");
    expect(text).toContain("9");
    expect(text).toContain("Cue is doing");
  });
});

describe("PulseStrip", () => {
  test("watching nothing says WHY, and never implies quiet", () => {
    const { container } = wrap(
      <PulseStrip sourceCount={0} checkCount={1851} lastCheckLabel={null} />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Watching nothing");
    // The evidence that Cue has in fact been working the whole time.
    expect(text).toContain("1,851");
  });

  test("does not invent a check count it was not given", () => {
    const { container } = wrap(
      <PulseStrip sourceCount={0} checkCount={null} lastCheckLabel={null} />,
    );
    expect(container.textContent).toBe("○Watching nothing yet");
  });

  test("reports real sources once watching is live", () => {
    const { container } = wrap(
      <PulseStrip
        sourceCount={3}
        checkCount={1851}
        lastCheckLabel="4 min ago"
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Watching 3 sources");
    expect(text).toContain("4 min ago");
  });

  test("singularises one source", () => {
    const { container } = wrap(
      <PulseStrip sourceCount={1} checkCount={null} lastCheckLabel={null} />,
    );
    expect(container.textContent).toContain("Watching 1 source");
    expect(container.textContent).not.toContain("1 sources");
  });
});

describe("EmptyState — three kinds, three treatments", () => {
  test("not-set-up owns the screen and offers the action", () => {
    const { container } = wrap(
      <EmptyState
        kind="not_set_up"
        title="Cue can see your inbox — but it isn't watching it"
        body="Right now Cue works when you ask."
        action={<button type="button">Start watching</button>}
      />,
    );
    expect(
      container.querySelector("[data-slot='hq-empty-not_set_up']"),
    ).not.toBeNull();
    expect(container.textContent).toContain("isn't watching it");
    expect(container.textContent).toContain("Start watching");
  });

  test("nothing-yet refuses to imply quiet", () => {
    // The failure mode this guards: "Nothing has arrived" on its own reads as a
    // calm inbox, when the truth is that observation is switched off.
    const { container } = wrap(
      <EmptyState
        kind="nothing_yet"
        title="Nothing has arrived"
        body="Because nothing is watching — not because it's quiet."
      />,
    );
    expect(container.textContent).toContain("not because it's quiet");
  });

  test("broken states are named, never a generic shrug", () => {
    const { container } = wrap(
      <EmptyState
        kind="broken"
        title="718 memory jobs found nothing"
        body="Contact extraction ran but had no channel bindings to read."
      />,
    );
    expect(
      container.querySelector("[data-slot='hq-empty-broken']"),
    ).not.toBeNull();
    expect(container.textContent).toContain("718");
  });

  test("each kind carries a distinct glyph, so state is never colour alone", () => {
    const kinds = ["not_set_up", "nothing_yet", "broken"] as const;
    const glyphs = kinds.map((kind) => {
      const { container } = wrap(
        <EmptyState kind={kind} title="t" body="b" />,
      );
      const g = container.querySelector("[aria-hidden]")?.textContent ?? "";
      cleanup();
      return g;
    });
    expect(new Set(glyphs).size).toBe(3);
  });
});
