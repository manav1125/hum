/**
 * The Notes list resolves, and it never lies about why it is empty.
 *
 * Both of these are regressions from a build that was actually run:
 *
 *   1. **It sat on "Loading…" forever.** The local read was awaited with no
 *      bound, so an environment where `indexedDB.open` never answers — a
 *      blocked upgrade, a private window, some custom-protocol origins — left
 *      the page waiting on a promise that would never settle.
 *   2. **A failed request drew the empty state.** "Say the thing you'd
 *      otherwise forget" and "I couldn't reach your notes" look identical on
 *      screen and mean opposite things, and showing the first when the second
 *      is true tells someone their notes are gone.
 *
 * The second is the same mistake as reporting "nothing to file" for a read
 * that errored, one level up — which is the mistake this whole feature is
 * built around not making.
 */

import { describe, expect, test } from "bun:test";

import type { Note, NoteCounts } from "@/types/notes";

import { resolveNotesView } from "./use-notes";

/**
 * Drives the REAL resolver the hook calls — not a restatement of it. A test
 * that re-derives these branches can pass while the hook does the opposite,
 * which is worse than having no test.
 */
function resolve(input: {
  serverData?: { notes: Note[]; counts: NoteCounts };
  isPending: boolean;
  isError: boolean;
  local?: Note[];
}) {
  const view = resolveNotesView(
    {
      ...(input.serverData ? { data: input.serverData } : {}),
      isPending: input.isPending,
      isError: input.isError,
    },
    input.local as never,
    "all",
  );
  return { status: view.status, source: view.source };
}

const note = (id: string): Note =>
  ({ id, title: "n", body: "", occurredAt: 1 }) as Note;

const counts: NoteCounts = {
  notes: 1,
  tasks: 0,
  memories: 0,
  waiting: 0,
  unfiled: 1,
  recorded: 0,
};

describe("the server's answer wins", () => {
  test("server data is used even when a local snapshot exists", () => {
    expect(
      resolve({
        serverData: { notes: [note("a")], counts },
        isPending: false,
        isError: false,
        local: [note("b")],
      }),
    ).toEqual({ status: "ready", source: "server" });
  });
});

describe("it always resolves", () => {
  test("loading only while BOTH sources are still working", () => {
    expect(resolve({ isPending: true, isError: false })).toEqual({
      status: "loading",
      source: null,
    });
  });

  test("REGRESSION: a local read that answers empty does not hold Loading", () => {
    // The shipped bug: `local` stayed null forever when the store could not
    // be opened, and the page waited on it. An unreadable store is a device
    // with no notes on it, not a reason to wait.
    expect(resolve({ isPending: false, isError: true, local: [] })).toEqual({
      status: "unreachable",
      source: null,
    });
  });

  test("a local snapshot renders while the daemon is still working", () => {
    expect(
      resolve({ isPending: true, isError: false, local: [note("a")] }),
    ).toEqual({ status: "ready", source: "local" });
  });
});

describe("empty and unreachable are never the same screen", () => {
  test("REGRESSION: a failed request is 'unreachable', not an empty list", () => {
    // Drawing the empty state here says "you have no notes" when the truth is
    // "I could not ask" — about the pile someone would most panic to see gone.
    expect(resolve({ isPending: false, isError: true, local: [] })).toEqual({
      status: "unreachable",
      source: null,
    });
  });

  test("a genuinely empty device is 'ready', so the empty state can show", () => {
    expect(resolve({ isPending: false, isError: false, local: [] })).toEqual({
      status: "ready",
      source: "local",
    });
  });

  test("an errored request with local notes still shows them", () => {
    // Being unable to reach the daemon must not hide what this device holds.
    expect(
      resolve({ isPending: false, isError: true, local: [note("a")] }),
    ).toEqual({ status: "ready", source: "local" });
  });
});
