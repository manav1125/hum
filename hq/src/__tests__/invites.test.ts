import { describe, expect, test } from "bun:test";

import { HqDb } from "../db.js";

describe("invite lifecycle", () => {
  test("mint → redeem decrements availability", () => {
    const db = new HqDb(":memory:");
    const c = db.createCustomer({ email: "inv@x.io", name: "Inv" });
    const invite = db.createInvite({
      customerId: c.id,
      percentOff: 20,
      maxUses: 2,
    });
    expect(invite.code).toMatch(/^CUE-[A-Z2-9]{8}$/);
    expect(invite.uses).toBe(0);

    expect(db.redeemInvite(invite.code).uses).toBe(1);
    expect(db.redeemInvite(invite.code).uses).toBe(2);
    expect(() => db.redeemInvite(invite.code)).toThrow("invite_exhausted");
  });

  test("expired invites are rejected", () => {
    const db = new HqDb(":memory:");
    const invite = db.createInvite({ expiresAt: Date.now() - 1000 });
    expect(() => db.redeemInvite(invite.code)).toThrow("invite_expired");
  });

  test("unknown codes are rejected; lookup is case-insensitive", () => {
    const db = new HqDb(":memory:");
    expect(() => db.redeemInvite("CUE-NOPE9999")).toThrow("invite_unknown");
    const invite = db.createInvite({});
    expect(db.getInvite(invite.code.toLowerCase())?.code).toBe(invite.code);
  });

  test("no-expiry invites never expire", () => {
    const db = new HqDb(":memory:");
    const invite = db.createInvite({ expiresAt: null, maxUses: 1 });
    expect(db.redeemInvite(invite.code).uses).toBe(1);
  });
});
