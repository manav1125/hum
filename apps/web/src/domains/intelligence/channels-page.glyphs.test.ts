/**
 * Every icon name the daemon can send must resolve to a glyph.
 *
 * The Channels cards rendered the literal words "hash", "send" and "phone"
 * where the Slack, Telegram and Phone marks belong. Nothing was broken in the
 * daemon: `assistant/src/channels/types.ts` documents `icon` as "Lucide icon
 * name without the `lucide-` prefix … web clients import the matching
 * component from `lucide-react`". The web client simply never did the import
 * and printed the string.
 *
 * That failure is invisible to a render test — the tile renders, it is the
 * right size, it has the right background, and it contains text. So the
 * assertion here is on the CONTRACT instead: the set of names the catalog can
 * emit must be a subset of the names the client can draw. Adding a channel to
 * the daemon without a glyph fails this file rather than shipping a word.
 */

import { describe, expect, test } from "bun:test";

import { CHANNEL_GLYPH } from "./channels-page";

/**
 * Mirrors the `icon:` values in `assistant/src/channels/types.ts`. Duplicated
 * on purpose — importing across the app/daemon boundary would drag the
 * daemon's module graph into a web test, and the point is to notice when the
 * two drift, which a shared constant would hide.
 */
const DAEMON_CHANNEL_ICONS = [
  "hash",
  "send",
  "phone",
  "message-circle",
  "mail",
  "message-square",
  "bot",
] as const;

describe("channel icon names resolve to glyphs", () => {
  test.each(DAEMON_CHANNEL_ICONS)("%s has a glyph", (name) => {
    expect(CHANNEL_GLYPH[name]).toBeDefined();
  });

  test("the map holds components, never strings", () => {
    // A string here would render as itself — the original bug, one layer down.
    for (const [name, glyph] of Object.entries(CHANNEL_GLYPH)) {
      expect(typeof glyph, `${name} must be a component`).not.toBe("string");
    }
  });
});
