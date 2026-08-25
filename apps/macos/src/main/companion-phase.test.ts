import { describe, expect, mock, test } from "bun:test";

import {
  CompanionPhaseStore,
  QUIET_SIGNALS,
  resolveCompanionPhase,
  type CompanionSignals,
} from "./companion-phase";

/**
 * The phase resolver — design `C2`, `C6`, `C7`, `C9`.
 *
 * The cases worth pinning are the ones where two true things compete, because
 * that is where a creature can end up telling a comfortable lie: a summary
 * covering a live recording, or a nudge arriving in the middle of a sentence
 * somebody is typing.
 */

const given = (patch: Partial<CompanionSignals>): CompanionSignals => ({
  ...QUIET_SIGNALS,
  ...patch,
});

describe("precedence: whatever you are more in the middle of", () => {
  test("a resting creature says nothing at all", () => {
    expect(resolveCompanionPhase(QUIET_SIGNALS)).toEqual({ phase: "resting" });
  });

  test("hover is the bottom of the pile — being outranked costs it nothing", () => {
    expect(resolveCompanionPhase(given({ hover: true, busy: true })).phase).toBe(
      "working",
    );
  });

  test("REGRESSION: a summary never covers a live recording", () => {
    // The creature is the only always-visible evidence that audio is being
    // kept (`C11`). Anything quieter drawn over it is the surface telling a
    // comfortable lie about what is running.
    const resolved = resolveCompanionPhase(
      given({ recording: { label: "Board prep", elapsed: "12:41" } }),
    );
    expect(resolved.phase).toBe("recording");
    expect(resolved.line).toBe("Recording · Board prep · 12:41");
  });

  test("a typing card outranks everything — it is a half-finished sentence", () => {
    expect(
      resolveCompanionPhase(
        given({
          typing: true,
          recording: { label: "Board prep", elapsed: "01:02" },
          awaitingApproval: true,
        }),
      ).phase,
    ).toBe("typing");
  });

  test("an approval outranks a capture, because it is holding something up", () => {
    expect(
      resolveCompanionPhase(given({ awaitingApproval: true, watching: true }))
        .phase,
    ).toBe("waiting");
  });
});

describe("the states that earn trust (C6)", () => {
  test("a failed read keeps the question, and never renders as an empty answer", () => {
    const resolved = resolveCompanionPhase(given({ couldnt: true }));
    expect(resolved.phase).toBe("couldnt");
    expect(resolved.line).toBe(
      "I couldn't read that just now — your question is kept.",
    );
  });

  test("offline says what still works before what does not", () => {
    const resolved = resolveCompanionPhase(given({ online: false }));
    expect(resolved.phase).toBe("offline");
    expect(resolved.line).toBe("Notes still save.");
    expect(resolved.detail).toBe(
      "Questions wait for signal — I'll say when I'm back.",
    );
  });
});

describe("the first approval is a cliff, walked once (C9)", () => {
  test("the first raise names the protocol", () => {
    const resolved = resolveCompanionPhase(given({ awaitingApproval: true }));
    expect(resolved.line).toContain("I'll always bring you there");
    expect(resolved.detail).toBe("I never approve things from here.");
  });

  test("every raise after it is the short line", () => {
    // Said once it becomes protocol; said every time it becomes noise.
    const resolved = resolveCompanionPhase(
      given({ awaitingApproval: true, approvalExplained: true }),
    );
    expect(resolved.line).toBe(
      "That one needs your okay — I've raised the window.",
    );
  });
});

describe("quiet hours mean the creature never moves first (C7)", () => {
  test("a nudge during quiet hours does not resolve at all", () => {
    // Suppressed at the source rather than covered: a nudge that resolved and
    // was then hidden would still have spent its budget.
    expect(
      resolveCompanionPhase(
        given({ nudge: { line: "Dana replied on pricing", itemId: "i1" }, quiet: true }),
      ).phase,
    ).toBe("resting");
  });

  test("outside quiet hours it carries its one line", () => {
    const resolved = resolveCompanionPhase(
      given({ nudge: { line: "Dana replied on pricing", itemId: "i1" } }),
    );
    expect(resolved.phase).toBe("nudge");
    expect(resolved.line).toBe("Dana replied on pricing");
  });

  test("quiet hours never hide something already running", () => {
    // Quiet is about Cue speaking first, not about concealing a live capture.
    expect(
      resolveCompanionPhase(
        given({ quiet: true, recording: { label: "Standup", elapsed: "00:31" } }),
      ).phase,
    ).toBe("recording");
  });
});

describe("the store publishes on the resolved phase, not the signals", () => {
  test("a pointer moving over the same drawn area republishes nothing", () => {
    const onChange = mock(() => undefined);
    const store = new CompanionPhaseStore(onChange);

    store.set({ hover: true });
    expect(onChange).toHaveBeenCalledTimes(1);

    // Hover is reported on every forwarded move. Republishing each one would
    // have the renderer redrawing on nothing.
    store.set({ hover: true });
    store.set({ hover: true });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test("a signal that changes nothing visible is silent", () => {
    const onChange = mock(() => undefined);
    const store = new CompanionPhaseStore(onChange);

    store.set({ typing: true });
    onChange.mockClear();
    // Outranked by the card: true, but nothing to redraw.
    store.set({ hover: true });
    expect(onChange).not.toHaveBeenCalled();
  });

  test("a change of words alone still publishes", () => {
    const onChange = mock(() => undefined);
    const store = new CompanionPhaseStore(onChange);

    store.set({ recording: { label: "Board prep", elapsed: "12:41" } });
    onChange.mockClear();
    store.set({ recording: { label: "Board prep", elapsed: "12:42" } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
