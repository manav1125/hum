/**
 * What crosses to the card, and what does not.
 *
 * The card draws these rows directly, so anything wrong here is wrong on a
 * surface that floats over everything the owner is doing.
 */

import { describe, expect, test } from "bun:test";

import type { DisplayMessage } from "@/domains/chat/types/types";

import { companionTurnsFrom } from "./use-publish-companion-turns";

const msg = (role: string, text: string): DisplayMessage =>
  ({
    id: `${role}-${text}`,
    role,
    contentBlocks: text ? [{ type: "text", text }] : [],
  }) as unknown as DisplayMessage;

describe("companionTurnsFrom", () => {
  test("keeps the tail, most recent last", () => {
    const rows = companionTurnsFrom(
      [
        msg("user", "one"),
        msg("assistant", "two"),
        msg("user", "three"),
        msg("assistant", "four"),
        msg("user", "five"),
      ],
      4,
    );
    expect(rows.map((r) => r.text)).toEqual(["two", "three", "four", "five"]);
    expect(rows[0]!.role).toBe("assistant");
  });

  test("a row whose text has not arrived is skipped, not sent empty", () => {
    // An assistant row exists from the first SSE frame, before any text. An
    // empty bubble in the card reads as an answer that said nothing.
    const rows = companionTurnsFrom([msg("user", "hi"), msg("assistant", "")]);
    expect(rows).toEqual([{ role: "user", text: "hi" }]);
  });

  test("only the two roles the card can draw", () => {
    // Rendering a system row as one side of an exchange would put words in
    // somebody's mouth.
    const rows = companionTurnsFrom([
      msg("system", "you are a helpful assistant"),
      msg("user", "hi"),
    ]);
    expect(rows).toEqual([{ role: "user", text: "hi" }]);
  });

  test("an empty conversation publishes nothing", () => {
    expect(companionTurnsFrom([])).toEqual([]);
  });
});
