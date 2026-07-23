import { describe, expect, it } from "bun:test";

import {
  colLetterToIndex,
  computeResults,
  type ModelCell,
  type WorkbookModel,
} from "@/domains/chat/utils/formula-eval";

/** Build a single-sheet model from an object of A1 → literal|"=formula". */
function sheet(
  name: string,
  cells: Record<string, number | string | boolean>,
): [string, Map<string, ModelCell>] {
  const map = new Map<string, ModelCell>();
  for (const [a1, v] of Object.entries(cells)) {
    if (typeof v === "string" && v.startsWith("=")) {
      map.set(a1, { formula: v.slice(1) });
    } else {
      map.set(a1, { literal: v });
    }
  }
  return [name, map];
}

describe("colLetterToIndex", () => {
  it("maps letters to 1-based indices", () => {
    expect(colLetterToIndex("A")).toBe(1);
    expect(colLetterToIndex("B")).toBe(2);
    expect(colLetterToIndex("Z")).toBe(26);
    expect(colLetterToIndex("AA")).toBe(27);
  });
});

describe("computeResults — arithmetic the SaaS model emits", () => {
  it("evaluates products, sums, and cross-sheet references", () => {
    const model: WorkbookModel = new Map([
      sheet("Assumptions", {
        B2: 10000, // starting MRR
        B3: 0.08, // growth
        B4: 0.02, // churn
      }),
      sheet("Monthly", {
        B5: "=Assumptions!B2*(1+Assumptions!B3)",
        B6: "=-Assumptions!B2*Assumptions!B4",
        B7: "=B5+B6",
        B10: "=SUM(B5:B7)",
      }),
    ]);
    const out = computeResults(model);
    const m = out.get("Monthly")!;
    expect(m.get("B5")).toBeCloseTo(10800, 6);
    expect(m.get("B6")).toBeCloseTo(-200, 6);
    expect(m.get("B7")).toBeCloseTo(10600, 6);
    expect(m.get("B10")).toBeCloseTo(21200, 6);
  });

  it("handles percentages, division, absolute refs, and IF", () => {
    const model: WorkbookModel = new Map([
      sheet("S", {
        B4: 100,
        B5: 300,
        B6: 100,
        C4: "=B4/SUM($B$4:$B$6)",
        D1: "=50%",
        E1: "=IF(B5>B4,B5,B4)",
        F1: "=ROUND(B4/3,2)",
        G1: "=MAX(B4,B5,B6)",
      }),
    ]);
    const out = computeResults(model).get("S")!;
    expect(out.get("C4")).toBeCloseTo(0.2, 6);
    expect(out.get("D1")).toBeCloseTo(0.5, 6);
    expect(out.get("E1")).toBe(300);
    expect(out.get("F1")).toBeCloseTo(33.33, 6);
    expect(out.get("G1")).toBe(300);
  });

  it("resolves chains of dependent formulas regardless of declaration order", () => {
    const model: WorkbookModel = new Map([
      sheet("S", {
        C1: "=B1+1",
        B1: "=A1*2",
        A1: 5,
      }),
    ]);
    const out = computeResults(model).get("S")!;
    expect(out.get("A1")).toBeUndefined(); // literal, not reported
    expect(out.get("B1")).toBe(10);
    expect(out.get("C1")).toBe(11);
  });

  it("recomputes dependents when an input literal changes (the edit path)", () => {
    const model: WorkbookModel = new Map([
      sheet("S", { A1: 10, A2: "=A1*2", A3: "=A2+A1" }),
    ]);
    expect(computeResults(model).get("S")!.get("A3")).toBe(30);
    // Simulate an edit: A1 10 → 100
    model.get("S")!.set("A1", { literal: 100 });
    const out = computeResults(model).get("S")!;
    expect(out.get("A2")).toBe(200);
    expect(out.get("A3")).toBe(300);
  });
});

describe("computeResults — fail-closed (the honesty guarantee)", () => {
  it("leaves division-by-zero uncached rather than emitting Infinity", () => {
    const model: WorkbookModel = new Map([
      sheet("S", { A1: 1, A2: 0, A3: "=A1/A2" }),
    ]);
    const out = computeResults(model).get("S")!;
    expect(out.has("A3")).toBe(false);
  });

  it("leaves unsupported functions uncached", () => {
    const model: WorkbookModel = new Map([
      sheet("S", { A1: 4, A2: "=SQRT(A1)" }),
    ]);
    const out = computeResults(model).get("S")!;
    expect(out.has("A2")).toBe(false);
  });

  it("does not loop or emit a value on a cyclic reference", () => {
    const model: WorkbookModel = new Map([
      sheet("S", { A1: "=B1", B1: "=A1" }),
    ]);
    const out = computeResults(model).get("S")!;
    expect(out.has("A1")).toBe(false);
    expect(out.has("B1")).toBe(false);
  });

  it("propagates uncomputable dependencies (a formula on an unresolved cell stays uncached)", () => {
    const model: WorkbookModel = new Map([
      sheet("S", { A1: "=NOPE(1)", A2: "=A1+1" }),
    ]);
    const out = computeResults(model).get("S")!;
    expect(out.has("A1")).toBe(false);
    expect(out.has("A2")).toBe(false);
  });
});
