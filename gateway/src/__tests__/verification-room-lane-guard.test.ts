/**
 * A verification code pasted into a room with other people in it.
 *
 * Two distinct harms, and only the first is obvious:
 *
 * 1. Redeeming binds the assistant to a shared room, and for a guardian
 *    session it hands guardianship to whoever pasted the code.
 * 2. The code has now been SHOWN to everyone present. Refusing to redeem it
 *    in the room, on its own, leaves it live — so any observer can carry it
 *    to a DM and redeem it there. That is the actual hijack, and refusing
 *    without retiring is strictly worse than useless: it blocks the
 *    legitimate owner while leaving a public credential valid.
 *
 * These pin the predicate rather than the whole intercept, because the
 * predicate is the security boundary and the intercept needs a live DB pair.
 */

import { describe, expect, test } from "bun:test";

import { isMultiPartyRoom } from "../verification/text-verification.js";

describe("multi-party room predicate", () => {
  test("every group shape our normalizers emit reads as multi-party", () => {
    // Slack: channel + mpim (a group DM is still more than one other person).
    // Telegram: group + supergroup + channel.
    for (const chatType of ["channel", "mpim", "group", "supergroup", "chat"]) {
      expect(isMultiPartyRoom(chatType)).toBe(true);
    }
  });

  test("one-to-one shapes redeem normally", () => {
    // Slack `im`, Telegram/WhatsApp `private`.
    for (const chatType of ["im", "private", "direct"]) {
      expect(isMultiPartyRoom(chatType)).toBe(false);
    }
  });

  test("an unrecognised room type reads as multi-party, not as a DM", () => {
    // The polarity that matters. This is an allowlist of one-to-one shapes
    // inverted, NOT a denylist of group shapes: a channel that grows a new
    // room type must fail toward refusing, since the cost of being wrong is
    // a guardian binding handed to a room, against the cost of telling one
    // owner to try again in a DM.
    for (const chatType of ["huddle", "space", "thread", "", "IM", "Private"]) {
      expect(isMultiPartyRoom(chatType)).toBe(true);
    }
  });

  test("absent type means the channel has no rooms and stays redeemable", () => {
    // Email is the case: there is no room to leak into. Channels that DO
    // have rooms always report a type, so absence is not a silent bypass.
    expect(isMultiPartyRoom(undefined)).toBe(false);
  });
});
