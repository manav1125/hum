/**
 * The valve's three doors (design v35 · V2) — the rules that make three
 * surfaces one control rather than three controls.
 *
 * What is pinned here is deliberately not "does the menu open". It is the four
 * things that would each be a silent product lie:
 *
 *   1. **One vocabulary.** All three doors take their stop labels and their
 *      copy from `VALVE_STOP_META`. A second definition anywhere is how the
 *      rail says "Needs you" while Guardrails says "Balanced".
 *   2. **No fabricated count.** A stop whose preview has not landed renders no
 *      digit — never a zero, which reads as "nothing would reach you".
 *   3. **The taught number is a result or an absence, never a zero dressed as
 *      a result.** A fresh account is told it has taught nothing; an
 *      unreachable route is told we could not ask; and neither is "0 senders
 *      demoted".
 *   4. **Filtered is never the default story.** No door's copy presents quiet
 *      as the resting position, and every door can say the fail-open rule.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";

import {
  MissionValveChip,
  stopCaption,
  taughtSentence,
  ValveDoor,
  VALVE_FAIL_OPEN,
  VALVE_FOOTER,
  VALVE_STOP_META,
  VALVE_STOP_ORDER,
  type ValveTeaching,
} from "./valve-doors";

afterEach(cleanup);

/** A tree with a query client and nothing behind it — the unread valve. */
function renderUnread(node: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

function teaching(over: Partial<ValveTeaching> = {}): ValveTeaching {
  return { demotedSenders: 0, threshold: 2, taught: [], ...over };
}

function taughtRow(subjectKey: string, dismissed: number, kept = 0) {
  return {
    subjectKind: "sender",
    subjectKey,
    dismissed,
    kept,
    lastSignalAt: 0,
  };
}

describe("one vocabulary, shared by all three doors", () => {
  test("the three stops are the daemon's three, in the order that opens loud", () => {
    // Order matters on every door: reading top-to-bottom must go from most
    // reaching you to least, so nobody picks "quieter" by reading downward
    // and landing on the loudest option.
    expect([...VALVE_STOP_ORDER]).toEqual([
      "everything",
      "needs_you",
      "only_urgent",
    ]);
  });

  test("every stop has a label, a subclause and a full explanation", () => {
    for (const stop of VALVE_STOP_ORDER) {
      const meta = VALVE_STOP_META[stop];
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.sub.length).toBeGreaterThan(0);
      // Guardrails is the door that explains rather than sets, so every stop
      // owes it a sentence — a stop with no explanation is a control the owner
      // is asked to choose blind.
      expect(meta.explains.length).toBeGreaterThan(40);
    }
  });

  test("no stop's copy carries a number — measured counts come from the daemon", () => {
    // The frame's "94 a day" / "57 now" are illustrations. A digit baked into
    // a label here would ship one account's day to every account.
    for (const stop of VALVE_STOP_ORDER) {
      const meta = VALVE_STOP_META[stop];
      expect(meta.label).not.toMatch(/\d/);
      expect(meta.sub).not.toMatch(/\d/);
      expect(meta.countSuffix ?? "").not.toMatch(/\d/);
      expect(meta.explains).not.toMatch(/\d/);
    }
  });
});

describe("filtered is never the default story", () => {
  test("the footer says held work is kept, not hidden", () => {
    expect(VALVE_FOOTER).toContain("stay in Work");
    expect(VALVE_FOOTER).toContain("what interrupts");
  });

  test("the fail-open rule says turning it off makes Cue LOUDER", () => {
    // The sentence exists because the opposite is what everyone assumes. An
    // unscored item is treated as urgent, so an empty valve is a wide-open
    // one — and a Guardrails page that let a reader believe otherwise would be
    // selling the safe-sounding choice as the safe one.
    expect(VALVE_FAIL_OPEN).toContain("urgent");
    expect(VALVE_FAIL_OPEN).toContain("louder");
    expect(VALVE_FAIL_OPEN).not.toContain("quieter,");
  });

  test("the default stop's own copy admits it starts loud and quietens", () => {
    // 57 is the honest number and design refused a tighter default to hide it.
    // The copy has to carry that, or the first week reads as a broken filter.
    expect(VALVE_STOP_META.needs_you.explains).toContain("could not judge");
    expect(VALVE_STOP_META.needs_you.countSuffix).toContain("shrinks");
  });
});

describe("stopCaption — a pending count prints NO digit", () => {
  test("a measured count is shown with its own clause", () => {
    expect(stopCaption("everything", 94)).toBe("94 a day, unfiltered");
    expect(stopCaption("needs_you", 57)).toBe(
      "57 now · shrinks as Cue learns",
    );
  });

  test("a measured zero is still a fact and is shown", () => {
    expect(stopCaption("only_urgent", 0)).toContain("0");
  });

  test("an unlanded preview is an em-dash, never a zero", () => {
    for (const stop of VALVE_STOP_ORDER) {
      const caption = stopCaption(stop, null);
      expect(caption).toContain("—");
      // The whole defect in one assertion: no digit may appear for a count we
      // have not got. "0 a day, unfiltered" would tell the owner that nothing
      // reaches them at the loudest stop there is.
      expect(caption).not.toMatch(/\d/);
    }
  });
});

describe("taughtSentence — a result, an absence, or 'I couldn't ask'", () => {
  test("a real demotion count is stated as a result", () => {
    expect(taughtSentence(teaching({ demotedSenders: 34 }))).toContain(
      "34 senders demoted",
    );
  });

  test("one demoted sender is singular", () => {
    expect(taughtSentence(teaching({ demotedSenders: 1 }))).toContain(
      "1 sender demoted",
    );
  });

  test("corrections that have not reached the threshold are NOT a zero", () => {
    // The specific lie this blocks: "0 senders demoted" beside four ✕'s the
    // owner remembers giving. The truth is that one ✕ is deliberately not
    // enough, and the sentence has to say so rather than report a nil result.
    const s = taughtSentence(
      teaching({ taught: [taughtRow("a@example.com", 1)], threshold: 2 }),
    );
    expect(s).toContain("Nothing demoted yet");
    expect(s).toContain("takes 2");
    expect(s).not.toMatch(/\b0 senders?\b/);
  });

  test("a fresh account is told it has taught nothing, not shown a zero", () => {
    const s = taughtSentence(teaching());
    expect(s).toContain("haven't used the ✕");
    expect(s).not.toMatch(/\b0\b/);
  });

  test("an unreadable route says we could not ask — a different sentence again", () => {
    // Three states, three sentences. Collapsing "couldn't ask" into "nothing
    // taught" is how a broken read becomes a confident claim about the owner.
    const cannotAsk = taughtSentence(null);
    expect(cannotAsk).toContain("couldn't read");
    expect(cannotAsk).not.toBe(taughtSentence(teaching()));
    expect(cannotAsk).not.toMatch(/\b0\b/);
  });
});

describe("an unread valve asserts nothing — on either door", () => {
  test("the HQ door says it is reading, and offers no stop to write", () => {
    // The failure this blocks: a control that renders "Reaching you: Needs
    // you" from a default while the read is still in flight, and then lets you
    // "change" a stop the surface only guessed at.
    const { container } = renderUnread(<ValveDoor assistantId="a1" />);
    const button = container.querySelector("button")!;
    expect(button.textContent).toContain("reading");
    expect(button.textContent).not.toContain("Needs you");
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  test("the mission chip renders NOTHING rather than offering a blind override", () => {
    // An override written against a global stop we have not read would be an
    // exception to a rule nobody has established.
    const { container } = renderUnread(
      <MissionValveChip
        assistantId="a1"
        missionId="m1"
        missionStatus="active"
      />,
    );
    expect(container.querySelector('[data-slot="mission-valve-chip"]')).toBeNull();
  });
});
