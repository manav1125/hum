import { describe, expect, test } from "bun:test";

import {
  isTrustClass,
  isUntrustedTrustClass,
  meetsAdmissionFloor,
  TRUST_CLASS_RANK,
  TRUST_CLASSES,
  type TrustClass,
  trustClassRank,
} from "../trust.js";

describe("TRUST_CLASS_RANK", () => {
  test("orders unknown below trusted_contact below guardian", () => {
    expect(TRUST_CLASS_RANK.unknown).toBeLessThan(
      TRUST_CLASS_RANK.trusted_contact,
    );
    expect(TRUST_CLASS_RANK.trusted_contact).toBeLessThan(
      TRUST_CLASS_RANK.guardian,
    );
  });

  test("ranks every declared class exactly once", () => {
    const ranks = TRUST_CLASSES.map((c) => TRUST_CLASS_RANK[c]);
    expect(ranks).toHaveLength(Object.keys(TRUST_CLASS_RANK).length);
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  test("TRUST_CLASSES is listed least-trusted first", () => {
    const ranks = TRUST_CLASSES.map((c) => TRUST_CLASS_RANK[c]);
    expect([...ranks].sort((a, b) => a - b)).toEqual([...ranks]);
  });
});

describe("meetsAdmissionFloor", () => {
  test("admits at and above the floor", () => {
    expect(meetsAdmissionFloor("trusted_contact", "trusted_contact")).toBe(
      true,
    );
    expect(meetsAdmissionFloor("guardian", "trusted_contact")).toBe(true);
    expect(meetsAdmissionFloor("guardian", "guardian")).toBe(true);
    expect(meetsAdmissionFloor("unknown", "unknown")).toBe(true);
  });

  test("refuses below the floor", () => {
    expect(meetsAdmissionFloor("unknown", "trusted_contact")).toBe(false);
    expect(meetsAdmissionFloor("trusted_contact", "guardian")).toBe(false);
    expect(meetsAdmissionFloor("unknown", "guardian")).toBe(false);
  });

  /**
   * The failure this module exists to prevent: a floor and a rank that drift
   * apart do not fail loudly, they admit everyone. Both unknown inputs must
   * therefore deny, not default to zero and compare equal.
   */
  test("an unclassified actor clears no floor", () => {
    expect(meetsAdmissionFloor(undefined, "unknown")).toBe(false);
    expect(meetsAdmissionFloor(undefined, "trusted_contact")).toBe(false);
    expect(meetsAdmissionFloor(undefined, "guardian")).toBe(false);
  });

  test("a class this build has never heard of clears no floor", () => {
    const fromAFutureService = "superuser" as TrustClass;
    expect(meetsAdmissionFloor(fromAFutureService, "unknown")).toBe(false);
    expect(meetsAdmissionFloor(fromAFutureService, "guardian")).toBe(false);
  });

  test("a floor this build has never heard of admits nobody", () => {
    const unknownFloor = "superuser" as TrustClass;
    expect(meetsAdmissionFloor("guardian", unknownFloor)).toBe(false);
    expect(meetsAdmissionFloor("trusted_contact", unknownFloor)).toBe(false);
    expect(meetsAdmissionFloor("unknown", unknownFloor)).toBe(false);
  });
});

describe("trustClassRank", () => {
  test("ranks an unrecognized value below every real class", () => {
    for (const trustClass of TRUST_CLASSES) {
      expect(trustClassRank("nonsense")).toBeLessThan(
        trustClassRank(trustClass),
      );
    }
    expect(trustClassRank(undefined)).toBeLessThan(trustClassRank("unknown"));
    expect(trustClassRank(null)).toBeLessThan(trustClassRank("unknown"));
    expect(trustClassRank(2)).toBeLessThan(trustClassRank("unknown"));
  });

  test("does not treat inherited Object properties as classes", () => {
    // `"constructor" in TRUST_CLASS_RANK` is true on a plain object; a
    // prototype-walking lookup would rank it as a real trust class.
    expect(isTrustClass("constructor")).toBe(false);
    expect(isTrustClass("toString")).toBe(false);
    expect(trustClassRank("constructor")).toBe(-1);
  });
});

describe("isUntrustedTrustClass", () => {
  test("only the guardian is trusted", () => {
    expect(isUntrustedTrustClass("guardian")).toBe(false);
    expect(isUntrustedTrustClass("trusted_contact")).toBe(true);
    expect(isUntrustedTrustClass("unknown")).toBe(true);
    expect(isUntrustedTrustClass(undefined)).toBe(true);
  });

  test("agrees with the guardian floor for every class", () => {
    for (const trustClass of [...TRUST_CLASSES, undefined]) {
      expect(isUntrustedTrustClass(trustClass)).toBe(
        !meetsAdmissionFloor(trustClass, "guardian"),
      );
    }
  });
});
