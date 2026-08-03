/**
 * The budget only holds if every remote push goes through it.
 *
 * `sendAlertToAllDevices` is the raw APNs transport: it fans an alert out to
 * every registered device and counts nothing. `sendBudgetedAlert` is the entry
 * point that tiers the push, checks design's ceiling and writes the ledger row
 * before the alert leaves. A future call site that reaches the transport
 * directly would be a push nobody counted — and, being a push, exactly the
 * kind of thing nobody notices is uncounted.
 *
 * So this test pins the chokepoint by inspection: the only production module
 * allowed to name the raw transport is the one that defines it.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const SRC_ROOT = join(import.meta.dir, "../..");

/** The module that defines the transport, and therefore may name it. */
const ALLOWED = new Set(["notifications/push-dispatch.ts"]);

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      yield* walk(full);
      continue;
    }
    if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) yield full;
  }
}

describe("every remote push goes through the budget", () => {
  test("no production module calls the raw APNs transport directly", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      const relative = file.slice(SRC_ROOT.length + 1);
      if (ALLOWED.has(relative)) continue;
      if (readFileSync(file, "utf-8").includes("sendAlertToAllDevices")) {
        offenders.push(relative);
      }
    }
    expect(offenders).toEqual([]);
  });
});
