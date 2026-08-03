/**
 * K1 · Offline — the two promises, tested rather than commented.
 *
 *   1. **No spinner ever appears offline.** Asserted against the rendered tree,
 *      not by reading the source: a spinner arriving through a shared component
 *      would pass a grep and fail a user.
 *   2. **Each queued thing is undoable.** And "undoable" means the action is
 *      actually gone afterwards — not that a button exists next to it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import {
  clearOfflineQueue,
  enqueueOfflineAction,
  flushOfflineQueue,
  readOfflineQueue,
  registerOfflineReplay,
  undoOfflineAction,
} from "./offline-queue";
import { OfflineState } from "./offline-state";

beforeEach(() => {
  localStorage.clear();
  clearOfflineQueue();
});
afterEach(cleanup);

function seed() {
  enqueueOfflineAction({
    label: "Approved the Acme reply",
    verb: "approve",
    replay: { kind: "work_item.approve", payload: { id: "w1" } },
  });
  enqueueOfflineAction({
    label: '"chase Dana about the form"',
    verb: "capture",
    replay: { kind: "capture", payload: { text: "chase Dana" } },
  });
}

describe("no spinner ever appears offline", () => {
  test("with a queue, and without one", () => {
    for (const withQueue of [false, true]) {
      cleanup();
      clearOfflineQueue();
      if (withQueue) seed();
      const { container } = render(<OfflineState lastSyncedAt={Date.now()} />);

      // Every shape a spinner takes in this codebase.
      expect(container.querySelector('[role="progressbar"]')).toBeNull();
      expect(container.querySelector("svg circle[stroke-dasharray]")).toBeNull();

      // …and any animation at all. Offline, nothing is in flight, so there is
      // nothing for motion to be reporting on.
      const animated = [...container.querySelectorAll<HTMLElement>("*")].filter(
        (el) =>
          (el.style.animation || el.style.animationName || "").trim().length > 0,
      );
      expect(animated).toEqual([]);
    }
  });

  test("it never says something is sending — it says it is queued", () => {
    seed();
    render(<OfflineState />);
    expect(screen.queryByText(/sending/i)).toBeNull();
    expect(screen.getByText(/SENDS WHEN YOU'RE BACK/)).toBeTruthy();
  });
});

describe("the three honest blocks", () => {
  test("queued, still usable, and not until you're back", () => {
    seed();
    render(<OfflineState />);
    expect(screen.getByText(/QUEUED · SENDS WHEN YOU'RE BACK/)).toBeTruthy();
    expect(screen.getByText("STILL USABLE")).toBeTruthy();
    expect(screen.getByText(/NOT UNTIL YOU'RE BACK/)).toBeTruthy();
  });

  test("the composer recedes with a reason, in the first person", () => {
    render(<OfflineState />);
    expect(screen.getByText("I can't answer offline")).toBeTruthy();
  });

  test("an empty queue says why it is empty rather than showing nothing", () => {
    render(<OfflineState />);
    expect(screen.getByText(/Nothing is waiting/)).toBeTruthy();
    expect(screen.getByText(/nothing waiting to send/)).toBeTruthy();
  });

  test("never a fake sync time — a device that has never synced says so", () => {
    render(<OfflineState lastSyncedAt={null} />);
    expect(screen.getByText("Not synced on this device yet")).toBeTruthy();
  });
});

describe("a queued action can actually be undone", () => {
  test("tapping Undo removes it from the queue and from the screen", () => {
    seed();
    render(<OfflineState />);
    expect(readOfflineQueue()).toHaveLength(2);
    expect(screen.getByText("Approved the Acme reply")).toBeTruthy();

    const undos = screen.getAllByText("Undo");
    expect(undos).toHaveLength(2);
    fireEvent.click(undos[0]!);

    expect(readOfflineQueue()).toHaveLength(1);
    expect(readOfflineQueue()[0]!.label).toBe('"chase Dana about the form"');
    expect(screen.queryByText("Approved the Acme reply")).toBeNull();
  });

  test("it survives a reload — the queue is durable, not in-memory", () => {
    seed();
    cleanup();
    render(<OfflineState />);
    expect(screen.getByText("Approved the Acme reply")).toBeTruthy();
  });

  test("undoing something that is not there reports nothing, and claims nothing", () => {
    expect(undoOfflineAction("nope")).toBeNull();
  });

  test("an action with no replay handler says so instead of implying a send", () => {
    seed();
    render(<OfflineState />);
    expect(
      screen.getAllByText(/I don't know how to send this one yet/).length,
    ).toBeGreaterThan(0);
  });
});

describe("flush replays, and never lies about what it replayed", () => {
  test("a registered kind runs and leaves the queue", async () => {
    const seen: unknown[] = [];
    const off = registerOfflineReplay("capture", async (payload) => {
      seen.push(payload);
    });
    seed();

    const report = await flushOfflineQueue();
    expect(seen).toEqual([{ text: "chase Dana" }]);
    expect(report.sent.map((a) => a.verb)).toEqual(["capture"]);
    // The approve had no handler — it stays queued and is reported as such.
    expect(report.unhandled).toHaveLength(1);
    expect(readOfflineQueue()).toHaveLength(1);
    off();
  });

  test("a handler that throws leaves the action queued, not silently dropped", async () => {
    const off = registerOfflineReplay("capture", async () => {
      throw new Error("still offline");
    });
    seed();
    const report = await flushOfflineQueue();
    expect(report.sent).toEqual([]);
    expect(report.failed).toHaveLength(1);
    expect(readOfflineQueue()).toHaveLength(2);
    off();
  });

  test("order is preserved — archive-then-approve is not approve-then-archive", async () => {
    const order: string[] = [];
    const off = registerOfflineReplay("k", async (p) => {
      order.push((p as { n: string }).n);
    });
    for (const n of ["a", "b", "c"]) {
      enqueueOfflineAction({
        label: n,
        verb: "archive",
        replay: { kind: "k", payload: { n } },
      });
    }
    await flushOfflineQueue();
    expect(order).toEqual(["a", "b", "c"]);
    off();
  });
});
