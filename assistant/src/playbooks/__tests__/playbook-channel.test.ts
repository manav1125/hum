/**
 * Tests for playbook channel normalisation.
 *
 * The runtime matches a playbook's channel against `watcher:<providerId>` by
 * exact string equality, so every alias here must land on a provider id the
 * watcher registry actually uses — an unmapped alias stores a channel that can
 * never fire.
 */

import { describe, expect, test } from "bun:test";

import {
  ANY_CHANNEL,
  describePlaybookChannel,
  normalizePlaybookChannel,
} from "../playbook-channel.js";

describe("normalizePlaybookChannel", () => {
  test("maps friendly aliases onto registered watcher provider ids", () => {
    expect(normalizePlaybookChannel("email")).toBe("watcher:gmail");
    expect(normalizePlaybookChannel("gmail")).toBe("watcher:gmail");
    expect(normalizePlaybookChannel("calendar")).toBe(
      "watcher:google-calendar",
    );
    expect(normalizePlaybookChannel("gh")).toBe("watcher:github");
    expect(normalizePlaybookChannel("linear")).toBe("watcher:linear");
  });

  test("slack maps to the slack watcher provider", () => {
    expect(normalizePlaybookChannel("slack")).toBe("watcher:slack");
    // Case- and whitespace-insensitive, like every other alias.
    expect(normalizePlaybookChannel(" Slack ")).toBe("watcher:slack");
  });

  test("wildcards and non-strings mean any channel", () => {
    expect(normalizePlaybookChannel("*")).toBe(ANY_CHANNEL);
    expect(normalizePlaybookChannel("")).toBe(ANY_CHANNEL);
    expect(normalizePlaybookChannel(undefined)).toBe(ANY_CHANNEL);
  });

  test("already-canonical watcher channels pass through untouched", () => {
    expect(normalizePlaybookChannel("watcher:slack")).toBe("watcher:slack");
  });
});

describe("describePlaybookChannel", () => {
  test("strips the watcher prefix for display", () => {
    expect(describePlaybookChannel("watcher:slack")).toBe("slack");
    expect(describePlaybookChannel(ANY_CHANNEL)).toBe("all channels");
  });
});
