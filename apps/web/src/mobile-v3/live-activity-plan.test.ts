import { describe, expect, test } from "bun:test";

import {
  planRunActivity,
  type RunActivityItem,
  type TrackedActivity,
} from "./live-activity-plan";

function item(over: Partial<RunActivityItem> & { id: string }): RunActivityItem {
  return {
    title: "Booking Bottega",
    status: "running",
    lastProgressNote: null,
    ...over,
  };
}

const tracked = (over?: Partial<TrackedActivity>): TrackedActivity => ({
  runId: "wi-1",
  title: "Booking Bottega",
  statusLine: "Working…",
  ...over,
});

describe("planRunActivity", () => {
  test("idle → idle issues nothing", () => {
    const r = planRunActivity(null, []);
    expect(r.command.kind).toBe("none");
    expect(r.tracked).toBeNull();
  });

  test("first running item starts an activity with its progress note", () => {
    const r = planRunActivity(null, [
      item({ id: "wi-1", lastProgressNote: "Confirming Thu 7:00pm…" }),
    ]);
    expect(r.command).toEqual({
      kind: "start",
      runId: "wi-1",
      title: "Booking Bottega",
      status: "Confirming Thu 7:00pm…",
      state: "running",
    });
    expect(r.tracked).toEqual({
      runId: "wi-1",
      title: "Booking Bottega",
      statusLine: "Confirming Thu 7:00pm…",
    });
  });

  test("missing progress note falls back to the default line", () => {
    const r = planRunActivity(null, [item({ id: "wi-1" })]);
    expect(r.command).toMatchObject({ kind: "start", status: "Working…" });
  });

  test("same run + same note is a no-op (no bridge spam)", () => {
    const t = tracked();
    const r = planRunActivity(t, [item({ id: "wi-1" })]);
    expect(r.command.kind).toBe("none");
    expect(r.tracked).toBe(t);
  });

  test("progress-note change on the tracked run updates", () => {
    const r = planRunActivity(tracked(), [
      item({ id: "wi-1", lastProgressNote: "Emailing the venue…" }),
    ]);
    expect(r.command).toEqual({
      kind: "update",
      status: "Emailing the venue…",
      state: "running",
    });
    expect(r.tracked?.statusLine).toBe("Emailing the venue…");
  });

  test("a different run taking the top slot restarts (latest-run-wins)", () => {
    const r = planRunActivity(tracked(), [
      item({ id: "wi-2", title: "Drafting the brief" }),
    ]);
    expect(r.command).toMatchObject({
      kind: "start",
      runId: "wi-2",
      title: "Drafting the brief",
    });
    expect(r.tracked?.runId).toBe("wi-2");
  });

  test("non-running items never start an activity", () => {
    const r = planRunActivity(null, [
      item({ id: "wi-1", status: "pending" }),
      item({ id: "wi-2", status: "awaiting_review" }),
    ]);
    expect(r.command.kind).toBe("none");
  });

  test("tracked run landing in awaiting_review ends as review", () => {
    const r = planRunActivity(tracked(), [
      item({ id: "wi-1", status: "awaiting_review" }),
    ]);
    expect(r.command).toEqual({
      kind: "end",
      status: "Ready for your review",
      state: "review",
    });
    expect(r.tracked).toBeNull();
  });

  test("tracked run landing in failed ends as failed", () => {
    const r = planRunActivity(tracked(), [item({ id: "wi-1", status: "failed" })]);
    expect(r.command).toMatchObject({ kind: "end", state: "failed" });
  });

  test("tracked run gone from the snapshot ends as done", () => {
    const r = planRunActivity(tracked(), []);
    expect(r.command).toEqual({ kind: "end", status: "Done", state: "done" });
    expect(r.tracked).toBeNull();
  });

  test("tracked run done ends as done even when another finished item exists", () => {
    const r = planRunActivity(tracked(), [
      item({ id: "wi-1", status: "done" }),
      item({ id: "wi-9", status: "failed" }),
    ]);
    expect(r.command).toMatchObject({ kind: "end", state: "done" });
  });

  test("end→start across snapshots: finishing one run while another starts wins the slot", () => {
    // wi-1 finished, wi-2 running — the planner starts wi-2 directly; the
    // native side retires the old activity itself (single slot).
    const r = planRunActivity(tracked(), [
      item({ id: "wi-1", status: "done" }),
      item({ id: "wi-2", title: "Chasing the invoice" }),
    ]);
    expect(r.command).toMatchObject({ kind: "start", runId: "wi-2" });
  });
});
